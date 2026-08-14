import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { ChatHandoffService, type ChatHandoffSafeResolveResponse } from './chat-handoff.service';
import { ResolveChatHandoffBodyDto } from './dto/resolve-chat-handoff-body.dto';

type AuthenticatedRequest = {
  user: {
    id?: string;
    sub?: string;
  };
};

@Controller('bookings/handoffs')
@UseGuards(JwtAuthGuard)
export class BookingHandoffController {
  private readonly logger = new Logger(BookingHandoffController.name);

  constructor(private readonly chatHandoffService: ChatHandoffService) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(
    @Body() body: ResolveChatHandoffBodyDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('X-Trace-Id') traceId?: string,
    @Headers('X-Correlation-Id') correlationId?: string,
  ): Promise<ChatHandoffSafeResolveResponse> {
    try {
      const userId = request.user.id ?? request.user.sub;
      if (!userId) {
        throw new UnauthorizedException('Authenticated user identity is missing');
      }

      response.setHeader('Cache-Control', 'no-store, private');

      return await this.chatHandoffService.resolveSafe(body.handoffToken, userId, {
        traceId,
        correlationId,
      });
    } catch (error) {
      this.logger.warn('chat_handoff_resolve_failed');
      throw error;
    }
  }
}
