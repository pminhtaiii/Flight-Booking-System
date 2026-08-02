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

  it('throws when the authentication tag is tampered with', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);

    const service = new EncryptionService();
    const [ivHex, authTagHex, encryptedHex] = service.encrypt('passport-123').split(':');
    const tamperedAuthTag = authTagHex.replace(/.$/, authTagHex.endsWith('0') ? '1' : '0');

    expect(() => service.decrypt([ivHex, tamperedAuthTag, encryptedHex].join(':'))).toThrow();
  });

  it('throws when the payload is missing a segment', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);

    const service = new EncryptionService();

    expect(() => service.decrypt('iv:tag')).toThrow('Invalid encrypted payload format.');
  });

  it('throws when ENCRYPTION_KEY does not decode to 32 bytes', () => {
    process.env.ENCRYPTION_KEY = 'abc';

    expect(() => new EncryptionService()).toThrow(
      'ENCRYPTION_KEY must be a 64-character hexadecimal string.',
    );
  });

  describe('bound encryption', () => {
    beforeEach(() => {
      process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    });

    it('round-trips plaintext with context binding and version prefixing', () => {
      const service = new EncryptionService();
      const context = { snapshotVersion: 1, intentId: 'intent-123', position: 1, fieldName: 'passportExpiry' };
      const plaintext = '2026-08-01';

      const ciphertext = (service as any).encryptBound(plaintext, context);

      // Verify version prefixing (e.g., starts with 'v1:')
      expect(ciphertext.startsWith('v1:')).toBe(true);

      // Verify successful decryption with the correct context
      const decrypted = (service as any).decryptBound(ciphertext, context);
      expect(decrypted).toBe(plaintext);
    });

    it('fails to decrypt if the wrong context is provided (wrong context swap)', () => {
      const service = new EncryptionService();
      const contextA = { snapshotVersion: 1, intentId: 'intent-A', position: 1, fieldName: 'passportExpiry' };
      const contextB = { snapshotVersion: 1, intentId: 'intent-B', position: 1, fieldName: 'passportExpiry' };
      const plaintext = '2026-08-01';

      const ciphertext = (service as any).encryptBound(plaintext, contextA);

      // Decrypting with context B should throw an error (fail authentication)
      expect(() => (service as any).decryptBound(ciphertext, contextB)).toThrow();
    });

    it('fails to decrypt if ciphertext from another record is swapped (cross-record swap)', () => {
      const service = new EncryptionService();
      const contextA = { snapshotVersion: 1, intentId: 'intent-123', position: 1, fieldName: 'passportNumber' };
      const contextB = { snapshotVersion: 1, intentId: 'intent-123', position: 2, fieldName: 'passportNumber' };

      const ciphertextA = (service as any).encryptBound('passport-A', contextA);
      const ciphertextB = (service as any).encryptBound('passport-B', contextB);

      // Decrypting ciphertext A with context B must throw
      expect(() => (service as any).decryptBound(ciphertextA, contextB)).toThrow();
      // Decrypting ciphertext B with context A must throw
      expect(() => (service as any).decryptBound(ciphertextB, contextA)).toThrow();
    });

    it('is backward-compatible: decryptBound can decrypt legacy unbound ciphertext', () => {
      const service = new EncryptionService();
      const plaintext = 'legacy-data';
      const legacyCiphertext = service.encrypt(plaintext);

      // legacyCiphertext does not have v1 prefix
      expect(legacyCiphertext.startsWith('v1:')).toBe(false);

      // decryptBound should successfully decrypt it even if context is provided
      const decrypted = (service as any).decryptBound(legacyCiphertext, { intentId: 'any' });
      expect(decrypted).toBe(plaintext);
    });

    it('fails closed safely on tampering', () => {
      const service = new EncryptionService();
      const context = { snapshotVersion: 1, intentId: 'intent-123', position: 1, fieldName: 'passportExpiry' };
      const ciphertext = (service as any).encryptBound('data', context);

      const parts = ciphertext.split(':');
      // Tamper with the encrypted payload segment
      parts[3] = parts[3].substring(0, parts[3].length - 2) + '00';
      const tamperedCiphertext = parts.join(':');

      expect(() => (service as any).decryptBound(tamperedCiphertext, context)).toThrow();
    });
  });
});