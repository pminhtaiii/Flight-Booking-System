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
import { BookingModule } from './booking/booking.module';
import { PaymentModule } from './payment/payment.module';
import { DisruptionModule } from './disruption/disruption.module';
import { AncillariesModule } from './ancillaries/ancillaries.module';
import { ProfileModule } from './profile/profile.module';
import { ChatHandoffModule } from './chat-handoff/chat-handoff.module';

import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  STRIPE_SECRET_KEY: z.string({
    required_error: 'STRIPE_SECRET_KEY is required',
  }),
  STRIPE_WEBHOOK_SECRET: z.string({
    required_error: 'STRIPE_WEBHOOK_SECRET is required',
  }),
  JWT_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  DUFFEL_WEBHOOK_SECRET: z.string().optional(),
  FEATURE_FLAG_DISRUPTION_INGRESS: z.string().optional().default('false'),
  FEATURE_FLAG_BOOKING_READINESS: z.string().optional().default('false'),
  FEATURE_FLAG_DISRUPTION_PROCESSOR: z.string().optional().default('false'),
  FEATURE_FLAG_DISRUPTION_RECONCILIATION: z.string().optional().default('false'),
  FEATURE_FLAG_DISRUPTION_SURFACING: z.string().optional().default('false'),
  FEATURE_FLAG_DISRUPTION_OUTBOX: z.string().optional().default('false'),
  FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: z.string().optional().default('false'),
  FEATURE_FLAG_CHAT_HANDOFF_ISSUE: z.string().optional().default('false'),
  FEATURE_FLAG_WRITE_FENCE: z.string().optional().default('false'),
  CHAT_ENCRYPTION_KEY: z.string().optional(),
  CHAT_ATTESTATION_KEY: z.string().optional(),
  CHAT_HANDOFF_SECRET: z.string().optional(),
  CHAT_HANDOFF_SECRET_V1: z.string().optional(),
  CHAT_HANDOFF_SECRET_V2: z.string().optional(),
  CHAT_HANDOFF_SECRET_V3: z.string().optional(),
  CHAT_HANDOFF_CLAIM_TTL: z.coerce.number().optional().default(600),
}).passthrough().refine(data => {
  if (data.FEATURE_FLAG_CHAT_HANDOFF_ISSUE === 'true' && data.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT !== 'true') {
    return false;
  }
  return true;
}, {
  message: "Invalid config: ISSUE=true but ACCEPT=false",
});

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => envSchema.parse(config),
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
    BookingModule,
    PaymentModule,
    DisruptionModule,
    AncillariesModule,
    ProfileModule,
    ChatHandoffModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
