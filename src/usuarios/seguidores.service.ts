import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import type { ListSeguidoresDto } from './dto/seguidores.dto.js';
import { Seguidor } from './schemas/seguidor.schema.js';
import type { SeguidorDocument } from './schemas/seguidor.schema.js';
import { Usuario } from './schemas/usuario.schema.js';
import { SeguidoresCursor } from './seguidores.cursor.js';
import type { SeguidoresCursorScope } from './seguidores.cursor.js';
import { NotificationProducerService } from '../notificacoes/notification-producer.service.js';

type RelationState = 'nenhuma' | 'pendente' | 'aceita';
type CounterSnapshot = { seguidores: number; seguindo: number };

@Injectable()
export class SeguidoresService implements OnModuleInit, OnModuleDestroy {
  @Inject(NotificationProducerService) private notifications?: NotificationProducerService;
  private readonly logger = new Logger(SeguidoresService.name);
  private auditTimer?: ReturnType<typeof setInterval>;
  private auditTask?: Promise<number>;
  private auditAfter: Types.ObjectId | null = null;

  constructor(
    @InjectModel(Seguidor.name) private readonly seguidores: Model<Seguidor>,
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @Inject(SeguidoresCursor) private readonly cursor: SeguidoresCursor,
  ) {}

  onModuleInit() {
    this.auditTimer = setInterval(() => {
      void this.reconcileBatch().catch(() => this.logger.warn('Falha na reconciliação de seguidores.'));
    }, 30_000);
    this.auditTimer.unref();
  }

  async onModuleDestroy() {
    if (this.auditTimer) clearInterval(this.auditTimer);
    await this.auditTask?.catch(() => undefined);
  }

  async follow(actorId: string, targetId: string) {
    if (actorId === targetId) throw new ApiException('SEGUIDOR_SELF');
    const target = await this.activeUser(targetId);
    const pair = { seguidor_id: new Types.ObjectId(actorId), seguido_id: target._id };
    let relation = await this.seguidores.findOne(pair).exec();
    if (!relation) {
      const status = target.visibilidade_perfil === 'privado' ? 'pendente' : 'aceito';
      try {
        relation = await this.seguidores.create({
          ...pair,
          status,
          aceito_em: status === 'aceito' ? new Date() : null,
          notificacao_origem: status === 'aceito' ? 'publico' : 'solicitacao',
          notificacao_follow_pendente: true,
        });
      } catch {
        relation = await this.seguidores.findOne(pair).exec();
        if (!relation) throw new ApiException('SEGUIDOR_WRITE_UNAVAILABLE');
      }
    }
    const result = await this.mutationResult(actorId, targetId, this.state(relation.status), actorId);
    await this.notifications?.processRelation(relation._id.toString()).catch(() => undefined);
    return result;
  }

  async unfollow(actorId: string, targetId: string) {
    if (actorId === targetId) throw new ApiException('SEGUIDOR_SELF');
    const pair = { seguidor_id: new Types.ObjectId(actorId), seguido_id: new Types.ObjectId(targetId) };
    try {
      await this.seguidores.deleteOne(pair).exec();
    } catch {
      const remaining = await this.seguidores.exists(pair);
      if (remaining) throw new ApiException('SEGUIDOR_WRITE_UNAVAILABLE');
    }
    return this.mutationResult(actorId, targetId, 'nenhuma', actorId);
  }

  async accept(actorId: string, requestId: string) {
    const filter = { _id: new Types.ObjectId(requestId), seguido_id: new Types.ObjectId(actorId) };
    const pending = await this.seguidores.findOne({ ...filter, status: 'pendente' }).exec();
    if (pending) await this.activeUser(pending.seguidor_id.toString());
    let relation: SeguidorDocument | null = null;
    try {
      relation = await this.seguidores.findOneAndUpdate(
        { ...filter, status: 'pendente' },
        { $set: { status: 'aceito', aceito_em: new Date(), notificacao_aceite_pendente: true } },
        { returnDocument: 'after', runValidators: true },
      ).exec();
    } catch {
      relation = await this.seguidores.findOne(filter).exec();
      if (relation?.status !== 'aceito') throw new ApiException('SEGUIDOR_WRITE_UNAVAILABLE');
    }
    if (!relation) relation = await this.seguidores.findOne(filter).exec();
    if (relation?.status !== 'aceito') throw new ApiException('SEGUIDOR_REQUEST_NOT_FOUND');
    const result = await this.mutationResult(relation.seguidor_id.toString(), actorId, 'aceita', actorId);
    await this.notifications?.processRelation(relation._id.toString()).catch(() => undefined);
    return result;
  }

