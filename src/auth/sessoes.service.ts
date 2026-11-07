import { createHash } from 'node:crypto';
import { InjectModel } from '@nestjs/mongoose';
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Sessao } from './schemas/sessao.schema.js';

@Injectable()
export class SessoesService {
  constructor(
    @InjectModel(Sessao.name) private readonly sessoes: Model<Sessao>,
  ) {}

  async create(id: string, usuarioId: string, expiraEm: Date) {
    await this.sessoes.create({
      id_hash: this.hash(id),
      usuario_id: new Types.ObjectId(usuarioId),
      expira_em: expiraEm,
    });
  }

  async assertActive(id: string, usuarioId: string) {
    const sessao = await this.sessoes
      .findOne({
        id_hash: this.hash(id),
        usuario_id: new Types.ObjectId(usuarioId),
        revogada_em: null,
        expira_em: { $gt: new Date() },
      })
      .exec();
    if (!sessao) throw new ApiException('INVALID_TOKEN');
  }

  async revoke(id: string, usuarioId: string) {
    const now = new Date();
    const filter = {
      id_hash: this.hash(id),
      usuario_id: new Types.ObjectId(usuarioId),
    };
    const sessao = await this.sessoes
      .findOneAndUpdate(
        {
          ...filter,
          revogada_em: null,
          expira_em: { $gt: now },
        },
        { $set: { revogada_em: now } },
        { new: true },
      )
      .exec();
    if (sessao) return 'revoked';
    const existing = await this.sessoes.findOne(filter).exec();
    if (!existing) return 'missing';
    if (existing.revogada_em) return 'already_revoked';
    if (existing.expira_em <= now) return 'expired';
    throw new ApiException('INVALID_TOKEN');
  }

  private hash(id: string) {
    return createHash('sha256').update(id).digest('hex');
  }
}
