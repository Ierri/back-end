import { Inject, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { ApiException } from '../common/http/api.exception.js';
import { MAX_MEDIA_SIZE_BYTES } from './media-verifier.js';
import { VideoProbeService } from './video-probe.service.js';

export type InspectedMedia = {
  tipo: 'imagem' | 'video';
  mime_type: string;
  tamanho_bytes: number;
  largura: number | null;
  altura: number | null;
  duracao_segundos: number | null;
};

@Injectable()
export class MediaInspectionService {
  constructor(
    @Inject(VideoProbeService) private readonly video: VideoProbeService,
  ) {}

  async inspect(buffer: Buffer, declaredMime: string): Promise<InspectedMedia> {
    if (buffer.length < 1 || buffer.length > MAX_MEDIA_SIZE_BYTES) {
      throw new ApiException('MEDIA_INVALID');
    }
    const mime = this.detectMime(buffer);
    if (!mime || mime !== declaredMime) throw new ApiException('MEDIA_INVALID');
    if (mime === 'video/mp4' || mime === 'video/webm') {
      const metadata = await this.video.probe(buffer, mime);
      if (
        !Number.isFinite(metadata.duracao_segundos) ||
        metadata.duracao_segundos <= 0 ||
        metadata.duracao_segundos > 120
      ) {
        throw new ApiException('MEDIA_INVALID');
      }
      return {
        tipo: 'video',
        mime_type: mime,
        tamanho_bytes: buffer.length,
        ...metadata,
      };
    }
    try {
      const image = sharp(buffer, {
        failOn: 'error',
        limitInputPixels: 50_000_000,
      });
      const metadata = await image.metadata();
      if (
        metadata.format !==
          (
            {
              'image/jpeg': 'jpeg',
              'image/png': 'png',
              'image/webp': 'webp',
            } as Record<string, string>
          )[mime] ||
        !metadata.width ||
        !metadata.height ||
        !Number.isSafeInteger(metadata.width) ||
        !Number.isSafeInteger(metadata.height)
      ) {
        throw new ApiException('MEDIA_INVALID');
      }
      await image.stats();
      return {
        tipo: 'imagem',
        mime_type: mime,
        tamanho_bytes: buffer.length,
        largura: metadata.width,
        altura: metadata.height,
        duracao_segundos: null,
      };
    } catch {
      throw new ApiException('MEDIA_INVALID');
    }
  }

  private detectMime(buffer: Buffer) {
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    )
      return 'image/jpeg';
    if (
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
      return 'image/png';
    if (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    )
      return 'image/webp';
    if (
      buffer.length >= 12 &&
      buffer.toString('ascii', 4, 8) === 'ftyp' &&
      [
        'isom',
        'iso2',
        'iso3',
        'iso4',
        'iso5',
        'iso6',
        'iso7',
        'iso8',
        'iso9',
        'mp41',
        'mp42',
        'avc1',
        'dash',
        'm4v ',
        'msnv',
        'mp4v',
        'cmfc',
        'cmfs',
      ].includes(buffer.toString('ascii', 8, 12).toLowerCase())
    )
      return 'video/mp4';
    if (
      buffer.length >= 4 &&
      buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      this.hasWebmDocType(buffer)
    )
      return 'video/webm';
    return null;
  }

  private hasWebmDocType(buffer: Buffer) {
    const headerSize = this.readEbmlVint(buffer, 4, true);
    if (!headerSize) return false;
    const end = 4 + headerSize.width + headerSize.value;
    if (end > buffer.length || end > 1024) return false;
    let position = 4 + headerSize.width;
    while (position < end) {
      const id = this.readEbmlVint(buffer, position, false);
      if (!id) return false;
      const size = this.readEbmlVint(buffer, position + id.width, true);
      if (!size) return false;
      const start = position + id.width + size.width;
      const next = start + size.value;
      if (next > end) return false;
      if (id.value === 0x4282) {
        return (
          size.value === 4 && buffer.toString('ascii', start, next) === 'webm'
        );
      }
      position = next;
    }
    return false;
  }

  private readEbmlVint(buffer: Buffer, offset: number, stripMarker: boolean) {
    const first = buffer[offset];
    if (first === undefined) return null;
    let width = 1;
    let marker = 0x80;
    while (width <= 8 && !(first & marker)) {
      width++;
      marker >>= 1;
    }
    if (width > 8 || offset + width > buffer.length) return null;
    let value = stripMarker ? first & (marker - 1) : first;
    for (let index = 1; index < width; index++)
      value = value * 256 + buffer[offset + index];
    return Number.isSafeInteger(value) ? { width, value } : null;
  }
}
