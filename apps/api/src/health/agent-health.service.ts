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
      const url = `${agentUrl.replace(/\/+$/, '')}/health`;
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

      const details = (await response.json()) as Record<string, unknown>;
      return {
        status: 'up',
        details,
      };
    } catch (error) {
      this.logger.warn(
        `Agent health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
