import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOpaqueChatId, isOpaqueChatId } from './chatTrace';

describe('chat trace identifiers', () => {
  it('creates independent opaque identifiers with the bounded chat format', () => {
    const traceId = createOpaqueChatId();
    const correlationId = createOpaqueChatId();

    assert.strictEqual(isOpaqueChatId(traceId), true);
    assert.strictEqual(isOpaqueChatId(correlationId), true);
    assert.notStrictEqual(traceId, correlationId);
  });

  const invalidCases = [
    null,
    '',
    `chat_${'a'.repeat(31)}`,
    `chat_${'a'.repeat(33)}`,
    `chat_${'A'.repeat(32)}`,
    `trace_${'a'.repeat(32)}`,
    `chat_${'g'.repeat(32)}`,
  ];

  for (const value of invalidCases) {
    it(`rejects a non-opaque chat identifier: ${value}`, () => {
      assert.strictEqual(isOpaqueChatId(value), false);
    });
  }
});

