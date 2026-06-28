import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { Request } from 'express';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
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

  async validate(req: Request, payload: { id: string; email: string }) {
    const authHeader = req.headers.authorization;
    const token =
      authHeader && authHeader.toLowerCase().startsWith('bearer ') ? authHeader.substring(7) : null;

    if (token) {
      const isBlacklisted = await this.cacheService.get(`blacklist:${token}`);
      if (isBlacklisted) {
        throw new UnauthorizedException();
      }
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.id },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException();
    }

    return { id: user.id, email: user.email };
  }
}
