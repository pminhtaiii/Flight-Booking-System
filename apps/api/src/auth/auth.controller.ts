import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { LockoutService } from './rate-limit/lockout.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly lockoutService: LockoutService,
  ) {}

  private getRequestDetails(req: Request, headers: Record<string, string>) {
    // Use req.ip which respects express trust proxy configuration
    const rawIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const ipAddress = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';
    const traceId = headers['x-trace-id'] || null;
    const correlationId = headers['x-correlation-id'] || null;
    return { ipAddress, traceId, correlationId };
  }

  @Post('register')
  @HttpCode(201)
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
  ) {
    const { ipAddress, traceId, correlationId } = this.getRequestDetails(req, headers);

    // Check registration rate-limiting lockout
    const lockout = await this.lockoutService.isLockedOut(ipAddress);
    if (lockout.locked) {
      throw new HttpException(
        {
          code: 'auth_locked',
          message: `Too many failed attempts. Please try again after ${lockout.retryAfterSeconds} seconds.`,
          retryAfterSeconds: lockout.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return this.authService.register(dto, ipAddress, traceId, correlationId);
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
  ) {
    const { ipAddress, traceId, correlationId } = this.getRequestDetails(req, headers);

    const lockout = await this.lockoutService.isLockedOut(ipAddress);
    if (lockout.locked) {
      throw new HttpException(
        {
          code: 'auth_locked',
          message: `Too many failed attempts. Please try again after ${lockout.retryAfterSeconds} seconds.`,
          retryAfterSeconds: lockout.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      return await this.authService.login(dto, ipAddress, traceId, correlationId);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '';
      if (errMsg === 'lockout_triggered') {
        const checkAgain = await this.lockoutService.isLockedOut(ipAddress);
        throw new HttpException(
          {
            code: 'auth_locked',
            message: `Too many failed attempts. Please try again after ${checkAgain.retryAfterSeconds} seconds.`,
            retryAfterSeconds: checkAgain.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw error;
    }
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async logout(@Req() req: AuthenticatedRequest, @Headers() headers: Record<string, string>) {
    const { ipAddress, traceId, correlationId } = this.getRequestDetails(req, headers);
    const userId = req.user.id;
    const authHeader = headers['authorization'] || headers['Authorization'];
    const token =
      authHeader && authHeader.toLowerCase().startsWith('bearer ') ? authHeader.substring(7) : null;
    await this.authService.logout(userId, token, ipAddress, traceId, correlationId);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async me(@Req() req: AuthenticatedRequest) {
    return {
      id: req.user.id,
      email: req.user.email,
    };
  }

  @Post('test/reset-lockout')
  @HttpCode(200)
  async resetLockout(
    @Body() body: { clearAll?: boolean; keepEscalation?: boolean; clearAllLockoutsOnly?: boolean },
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
  ) {
    const { ipAddress } = this.getRequestDetails(req, headers);
    if (body.clearAll) {
      await this.lockoutService.clearAllLockouts();
      await this.authService.resetDatabaseForTesting();
    } else if (body.clearAllLockoutsOnly) {
      await this.lockoutService.clearAllLockouts();
    } else {
      await this.lockoutService.clearLockoutForIp(ipAddress, !!body.keepEscalation);
    }
    return { success: true };
  }
}
