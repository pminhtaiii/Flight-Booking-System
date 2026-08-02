import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  Req,
  Headers,
  Res,
  NotFoundException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileResponseDto } from './dto/profile-response.dto';
import { ConfigService } from '@nestjs/config';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(
    private readonly profileService: ProfileService,
    private readonly configService: ConfigService,
  ) {}

  private checkFeatureEnabled() {
    const enabled = this.configService.get<string>('FEATURE_FLAG_BOOKING_READINESS') === 'true';
    if (!enabled) {
      throw new NotFoundException('FEATURE_DISABLED');
    }
  }

  @Get()
  async getProfile(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProfileResponseDto> {
    this.checkFeatureEnabled();
    res.setHeader('Cache-Control', 'no-store, private');
    res.removeHeader('ETag');

    return this.profileService.getProfile(req.user.id);
  }

  @Patch()
  async updateProfile(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: UpdateProfileDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProfileResponseDto> {
    this.checkFeatureEnabled();
    res.setHeader('Cache-Control', 'no-store, private');
    res.removeHeader('ETag');

    const traceId = headers['x-trace-id'] || undefined;
    const correlationId = headers['x-correlation-id'] || undefined;

    return this.profileService.updateProfile(req.user.id, dto, traceId, correlationId);
  }
}
