import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DataDriftSentinelService } from './data-drift-sentinel.service';

@Module({
  imports: [PrismaModule],
  providers: [DataDriftSentinelService],
  exports: [DataDriftSentinelService],
})
export class DataDriftSentinelModule {}
