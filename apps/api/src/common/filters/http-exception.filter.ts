import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // 1. Determine HTTP status code
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // 2. Format user-facing message & detail safely
    let message: string | string[] = 'Internal server error';
    let errorDetail: unknown = null;
    let extraFields: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      const resContent = exception.getResponse();
      if (typeof resContent === 'object' && resContent !== null) {
        const responseBody = resContent as Record<string, unknown>;
        message = (responseBody.message as string | string[]) || exception.message;
        errorDetail = responseBody.error || null;
        const rest = { ...responseBody };
        delete rest.message;
        delete rest.error;
        delete rest.statusCode;
        extraFields = rest;
      } else {
        message = exception.message;
      }
    } else if (exception instanceof Error) {
      // In production, do not leak raw exception stacks to client
      if (process.env.NODE_ENV !== 'production') {
        message = exception.message;
        errorDetail = exception.stack;
      }
    }

    // 3. Extract tracing propagation headers with truncation to mitigate log injection
    const getSanitizedHeader = (val: string | string[] | undefined): string | null => {
      if (!val) return null;
      const strVal = Array.isArray(val) ? val[0] : val;
      if (!strVal) return null;
      return strVal.length > 64 ? strVal.substring(0, 64) : strVal;
    };

    const traceId = getSanitizedHeader(request.headers['x-trace-id']);
    const correlationId = getSanitizedHeader(request.headers['x-correlation-id']);

    // 4. Structure JSON log format conforming to Observability standard
    const logPayload = {
      timestamp: new Date().toISOString(),
      level: status >= 500 ? 'error' : 'warn',
      service: 'api',
      trace_id: traceId,
      correlation_id: correlationId,
      message: exception instanceof Error ? exception.message : String(exception),
      metadata: {
        path: request.url,
        method: request.method,
        status,
        stack: exception instanceof Error ? exception.stack : null,
      },
    };

    // 5. Emit log via NestJS Logger service
    if (status >= 500) {
      this.logger.error(
        `[HttpExceptionFilter] ${request.method} ${request.url} - ${logPayload.message}`,
        JSON.stringify(logPayload),
      );
    } else {
      this.logger.warn(
        `[HttpExceptionFilter] ${request.method} ${request.url} - ${logPayload.message}`,
        JSON.stringify(logPayload),
      );
    }

    // 6. Respond with sanitized JSON
    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
      error: errorDetail,
      ...extraFields,
    });
  }
}
