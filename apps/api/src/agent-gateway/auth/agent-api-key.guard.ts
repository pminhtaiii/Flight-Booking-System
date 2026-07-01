import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class AgentApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(AgentApiKeyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    // Express automatically lowercases header keys in request.headers
    const apiKey = request.headers['x-agent-api-key'];

    if (!apiKey || typeof apiKey !== 'string') {
      this.logger.warn('Missing or invalid X-Agent-API-Key header');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Missing API key',
        code: 'INVALID_API_KEY',
      });
    }

    const expectedApiKey = process.env.AGENT_SERVICE_API_KEY;
    if (!expectedApiKey) {
      this.logger.error('AGENT_SERVICE_API_KEY environment variable is not configured');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid API key configuration',
        code: 'INVALID_API_KEY',
      });
    }

    const bufProvided = Buffer.from(apiKey, 'utf8');
    const bufExpected = Buffer.from(expectedApiKey, 'utf8');

    if (bufProvided.length !== bufExpected.length) {
      // Dummy check to mitigate timing attacks on length
      timingSafeEqual(bufExpected, bufExpected);
      this.logger.warn('Provided API key does not match (length mismatch)');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid API key',
        code: 'INVALID_API_KEY',
      });
    }

    const match = timingSafeEqual(bufProvided, bufExpected);
    if (!match) {
      this.logger.warn('Provided API key does not match');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid API key',
        code: 'INVALID_API_KEY',
      });
    }

    return true;
  }
}
