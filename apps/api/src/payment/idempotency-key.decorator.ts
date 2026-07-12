import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Helper function that extracts the idempotency-key header from request headers case-insensitively.
 * Returns the key string if present, or null if missing or invalid.
 */
export const extractIdempotencyKey = (data: unknown, ctx: ExecutionContext): string | null => {
  const request = ctx.switchToHttp().getRequest();
  if (!request || !request.headers) {
    return null;
  }

  const headerKeys = Object.keys(request.headers);
  const foundKey = headerKeys.find(
    (key) => key.toLowerCase() === 'idempotency-key'
  );

  if (!foundKey) {
    return null;
  }

  const value = request.headers[foundKey];
  return typeof value === 'string' ? value : null;
};

/**
 * Custom parameter decorator to extract the Idempotency-Key header.
 * Usage: @IdempotencyKey() idempotencyKey: string | null
 */
export const IdempotencyKey = createParamDecorator(extractIdempotencyKey);
