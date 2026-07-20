import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { CacheModule } from './cache/cache.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { ChatModule } from './chat/chat.module';
import { AgentGatewayModule } from './agent-gateway/agent-gateway.module';
import { AirportsModule } from './airports/airports.module';
import { DuffelModule } from './duffel/duffel.module';
import { FlightsModule } from './flights/flights.module';
import { BookingIntentModule } from './booking-intent/booking-intent.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    HealthModule,
    CacheModule,
    AuthModule,
    AuditModule,
    ChatModule,
    AgentGatewayModule,
    AirportsModule,
    DuffelModule,
    FlightsModule,
    BookingIntentModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
