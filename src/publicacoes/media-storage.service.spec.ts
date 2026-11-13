import type { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { MediaStorageService } from './media-storage.service.js';

const values: Record<string, string> = {
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'local-user',
  S3_SECRET_ACCESS_KEY: 'local-secret',
  S3_BUCKET: 'ierri-midias',
  S3_FORCE_PATH_STYLE: 'true',
  MEDIA_PUBLIC_BASE_URL: 'http://localhost:3001',
};

function service(config = values) {
  return new MediaStorageService({
    get: (key: string) => config[key],
  } as unknown as ConfigService);
}

describe('MediaStorageService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reuses one S3 client for put, head, get and delete, then closes it', async () => {
    const commands: unknown[] = [];
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command) => {
      commands.push(command);
      if (command instanceof HeadObjectCommand)
        return { ContentLength: 3 } as never;
      if (command instanceof GetObjectCommand)
        return { ContentLength: 3 } as never;
      return {} as never;
    });
    const destroy = vi.spyOn(S3Client.prototype, 'destroy');
    const storage = service();
    await storage.put('uploads/key', Buffer.from('abc'), 'image/png', 'hash');
    const client = (storage as unknown as { client: S3Client }).client;
    await storage.head('uploads/key');
    await storage.get('uploads/key', { start: 1, end: 2 });
    await storage.remove('uploads/key');
    expect((storage as unknown as { client: S3Client }).client).toBe(client);
    expect(commands.map((command) => command?.constructor)).toEqual([
      PutObjectCommand,
      HeadObjectCommand,
      GetObjectCommand,
      DeleteObjectCommand,
    ]);
    expect((commands[0] as PutObjectCommand).input).toMatchObject({
      Bucket: 'ierri-midias',
      Key: 'uploads/key',
      ContentLength: 3,
    });
    expect((commands[2] as GetObjectCommand).input.Range).toBe('bytes=1-2');
    expect(storage.publicUrl('opaque-reference')).toBe(
      'http://localhost:3001/publicacoes/midias/opaque-reference',
    );
    storage.onModuleDestroy();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('fails closed on missing configuration and S3 failures', async () => {
    await expect(service({}).head('uploads/key')).rejects.toMatchObject({
      status: 503,
    });
    expect(() =>
      service({
        ...values,
        MEDIA_PUBLIC_BASE_URL: 'http://user:password@example.test',
      }).publicUrl('reference'),
    ).toThrow();
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValueOnce(
      new Error('connection refused'),
    );
    const storage = service();
    await expect(storage.head('uploads/key')).rejects.toMatchObject({
      status: 503,
    });
    storage.onModuleDestroy();
  });

  it('distinguishes missing objects from S3 unavailability', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValueOnce({
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const storage = service();
    await expect(storage.head('uploads/missing')).resolves.toBeNull();
    storage.onModuleDestroy();
  });
});
