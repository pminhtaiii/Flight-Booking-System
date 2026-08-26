import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { AgentToolAuditRecord } from './agent-tool-audit.types';

@Injectable()
export class AgentToolAuditService {
  private readonly logger = new Logger(AgentToolAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordToolExecution(record: AgentToolAuditRecord): Promise<void> {
    try {
      // Negative privacy enforcement: Project ONLY allowlisted metrics metadata.
      // Explicitly discard raw parameters, customer messages, passenger details,
      // passport numbers, card numbers, or external supplier identifiers.
      const metadata = {
        toolName: record.toolName,
        outcome: record.outcome,
        durationMs: record.durationMs,
        responseSizeBytes: record.responseSizeBytes,
        occurredAt: record.occurredAt,
        ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      };

      await this.prisma.auditLog.create({
        data: {
          userId: record.actorId || null,
          action: 'AGENT_TOOL_CALL',
          resourceType: 'agent-gateway',
          resourceId: record.toolName,
          metadata,
          traceId: record.traceId || crypto.randomUUID(),
          correlationId: record.correlationId || crypto.randomUUID(),
        },
      });
    } catch (error) {
      this.logger.error(
        `[recordToolExecution] Failed to record agent tool execution audit log: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
