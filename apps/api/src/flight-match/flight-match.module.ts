import { Module } from '@nestjs/common';

/**
 * Clean NestJS module scaffold for pure flight match scoring and category ranking.
 * Zero external infrastructure imports (no Prisma, no HTTP, no Redis, no cache, no profile, no duffel).
 * Providers (FlightMatchScorerService, CategoryRankerService) are registered in Phase 3 when implementations exist.
 */
@Module({
  providers: [],
  exports: [],
})
export class FlightMatchModule {}
