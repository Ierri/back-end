import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Tecnologia } from '../usuarios/schemas/tecnologia.schema.js';
import { listTecnologiasSchema } from './dto/list-tecnologias.dto.js';
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
  const technologies = { find: vi.fn().mockReturnValue(query) };
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
