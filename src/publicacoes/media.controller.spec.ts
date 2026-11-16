import 'reflect-metadata';
import { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import {
  MediaAccessService,
  UnsatisfiableMediaRange,
} from './media-access.service.js';
import { MediaController } from './media.controller.js';
import { MediaUploadService } from './media-upload.service.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';
import { RequiredAuthGuard } from './required-auth.guard.js';

describe('MediaController multipart contract', () => {
  let app: INestApplication;
  const upload = vi
    .fn()
    .mockResolvedValue({ referencia: 'opaque-reference', tipo: 'imagem' });
  const open = vi.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MediaController],
      providers: [
        { provide: MediaUploadService, useValue: { upload } },
        { provide: MediaAccessService, useValue: { open } },
        {
          provide: JwtAuthGuard,
          useValue: {
            canActivate: (context: {
              switchToHttp: () => { getRequest: () => { authUserId: string } };
            }) => {
              context.switchToHttp().getRequest().authUserId =
                '507f1f77bcf86cd799439011';
              return true;
            },
          },
        },
        RequiredAuthGuard,
        OptionalAuthGuard,
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    upload.mockClear();
    open.mockReset();
  });

  it('accepts one file in the arquivo field and passes actual buffered bytes', async () => {
    await request(app.getHttpServer())
      .post('/publicacoes/midias')
      .attach('arquivo', Buffer.from('real-bytes'), {
        filename: 'name-controlled-by-client.png',
        contentType: 'image/png',
      })
      .expect(201);
    expect(upload).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      expect.objectContaining({
        buffer: Buffer.from('real-bytes'),
        mimetype: 'image/png',
        size: 10,
      }),
    );
  });

  it('rejects more than one part and does not call the upload service', async () => {
    await request(app.getHttpServer())
      .post('/publicacoes/midias')
      .attach('arquivo', Buffer.from('one'), 'one.png')
      .attach('arquivo', Buffer.from('two'), 'two.png')
      .expect(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it('streams a complete image with HTTP 200', async () => {
    open.mockResolvedValueOnce({
      body: Readable.from(Buffer.from('image-bytes')),
      mimeType: 'image/png',
      size: 11,
      length: 11,
      range: null,
      isVideo: false,
    });
    const response = await request(app.getHttpServer())
      .get('/publicacoes/midias/valid-reference-123')
      .expect(200);
    expect(response.body).toEqual(Buffer.from('image-bytes'));
    expect(response.headers['content-length']).toBe('11');
  });

  it('responds with HTTP 206 and exact byte range headers for video', async () => {
    open.mockResolvedValueOnce({
      body: Readable.from(Buffer.from('0123456789')),
      mimeType: 'video/mp4',
      size: 100,
      length: 10,
      range: { start: 10, end: 19 },
      isVideo: true,
    });
    const response = await request(app.getHttpServer())
      .get('/publicacoes/midias/valid-reference-123')
      .set('Range', 'bytes=10-19')
      .expect(206);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-range']).toBe('bytes 10-19/100');
    expect(response.headers['content-length']).toBe('10');
    expect(open).toHaveBeenCalledWith(
      'valid-reference-123',
      undefined,
      'bytes=10-19',
    );
  });

  it('responds with HTTP 416 and the complete size on an invalid range', async () => {
    open.mockRejectedValueOnce(new UnsatisfiableMediaRange(100));
    const response = await request(app.getHttpServer())
      .get('/publicacoes/midias/valid-reference-123')
      .set('Range', 'bytes=100-')
      .expect(416);
    expect(response.headers['content-range']).toBe('bytes */100');
    expect(response.headers['accept-ranges']).toBe('bytes');
  });
});
