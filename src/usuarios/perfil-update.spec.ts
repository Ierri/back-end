import type { Model } from 'mongoose';
import { updatePerfilSchema } from './dto/perfil-update.dto.js';
import { PerfilUpdateService } from './perfil-update.service.js';
import type { UsuarioDocument } from './schemas/usuario.schema.js';
import { Usuario } from './schemas/usuario.schema.js';

function setup(value: UsuarioDocument | null = { nome: 'Pessoa' } as UsuarioDocument) {
  const exec = vi.fn().mockResolvedValue(value);
  const findOneAndUpdate = vi.fn().mockReturnValue({ exec });
  const service = new PerfilUpdateService({ findOneAndUpdate } as unknown as Model<Usuario>);
  return { service, findOneAndUpdate, exec };
}

describe('atualização do próprio perfil', () => {
  it('validates and normalizes allowed fields', () => {
    expect(updatePerfilSchema.parse({ nome: '  Pessoa  ', username: '  NOVO_NOME  ' })).toEqual({
      nome: 'Pessoa',
      username: 'novo_nome',
    });
    expect(updatePerfilSchema.parse({ biografia: null, avatarUrl: null })).toEqual({
      biografia: null,
      avatarUrl: null,
    });
    for (const avatarUrl of [
      '/brand/ierri/social/github-avatar-512.png',
      '/brand/ierri/social/avatar-light-1024.png',
      '/brand/ierri/social/avatar-dark-1024.png',
    ]) expect(updatePerfilSchema.parse({ avatarUrl }).avatarUrl).toBe(avatarUrl);
  });

  it('rejects empty payloads, administrative fields and unsafe avatars', () => {
    for (const payload of [
      {},
      { nome: ' ' },
      { nome: 'x'.repeat(101) },
      { username: 'ab' },
      { username: 'nome com espaço' },
      { biografia: 'x'.repeat(501) },
      { status: 'ativo' },
      { email: 'pessoa@example.test' },
      { senha_hash: 'hash' },
      { papeis: ['administrador'] },
      { contadores: { seguidores: 100 } },
      { avatarUrl: 'https://example.test/avatar.png' },
      { avatarUrl: '//example.test/avatar.png' },
      { avatarUrl: '/brand/ierri/../private.png' },
      { avatarUrl: '/brand/ierri/social/avatar.png?token=secret' },
      { avatarUrl: '/brand/ierri/social/unverified-avatar.png' },
      { avatarUrl: `/publicacoes/midias/${'a'.repeat(16)}` },
    ]) expect(updatePerfilSchema.safeParse(payload).success).toBe(false);
  });

  it('writes only whitelisted fields atomically for the authenticated user', async () => {
    const persisted = { nome: 'Pessoa', username: 'novo_nome' } as UsuarioDocument;
    const { service, findOneAndUpdate } = setup(persisted);
    const dto = updatePerfilSchema.parse({ nome: ' Pessoa ', username: 'NOVO_NOME', biografia: null, avatarUrl: null, visibilidadePerfil: 'privado' });
    await expect(service.update('user-id', dto)).resolves.toBe(persisted);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'user-id' },
      { $set: { nome: 'Pessoa', username: 'novo_nome', biografia: null, avatar_url: null, visibilidade_perfil: 'privado' } },
      { new: true, runValidators: true },
    );
    const update = findOneAndUpdate.mock.calls[0][1].$set;
    expect(update).not.toHaveProperty('criado_em');
    expect(update).not.toHaveProperty('email');
    expect(update).not.toHaveProperty('senha_hash');
  });

  it('returns not found when the authenticated account is absent', async () => {
    const { service } = setup(null);
    await expect(service.update('missing-id', { nome: 'Pessoa' })).rejects.toMatchObject({
      response: { code: 'USER_NOT_FOUND' },
    });
  });

  it('maps concurrent username collisions to HTTP 409', async () => {
    const { service, exec } = setup();
    exec.mockRejectedValueOnce({ code: 11000, keyPattern: { username: 1 } });
    await expect(service.update('user-id', { username: 'ocupado' })).rejects.toMatchObject({
      status: 409,
      response: { code: 'USERNAME_ALREADY_EXISTS' },
    });
  });
});
