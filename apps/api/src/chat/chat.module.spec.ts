import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ChatModule } from './chat.module';
import { ChatService } from './chat.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { CacheService } from '@/cache/cache.service';

describe('ChatModule architectural boundary (US1 T009)', () => {
  it('asserts ChatModule exports ChatService', () => {
    const exports = Reflect.getMetadata('exports', ChatModule) ?? [];
    expect(exports).toContain(ChatService);
  });

  describe('Target architectural invariants and dependency boundaries', () => {
    it('asserts ChatService domain contract does not depend on AgentAuth or Gateway components', () => {
      const paramTypes: Array<{ name?: string }> = Reflect.getMetadata('design:paramtypes', ChatService) || [];
      const paramNames = paramTypes.map((t) => t?.name);

      expect(paramNames).not.toContain('AgentAuthService');
      expect(paramNames).not.toContain('ClaimTokenService');
      expect(paramNames).not.toContain('AgentChatAccessService');
      expect(paramNames).not.toContain('AgentApiKeyGuard');
      expect(paramNames).not.toContain('ClaimTokenGuard');
    });

    it('asserts ChatModule dependency rules and future exclusion of AgentAuthModule in target architecture', () => {
      const modulePath = join(__dirname, 'chat.module.ts');
      const moduleSource = readFileSync(modulePath, 'utf8');
      const imports = Reflect.getMetadata('imports', ChatModule) ?? [];

      // Core domain assertion: ChatModule imports foundational persistence and audit modules
      expect(imports).toContain(PrismaModule);
      expect(imports).toContain(AuditModule);

      // Target architecture invariant (Feature 026 / US1 T013):
      // ChatModule must isolate core chat functionality.
      // Agent-gateway concerns (AgentAuthModule, AgentChatController, AgentChatAccessService)
      // are moving to AgentChatModule at the gateway boundary.
      const isTargetArchitecture = !moduleSource.includes('@/agent-gateway/auth/agent-auth.module');
      const importedNames = imports.map((m: { name?: string } | Function) => (typeof m === 'function' ? m.name : m?.name));

      if (isTargetArchitecture) {
        expect(importedNames).not.toContain('AgentAuthModule');
        expect(moduleSource).not.toMatch(/@\/agent-gateway/);
      } else {
        // Transitional baseline for Slice 1: AgentAuthModule is present and flagged for future exclusion in Slice 2 (T013)
        expect(moduleSource).toContain('AgentAuthModule');
      }
    });

    it('verifies ChatModule can compile into a testing module exporting ChatService', async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [
              () => ({
                CHAT_ENCRYPTION_KEY: 'ab'.repeat(32),
                FEATURE_FLAG_WRITE_FENCE: 'false',
                AGENT_SERVICE_API_KEY: 'test-agent-key',
                CLAIM_TOKEN_SECRET: 'test-claim-secret',
              }),
            ],
          }),
          ChatModule,
        ],
      })
        .overrideProvider(PrismaService)
        .useValue({
          chatSession: { findMany: jest.fn() },
          chatMessage: { findMany: jest.fn() },
          user: { findUnique: jest.fn() },
        })
        .overrideProvider(AuditService)
        .useValue({ createLog: jest.fn() })
        .overrideProvider(CacheService)
        .useValue({ get: jest.fn(), set: jest.fn(), hget: jest.fn() })
        .compile();

      const chatService = moduleFixture.get<ChatService>(ChatService);
      expect(chatService).toBeDefined();
      expect(chatService).toBeInstanceOf(ChatService);
      await moduleFixture.close();
    });
  });
});
