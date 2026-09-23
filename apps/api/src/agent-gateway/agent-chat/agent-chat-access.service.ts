import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';

export interface CheckUserAccessDto {
  sub: string;
  jti?: string;
  exp?: number;
}

@Injectable()
export class AgentChatAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Verifies that the user exists, is active, the token is unexpired, and the JTI is not blacklisted.
   */
  async checkUserAccess(dto: CheckUserAccessDto): Promise<{ allowed: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.sub },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new HttpException(
        { code: 'UNAUTHORIZED', message: 'User is inactive or not found' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (dto.exp !== undefined && dto.exp !== null) {
      if (dto.exp * 1000 <= Date.now()) {
        throw new HttpException(
          { code: 'UNAUTHORIZED', message: 'Token has expired' },
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    if (dto.jti) {
      const isJtiBlacklisted = await this.cacheService.get(`blacklist:jti:${dto.jti}`);
      if (isJtiBlacklisted) {
        throw new HttpException(
          { code: 'UNAUTHORIZED', message: 'Token JTI has been revoked' },
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    return { allowed: true };
  }
}
