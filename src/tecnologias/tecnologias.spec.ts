import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Tecnologia } from '../usuarios/schemas/tecnologia.schema.js';
import { listTecnologiasSchema } from './dto/list-tecnologias.dto.js';
import { createAdminTecnologiaSchema, listAdminTecnologiasSchema,
  updateAdminTecnologiaSchema } from './dto/admin-tecnologias.dto.js';
import { TecnologiasService } from './tecnologias.service.js';

function setup(items: Array<Record<string, unknown>>) {
  const query = {
    select: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(items),
  };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  const technologies = { find: vi.fn().mockReturnValue(query), create: vi.fn(),
    findOneAndUpdate: vi.fn().mockReturnValue(query) };
  const service = new TecnologiasService(technologies as unknown as Model<Tecnologia>);
  return { service, technologies, query };
}

describe('catálogo público de tecnologias', () => {
  it('limits and normalizes queries while rejecting unknown fields', () => {
    expect(listTecnologiasSchema.parse({})).toEqual({ limite: 20 });
    expect(listTecnologiasSchema.parse({ busca: ' ReAcT ', limite: '50' })).toEqual({ busca: 'react', limite: 50 });
    expect(listTecnologiasSchema.safeParse({ limite: '51' }).success).toBe(false);
    expect(listTecnologiasSchema.safeParse({ busca: 'x', ativo: false }).success).toBe(false);
  });

  it('lists only active technologies with deterministic bounded pages', async () => {
    const first = { _id: new Types.ObjectId(), nome: 'Angular', slug: 'angular', categoria: 'Frontend', icone_url: null };
    const second = { _id: new Types.ObjectId(), nome: 'React', slug: 'react', categoria: 'Frontend', icone_url: '/brand/react.svg' };
    const third = { _id: new Types.ObjectId(), nome: 'Vue', slug: 'vue', categoria: 'Frontend', icone_url: null };
    const { service, technologies, query } = setup([first, second, third]);

    const page = await service.list({ limite: 2 });
    expect(page.items).toEqual([
      { id: first._id.toString(), nome: 'Angular', slug: 'angular', categoria: 'Frontend', iconeUrl: null },
      { id: second._id.toString(), nome: 'React', slug: 'react', categoria: 'Frontend', iconeUrl: '/brand/react.svg' },
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTypeOf('string');
    expect(technologies.find).toHaveBeenCalledWith({ $and: [{ ativo: true }] });
    expect(query.sort).toHaveBeenCalledWith({ nome: 1, _id: 1 });
    expect(query.limit).toHaveBeenCalledWith(3);

    const next = setup([third]);
    await expect(next.service.list({ limite: 2, cursor: page.nextCursor! })).resolves.toMatchObject({
      items: [{ id: third._id.toString() }], nextCursor: null, hasMore: false,
    });
    expect(next.technologies.find.mock.calls[0][0].$and).toHaveLength(2);
  });

  it('searches name or slug by escaped prefix and binds cursors to the search', async () => {
    const id = new Types.ObjectId();
    const { service, technologies } = setup([
      { _id: id, nome: 'C++', slug: 'cpp' },
      { _id: new Types.ObjectId(), nome: 'C Sharp', slug: 'c-sharp' },
    ]);
    const page = await service.list({ busca: 'c+', limite: 1 });
    expect(technologies.find.mock.calls[0][0].$and[1].$or).toEqual([
      { nome: { $regex: '^c\\+', $options: 'i' } },
      { slug: { $regex: '^c\\+' } },
    ]);
    await expect(service.list({ busca: 'other', limite: 1, cursor: page.nextCursor! })).rejects.toBeInstanceOf(ApiException);
    await expect(service.list({ limite: 1, cursor: 'invalidcursor' })).rejects.toBeInstanceOf(ApiException);
  });
});

describe('administração de tecnologias', () => {
  it('validates names, slugs, icons, status and nonempty edits', () => {
    expect(createAdminTecnologiaSchema.parse({ nome: ' TypeScript ', slug: 'TypeScript' }))
      .toMatchObject({ nome: 'TypeScript', slug: 'typescript' });
    expect(createAdminTecnologiaSchema.safeParse({ nome: 'A', slug: 'a',
      iconeUrl: 'https://cdn.example.test/a.svg' }).success).toBe(true);
    expect(updateAdminTecnologiaSchema.safeParse({ iconeUrl: '/brand/typescript.svg', ativo: false }).success).toBe(true);
    for (const invalid of [
      { nome: '', slug: 'tech' }, { nome: 'Tech', slug: 'bad_slug' },
      { nome: 'Tech', slug: 'tech', iconeUrl: 'http://example.test/icon.svg' },
      { nome: 'Tech', slug: 'tech', iconeUrl: '/brand/../secret.svg' },
      { nome: 'Tech', slug: 'tech', ativo: 'false' },
    ]) expect(createAdminTecnologiaSchema.safeParse(invalid).success).toBe(false);
    expect(updateAdminTecnologiaSchema.safeParse({}).success).toBe(false);
    expect(listAdminTecnologiasSchema.parse({})).toEqual({ status: 'todos', limite: 20 });
    expect(listAdminTecnologiasSchema.safeParse({ status: 'blocked' }).success).toBe(false);
  });

  it('lists active and inactive records with a filter-bound cursor', async () => {
    const first = { _id: new Types.ObjectId(), nome: 'Angular', slug: 'angular',
      categoria: null, icone_url: null, ativo: false };
    const second = { _id: new Types.ObjectId(), nome: 'React', slug: 'react',
      categoria: 'Frontend', icone_url: '/brand/react.svg', ativo: false };
    const { service, technologies, query } = setup([first, second]);
    const page = await service.adminList({ status: 'inativo', limite: 1 });
    expect(page.items).toEqual([{ id: first._id.toString(), nome: 'Angular', slug: 'angular',
      categoria: null, iconeUrl: null, ativo: false }]);
    expect(technologies.find).toHaveBeenCalledWith({ $and: [{ ativo: false }] });
    expect(query.limit).toHaveBeenCalledWith(2);
    await expect(service.adminList({ status: 'ativo', limite: 1, cursor: page.nextCursor! }))
      .rejects.toBeInstanceOf(ApiException);
    const next = setup([second]);
    await expect(next.service.adminList({ status: 'inativo', limite: 1, cursor: page.nextCursor! }))
      .resolves.toMatchObject({ items: [{ id: second._id.toString() }], hasMore: false });
  });

  it('creates technologies and maps duplicate slugs to conflict', async () => {
    const { service, technologies } = setup([]);
    const id = new Types.ObjectId();
    technologies.create.mockResolvedValue({ _id: id, nome: 'Rust', slug: 'rust',
      categoria: null, icone_url: null, ativo: true });
    await expect(service.create({ nome: 'Rust', slug: 'rust' }))
      .resolves.toEqual({ id: id.toString(), nome: 'Rust', slug: 'rust',
        categoria: null, iconeUrl: null, ativo: true });
    expect(technologies.create).toHaveBeenCalledWith({ nome: 'Rust', slug: 'rust',
      categoria: null, icone_url: null, ativo: true });
    technologies.create.mockRejectedValue({ code: 11000 });
    await expect(service.create({ nome: 'Rust', slug: 'rust' }))
      .rejects.toMatchObject({ response: { code: 'TECNOLOGIA_SLUG_EXISTS' } });
  });

  it('edits and deactivates without deleting, and reports missing or duplicate slugs', async () => {
    const { service, technologies, query } = setup([]);
    const id = new Types.ObjectId();
    query.exec.mockResolvedValueOnce({ _id: id, nome: 'Go', slug: 'go',
      categoria: null, icone_url: null, ativo: false });
    await expect(service.update(id.toString(), { ativo: false }))
      .resolves.toMatchObject({ id: id.toString(), ativo: false });
    expect(technologies.findOneAndUpdate).toHaveBeenCalledWith({ _id: id },
      { $set: { ativo: false } }, { returnDocument: 'after', runValidators: true });
    query.exec.mockResolvedValueOnce(null);
    await expect(service.update(id.toString(), { ativo: true }))
      .rejects.toMatchObject({ response: { code: 'TECNOLOGIA_NOT_FOUND' } });
    query.exec.mockRejectedValueOnce({ code: 11000 });
    await expect(service.update(id.toString(), { slug: 'taken' }))
      .rejects.toMatchObject({ response: { code: 'TECNOLOGIA_SLUG_EXISTS' } });
  });
});
