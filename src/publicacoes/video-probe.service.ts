import { execFile } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/http/api.exception.js';

const execFileAsync = promisify(execFile);

export function parseVideoProbeOutput(
  stdout: string,
  mime: 'video/mp4' | 'video/webm',
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ApiException('MEDIA_INVALID');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('streams' in parsed) ||
    !Array.isArray(parsed.streams)
  ) {
    throw new ApiException('MEDIA_INVALID');
  }
  const stream = parsed.streams.find(
    (item: unknown) =>
      typeof item === 'object' &&
      item !== null &&
      'codec_type' in item &&
      item.codec_type === 'video',
  ) as Record<string, unknown> | undefined;
  if (!stream) throw new ApiException('MEDIA_INVALID');
  const codecs = mime === 'video/mp4' ? ['h264'] : ['vp8', 'vp9', 'av1'];
  if (!codecs.includes(String(stream.codec_name)))
    throw new ApiException('MEDIA_INVALID');
  const format =
    'format' in parsed &&
    typeof parsed.format === 'object' &&
    parsed.format !== null
      ? (parsed.format as Record<string, unknown>)
      : {};
  const formatNames =
    typeof format.format_name === 'string' ? format.format_name.split(',') : [];
  if (!formatNames.includes(mime === 'video/mp4' ? 'mp4' : 'webm'))
    throw new ApiException('MEDIA_INVALID');
  const duration = Number(stream.duration ?? format.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120)
    throw new ApiException('MEDIA_INVALID');
  const width = Number(stream.width);
  const height = Number(stream.height);
  return {
    largura: Number.isSafeInteger(width) && width > 0 ? width : null,
    altura: Number.isSafeInteger(height) && height > 0 ? height : null,
    duracao_segundos: duration,
  };
}

@Injectable()
export class VideoProbeService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async probe(buffer: Buffer, mime: 'video/mp4' | 'video/webm') {
    const directory = await mkdtemp(join(tmpdir(), 'ierri-video-')).catch(
      () => {
        throw new ApiException('MEDIA_PROCESSING_UNAVAILABLE');
      },
    );
    const file = join(directory, 'media');
    try {
      await writeFile(file, buffer, { flag: 'wx' }).catch(() => {
        throw new ApiException('MEDIA_PROCESSING_UNAVAILABLE');
      });
      let stdout: string;
      try {
        const result = await execFileAsync(
          this.config.get<string>('FFPROBE_PATH')?.trim() || 'ffprobe',
          ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
          { timeout: 15_000, maxBuffer: 1_000_000, windowsHide: true },
        );
        stdout = result.stdout;
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : null;
        if (
          [
            'ENOENT',
            'ETIMEDOUT',
            'EACCES',
            'ENOMEM',
            'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          ].includes(String(code))
        ) {
          throw new ApiException('MEDIA_PROCESSING_UNAVAILABLE');
        }
        throw new ApiException('MEDIA_INVALID');
      }
      return parseVideoProbeOutput(stdout, mime);
    } finally {
      await unlink(file).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
    }
  }
}
