import { createChatTelemetryEvent } from './chat-observability';

describe('chat telemetry privacy contract', () => {
  it('emits bounded opaque identifiers and allowlisted metadata', () => {
    const event = createChatTelemetryEvent(
      'handoff_create',
      'created',
      12.4,
      { traceId: 'session-123', correlationId: 'user-456' },
      { outcome: 'created', price_changed: false },
    );

    expect(event.metric).toBe('chat_handoff_create_total');
    expect(event.latency_ms).toBe(12);
    expect(event.trace_id).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(event.correlation_id).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(JSON.stringify(event)).not.toContain('session-123');
    expect(JSON.stringify(event)).not.toContain('user-456');
  });

  it.each([
    ['message', 'book a flight'],
    ['token', 'handoff-secret'],
    ['offer_id', 'offer-123'],
    ['user_id', 'user-123'],
    ['session_id', 'session-123'],
    ['passenger_count', 2],
  ])('rejects non-allowlisted metadata key %s', (key, value) => {
    expect(() => createChatTelemetryEvent(
      'intent_create',
      'created',
      1,
      {},
      { [key]: value },
    )).toThrow();
  });

  it('rejects a sensitive-looking value under an allowlisted field', () => {
    expect(() => createChatTelemetryEvent(
      'handoff_resolve',
      'resolved',
      1,
      {},
      { outcome: 'user_reference' },
    )).toThrow();
  });
});
