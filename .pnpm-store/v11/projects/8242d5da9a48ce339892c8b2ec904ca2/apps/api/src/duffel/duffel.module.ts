import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@/cache/cache.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelService } from './duffel.service';
import { DuffelCleanupService } from './duffel-cleanup.service';

@Module({
  imports: [ConfigModule, CacheModule, PrismaModule],
  providers: [DuffelService, DuffelCleanupService],
  exports: [DuffelService],
})
export class DuffelModule {}
