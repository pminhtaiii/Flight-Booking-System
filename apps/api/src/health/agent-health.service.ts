import { Injectable, Logger } from '@nestjs/common';

export type AgentHealthResult = {
  status: 'up' | 'down';
  details?: Record<string, unknown>;
  statusCode?: number;
};

@Injectable()
export class AgentHealthService {
  private readonly logger = new Logger(AgentHealthService.name);

  async checkAgentHealth(customUrl?: string): Promise<AgentHealthResult> {
    const agentUrl = customUrl || process.env.AGENT_SERVICE_URL || 'http://127.0.0.1:3002';
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 2000);
      const url = `${agentUrl.replace(/\/+$/, '')}/health/live`;
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          status: 'down',
          statusCode: response.status,
        };
      }

      // Parse and safely narrow unknown payload without unsafe casting
      const rawJson: unknown = await response.json();
      if (
        rawJson &&
        typeof rawJson === 'object' &&
        !Array.isArray(rawJson) &&
        (rawJson as Record<string, unknown>).status === 'ok'
      ) {
        return {
          status: 'up',
          details: rawJson as Record<string, unknown>,
        };
      }

      return {
        status: 'down',
      };
    } catch (error) {
      // Redact sensitive details (URLs, tokens, stack) from operational log
      const errorReason = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn(`[checkAgentHealth] Agent health check failed: ${errorReason}`);
      return {
        status: 'down',
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
