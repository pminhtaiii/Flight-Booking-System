import { EncryptionService } from './encryption.service';

describe('EncryptionService', () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalKey;
    jest.restoreAllMocks();
  });

  it('round-trips plaintext with AES-256-GCM', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);

    const service = new EncryptionService();
    const ciphertext = service.encrypt('passport-123');

    expect(ciphertext).toContain(':');
    expect(service.decrypt(ciphertext)).toBe('passport-123');
  });

  it('throws when ENCRYPTION_KEY does not decode to 32 bytes', () => {
    process.env.ENCRYPTION_KEY = 'abc';

    expect(() => new EncryptionService()).toThrow(
      'ENCRYPTION_KEY must be a 64-character hexadecimal string.',
    );
  });
});