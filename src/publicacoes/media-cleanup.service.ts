import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { MediaStorageService } from './media-storage.service.js';
import { MEDIA_RESERVATION_LEASE_MS } from './media-verifier.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import { UploadMedia } from './schemas/upload-media.schema.js';

@Injectable()
export class MediaCleanupService {
  constructor(
    @InjectModel(UploadMedia.name) private readonly uploads: Model<UploadMedia>,
    @InjectModel(Publicacao.name)
    private readonly publications: Model<Publicacao>,
    @Inject(MediaStorageService) private readonly storage: MediaStorageService,
  ) {}

  async cleanupExpired(now = new Date(), limit = 100) {
    const staleProcessing = new Date(
      now.getTime() - MEDIA_RESERVATION_LEASE_MS,
    );
    const stale = await this.uploads
      .find({ expira_em: { $lt: now } })
      .sort({ expira_em: 1, _id: 1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .exec();
    let removed = 0;
    for (const record of stale) {
      if (
        record.estado === 'vinculada' &&
        record.publicacao_id &&
        (await this.publications
          .exists({
            _id: record.publicacao_id,
            status: { $ne: 'processando' },
          })
          .exec())
      ) {
        await this.uploads
          .updateOne(
            {
              _id: record._id,
              estado: 'vinculada',
              publicacao_id: record.publicacao_id,
              expira_em: record.expira_em,
            },
            { $set: { expira_em: null } },
          )
          .exec();
        continue;
      }
      const reserved =
        record.estado === 'reservada' || record.estado === 'vinculada';
      const reservedAt =
        record.reservada_em ?? record.atualizado_em ?? record.criado_em;
      if (reserved && (!reservedAt || reservedAt >= staleProcessing)) continue;
      if (
        record.publicacao_id &&
        (await this.publications.exists({ _id: record.publicacao_id }).exec())
      ) {
        const deleted = await this.publications
          .deleteOne({
            _id: record.publicacao_id,
            status: 'processando',
            criada_em: { $lt: staleProcessing },
          })
          .exec();
        if (deleted.deletedCount !== 1) continue;
      }
      const claimed = await this.uploads
        .findOneAndUpdate(
          {
            _id: record._id,
            estado: record.estado,
            publicacao_id: record.publicacao_id,
            expira_em: { $lt: now },
            ...(reserved ? { reservada_em: record.reservada_em ?? null } : {}),
          },
          { $set: { estado: 'excluindo' } },
          { new: true },
        )
        .exec();
      if (!claimed) continue;
      if (
        claimed.publicacao_id &&
        (await this.publications.exists({ _id: claimed.publicacao_id }).exec())
      ) {
        await this.uploads
          .updateOne(
            {
              _id: claimed._id,
              estado: 'excluindo',
              publicacao_id: claimed.publicacao_id,
            },
            { $set: { estado: record.estado } },
          )
          .exec();
        continue;
      }
      try {
        await this.storage.remove(claimed.chave_storage);
        await this.uploads
          .deleteOne({ _id: claimed._id, estado: 'excluindo' })
          .exec();
        removed++;
      } catch {}
    }
    return removed;
  }
}
