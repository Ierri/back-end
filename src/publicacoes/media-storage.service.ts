import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  GetObjectCommandOutput,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { ApiException } from '../common/http/api.exception.js';

@Injectable()
export class MediaStorageService implements OnModuleDestroy {
  private client?: S3Client;
  private bucket?: string;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  publicUrl(reference: string) {
    const configured = this.config.get<string>('MEDIA_PUBLIC_BASE_URL')?.trim();
    if (!configured) throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    try {
      const url = new URL(configured);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (this.config.get<string>('NODE_ENV') === 'production' &&
          url.protocol !== 'https:')
      ) {
        throw new Error('Invalid public URL');
      }
      return `${url.toString().replace(/\/$/, '')}/publicacoes/midias/${reference}`;
    } catch {
      throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    }
  }

  async put(key: string, body: Buffer, mime: string, sha256: string) {
    const { client, bucket } = this.connection();
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: mime,
          ContentLength: body.length,
          Metadata: { sha256 },
        }),
        { abortSignal: AbortSignal.timeout(60_000) },
      );
    } catch {
      throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    }
  }

  async head(key: string): Promise<HeadObjectCommandOutput | null> {
    const { client, bucket } = this.connection();
    try {
      return await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(10_000) },
      );
    } catch (error) {
      if (this.isMissing(error)) return null;
      throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    }
  }

  async get(
    key: string,
    range?: { start: number; end: number },
  ): Promise<GetObjectCommandOutput | null> {
    const { client, bucket } = this.connection();
    try {
      return await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
        { abortSignal: AbortSignal.timeout(60_000) },
      );
    } catch (error) {
      if (this.isMissing(error)) return null;
      throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    }
  }

  async remove(key: string) {
    const { client, bucket } = this.connection();
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    }
  }

  onModuleDestroy() {
    this.client?.destroy();
  }

  private connection() {
    if (this.client && this.bucket)
      return { client: this.client, bucket: this.bucket };
    const endpoint = this.config.get<string>('S3_ENDPOINT')?.trim();
    const region = this.config.get<string>('S3_REGION')?.trim();
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY_ID')?.trim();
    const secretAccessKey = this.config
      .get<string>('S3_SECRET_ACCESS_KEY')
      ?.trim();
    const bucket = this.config.get<string>('S3_BUCKET')?.trim();
    const pathStyle = this.config.get<string>('S3_FORCE_PATH_STYLE')?.trim();
    if (
      !endpoint ||
      !region ||
      !accessKeyId ||
      !secretAccessKey ||
      !bucket ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      (pathStyle !== 'true' && pathStyle !== 'false')
    ) {
      throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    }
    try {
      const url = new URL(endpoint);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol === 'http:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(
            url.hostname.toLowerCase(),
          ))
      ) {
        throw new Error('Invalid endpoint');
      }
    } catch {
      throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    }
    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: pathStyle === 'true',
      maxAttempts: 2,
    });
    this.bucket = bucket;
    return { client: this.client, bucket };
  }

  private isMissing(error: unknown) {
    if (typeof error !== 'object' || error === null) return false;
    const status =
      '$metadata' in error &&
      typeof error.$metadata === 'object' &&
      error.$metadata !== null &&
      'httpStatusCode' in error.$metadata
        ? error.$metadata.httpStatusCode
        : null;
    const name = 'name' in error ? error.name : null;
    return status === 404 || name === 'NoSuchKey' || name === 'NotFound';
  }
}
