import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { PerfilReadService } from './perfil-read.service.js';
import type { Tecnologia } from './schemas/tecnologia.schema.js';
import type { Usuario } from './schemas/usuario.schema.js';
import type { SeguidoresService } from './seguidores.service.js';

const ownerId = new Types.ObjectId();
const firstStackId = new Types.ObjectId();
const secondStackId = new Types.ObjectId();

function query(value: unknown) {
  const result = {
    exec: vi.fn().mockResolvedValue(value),
    select: vi.fn(),
    lean: vi.fn(),
  };
  result.select.mockReturnValue(result);
  result.lean.mockReturnValue(result);
  return result;
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    _id: ownerId,
    nome: 'Pessoa',
    username: 'pessoa',
    email: 'pessoa@example.test',
    senha_hash: 'segredo',
    papeis: ['administrador'],
    status: 'ativo',
    visibilidade_perfil: 'publico',
    biografia: 'Biografia',
    avatar_url: '/brand/avatar.png',
    stack_ids: [firstStackId, secondStackId],
    criado_em: new Date('2026-01-01T00:00:00Z'),
    atualizado_em: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

function setup(currentUser: unknown = user()) {
  const users = {
    findById: vi.fn().mockReturnValue(query(currentUser)),
    findOne: vi.fn().mockReturnValue(query(currentUser)),
  };
  const techQuery = query([
    { _id: secondStackId, nome: 'React', slug: 'react', categoria: 'Frontend', icone_url: null, ativo: false },
    { _id: firstStackId, nome: 'TypeScript', slug: 'typescript', categoria: 'Linguagem', icone_url: '/brand/typescript.svg', ativo: true },
  ]);
  const technologies = { find: vi.fn().mockReturnValue(techQuery) };
  const followers = {
    counts: vi.fn().mockResolvedValue({ seguidores: 0, seguindo: 0 }),
    relationship: vi.fn().mockResolvedValue({ enviada: 'nenhuma', recebida: 'nenhuma' }),
  };
  const service = new PerfilReadService(
    users as unknown as Model<Usuario>,
    technologies as unknown as Model<Tecnologia>,
    followers as unknown as SeguidoresService,
  );
  return { service, users, technologies, techQuery, followers };
}

describe('PerfilReadService', () => {
  it('returns a complete own profile with ordered stacks and no secrets or admin fields', async () => {
    const { service, technologies } = setup();
    const result = await service.findSelf(ownerId.toString());
    expect(result).toEqual({
      id: ownerId.toString(),
      nome: 'Pessoa',
      username: 'pessoa',
      email: 'pessoa@example.test',
      biografia: 'Biografia',
      avatarUrl: '/brand/avatar.png',
      visibilidadePerfil: 'publico',
      stackIds: [firstStackId.toString(), secondStackId.toString()],
      stacks: [
        { id: firstStackId.toString(), nome: 'TypeScript', slug: 'typescript', categoria: 'Linguagem', iconeUrl: '/brand/typescript.svg' },
        { id: secondStackId.toString(), nome: 'React', slug: 'react', categoria: 'Frontend', iconeUrl: null },
      ],
      contadores: { seguidores: 0, seguindo: 0 },
      criadoEm: new Date('2026-01-01T00:00:00Z'),
      atualizadoEm: new Date('2026-01-02T00:00:00Z'),
    });
    expect(technologies.find).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('senha_hash');
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('papeis');
  });

  it('keeps legacy users readable without social fields', async () => {
    const { service, technologies } = setup(user({ stack_ids: undefined, visibilidade_perfil: undefined, biografia: undefined, avatar_url: undefined, atualizado_em: undefined }));
    const result = await service.findSelf(ownerId.toString());
    expect(result).toMatchObject({ stackIds: [], stacks: [], biografia: null, avatarUrl: null, visibilidadePerfil: 'publico', atualizadoEm: null });
    expect(technologies.find).not.toHaveBeenCalled();
  });

  it('returns public profile details without email or administrative fields', async () => {
    const { service, users } = setup();
    const result = await service.findPublic(' Pessoa ');
    expect(users.findOne).toHaveBeenCalledWith({ username: 'pessoa' });
    expect(result).toMatchObject({ id: ownerId.toString(), biografia: 'Biografia', stacks: expect.any(Array) });
    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('senha_hash');
    expect(result).toHaveProperty('contadores', { seguidores: 0, seguindo: 0 });
    expect(result).not.toHaveProperty('stackIds');
  });

  it('limits a private profile for visitors and exposes it to its owner without email', async () => {
    const { service, technologies } = setup(user({ visibilidade_perfil: 'privado' }));
    const thirdParty = await service.findPublic('pessoa', new Types.ObjectId().toString());
    expect(thirdParty).toEqual({ id: ownerId.toString(), nome: 'Pessoa', username: 'pessoa', avatarUrl: '/brand/avatar.png', visibilidadePerfil: 'privado', relacao: { enviada: 'nenhuma', recebida: 'nenhuma' } });
    expect(technologies.find).not.toHaveBeenCalled();
    const owner = await service.findPublic('pessoa', ownerId.toString());
    expect(owner).toMatchObject({ biografia: 'Biografia', stacks: expect.any(Array) });
    expect(owner).not.toHaveProperty('email');
  });

  it.each(['bloqueado', 'excluido'])(
    'hides %s profiles from every public request',
    async (status) => {
      const { service, technologies } = setup(user({ status }));
      await expect(service.findPublic('pessoa')).rejects.toThrow(ApiException);
      await expect(service.findPublic('pessoa', ownerId.toString())).rejects.toThrow(ApiException);
      expect(technologies.find).not.toHaveBeenCalled();
    },
  );

  it('returns 404 for an unknown public or own profile', async () => {
    const { service } = setup(null);
    await expect(service.findPublic('inexistente')).rejects.toMatchObject({ status: 404 });
    await expect(service.findSelf(ownerId.toString())).rejects.toMatchObject({ status: 404 });
  });
});
