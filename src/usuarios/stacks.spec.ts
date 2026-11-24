import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { replaceStacksSchema } from './dto/stacks.dto.js';
import { Tecnologia } from './schemas/tecnologia.schema.js';
import { Usuario } from './schemas/usuario.schema.js';
import { UsuariosStacksService } from './stacks.service.js';

function setup() {
  const technologies = {
    find: vi.fn(),
  };
  const users = {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  };
  const technologyQuery = {
    select: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue([]),
  };
  technologyQuery.select.mockReturnValue(technologyQuery);
  technologyQuery.limit.mockReturnValue(technologyQuery);
  technologyQuery.lean.mockReturnValue(technologyQuery);
  technologies.find.mockReturnValue(technologyQuery);
  const userQuery = {
    select: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue({ stack_ids: [] }),
  };
  userQuery.select.mockReturnValue(userQuery);
  userQuery.lean.mockReturnValue(userQuery);
  users.findOne.mockReturnValue(userQuery);
  users.findOneAndUpdate.mockReturnValue(userQuery);
  const service = new UsuariosStacksService(
    users as unknown as Model<Usuario>,
    technologies as unknown as Model<Tecnologia>,
  );
  return { service, users, technologies, technologyQuery, userQuery };
}

describe('seleção de stacks do usuário', () => {
  it('accepts 0 to 20 unique ObjectIds and rejects extras or invalid input', () => {
    const ids = Array.from({ length: 20 }, () => new Types.ObjectId().toString());
    expect(replaceStacksSchema.safeParse({ stackIds: [] }).success).toBe(true);
    expect(replaceStacksSchema.safeParse({ stackIds: ids }).success).toBe(true);
    for (const invalid of [
      { stackIds: [...ids, new Types.ObjectId().toString()] },
      { stackIds: [ids[0], ids[0].toUpperCase()] },
      { stackIds: ['invalid'] },
      { stackIds: [], userId: new Types.ObjectId().toString() },
    ]) expect(replaceStacksSchema.safeParse(invalid).success).toBe(false);
  });

  it('validates all active technologies before one atomic replacement and returns stored IDs', async () => {
    const { service, users, technologies, technologyQuery, userQuery } = setup();
    const userId = new Types.ObjectId().toString();
    const ids = [new Types.ObjectId(), new Types.ObjectId()];
    technologyQuery.exec.mockResolvedValue(ids.map((_id) => ({ _id })));
    userQuery.exec.mockResolvedValueOnce({ stack_ids: [] }).mockResolvedValueOnce({ stack_ids: ids });

    await expect(service.replace(userId, ids.map((id) => id.toString()))).resolves.toEqual(ids.map((id) => id.toString()));
    expect(technologies.find).toHaveBeenCalledWith({ _id: { $in: ids }, ativo: true });
    expect(technologyQuery.limit).toHaveBeenCalledWith(2);
    expect(users.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: new Types.ObjectId(userId), status: 'ativo' },
      { $set: { stack_ids: ids } },
      { returnDocument: 'after', runValidators: true },
    );
  });

  it('rejects missing or inactive technologies before writing', async () => {
    const { service, users } = setup();
    const id = new Types.ObjectId().toString();
    await expect(service.replace(new Types.ObjectId().toString(), [id])).rejects.toBeInstanceOf(ApiException);
    expect(users.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('keeps historical inactive technologies while allowing their removal', async () => {
    const { service, technologies, technologyQuery, userQuery } = setup();
    const inactive = new Types.ObjectId();
    const active = new Types.ObjectId();
    userQuery.exec.mockResolvedValueOnce({ stack_ids: [inactive] })
      .mockResolvedValueOnce({ stack_ids: [inactive, active] });
    technologyQuery.exec.mockResolvedValue([{ _id: active }]);
    await expect(service.replace(new Types.ObjectId().toString(),
      [inactive.toString(), active.toString()])).resolves.toEqual([inactive.toString(), active.toString()]);
    expect(technologies.find).toHaveBeenCalledWith({ _id: { $in: [active] }, ativo: true });
    userQuery.exec.mockResolvedValueOnce({ stack_ids: [inactive, active] })
      .mockResolvedValueOnce({ stack_ids: [active] });
    await expect(service.replace(new Types.ObjectId().toString(), [active.toString()]))
      .resolves.toEqual([active.toString()]);
  });

  it('does not allow a first association with an inactive technology', async () => {
    const { service, users, userQuery } = setup();
    const inactive = new Types.ObjectId();
    userQuery.exec.mockResolvedValueOnce({ stack_ids: [] });
    await expect(service.replace(new Types.ObjectId().toString(), [inactive.toString()]))
      .rejects.toMatchObject({ response: { code: 'TECNOLOGIAS_INVALIDAS' } });
    expect(users.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('allows removing every stack without querying the catalogue', async () => {
    const { service, users, technologies } = setup();
    await expect(service.replace(new Types.ObjectId().toString(), [])).resolves.toEqual([]);
    expect(technologies.find).not.toHaveBeenCalled();
    expect(users.findOneAndUpdate).toHaveBeenCalledOnce();
  });

  it('rejects a missing authenticated user', async () => {
    const { service, userQuery } = setup();
    userQuery.exec.mockResolvedValue(null);
    await expect(service.replace(new Types.ObjectId().toString(), [])).rejects.toBeInstanceOf(ApiException);
  });

  it('does not replace stacks after the account status changes before the atomic write', async () => {
    const { service, users, userQuery } = setup();
    const userId = new Types.ObjectId().toString();
    userQuery.exec.mockResolvedValueOnce({ stack_ids: [] }).mockResolvedValueOnce(null);
    await expect(service.replace(userId, [])).rejects.toMatchObject({
      response: { code: 'AUTH_REQUIRED' },
    });
    expect(users.findOneAndUpdate.mock.calls[0][0]).toEqual({
      _id: new Types.ObjectId(userId), status: 'ativo',
    });
  });
});
