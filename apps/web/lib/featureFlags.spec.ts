import { getFeatureFlags } from './featureFlags';

describe('Feature Flags Config', () => {
  it('should default FEATURE_FLAG_CHAT_DIRECT_STREAM to false', () => {
    const flags = getFeatureFlags();
    expect(flags.FEATURE_FLAG_CHAT_DIRECT_STREAM).toBe(false);
  });
});
