import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { CreateChatHandoffDto } from './dto/create-chat-handoff.dto';

/**
 * ChatHandoffService — stubbed skeleton.
 *
 * All methods throw ServiceUnavailableException until the feature is
 * implemented and enabled via feature flags.
 */
@Injectable()
export class ChatHandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Creates a new chat handoff claim record.
   * Stubbed — throws ServiceUnavailableException.
   */
  async create(_dto: CreateChatHandoffDto): Promise<never> {
    throw new ServiceUnavailableException(
      'Chat handoff feature is not implemented',
    );
  }

  /**
   * Resolves a handoff token, binding it to an authenticated user.
   * Stubbed — throws ServiceUnavailableException.
   */
  async resolve(_token: string, _userId: string): Promise<never> {
    throw new ServiceUnavailableException(
      'Chat handoff feature is not implemented',
    );
  }
}
