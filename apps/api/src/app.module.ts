import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { CacheModule } from './cache/cache.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { ChatModule } from './chat/chat.module';
import { AgentGatewayModule } from './agent-gateway/agent-gateway.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    HealthModule,
    CacheModule,
    AuthModule,
    AuditModule,
    ChatModule,
    AgentGatewayModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
