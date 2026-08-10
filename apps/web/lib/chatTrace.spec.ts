import { createOpaqueChatId, isOpaqueChatId } from './chatTrace';

describe('chat trace identifiers', () => {
  it('creates independent opaque identifiers with the bounded chat format', () => {
    const traceId = createOpaqueChatId();
    const correlationId = createOpaqueChatId();

    expect(isOpaqueChatId(traceId)).toBe(true);
    expect(isOpaqueChatId(correlationId)).toBe(true);
    expect(traceId).not.toBe(correlationId);
  });

  it.each([
    null,
    '',
    `chat_${'a'.repeat(31)}`,
    `chat_${'a'.repeat(33)}`,
    `chat_${'A'.repeat(32)}`,
    `trace_${'a'.repeat(32)}`,
    `chat_${'g'.repeat(32)}`,
  ])('rejects a non-opaque chat identifier: %s', (value) => {
    expect(isOpaqueChatId(value)).toBe(false);
  });
});
