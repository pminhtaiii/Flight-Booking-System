import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@/cache/cache.module';
import { DuffelService } from './duffel.service';

@Module({
  imports: [ConfigModule, CacheModule],
  providers: [DuffelService],
  exports: [DuffelService],
})
export class DuffelModule {}
