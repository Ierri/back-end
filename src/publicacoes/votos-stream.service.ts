import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  MessageEvent,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { Observable, Subject } from 'rxjs';
import { z } from 'zod';
import { ApiException } from '../common/http/api.exception.js';
import { Seguidor } from '../usuarios/schemas/seguidor.schema.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { PublicacaoAccessService } from './publicacao-access.service.js';
import { PublicacoesCacheClient } from './publicacoes-cache.client.js';
import { Publicacao } from './schemas/publicacao.schema.js';

export const MAX_STREAMS_PER_USER = 8;
export const MAX_STREAMS_PER_IP = 12;
export const MAX_GLOBAL_STREAMS = 2_000;
export const STREAM_HEARTBEAT_MS = 25_000;
export const STREAM_MAX_LIFETIME_MS = 300_000;
export const STREAM_RETRY_MS = 3_000;

export type VoteStreamPublicPayload = {
  publicationId: string;
  upvotes: number;
  downvotes: number;
  score: number;
  revisao: number;
};

export type VoteBroadcastInput = VoteStreamPublicPayload & {
  authorId: string;
  visibility: 'publico' | 'seguidores';
};

export type PublicationAccessChangeInput = {
  publicationId: string;
  authorId: string;
  visibility: 'publico' | 'seguidores' | 'removida';
};

type StreamClient = {
  id: string;
  viewerId: string | null;
  subjectKey: string;
  maxForSubject: number;
  allowedIds: Set<string>;
  subject: Subject<MessageEvent>;
  closed: boolean;
};

type SnapshotPublicationLean = {
  _id: Types.ObjectId;
  autor_id: Types.ObjectId;
  visibilidade: 'publico' | 'seguidores';
  contadores?: {
    upvotes?: number;
    downvotes?: number;
    score?: number;
  };
  votos_revisao?: number;
};

const pubSubVoteMessageSchema = z.strictObject({
  instanceId: z.string().min(1).max(64),
  kind: z.literal('vote'),
  publicationId: z.string().regex(/^[a-f\d]{24}$/i),
  authorId: z.string().regex(/^[a-f\d]{24}$/i),
  visibility: z.enum(['publico', 'seguidores']),
  upvotes: z.number().int().min(0),
  downvotes: z.number().int().min(0),
  score: z.number().int(),
  revisao: z.number().int().min(0),
});

const pubSubAccessMessageSchema = z.strictObject({
  instanceId: z.string().min(1).max(64),
  kind: z.literal('access'),
  publicationId: z.string().regex(/^[a-f\d]{24}$/i),
  authorId: z.string().regex(/^[a-f\d]{24}$/i),
  visibility: z.enum(['publico', 'seguidores', 'removida']),
});

const pubSubEnvelopeSchema = z.discriminatedUnion('kind', [
  pubSubVoteMessageSchema,
  pubSubAccessMessageSchema,
]);

