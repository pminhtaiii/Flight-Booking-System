import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { Request } from 'express';
import { createHash } from 'crypto';

type ActiveUser = {
  id: string;
  email: string;
  role: string;
  status: string;
};

type JwtPayload = {
  id: string;
  email: string;
  jti?: string;
};

type ValidatedUser = {
  id: string;
  email: string;
  role: string;
  jti?: string;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly activeUserLookups = new Map<string, Promise<ActiveUser | null>>();
  private readonly revocationLookups = new Map<string, Promise<string | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: (() => {
        const secret = process.env.JWT_SECRET;
        if (!secret && process.env.NODE_ENV !== 'test') {
          throw new Error('JWT_SECRET environment variable is missing.');
        }
        return secret || 'test_secret';
      })(),
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<ValidatedUser> {
    const authHeader = req.headers.authorization;
    const token =
      authHeader && authHeader.toLowerCase().startsWith('bearer ') ? authHeader.substring(7) : null;

    if (token) {
      const isBlacklisted = await this.findRevocationOnce(token);
      if (isBlacklisted) {
        throw new UnauthorizedException();
      }
    }

    const user = await this.findActiveUserOnce(payload.id);

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException();
    }

    return { id: user.id, email: user.email, role: user.role, jti: payload.jti };
  }

  private async findActiveUserOnce(userId: string): Promise<ActiveUser | null> {
    const lookupKey = this.inFlightKey(userId);
    const existing = this.activeUserLookups.get(lookupKey);
    if (existing) {
      return existing;
    }

    const lookup = this.prisma.user.findUnique({ where: { id: userId } });

    this.activeUserLookups.set(lookupKey, lookup);
    try {
      return await lookup;
    } finally {
      if (this.activeUserLookups.get(lookupKey) === lookup) {
        this.activeUserLookups.delete(lookupKey);
      }
    }
  }

  private async findRevocationOnce(token: string): Promise<string | null> {
    const lookupKey = this.inFlightKey(token);
    const existing = this.revocationLookups.get(lookupKey);
    if (existing) {
      return existing;
    }

    const lookup = this.cacheService.get(`blacklist:${token}`);

    this.revocationLookups.set(lookupKey, lookup);
    try {
      return await lookup;
    } finally {
      if (this.revocationLookups.get(lookupKey) === lookup) {
        this.revocationLookups.delete(lookupKey);
      }
    }
  }

  private inFlightKey(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
