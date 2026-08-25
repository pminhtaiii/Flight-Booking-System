import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getFeatureFlags, isBookingReadinessEnabled, isCheckoutEnabled } from './featureFlags';

describe('Feature Flags Config - Phase 8D Direct-Only Transport', () => {
  it('does not expose retired FEATURE_FLAG_CHAT_DIRECT_STREAM toggle in getFeatureFlags', () => {
    const flags = getFeatureFlags() as Record<string, unknown>;
    // Direct stream is permanently canonical; the proxy toggle must not exist in flags object
    assert.strictEqual(
      'FEATURE_FLAG_CHAT_DIRECT_STREAM' in flags,
      false,
      'FEATURE_FLAG_CHAT_DIRECT_STREAM toggle must be retired from getFeatureFlags',
    );
  });

  it('preserves non-transport feature flags', () => {
    const flags = getFeatureFlags();
    assert.strictEqual(typeof flags.FEATURE_FLAG_CHAT_MULTI_AGENT, 'boolean');
    assert.strictEqual(typeof flags.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT, 'boolean');
  });

  it('preserves readiness and checkout helpers', () => {
    assert.strictEqual(typeof isBookingReadinessEnabled(), 'boolean');
    assert.strictEqual(typeof isCheckoutEnabled(), 'boolean');
  });
});
