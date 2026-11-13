import { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { MediaStorageService } from './media-storage.service.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import { UploadMedia } from './schemas/upload-media.schema.js';

export class UnsatisfiableMediaRange extends Error {
  constructor(readonly size: number) {
    super('Invalid media range');
  }
}

export function parseMediaRange(header: string, size: number) {
  if (header.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]))
    throw new UnsatisfiableMediaRange(size);
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last)) ||
    (first === null && last === 0)
  )
    throw new UnsatisfiableMediaRange(size);
  const start = first ?? Math.max(0, size - last!);
  const end = first === null ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if (start >= size || end < start) throw new UnsatisfiableMediaRange(size);
  return { start, end };
}

@Injectable()
export class MediaAccessService {
  constructor(
    @InjectModel(UploadMedia.name) private readonly uploads: Model<UploadMedia>,
    @InjectModel(Publicacao.name)
    private readonly publications: Model<Publicacao>,
    @Inject(MediaStorageService) private readonly storage: MediaStorageService,
  ) {}

  async open(reference: string, viewerId?: string, rangeHeader?: string) {
    const media = await this.uploads
      .findOne({
        referencia: reference,
        estado: 'vinculada',
        publicacao_id: { $ne: null },
      })
      .exec();
    if (!media?.publicacao_id) throw new ApiException('MEDIA_NOT_FOUND');
    const access = viewerId
      ? [
          { visibilidade: 'publico' as const },
          { autor_id: new Types.ObjectId(viewerId) },
        ]
      : [{ visibilidade: 'publico' as const }];
    const publication = await this.publications
      .findOne({
        _id: media.publicacao_id,
        status: 'publicada',
        $or: access,
      })
      .exec();
    if (!publication) throw new ApiException('MEDIA_NOT_FOUND');
    const isVideo = media.tipo === 'video';
    const range =
      isVideo && rangeHeader
        ? parseMediaRange(rangeHeader, media.tamanho_bytes)
        : null;
    const object = await this.storage.get(
      media.chave_storage,
      range ?? undefined,
    );
    if (
      !object ||
      object.ContentLength !==
        (range ? range.end - range.start + 1 : media.tamanho_bytes) ||
      object.ContentType !== media.mime_type ||
      object.Metadata?.sha256 !== media.sha256 ||
      (range &&
        object.ContentRange !==
          `bytes ${range.start}-${range.end}/${media.tamanho_bytes}`) ||
      !(object.Body instanceof Readable)
    ) {
      if (object?.Body instanceof Readable) object.Body.destroy();
      throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    }
    return {
      body: object.Body,
      mimeType: media.mime_type,
      size: media.tamanho_bytes,
      length: range ? range.end - range.start + 1 : media.tamanho_bytes,
      range,
      isVideo,
    };
  }
}
