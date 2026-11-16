import type { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { MediaInspectionService } from './media-inspection.service.js';
import { MAX_MEDIA_SIZE_BYTES } from './media-verifier.js';
import {
  parseVideoProbeOutput,
  VideoProbeService,
} from './video-probe.service.js';

describe('MediaInspectionService', () => {
  const probe = vi.fn();
  const inspection = new MediaInspectionService({
    probe,
  } as unknown as VideoProbeService);

  beforeEach(() => probe.mockReset());

  it.each([
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ] as const)(
    'decodes a real %s image and its dimensions',
    async (mime, format) => {
      const buffer = await sharp({
        create: { width: 4, height: 3, channels: 3, background: '#234567' },
      })
        .toFormat(format)
        .toBuffer();
      await expect(inspection.inspect(buffer, mime)).resolves.toMatchObject({
        tipo: 'imagem',
        mime_type: mime,
        tamanho_bytes: buffer.length,
        largura: 4,
        altura: 3,
        duracao_segundos: null,
      });
    },
  );

  it.each([
    [
      'video/mp4',
      Buffer.concat([
        Buffer.alloc(4),
        Buffer.from('ftypisom'),
        Buffer.alloc(16),
      ]),
    ],
    [
      'video/mp4',
      Buffer.concat([
        Buffer.alloc(4),
        Buffer.from('ftypiso6'),
        Buffer.alloc(16),
      ]),
    ],
    [
      'video/webm',
      Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84]),
        Buffer.from('webm'),
      ]),
    ],
  ] as const)('accepts %s only after video probing', async (mime, buffer) => {
    probe.mockResolvedValueOnce({
      largura: 640,
      altura: 480,
      duracao_segundos: 30,
    });
    await expect(inspection.inspect(buffer, mime)).resolves.toMatchObject({
      tipo: 'video',
      mime_type: mime,
      duracao_segundos: 30,
    });
    expect(probe).toHaveBeenCalledWith(buffer, mime);
  });

  it('rejects client MIME mismatch, damaged files, oversize and excess duration', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    await expect(inspection.inspect(png, 'image/jpeg')).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      inspection.inspect(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg'),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      inspection.inspect(Buffer.alloc(MAX_MEDIA_SIZE_BYTES + 1), 'image/png'),
    ).rejects.toMatchObject({ status: 422 });
    probe.mockResolvedValueOnce({
      largura: 640,
      altura: 480,
      duracao_segundos: 121,
    });
    await expect(
      inspection.inspect(
        Buffer.concat([
          Buffer.alloc(4),
          Buffer.from('ftypisom'),
          Buffer.alloc(16),
        ]),
        'video/mp4',
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects Matroska or QuickTime headers even if the video codec would be allowed', async () => {
    const matroska = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x82, 0x88]),
      Buffer.from('matroska'),
    ]);
    const quicktime = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from('ftypqt  '),
      Buffer.alloc(16),
    ]);
    await expect(
      inspection.inspect(matroska, 'video/webm'),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      inspection.inspect(quicktime, 'video/mp4'),
    ).rejects.toMatchObject({ status: 422 });
    expect(probe).not.toHaveBeenCalled();
  });

  it('rejects a corrupt video when ffprobe cannot parse it', async () => {
    const mp4 = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from('ftypisom'),
      Buffer.alloc(16),
    ]);
    probe.mockRejectedValueOnce({ status: 422 });
    await expect(inspection.inspect(mp4, 'video/mp4')).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('VideoProbeService', () => {
  it('accepts actual probe metadata for H.264 MP4 and VP9 WebM', () => {
    const output = (
      codec_name: string,
      duration = '120',
      formatName?: string,
    ) =>
      JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name, width: 1280, height: 720 },
        ],
        format: {
          duration,
          format_name:
            formatName ??
            (codec_name === 'h264'
              ? 'mov,mp4,m4a,3gp,3g2,mj2'
              : 'matroska,webm'),
        },
      });
    expect(parseVideoProbeOutput(output('h264'), 'video/mp4')).toEqual({
      largura: 1280,
      altura: 720,
      duracao_segundos: 120,
    });
    expect(
      parseVideoProbeOutput(output('vp9'), 'video/webm').duracao_segundos,
    ).toBe(120);
    expect(() =>
      parseVideoProbeOutput(output('h264', '120.01'), 'video/mp4'),
    ).toThrow();
    expect(() => parseVideoProbeOutput(output('vp9'), 'video/mp4')).toThrow();
    expect(() =>
      parseVideoProbeOutput(output('h264', '30', 'avi'), 'video/mp4'),
    ).toThrow();
    expect(() =>
      parseVideoProbeOutput(output('vp9', '30', 'matroska'), 'video/webm'),
    ).toThrow();
    expect(() => parseVideoProbeOutput('invalid', 'video/webm')).toThrow();
  });

  it('fails closed when ffprobe is unavailable', async () => {
    const service = new VideoProbeService({
      get: () => 'missing-ierri-ffprobe-executable',
    } as unknown as ConfigService);
    await expect(
      service.probe(Buffer.from('invalid'), 'video/mp4'),
    ).rejects.toMatchObject({ status: 503 });
  });
});
