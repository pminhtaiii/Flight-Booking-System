import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { LockoutService } from './rate-limit/lockout.service';
import { JwtService } from '@nestjs/jwt';
import { CacheService } from '@/cache/cache.service';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly lockoutService: LockoutService,
    private readonly jwtService: JwtService,
    private readonly cacheService: CacheService,
  ) {}

  async register(
    dto: { email: string; password?: string },
    ipAddress?: string | null,
    traceId?: string | null,
    correlationId?: string | null,
  ) {
    const email = dto.email.trim().toLowerCase();
    const password = dto.password || '';

    // Password strength check (as a fallback validation)
    const hasMinLength = password.length >= 8 && password.length <= 128;
    const hasLowercase = /[a-z]/.test(password);
    const hasUppercase = /[A-Z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSpecialChar = /[^a-zA-Z0-9]/.test(password);

    if (!hasMinLength || !hasLowercase || !hasUppercase || !hasDigit || !hasSpecialChar) {
      throw new BadRequestException('Password does not meet complexity requirements');
    }

    // Check email uniqueness beforehand
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with this email address already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    try {
      const result = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const user = await tx.user.create({
          data: {
            email,
            password: hashedPassword,
            status: 'ACTIVE',
          },
        });

        await this.auditService.createLog(tx, {
          userId: user.id,
          action: 'registration',
          resourceType: 'User',
          resourceId: user.id,
          ipAddress,
          traceId,
          correlationId,
          metadata: {},
        });

        return user;
      });

      const token = this.jwtService.sign(
        { id: result.id, email: result.email },
        { expiresIn: '24h' },
      );

      return {
        token,
        user: {
          id: result.id,
          email: result.email,
        },
      };
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An account with this email address already exists');
      }
      throw error;
    }
  }

  async login(
    dto: { email: string; password?: string },
    ipAddress?: string | null,
    traceId?: string | null,
    correlationId?: string | null,
  ) {
    const email = dto.email.trim().toLowerCase();
    const password = dto.password || '';

    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || user.status !== 'ACTIVE') {
      // Record failed attempt
      const record = await this.lockoutService.recordFailedAttempt(ipAddress || '127.0.0.1');
      // Create failure audit log
      await this.auditService.createLog(null, {
        userId: user ? user.id : null,
        action: 'failed_login',
        resourceType: 'User',
        resourceId: user ? user.id : null,
        ipAddress,
        traceId,
        correlationId,
        metadata: { reason: user ? 'Account is inactive' : 'User not found' },
      });

      if (record.locked && record.attempts > 5) {
        throw new UnauthorizedException('lockout_triggered'); // We'll handle this in the controller
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      const record = await this.lockoutService.recordFailedAttempt(ipAddress || '127.0.0.1');
      await this.auditService.createLog(null, {
        userId: user.id,
        action: 'failed_login',
        resourceType: 'User',
        resourceId: user.id,
        ipAddress,
        traceId,
        correlationId,
        metadata: { reason: 'Incorrect password' },
      });

      if (record.locked && record.attempts > 5) {
        throw new UnauthorizedException('lockout_triggered');
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    // Reset lockout
    await this.lockoutService.resetLockoutState(ipAddress || '127.0.0.1');

    // Update lastLogin
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    // Create login audit log
    await this.auditService.createLog(null, {
      userId: user.id,
      action: 'login',
      resourceType: 'User',
      resourceId: user.id,
      ipAddress,
      traceId,
      correlationId,
      metadata: {},
    });

    const token = this.jwtService.sign(
      { id: updatedUser.id, email: updatedUser.email },
      { expiresIn: '24h' },
    );

    return {
      token,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        lastLogin: updatedUser.lastLogin, // Map it to lastLogin for Jest E2E compatibility
      },
    };
  }

  async logout(
    userId: string,
    token?: string | null,
    ipAddress?: string | null,
    traceId?: string | null,
    correlationId?: string | null,
  ) {
    if (token) {
      // Blacklist token in CacheService for 24 hours
      await this.cacheService.set(`blacklist:${token}`, 'true', 86400);
    }

    await this.auditService.createLog(null, {
      userId,
      action: 'logout',
      resourceType: 'User',
      resourceId: userId,
      ipAddress,
      traceId,
      correlationId,
      metadata: {},
    });
  }

  async resetDatabaseForTesting() {
    const logs = await this.prisma.auditLog.deleteMany({});
    const users = await this.prisma.user.deleteMany({});
    // eslint-disable-next-line no-console
    console.log(
      `[resetDatabaseForTesting] Deleted ${users.count} users and ${logs.count} audit logs.`,
    );
  }
}
