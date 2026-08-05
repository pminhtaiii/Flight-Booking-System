import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DisruptionModule } from '../disruption/disruption.module';

@Module({
  imports: [DisruptionModule],
  controllers: [HealthController],
})
export class HealthModule {}
