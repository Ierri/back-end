import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { MediaInspectionService } from './media-inspection.service.js';
import { MediaStorageService } from './media-storage.service.js';
import { UploadMedia } from './schemas/upload-media.schema.js';

export type UploadedMediaFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
};

@Injectable()
export class MediaUploadService {
  constructor(
    @InjectModel(UploadMedia.name) private readonly uploads: Model<UploadMedia>,
    @Inject(MediaInspectionService)
    private readonly inspection: MediaInspectionService,
    @Inject(MediaStorageService) private readonly storage: MediaStorageService,
  ) {}

  async upload(authorId: string, file?: UploadedMediaFile) {
    if (!file?.buffer || file.buffer.length !== file.size) {
      throw new ApiException('MEDIA_INVALID');
    }
    const inspected = await this.inspection.inspect(file.buffer, file.mimetype);
    const reference = randomBytes(24).toString('base64url');
    const key = `uploads/${authorId}/${randomUUID()}`;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    this.storage.publicUrl(reference);
    const expiration = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const record = await this.uploads.create({
      referencia: reference,
      usuario_id: new Types.ObjectId(authorId),
      chave_storage: key,
      ...inspected,
      sha256,
      estado: 'recebendo',
      publicacao_id: null,
      expira_em: expiration,
    });
    try {
      await this.storage.put(key, file.buffer, inspected.mime_type, sha256);
      const head = await this.storage.head(key);
      if (
        !head ||
        head.ContentLength !== file.buffer.length ||
        head.ContentType !== inspected.mime_type ||
        head.Metadata?.sha256 !== sha256
      ) {
        throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
      }
      const ready = await this.uploads
        .findOneAndUpdate(
          { _id: record._id, estado: 'recebendo' },
          { $set: { estado: 'pronta' } },
          { new: true },
        )
        .exec();
      if (!ready) throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
      return {
        referencia: reference,
        tipo: inspected.tipo,
        mimeType: inspected.mime_type,
        tamanhoBytes: inspected.tamanho_bytes,
        largura: inspected.largura,
        altura: inspected.altura,
        duracaoSegundos: inspected.duracao_segundos,
        expiraEm: expiration,
      };
    } catch (error) {
      const deleting = await this.uploads
        .findOneAndUpdate(
          { _id: record._id, estado: 'recebendo' },
          { $set: { estado: 'excluindo' } },
          { new: true },
        )
        .exec()
        .catch(() => null);
      if (deleting) {
        try {
          await this.storage.remove(key);
          await this.uploads
            .deleteOne({ _id: record._id, estado: 'excluindo' })
            .exec();
        } catch {}
      }
      throw error;
    }
  }
}
