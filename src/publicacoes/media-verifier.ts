import { Injectable } from '@nestjs/common';
import { ApiException } from '../common/http/api.exception.js';

export const MEDIA_VERIFIER = Symbol('MEDIA_VERIFIER');
export const MAX_MEDIA_SIZE_BYTES = 25 * 1_000_000;

export type VerifiedMedia = {
  referencia: string;
  tipo: 'imagem' | 'video';
  url: string;
  chave_storage: string;
  mime_type: string;
  tamanho_bytes: number;
  largura: number | null;
  altura: number | null;
  duracao_segundos: number | null;
};

export interface MediaVerifier {
  resolveForPublication(
    authorId: string,
    references: readonly string[],
  ): Promise<VerifiedMedia[]>;
}

@Injectable()
export class UnavailableMediaVerifier implements MediaVerifier {
  async resolveForPublication(): Promise<VerifiedMedia[]> {
    throw new ApiException('MEDIA_VERIFICATION_UNAVAILABLE');
  }
}