  async decline(actorId: string, requestId: string) {
    const filter = {
      _id: new Types.ObjectId(requestId),
      seguido_id: new Types.ObjectId(actorId),
      status: 'pendente' as const,
    };
    const pending = await this.seguidores.findOne(filter).exec();
    if (!pending) throw new ApiException('SEGUIDOR_REQUEST_NOT_FOUND');
    try {
      const removed = await this.seguidores.deleteOne(filter).exec();
      if (removed.deletedCount === 0) {
        const current = await this.seguidores.findById(requestId).select('status').lean().exec();
        if (current) throw new ApiException('SEGUIDOR_REQUEST_NOT_FOUND');
      }
    } catch (error) {
      if (error instanceof ApiException) throw error;
      const current = await this.seguidores.findById(requestId).select('status').lean().exec();
      if (current) throw new ApiException('SEGUIDOR_WRITE_UNAVAILABLE');
    }
    return { estado: 'nenhuma' as const };
  }

  async relationship(viewerId: string, targetId: string) {
    if (viewerId === targetId) return { enviada: 'nenhuma' as const, recebida: 'nenhuma' as const };
    const [outgoing, incoming] = await Promise.all([
      this.seguidores.findOne({ seguidor_id: new Types.ObjectId(viewerId), seguido_id: new Types.ObjectId(targetId) })
        .select('status').lean().exec(),
      this.seguidores.findOne({ seguidor_id: new Types.ObjectId(targetId), seguido_id: new Types.ObjectId(viewerId) })
        .select('status').lean().exec(),
    ]);
    return {
      enviada: this.state(outgoing?.status),
      recebida: this.state(incoming?.status),
    };
  }

  async counts(userId: string): Promise<CounterSnapshot> {
    try {
      return await this.repairProjection(userId);
    } catch {
      this.logger.warn('Projeção de seguidores pendente de reconciliação.');
      try {
        return await this.sourceCounts(userId);
      } catch {
        throw new ApiException('SEGUIDOR_WRITE_UNAVAILABLE');
      }
    }
  }

  async list(userId: string, viewerId: string | undefined, kind: 'seguidores' | 'seguindo', query: ListSeguidoresDto) {
    await this.visibleProfile(userId, viewerId);
    const scope: SeguidoresCursorScope = { kind, userId };
    const position = query.cursor ? this.cursor.decode(query.cursor, scope) : null;
    const dateField = 'atualizado_em';
    const filter = {
      [kind === 'seguidores' ? 'seguido_id' : 'seguidor_id']: new Types.ObjectId(userId),
      status: 'aceito' as const,
      ...(position ? {
        $or: [
          { [dateField]: { $lt: position.date } },
          { [dateField]: position.date, _id: { $lt: position.id } },
        ],
      } : {}),
    };
    const found = await this.seguidores.find(filter)
      .sort({ [dateField]: -1, _id: -1 }).limit(query.limite + 1).exec();
    const page = found.slice(0, query.limite);
    const otherIds = page.map((relation) => kind === 'seguidores' ? relation.seguidor_id : relation.seguido_id);
    const users = await this.usuarios.find({ _id: { $in: otherIds }, status: 'ativo' })
      .select('nome username avatar_url visibilidade_perfil').lean().exec();
    const byId = new Map(users.map((user) => [user._id.toString(), user]));
    const items = page.flatMap((relation) => {
      const otherId = kind === 'seguidores' ? relation.seguidor_id : relation.seguido_id;
      const user = byId.get(otherId.toString());
      return user ? [this.publicUser(user)] : [];
    });
    const last = page.at(-1);
    await this.visibleProfile(userId, viewerId);
    return {
      items,
      nextCursor: found.length > query.limite && last
        ? this.cursor.encode({ date: last.atualizado_em, id: last._id }, scope)
        : null,
      hasMore: found.length > query.limite,
    };
  }

