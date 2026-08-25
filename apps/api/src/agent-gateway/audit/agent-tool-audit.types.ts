export type AgentToolOutcome = 'SUCCESS' | 'FAILURE';

export type AgentToolAuditRecord = {
  toolName: string;
  outcome: AgentToolOutcome;
  durationMs: number;
  responseSizeBytes: number;
  traceId?: string | null;
  correlationId?: string | null;
  actorId?: string | null;
  errorCode?: string | null;
  occurredAt: string; // ISO 8601 string
};
