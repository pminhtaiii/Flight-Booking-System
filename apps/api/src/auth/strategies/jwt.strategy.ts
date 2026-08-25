import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { Request } from 'express';
import * as crypto from 'crypto';

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
      secretOrKeyProvider: (
        request: Request,
        rawJwtToken: any,
        done: (err: any, secretOrKey?: string | Buffer) => void,
      ) => {
        // Collect candidate keys in priority order
        const candidateKeys = [
          process.env.JWT_SECRET_CURRENT,
          process.env.JWT_SECRET,
          process.env.JWT_SECRET_PREVIOUS,
          process.env.JWT_SECRET_V2,
          process.env.JWT_SECRET_V1,
        ].filter((k): k is string => typeof k === 'string' && k.trim().length > 0);

        if (candidateKeys.length === 0) {
          if (process.env.NODE_ENV !== 'test') {
            return done(new Error('JWT_SECRET environment variable is missing.'));
          }
          return done(null, 'test_secret');
        }

        if (typeof rawJwtToken === 'string') {
          const parts = rawJwtToken.split('.');
          if (parts.length === 3) {
            const headerPayload = `${parts[0]}.${parts[1]}`;
            const sig = parts[2].replace(/=+$/, '');
            for (const key of candidateKeys) {
              try {
                const computed = crypto
                  .createHmac('sha256', key)
                  .update(headerPayload)
                  .digest('base64url')
                  .replace(/=+$/, '');
                if (computed === sig) {
                  return done(null, key);
                }
              } catch {
                // ignore
              }
            }
          }
        }

        // Default to primary key
        return done(null, candidateKeys[0]);
      },
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
    return crypto.createHash('sha256').update(value).digest('hex');
  }
}
