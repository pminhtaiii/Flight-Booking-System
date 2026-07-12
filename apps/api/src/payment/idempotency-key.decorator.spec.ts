import { ExecutionContext } from '@nestjs/common';
import { extractIdempotencyKey } from './idempotency-key.decorator';

describe('IdempotencyKey Decorator', () => {
  const createMockExecutionContext = (headers: Record<string, string>): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
        }),
      }),
    } as unknown as ExecutionContext;
  };

  it('should extract idempotency key from lowercase header', () => {
    const context = createMockExecutionContext({
      'idempotency-key': 'test-key-123',
    });
    const result = extractIdempotencyKey(undefined, context);
    expect(result).toBe('test-key-123');
  });

  it('should extract idempotency key from mixedcase header', () => {
    const context = createMockExecutionContext({
      'Idempotency-Key': 'test-key-456',
    });
    const result = extractIdempotencyKey(undefined, context);
    expect(result).toBe('test-key-456');
  });

  it('should return null if header is missing', () => {
    const context = createMockExecutionContext({
      'content-type': 'application/json',
    });
    const result = extractIdempotencyKey(undefined, context);
    expect(result).toBeNull();
  });

  it('should return null if header is an array of strings', () => {
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {
            'idempotency-key': ['key1', 'key2'],
          },
        }),
      }),
    } as unknown as ExecutionContext;
    const result = extractIdempotencyKey(undefined, context);
    expect(result).toBeNull();
  });
});
