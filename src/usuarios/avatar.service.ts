import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import sharp from 'sharp';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { MediaInspectionService } from '../publicacoes/media-inspection.service.js';
import { MediaStorageService } from '../publicacoes/media-storage.service.js';
import { PublicacoesCacheService } from '../publicacoes/publicacoes-cache.service.js';
import { AvatarArquivo } from './schemas/avatar-arquivo.schema.js';
import { Usuario } from './schemas/usuario.schema.js';
import type { AvatarAtual, UsuarioDocument } from './schemas/usuario.schema.js';

export const MAX_AVATAR_SIZE_BYTES = 5_000_000;
const STAGING_MS = 30 * 60 * 1000;

export type UploadedAvatarFile = { buffer: Buffer; mimetype: string; size: number };

@Injectable()
export class AvatarService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AvatarService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private pendingAfter: Types.ObjectId | null = null;
  private activeAfter: Types.ObjectId | null = null;

  constructor(
    @InjectModel(Usuario.name) private readonly users: Model<Usuario>,
    @InjectModel(AvatarArquivo.name) private readonly files: Model<AvatarArquivo>,
    @Inject(MediaInspectionService) private readonly inspection: MediaInspectionService,
    @Inject(MediaStorageService) private readonly storage: MediaStorageService,
    @Inject(PublicacoesCacheService) private readonly cache: PublicacoesCacheService,
  ) {}

  onModuleInit() {
    void this.recoverBatch().catch(() => this.logger.warn('Falha na recuperação de avatares.'));
    this.timer = setInterval(() => {
      void this.recoverBatch().catch(() => this.logger.warn('Falha na recuperação de avatares.'));
    }, 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async upload(userId: string, file?: UploadedAvatarFile) {
    if (!file?.buffer || file.size !== file.buffer.length ||
      file.size < 1 || file.size > MAX_AVATAR_SIZE_BYTES ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
      throw new ApiException('AVATAR_INVALID');
    let inspected;
    try {
      inspected = await this.inspection.inspect(file.buffer, file.mimetype);
      const metadata = await sharp(file.buffer, { animated: true, failOn: 'error',
        limitInputPixels: 50_000_000 }).metadata();
      if (inspected.tipo !== 'imagem' || !inspected.largura || !inspected.altura ||
        inspected.largura < 128 || inspected.altura < 128 ||
        inspected.largura > 4096 || inspected.altura > 4096 ||
        (metadata.pages ?? 1) !== 1)
        throw new Error('invalid image');
    } catch {
      throw new ApiException('AVATAR_INVALID');
    }
    const reference = randomBytes(24).toString('base64url');
    const key = `avatars/${userId}/${randomUUID()}`;
    const url = this.storage.avatarUrl(userId, reference);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const record = await this.files.create({ usuario_id: new Types.ObjectId(userId),
      referencia: reference, chave_storage: key, estado: 'preparando' });
    let committed = false;
    try {
      await this.storage.put(key, file.buffer, inspected.mime_type, sha256);
      const head = await this.storage.head(key);
      if (!head || head.ContentLength !== file.size || head.ContentType !== inspected.mime_type ||
        head.Metadata?.sha256 !== sha256) throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
      const current = await this.users.findOne({ _id: new Types.ObjectId(userId), status: 'ativo' })
        .select('avatar_atual avatar_revisao').exec();
      if (!current) throw new ApiException('USER_NOT_FOUND');
      const old = current.avatar_atual;
      const updated = await this.users.findOneAndUpdate({ _id: current._id, status: 'ativo',
        avatar_revisao: this.revisionFilter(current.avatar_revisao) },
      { $set: { avatar_url: url, avatar_atual: { referencia: reference, chave_storage: key,
        mime_type: inspected.mime_type, tamanho_bytes: file.size,
        largura: inspected.largura, altura: inspected.altura, sha256 } },
      $inc: { avatar_revisao: 1 } }, { returnDocument: 'after', runValidators: true }).exec();
      if (!updated) throw new ApiException('AVATAR_CONFLICT');
      committed = true;
      await this.files.updateOne({ _id: record._id, estado: 'preparando' },
        { $set: { estado: 'ativo' } }).exec().catch(() => undefined);
      await this.retire(old).catch(() => undefined);
      await this.cache.invalidateAuthor(userId).catch(() => undefined);
      return { avatarUrl: url, mimeType: inspected.mime_type, tamanhoBytes: file.size,
        largura: inspected.largura, altura: inspected.altura };
    } catch (error) {
      if (!committed) await this.clean(record).catch(() => undefined);
      throw error;
    }
  }

  async updateProfile(userId: string, changes: Record<string, string | null>, avatarUrl: string | null)
    : Promise<UsuarioDocument> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.users.findOne({ _id: new Types.ObjectId(userId), status: 'ativo' })
        .select('avatar_atual avatar_revisao').exec();
      if (!current) throw new ApiException('USER_NOT_FOUND');
      const updated = await this.users.findOneAndUpdate({ _id: current._id, status: 'ativo',
        avatar_revisao: this.revisionFilter(current.avatar_revisao) },
      { $set: { ...changes, avatar_url: avatarUrl, avatar_atual: null },
        $inc: { avatar_revisao: 1 } },
      { returnDocument: 'after', runValidators: true }).exec();
      if (!updated) continue;
      await this.retire(current.avatar_atual).catch(() => undefined);
      await this.cache.invalidateAuthor(userId).catch(() => undefined);
      return updated;
    }
    throw new ApiException('AVATAR_CONFLICT');
  }

  async remove(userId: string) {
    await this.updateProfile(userId, {}, null);
    return { avatarUrl: null };
  }

  async open(userId: string, reference: string) {
    const user = await this.users.findOne({ _id: new Types.ObjectId(userId), status: 'ativo',
      'avatar_atual.referencia': reference }).select('avatar_atual').lean().exec();
    const avatar = user?.avatar_atual;
    if (!avatar || avatar.referencia !== reference) throw new ApiException('AVATAR_NOT_FOUND');
    const object = await this.storage.get(avatar.chave_storage);
    if (!object || object.ContentLength !== avatar.tamanho_bytes ||
      object.ContentType !== avatar.mime_type || object.Metadata?.sha256 !== avatar.sha256 ||
      !(object.Body instanceof Readable)) {
      if (object?.Body instanceof Readable) object.Body.destroy();
      throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    }
    return { body: object.Body, mimeType: avatar.mime_type, size: avatar.tamanho_bytes };
  }

  private revisionFilter(value: number | undefined) {
    return value ? value : { $in: [0, null] };
  }

  private async retire(old: AvatarAtual | null | undefined) {
    if (!old) return;
    const record = await this.files.findOneAndUpdate({ referencia: old.referencia,
      estado: { $ne: 'excluindo' } }, { $set: { estado: 'excluindo' } },
    { returnDocument: 'after' }).exec();
    if (record) await this.clean(record);
  }

  private async clean(record: AvatarArquivo & { _id: Types.ObjectId }) {
    const current = await this.users.findById(record.usuario_id)
      .select('avatar_atual.referencia').lean().exec();
    if (current?.avatar_atual?.referencia === record.referencia) {
      if (record.estado !== 'ativo') await this.files.updateOne({ _id: record._id },
        { $set: { estado: 'ativo' } }).exec();
      return;
    }
    if (record.estado === 'preparando' && record.criado_em.getTime() > Date.now() - STAGING_MS)
      return;
    if (record.estado !== 'excluindo') await this.files.updateOne({ _id: record._id },
      { $set: { estado: 'excluindo' } }).exec();
    await this.storage.remove(record.chave_storage);
    await this.files.deleteOne({ _id: record._id, estado: 'excluindo' }).exec();
  }

  async recoverBatch() {
    if (this.running) return 0;
    this.running = true;
    try {
      const pending = await this.files.find({ estado: { $in: ['preparando', 'excluindo'] },
        ...(this.pendingAfter ? { _id: { $gt: this.pendingAfter } } : {}) })
        .sort({ _id: 1 }).limit(50).exec();
      for (const record of pending) await this.clean(record).catch(() => undefined);
      this.pendingAfter = pending.length === 50 ? pending[49]._id : null;
      const active = await this.files.find({ estado: 'ativo',
        ...(this.activeAfter ? { _id: { $gt: this.activeAfter } } : {}) })
        .sort({ _id: 1 }).limit(25).exec();
      for (const record of active) await this.clean(record).catch(() => undefined);
      this.activeAfter = active.length === 25 ? active[24]._id : null;
      return pending.length + active.length;
    } finally {
      this.running = false;
    }
  }
}