@Injectable()
export class VotosStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VotosStreamService.name);
  private readonly instanceId = randomUUID();
  private readonly channel: string;
  private readonly byPublication = new Map<string, Set<StreamClient>>();
  private readonly clients = new Set<StreamClient>();
  private readonly subjectCounts = new Map<string, number>();
  private subscriber: ReturnType<PublicacoesCacheClient['createSubscriber']> =
    null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectModel(Publicacao.name)
    private readonly publicacoes: Model<Publicacao>,
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @InjectModel(Seguidor.name) private readonly seguidores: Model<Seguidor>,
    @Inject(PublicacaoAccessService)
    private readonly access: PublicacaoAccessService,
    @Inject(PublicacoesCacheClient)
    private readonly cacheClient: PublicacoesCacheClient,
  ) {
    this.channel = `${this.cacheClient.prefix}pubsub:votos`;
  }

  onModuleInit() {
    this.heartbeatTimer = setInterval(() => {
      this.broadcastHeartbeat();
    }, STREAM_HEARTBEAT_MS);
    this.heartbeatTimer.unref();

    const sub = this.cacheClient.createSubscriber();
    if (!sub) return;
    this.subscriber = sub;
    void (async () => {
      try {
        await sub.connect();
        await sub.subscribe(this.channel, (rawMessage) => {
          void this.handlePubSubMessage(rawMessage);
        });
      } catch {
        this.logger.warn(
          'Assinatura Redis Pub/Sub de votos indisponível; operando em modo local.',
        );
      }
    })();
  }

  async onModuleDestroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const snapshotClients = Array.from(this.clients);
    for (const client of snapshotClients) {
      this.teardownClient(client, true);
    }
    const sub = this.subscriber;
    this.subscriber = null;
    if (sub) {
      if (sub.isReady) {
        await sub.close().catch(() => sub.destroy());
      } else {
        sub.destroy();
      }
    }
  }

  get activeStreamCount() {
    return this.clients.size;
  }

  async openStream(
    requestedIds: string[],
    viewerId: string | undefined,
    clientIp: string,
  ): Promise<Observable<MessageEvent>> {
    const normalizedViewer = viewerId?.trim().toLowerCase() || null;
    const subjectKey = normalizedViewer
      ? `user:${normalizedViewer}`
      : `ip:${clientIp || 'unknown'}`;
    const maxForSubject = normalizedViewer
      ? MAX_STREAMS_PER_USER
      : MAX_STREAMS_PER_IP;

    const currentForSubject = this.subjectCounts.get(subjectKey) ?? 0;
    if (
      this.clients.size >= MAX_GLOBAL_STREAMS ||
      currentForSubject >= maxForSubject
    ) {
      throw new ApiException('VOTO_STREAM_LIMIT_EXCEEDED');
    }

    // Reserve slot before async DB queries so concurrent bursts respect limits
    this.subjectCounts.set(subjectKey, currentForSubject + 1);

    let snapshotItems: VoteStreamPublicPayload[];
    try {
      snapshotItems = await this.resolveAuthorizedSnapshot(
        requestedIds,
        normalizedViewer ?? undefined,
      );
    } catch (error) {
      this.decrementSubjectCount(subjectKey);
      throw error;
    }

    const allowedIds = new Set(snapshotItems.map((item) => item.publicationId));
    const subject = new Subject<MessageEvent>();
    const client: StreamClient = {
      id: randomUUID(),
      viewerId: normalizedViewer,
      subjectKey,
      maxForSubject,
      allowedIds,
      subject,
      closed: false,
    };

    this.clients.add(client);
    for (const pubId of allowedIds) {
      let bucket = this.byPublication.get(pubId);
      if (!bucket) {
        bucket = new Set();
        this.byPublication.set(pubId, bucket);
      }
      bucket.add(client);
    }

    return new Observable<MessageEvent>((subscriber) => {
      const lifetimeTimer = setTimeout(() => {
        this.teardownClient(client, true);
      }, STREAM_MAX_LIFETIME_MS);
      lifetimeTimer.unref();

      const innerSub = subject.subscribe(subscriber);

      subscriber.next({
        type: 'snapshot',
        retry: STREAM_RETRY_MS,
        data: { items: snapshotItems },
      });

      return () => {
        clearTimeout(lifetimeTimer);
        innerSub.unsubscribe();
        this.teardownClient(client, false);
      };
    });
  }

  async publishVoteUpdate(event: VoteBroadcastInput): Promise<void> {
    const normalized: VoteBroadcastInput = {
      publicationId: event.publicationId.toLowerCase(),
      authorId: event.authorId.toLowerCase(),
      visibility: event.visibility,
      upvotes: event.upvotes,
      downvotes: event.downvotes,
      score: event.score,
      revisao: event.revisao,
    };

    await this.dispatchVoteLocally(normalized);

    const wirePayload = JSON.stringify({
      instanceId: this.instanceId,
      kind: 'vote' as const,
      ...normalized,
    });
    await this.cacheClient.publish(this.channel, wirePayload);
  }

  async publishAccessChange(
    input: PublicationAccessChangeInput,
  ): Promise<void> {
    const normalized: PublicationAccessChangeInput = {
      publicationId: input.publicationId.toLowerCase(),
      authorId: input.authorId.toLowerCase(),
      visibility: input.visibility,
    };

    await this.applyAccessChangeLocally(normalized);

    const wirePayload = JSON.stringify({
      instanceId: this.instanceId,
      kind: 'access' as const,
      ...normalized,
    });
    await this.cacheClient.publish(this.channel, wirePayload);
  }

  private async handlePubSubMessage(rawMessage: string): Promise<void> {
    if (rawMessage.length > 4_096) return;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawMessage);
    } catch {
      return;
    }
    const parsed = pubSubEnvelopeSchema.safeParse(parsedJson);
    if (!parsed.success) return;
    if (parsed.data.instanceId === this.instanceId) return;

    if (parsed.data.kind === 'vote') {
      await this.dispatchVoteLocally(parsed.data);
    } else {
      await this.applyAccessChangeLocally(parsed.data);
    }
  }

  private async dispatchVoteLocally(event: VoteBroadcastInput): Promise<void> {
    const bucket = this.byPublication.get(event.publicationId);
    if (!bucket || bucket.size === 0) return;

    const recipients = [...bucket];
    let authorizedFollowers: Set<string> | null = null;

    if (event.visibility === 'seguidores') {
      const candidateFollowers = recipients
        .map((client) => client.viewerId)
        .filter(
          (viewerId): viewerId is string =>
            viewerId !== null && viewerId !== event.authorId,
        );

      authorizedFollowers = await this.resolveAcceptedFollowers(
        event.authorId,
        candidateFollowers,
      );
    }

    const publicPayload: VoteStreamPublicPayload = {
      publicationId: event.publicationId,
      upvotes: event.upvotes,
      downvotes: event.downvotes,
      score: event.score,
      revisao: event.revisao,
    };

    for (const client of recipients) {
      if (client.closed || !client.allowedIds.has(event.publicationId)) {
        continue;
      }
      if (event.visibility === 'seguidores') {
        const isAuthor = client.viewerId === event.authorId;
        const isFollower =
          client.viewerId !== null &&
          Boolean(authorizedFollowers?.has(client.viewerId));
        if (!isAuthor && !isFollower) {
          this.detachPublicationFromClient(client, event.publicationId);
          continue;
        }
      }
      client.subject.next({
        type: 'vote',
        data: publicPayload,
      });
    }
  }

  private async applyAccessChangeLocally(
    change: PublicationAccessChangeInput,
  ): Promise<void> {
    const bucket = this.byPublication.get(change.publicationId);
    if (!bucket || bucket.size === 0) return;

    if (change.visibility === 'removida') {
      const affected = Array.from(bucket);
      for (const client of affected) {
        this.detachPublicationFromClient(client, change.publicationId);
      }
      return;
    }

    if (change.visibility === 'seguidores') {
      const recipients = [...bucket];
      const candidateFollowers = recipients
        .map((client) => client.viewerId)
        .filter(
          (viewerId): viewerId is string =>
            viewerId !== null && viewerId !== change.authorId,
        );
      const authorizedFollowers = await this.resolveAcceptedFollowers(
        change.authorId,
        candidateFollowers,
      );

      for (const client of recipients) {
        const isAuthor = client.viewerId === change.authorId;
        const isFollower =
          client.viewerId !== null && authorizedFollowers.has(client.viewerId);
        if (!isAuthor && !isFollower) {
          this.detachPublicationFromClient(client, change.publicationId);
        }
      }
    }
  }

  private async resolveAcceptedFollowers(
    authorId: string,
    viewerIds: string[],
  ): Promise<Set<string>> {
    const uniqueViewerIds = [...new Set(viewerIds)];
    if (!uniqueViewerIds.length) return new Set();
    try {
      const viewerObjectIds = uniqueViewerIds.map(
        (id) => new Types.ObjectId(id),
      );
      const [activeUsers, relations] = await Promise.all([
        this.usuarios
          .find({ _id: { $in: viewerObjectIds }, status: 'ativo' })
          .select('_id')
          .lean()
          .exec(),
        this.seguidores
          .find({
            seguidor_id: { $in: viewerObjectIds },
            seguido_id: new Types.ObjectId(authorId),
            status: 'aceito',
          })
          .select('seguidor_id')
          .lean()
          .exec(),
      ]);
      const activeSet = new Set(activeUsers.map((u) => u._id.toString()));
      const allowed = new Set<string>();
      for (const rel of relations) {
        const followerId = rel.seguidor_id.toString();
        if (activeSet.has(followerId)) {
          allowed.add(followerId);
        }
      }
      return allowed;
    } catch {
      return new Set();
    }
  }

  private async resolveAuthorizedSnapshot(
    requestedIds: string[],
    viewerId?: string,
  ): Promise<VoteStreamPublicPayload[]> {
    const visibilityFilter = await this.access.listVisibility(viewerId);
    const objectIds = requestedIds.map((id) => new Types.ObjectId(id));

    const docs = await this.publicacoes
      .find({
        $and: [
          visibilityFilter,
          { _id: { $in: objectIds }, status: 'publicada' },
        ],
      })
      .select('_id autor_id visibilidade contadores votos_revisao')
      .lean<SnapshotPublicationLean[]>()
      .exec();

    if (!docs.length) return [];

    const authorIds = [
      ...new Set(docs.map((doc) => doc.autor_id.toString())),
    ].map((id) => new Types.ObjectId(id));

    const activeAuthors = await this.usuarios
      .find({ _id: { $in: authorIds }, status: 'ativo' })
      .select('_id')
      .lean()
      .exec();

    const activeAuthorIds = new Set(
      activeAuthors.map((author) => author._id.toString()),
    );

    const byId = new Map<string, VoteStreamPublicPayload>();
    for (const doc of docs) {
      if (!activeAuthorIds.has(doc.autor_id.toString())) continue;
      const pubId = doc._id.toString().toLowerCase();
      const upvotes = doc.contadores?.upvotes ?? 0;
      const downvotes = doc.contadores?.downvotes ?? 0;
      const score = doc.contadores?.score ?? upvotes - downvotes;
      byId.set(pubId, {
        publicationId: pubId,
        upvotes,
        downvotes,
        score,
        revisao: doc.votos_revisao ?? 0,
      });
    }

    const ordered: VoteStreamPublicPayload[] = [];
    for (const reqId of requestedIds) {
      const found = byId.get(reqId);
      if (found) ordered.push(found);
    }
    return ordered;
  }

  private broadcastHeartbeat() {
    for (const client of this.clients) {
      if (!client.closed) {
        client.subject.next({ comment: 'ping' } as MessageEvent);
      }
    }
  }

  private detachPublicationFromClient(
    client: StreamClient,
    publicationId: string,
  ) {
    client.allowedIds.delete(publicationId);
    const bucket = this.byPublication.get(publicationId);
    if (bucket) {
      bucket.delete(client);
      if (bucket.size === 0) {
        this.byPublication.delete(publicationId);
      }
    }
  }

  private teardownClient(client: StreamClient, completeSubject: boolean) {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    for (const pubId of client.allowedIds) {
      const bucket = this.byPublication.get(pubId);
      if (bucket) {
        bucket.delete(client);
        if (bucket.size === 0) {
          this.byPublication.delete(pubId);
        }
      }
    }
    client.allowedIds.clear();
    this.decrementSubjectCount(client.subjectKey);
    if (completeSubject) {
      client.subject.complete();
    }
  }

  private decrementSubjectCount(subjectKey: string) {
    const current = this.subjectCounts.get(subjectKey) ?? 0;
    if (current <= 1) {
      this.subjectCounts.delete(subjectKey);
    } else {
      this.subjectCounts.set(subjectKey, current - 1);
    }
  }
}
