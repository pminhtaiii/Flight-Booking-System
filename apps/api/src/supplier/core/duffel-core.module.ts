import { Global, Module } from '@nestjs/common';
import { CacheModule } from '@/cache/cache.module';
import { DUFFEL_SDK, duffelSdkProvider } from './duffel-sdk.provider';
import { DuffelRateBudgetService } from './duffel-rate-budget.service';

export { DUFFEL_SDK, duffelSdkProvider, DuffelRateBudgetService };

@Global()
@Module({
  imports: [CacheModule],
  providers: [duffelSdkProvider, DuffelRateBudgetService],
  exports: [DUFFEL_SDK, DuffelRateBudgetService],
})
export class DuffelCoreModule {}

