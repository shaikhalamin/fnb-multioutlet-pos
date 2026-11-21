import { describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { UsersService } from './users.service.js';
import type { UsersRepository } from './users.repository.js';

function makeRepo(overrides: Partial<UsersRepository> = {}) {
  return {
    findByEmail: vi.fn(async () => null),
    findRolesByCodes: vi.fn(async (codes: string[]) =>
      codes.map((code) => ({ id: `role-${code}`, code, name: code })),
    ),
    insertUser: vi.fn(async (manager: unknown, input: { email: string; passwordHash: string }) => ({
      id: 'user-1',
      email: input.email,
      passwordHash: input.passwordHash,
      status: 'ACTIVE',
      createdAt: new Date('2026-11-20T04:00:00Z'),
      updatedAt: new Date('2026-11-20T04:00:00Z'),
      managerReceived: manager,
    })),
    setUserRoles: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as UsersRepository;
}

/** DataSource stub whose transaction() hands the callback a sentinel manager. */
function makeDataSource() {
  const manager = { sentinel: 'tx-manager' };
  return {
    manager,
    transaction: vi.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn(manager)),
  };
}

function makeService(repo: UsersRepository, dataSource: ReturnType<typeof makeDataSource>) {
  return new UsersService(dataSource as never, repo);
}

describe('UsersService.create', () => {
  const request = { email: 'New@Outlet-A.local', password: 'StrongPass123!', roleCodes: ['OUTLET_CASHIER'] };

  it('rejects a duplicate email with 409 CONFLICT before any write', async () => {
    const repo = makeRepo({ findByEmail: vi.fn(async () => ({ id: 'existing' })) });
    const dataSource = makeDataSource();
    const service = makeService(repo, dataSource);

    await expect(service.create(request)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects unknown role codes with 422 before any write', async () => {
    const repo = makeRepo({ findRolesByCodes: vi.fn(async () => []) });
    const dataSource = makeDataSource();
    const service = makeService(repo, dataSource);

    await expect(service.create(request)).rejects.toMatchObject({
      status: 422,
      code: 'UNPROCESSABLE_ENTITY',
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('hashes the password with bcrypt and never stores plaintext', async () => {
    const repo = makeRepo();
    const service = makeService(repo, makeDataSource());

    const user = await service.create(request);

    expect(user.passwordHash).toBeUndefined(); // response carries no hash
    const inserted = (repo.insertUser as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      passwordHash: string;
    };
    expect(inserted.passwordHash).not.toBe(request.password);
    expect(await bcrypt.compare(request.password, inserted.passwordHash)).toBe(true);
  });

  it('writes the user and the role membership in ONE transaction', async () => {
    const repo = makeRepo();
    const dataSource = makeDataSource();
    const service = makeService(repo, dataSource);

    await service.create(request);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    const insertManager = (repo.insertUser as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const rolesManager = (repo.setUserRoles as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertManager).toBe(dataSource.manager);
    expect(rolesManager).toBe(dataSource.manager);
    expect((repo.setUserRoles as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('user-1');
  });

  it('lowercases the email before persisting', async () => {
    const repo = makeRepo();
    const service = makeService(repo, makeDataSource());

    const user = await service.create(request);

    expect(user.email).toBe('new@outlet-a.local');
  });
});
