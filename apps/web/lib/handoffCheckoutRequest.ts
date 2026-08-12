import { isSameOrigin } from './checkoutHandoffOrigin';
import { isOpaqueChatId } from './chatTrace';

export function safeHandoffCheckoutOrigin(
  request: Request,
  configuredOrigin = process.env.NEXTAUTH_URL,
): boolean {
  const boundaryValues = [request.headers.get('origin'), request.headers.get('referer')]
    .filter((value): value is string => value !== null && value !== 'null');
  const expectedOrigin = configuredOrigin || request.url;

  if (boundaryValues.length > 0) {
    return boundaryValues.every((value) => isSameOrigin(expectedOrigin, value));
  }
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export function safeHandoffTraceHeaders(headers: Headers): Record<string, string> {
  const safeHeaders: Record<string, string> = {};
  const traceId = headers.get('x-trace-id');
  const correlationId = headers.get('x-correlation-id');

  if (isOpaqueChatId(traceId)) safeHeaders['X-Trace-Id'] = traceId;
  if (isOpaqueChatId(correlationId)) safeHeaders['X-Correlation-Id'] = correlationId;
  return safeHeaders;
}
