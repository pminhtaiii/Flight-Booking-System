import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super();
  }

  async onModuleInit() {
    try {
      await this.$connect();
      // Warm up connection pool to avoid first-query cold-start latency
      await this.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.error('Failed to connect to the database on module initialization', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      await this.$disconnect();
    } catch (error) {
      this.logger.error('Error during database disconnection on module destroy', error);
    }
  }
}