  async requests(actorId: string, query: ListSeguidoresDto) {
    const scope: SeguidoresCursorScope = { kind: 'solicitacoes', userId: actorId };
    const position = query.cursor ? this.cursor.decode(query.cursor, scope) : null;
    const filter = {
      seguido_id: new Types.ObjectId(actorId),
      status: 'pendente' as const,
      ...(position ? {
        $or: [
          { solicitado_em: { $lt: position.date } },
          { solicitado_em: position.date, _id: { $lt: position.id } },
        ],
      } : {}),
    };
    const found = await this.seguidores.find(filter)
      .sort({ solicitado_em: -1, _id: -1 }).limit(query.limite + 1).exec();
    const page = found.slice(0, query.limite);
    const users = await this.usuarios.find({
      _id: { $in: page.map((relation) => relation.seguidor_id) }, status: 'ativo',
    }).select('nome username avatar_url visibilidade_perfil').lean().exec();
    const byId = new Map(users.map((user) => [user._id.toString(), user]));
    const items = page.flatMap((relation) => {
      const user = byId.get(relation.seguidor_id.toString());
      return user ? [{ id: relation._id.toString(), usuario: this.publicUser(user), solicitadoEm: relation.solicitado_em }] : [];
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor: found.length > query.limite && last
        ? this.cursor.encode({ date: last.solicitado_em, id: last._id }, scope)
        : null,
      hasMore: found.length > query.limite,
    };
  }

  reconcileBatch() {
    if (this.auditTask) return this.auditTask;
    this.auditTask = this.runAuditBatch().finally(() => { this.auditTask = undefined; });
    return this.auditTask;
  }

  private async runAuditBatch() {
    const filter = this.auditAfter ? { _id: { $gt: this.auditAfter } } : {};
    const users = await this.usuarios.find(filter).select('_id').sort({ _id: 1 }).limit(50).lean().exec();
    let processed = 0;
    let failures = 0;
    for (const user of users) {
      const id = user._id.toString();
      try {
        await this.repairProjection(id);
        processed++;
      } catch {
        failures++;
      }
      this.auditAfter = user._id;
    }
    if (failures > 0) this.logger.warn(`Falha ao reconciliar ${failures} usuário(s); a auditoria continuará.`);
    if (users.length < 50) this.auditAfter = null;
    return processed;
  }

  private async mutationResult(senderId: string, targetId: string, estado: RelationState, viewerId: string) {
    const [sender, target] = await Promise.all([this.counts(senderId), this.counts(targetId)]);
    if (viewerId === targetId)
      return { estado, contadores: { seguidores: target.seguidores, seguindo: target.seguindo } };
    const publicTarget = await this.usuarios.exists({
      _id: targetId,
      status: 'ativo',
      visibilidade_perfil: { $ne: 'privado' },
    });
    return {
      estado,
      contadores: {
        ...(publicTarget ? { seguidores: target.seguidores } : {}),
        seguindo: sender.seguindo,
      },
    };
  }

  private state(status?: Seguidor['status']): RelationState {
    return status === 'pendente' ? 'pendente' : status === 'aceito' ? 'aceita' : 'nenhuma';
  }

  private async activeUser(userId: string) {
    const user = await this.usuarios.findOne({ _id: userId, status: 'ativo' })
      .select('_id visibilidade_perfil').exec();
    if (!user) throw new ApiException('USER_NOT_FOUND');
    return user;
  }

  private async visibleProfile(userId: string, viewerId?: string) {
    const user = await this.activeUser(userId);
    if (user.visibilidade_perfil === 'privado' && viewerId !== userId)
      throw new ApiException('USER_NOT_FOUND');
  }

  private publicUser(user: Pick<Usuario, 'nome' | 'username' | 'avatar_url' | 'visibilidade_perfil'> & { _id: Types.ObjectId }) {
    return {
      id: user._id.toString(),
      nome: user.nome,
      username: user.username,
      avatarUrl: user.avatar_url ?? null,
      visibilidadePerfil: user.visibilidade_perfil ?? 'publico',
    };
  }

  private async sourceCounts(userId: string): Promise<CounterSnapshot> {
    const objectId = new Types.ObjectId(userId);
    const [seguidores, seguindo] = await Promise.all([
      this.seguidores.countDocuments({ seguido_id: objectId, status: 'aceito' }).exec(),
      this.seguidores.countDocuments({ seguidor_id: objectId, status: 'aceito' }).exec(),
    ]);
    return { seguidores, seguindo };
  }

  private async repairProjection(userId: string): Promise<CounterSnapshot> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const user = await this.usuarios.findById(userId)
        .select('contadores.seguidores contadores.seguindo').lean().exec();
      const counts = await this.sourceCounts(userId);
      if (!user) return counts;
      const current = user.contadores;
      if (current?.seguidores === counts.seguidores && current?.seguindo === counts.seguindo) return counts;
      const result = await this.usuarios.updateOne({
        _id: userId,
        'contadores.seguidores': current?.seguidores ?? { $exists: false },
        'contadores.seguindo': current?.seguindo ?? { $exists: false },
      }, { $set: {
        'contadores.seguidores': counts.seguidores,
        'contadores.seguindo': counts.seguindo,
      } }, { runValidators: true, timestamps: false }).exec();
      if (result.modifiedCount === 1) {
        const currentCounts = await this.sourceCounts(userId);
        if (currentCounts.seguidores === counts.seguidores && currentCounts.seguindo === counts.seguindo)
          return counts;
      }
    }
    throw new ApiException('SEGUIDOR_WRITE_UNAVAILABLE');
  }
}
