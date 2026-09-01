import { Module } from '@nestjs/common';
import { FlightMatchScorerService } from './flight-match-scorer.service';

/**
 * Clean NestJS module scaffold for pure flight match scoring and category ranking.
 * Zero external infrastructure imports (no Prisma, no HTTP, no Redis, no cache, no profile, no duffel).
 * Providers (FlightMatchScorerService, CategoryRankerService) are registered in Phase 3 when implementations exist.
 */
@Module({
  imports: [],
  providers: [FlightMatchScorerService],
  exports: [FlightMatchScorerService],
})
export class FlightMatchModule {}
