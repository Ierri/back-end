import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { MediaStorageService } from './media-storage.service.js';
import { MEDIA_RESERVATION_LEASE_MS } from './media-verifier.js';
import type { MediaVerifier, VerifiedMedia } from './media-verifier.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import { UploadMedia } from './schemas/upload-media.schema.js';

@Injectable()
export class MongoMediaVerifierService implements MediaVerifier {
  constructor(
    @InjectModel(UploadMedia.name) private readonly uploads: Model<UploadMedia>,
    @InjectModel(Publicacao.name)
    private readonly publications: Model<Publicacao>,
    @Inject(MediaStorageService) private readonly storage: MediaStorageService,
  ) {}

  async resolveForPublication(
    authorId: string,
    references: readonly string[],
    publicationId: string,
  ): Promise<VerifiedMedia[]> {
    if (
      references.length < 1 ||
      references.length > 10 ||
      new Set(references).size !== references.length
    ) {
      throw new ApiException('MEDIA_INVALID');
    }
    const owner = new Types.ObjectId(authorId);
    const publication = new Types.ObjectId(publicationId);
    const claimed: string[] = [];
    const verified: VerifiedMedia[] = [];
    try {
      for (const reference of references) {
        const record = await this.uploads
          .findOneAndUpdate(
            {
              referencia: reference,
              usuario_id: owner,
              estado: 'pronta',
              publicacao_id: null,
              expira_em: { $gt: new Date() },
            },
            {
              $set: {
                estado: 'reservada',
                publicacao_id: publication,
                reservada_em: new Date(),
              },
            },
            { new: true },
          )
          .exec();
        if (!record) throw new ApiException('MEDIA_INVALID');
        claimed.push(reference);
        const head = await this.storage.head(record.chave_storage);
        if (
          !head ||
          head.ContentLength !== record.tamanho_bytes ||
          head.ContentType !== record.mime_type ||
          head.Metadata?.sha256 !== record.sha256
        ) {
          throw new ApiException('MEDIA_INVALID');
        }
        verified.push({
          referencia: reference,
          tipo: record.tipo,
          url: this.storage.publicUrl(reference),
          chave_storage: record.chave_storage,
          mime_type: record.mime_type,
          tamanho_bytes: record.tamanho_bytes,
          largura: record.largura,
          altura: record.altura,
          duracao_segundos: record.duracao_segundos,
        });
      }
      return verified;
    } catch (error) {
      await this.releaseForPublication(publicationId, claimed).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async confirmForPublication(
    publicationId: string,
    references: readonly string[],
  ) {
    const publication = new Types.ObjectId(publicationId);
    for (const reference of references) {
      const confirmed = await this.uploads
        .findOneAndUpdate(
          {
            referencia: reference,
            publicacao_id: publication,
            estado: 'reservada',
            reservada_em: {
              $gt: new Date(Date.now() - MEDIA_RESERVATION_LEASE_MS),
            },
          },
          { $set: { estado: 'vinculada' } },
          { new: true },
        )
        .exec();
      if (!confirmed) throw new ApiException('MEDIA_INVALID');
    }
  }

  async releaseForPublication(
    publicationId: string,
    references: readonly string[],
  ) {
    if (!references.length) return;
    const publication = new Types.ObjectId(publicationId);
    if (await this.publications.exists({ _id: publication }).exec()) return;
    await this.uploads
      .updateMany(
        {
          referencia: { $in: [...references] },
          publicacao_id: publication,
          estado: { $in: ['reservada', 'vinculada'] },
        },
        {
          $set: { estado: 'pronta', publicacao_id: null, reservada_em: null },
        },
      )
      .exec();
  }

  async finalizeForPublication(
    publicationId: string,
    references: readonly string[],
  ) {
    await this.uploads
      .updateMany(
        {
          referencia: { $in: [...references] },
          publicacao_id: new Types.ObjectId(publicationId),
          estado: 'vinculada',
        },
        { $set: { expira_em: null } },
      )
      .exec();
  }
}
