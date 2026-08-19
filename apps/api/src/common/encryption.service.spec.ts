import { EncryptionService } from './encryption.service';

describe('EncryptionService', () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  const originalKeyCurrent = process.env.ENCRYPTION_KEY_CURRENT;
  const originalKeyPrevious = process.env.ENCRYPTION_KEY_PREVIOUS;
  const originalKeyV2 = process.env.ENCRYPTION_KEY_V2;
  const originalKeyV1 = process.env.ENCRYPTION_KEY_V1;

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
    if (originalKeyCurrent !== undefined) {
      process.env.ENCRYPTION_KEY_CURRENT = originalKeyCurrent;
    } else {
      delete process.env.ENCRYPTION_KEY_CURRENT;
    }
    if (originalKeyPrevious !== undefined) {
      process.env.ENCRYPTION_KEY_PREVIOUS = originalKeyPrevious;
    } else {
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
    }
    if (originalKeyV2 !== undefined) {
      process.env.ENCRYPTION_KEY_V2 = originalKeyV2;
    } else {
      delete process.env.ENCRYPTION_KEY_V2;
    }
    if (originalKeyV1 !== undefined) {
      process.env.ENCRYPTION_KEY_V1 = originalKeyV1;
    } else {
      delete process.env.ENCRYPTION_KEY_V1;
    }
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

  describe('key rotation ring', () => {
    const oldKey = '1'.repeat(64);
    const newKey = '2'.repeat(64);
    const context = { snapshotVersion: 1, intentId: 'intent-rot-1', position: 0, fieldName: 'passportNumber' };

    it('decrypts unbound ciphertext encrypted with previous key across rotation', () => {
      // 1. Encrypt with old key
      delete process.env.ENCRYPTION_KEY_CURRENT;
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      process.env.ENCRYPTION_KEY = oldKey;
      const oldService = new EncryptionService();
      const oldCiphertext = oldService.encrypt('sensitive-passport-old');

      // 2. Rotate keys: newKey is CURRENT, oldKey is PREVIOUS
      delete process.env.ENCRYPTION_KEY;
      process.env.ENCRYPTION_KEY_CURRENT = newKey;
      process.env.ENCRYPTION_KEY_PREVIOUS = oldKey;
      const rotatedService = new EncryptionService();

      // 3. Rotated service decrypts old ciphertext successfully
      expect(rotatedService.decrypt(oldCiphertext)).toBe('sensitive-passport-old');

      // 4. Rotated service encrypts with primary (newKey)
      const newCiphertext = rotatedService.encrypt('sensitive-passport-new');
      expect(rotatedService.decrypt(newCiphertext)).toBe('sensitive-passport-new');

      // 5. Old service cannot decrypt newCiphertext
      expect(() => oldService.decrypt(newCiphertext)).toThrow();
    });

    it('decrypts bound ciphertext encrypted with previous key across rotation', () => {
      // 1. Encrypt bound with old key
      delete process.env.ENCRYPTION_KEY_CURRENT;
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      process.env.ENCRYPTION_KEY = oldKey;
      const oldService = new EncryptionService();
      const oldBoundCiphertext = oldService.encryptBound('bound-passport-old', context);

      // 2. Rotate keys: newKey is CURRENT, oldKey is PREVIOUS
      delete process.env.ENCRYPTION_KEY;
      process.env.ENCRYPTION_KEY_CURRENT = newKey;
      process.env.ENCRYPTION_KEY_PREVIOUS = oldKey;
      const rotatedService = new EncryptionService();

      // 3. Rotated service decrypts old bound ciphertext successfully
      expect(rotatedService.decryptBound(oldBoundCiphertext, context)).toBe('bound-passport-old');

      // 4. Rotated service encrypts bound with primary (newKey)
      const newBoundCiphertext = rotatedService.encryptBound('bound-passport-new', context);
      expect(rotatedService.decryptBound(newBoundCiphertext, context)).toBe('bound-passport-new');

      // 5. Old service cannot decrypt newBoundCiphertext
      expect(() => oldService.decryptBound(newBoundCiphertext, context)).toThrow();
    });

    it('prioritizes primary key resolution and supports candidate ring fallback', () => {
      const keyV1 = '3'.repeat(64);
      const keyV2 = '4'.repeat(64);

      // Setup service with keyV1
      delete process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY_CURRENT;
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      process.env.ENCRYPTION_KEY_V1 = keyV1;
      const v1Service = new EncryptionService();
      const v1Ciphertext = v1Service.encrypt('v1-data');
      const v1BoundCiphertext = v1Service.encryptBound('v1-bound-data', context);

      // Service with ENCRYPTION_KEY_CURRENT as primary and keyV1 as candidate in ring
      process.env.ENCRYPTION_KEY_CURRENT = newKey;
      process.env.ENCRYPTION_KEY_V2 = keyV2;
      const multiRingService = new EncryptionService();

      expect(multiRingService.decrypt(v1Ciphertext)).toBe('v1-data');
      expect(multiRingService.decryptBound(v1BoundCiphertext, context)).toBe('v1-bound-data');
    });

    it('throws when no valid 32-byte key is configured', () => {
      delete process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY_CURRENT;
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      delete process.env.ENCRYPTION_KEY_V1;
      delete process.env.ENCRYPTION_KEY_V2;

      expect(() => new EncryptionService()).toThrow(
        'ENCRYPTION_KEY must be a 64-character hexadecimal string.',
      );
    });

    it('throws when payload fails decryption against all keys in candidate ring', () => {
      const foreignKey = '9'.repeat(64);
      delete process.env.ENCRYPTION_KEY_CURRENT;
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      process.env.ENCRYPTION_KEY = foreignKey;
      const foreignService = new EncryptionService();
      const foreignCiphertext = foreignService.encrypt('foreign-data');
      const foreignBoundCiphertext = foreignService.encryptBound('foreign-bound-data', context);

      delete process.env.ENCRYPTION_KEY;
      process.env.ENCRYPTION_KEY_CURRENT = newKey;
      process.env.ENCRYPTION_KEY_PREVIOUS = oldKey;
      const ringService = new EncryptionService();

      expect(() => ringService.decrypt(foreignCiphertext)).toThrow();
      expect(() => ringService.decryptBound(foreignBoundCiphertext, context)).toThrow();
    });
  });
});