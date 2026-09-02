import { Module } from '@nestjs/common';
import { FlightMatchScorerService } from './flight-match-scorer.service';
import { CategoryRankerService } from './category-ranker.service';

/**
 * Clean NestJS module scaffold for pure flight match scoring and category ranking.
 * Zero external infrastructure imports (no Prisma, no HTTP, no Redis, no cache, no profile, no duffel).
 * Registers and exports FlightMatchScorerService and CategoryRankerService.
 */
@Module({
  imports: [],
  providers: [FlightMatchScorerService, CategoryRankerService],
  exports: [FlightMatchScorerService, CategoryRankerService],
})
export class FlightMatchModule {}
