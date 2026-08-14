import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

const activeUser = {
  id: 'user-1',
  email: 'user@example.test',
  role: 'USER',
  status: 'ACTIVE',
};

const requestFor = (token: string) => ({
  headers: { authorization: `Bearer ${token}` },
}) as never;

const payload = { id: 'user-1', email: 'user@example.test', jti: 'jti-1' };

describe('JwtStrategy', () => {
  it('coalesces concurrent active-user lookups while checking every token revocation', async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(activeUser) } };
    let releaseRevocation!: (value: string | null) => void;
    const revocation = new Promise<string | null>((resolve) => { releaseRevocation = resolve; });
    const cache = { get: jest.fn().mockReturnValue(revocation) };
    const strategy = new JwtStrategy(prisma as never, cache as never);
    const request = requestFor('shared-token');

    const validations = Promise.all([
      strategy.validate(request, payload),
      strategy.validate(request, payload),
    ]);
    releaseRevocation('revoked');
    await expect(validations).rejects.toBeInstanceOf(UnauthorizedException);

    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('observes a token revocation on the next validation', async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(activeUser) } };
    const cache = { get: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('revoked') };
    const strategy = new JwtStrategy(prisma as never, cache as never);

    await expect(strategy.validate(requestFor('shared-token'), payload)).resolves.toEqual({
      id: activeUser.id,
      email: activeUser.email,
      role: activeUser.role,
      jti: payload.jti,
    });
    await expect(strategy.validate(requestFor('shared-token'), payload)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(cache.get).toHaveBeenCalledTimes(2);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('observes user deactivation on the next validation', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(activeUser)
          .mockResolvedValueOnce({ ...activeUser, status: 'INACTIVE' }),
      },
    };
    const cache = { get: jest.fn().mockResolvedValue(null) };
    const strategy = new JwtStrategy(prisma as never, cache as never);

    await expect(strategy.validate(requestFor('shared-token'), payload)).resolves.toEqual({
      id: activeUser.id,
      email: activeUser.email,
      role: activeUser.role,
      jti: payload.jti,
    });
    await expect(strategy.validate(requestFor('shared-token'), payload)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it('coalesces only simultaneous revocation lookups with a hashed token key', async () => {
    const token = 'shared-token';
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(activeUser) } };
    let releaseRevocation!: (value: string | null) => void;
    const revocation = new Promise<string | null>((resolve) => { releaseRevocation = resolve; });
    const cache = { get: jest.fn().mockReturnValueOnce(revocation).mockResolvedValueOnce(null) };
    const strategy = new JwtStrategy(prisma as never, cache as never);

    const first = strategy.validate(requestFor(token), payload);
    const lookupMap: unknown = Reflect.get(strategy, 'revocationLookups');
    expect(lookupMap).toBeInstanceOf(Map);
    if (!(lookupMap instanceof Map)) {
      throw new Error('Expected the strategy to track in-flight revocation lookups.');
    }
    const lookupKeys = [...lookupMap.keys()];
    expect(lookupKeys).toHaveLength(1);
    expect(lookupKeys[0]).not.toBe(token);
    expect(lookupKeys[0]).toMatch(/^[a-f0-9]{64}$/);

    const second = strategy.validate(requestFor(token), payload);
    releaseRevocation(null);
    await Promise.all([first, second]);
    await strategy.validate(requestFor(token), payload);

    expect(cache.get).toHaveBeenCalledTimes(2);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });
});
