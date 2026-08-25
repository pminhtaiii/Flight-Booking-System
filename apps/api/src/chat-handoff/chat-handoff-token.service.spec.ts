import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { ChatHandoffTokenService } from './chat-handoff-token.service';

describe('ChatHandoffTokenService', () => {
  let service: ChatHandoffTokenService;
  let configMap: Record<string, string | undefined>;

  const createService = async (customConfig: Record<string, string | undefined> = {}) => {
    configMap = {
      CHAT_HANDOFF_SECRET: 'test-secret-v1-fallback',
      ...customConfig,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatHandoffTokenService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => configMap[key] ?? null),
          },
        },
      ],
    }).compile();

    return module.get<ChatHandoffTokenService>(ChatHandoffTokenService);
  };

  beforeEach(async () => {
    service = await createService();
  });

  describe('getCurrentKeyVersion', () => {
    it('should return current key version 2', () => {
      expect(service.getCurrentKeyVersion()).toBe(2);
    });
  });

  describe('hashToken', () => {
    it('should return SHA256 hex digest of the given token', () => {
      const token = 'chk_handoff_v1_sample_token_credential';
      const expectedHash = crypto.createHash('sha256').update(token).digest('hex');

      const result = service.hashToken(token);

      expect(result).toBe(expectedHash);
      expect(result).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should be deterministic across multiple invocations', () => {
      const token = 'chk_handoff_v1_deterministic_test';
      const hash1 = service.hashToken(token);
      const hash2 = service.hashToken(token);

      expect(hash1).toBe(hash2);
    });
  });

  describe('deriveIdempotencyHash', () => {
    it('should derive server-side idempotency binding from attestation and offer index deterministically', () => {
      const attestation = 'sel_v1_eyJhbGciOiJIUzI1NiJ9.signature123';
      const index = 1;

      const hash1 = service.deriveIdempotencyHash(attestation, index);
      const hash2 = service.deriveIdempotencyHash(attestation, index);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce distinct hashes for different offer indices', () => {
      const attestation = 'sel_v1_eyJhbGciOiJIUzI1NiJ9.signature123';

      const hashOffer1 = service.deriveIdempotencyHash(attestation, 1);
      const hashOffer2 = service.deriveIdempotencyHash(attestation, 2);
      const hashOffer3 = service.deriveIdempotencyHash(attestation, 3);

      expect(hashOffer1).not.toEqual(hashOffer2);
      expect(hashOffer2).not.toEqual(hashOffer3);
      expect(hashOffer1).not.toEqual(hashOffer3);
    });

    it('should produce distinct hashes for different attestations with the same index', () => {
      const attestationA = 'sel_v1_attestation_A.sig';
      const attestationB = 'sel_v1_attestation_B.sig';

      const hashA = service.deriveIdempotencyHash(attestationA, 1);
      const hashB = service.deriveIdempotencyHash(attestationB, 1);

      expect(hashA).not.toEqual(hashB);
    });

    it('should throw error for non-positive or non-integer offer indices', () => {
      const attestation = 'sel_v1_valid.sig';

      expect(() => service.deriveIdempotencyHash(attestation, 0)).toThrow(
        'Invalid attestation or offer index for idempotency derivation',
      );
      expect(() => service.deriveIdempotencyHash(attestation, -1)).toThrow(
        'Invalid attestation or offer index for idempotency derivation',
      );
      expect(() => service.deriveIdempotencyHash(attestation, 1.5)).toThrow(
        'Invalid attestation or offer index for idempotency derivation',
      );
      expect(() => service.deriveIdempotencyHash(attestation, NaN)).toThrow(
        'Invalid attestation or offer index for idempotency derivation',
      );
      expect(() => service.deriveIdempotencyHash(attestation, null as unknown as number)).toThrow(
        'Invalid attestation or offer index for idempotency derivation',
      );
      expect(() => service.deriveIdempotencyHash(attestation, undefined as unknown as number)).toThrow(
        'Invalid attestation or offer index for idempotency derivation',
      );
    });

    it('should throw error for empty or invalid attestation strings', () => {
      expect(() => service.deriveIdempotencyHash('', 1)).toThrow(
        'Invalid attestation or offer index for idempotency derivation',
      );
      expect(() => service.deriveIdempotencyHash(null as unknown as string, 1)).toThrow(
        'Invalid attestation or offer index for idempotency derivation',
      );
      expect(() => service.deriveIdempotencyHash(undefined as unknown as string, 1)).toThrow(
        'Invalid attestation or offer index for idempotency derivation',
      );
      expect(() => service.deriveIdempotencyHash(123 as unknown as string, 1)).toThrow(
        'Invalid attestation or offer index for idempotency derivation',
      );
    });

    it('should throw error when secret is not configured', async () => {
      const unconfiguredService = await createService({
        CHAT_HANDOFF_SECRET: undefined,
        CHAT_HANDOFF_SECRET_V1: undefined,
        CHAT_HANDOFF_SECRET_V2: undefined,
        CHAT_HANDOFF_SECRET_CURRENT: undefined,
      });

      expect(() => unconfiguredService.deriveIdempotencyHash('sel_v1_test', 1)).toThrow(
        'CHAT_HANDOFF_SECRET is not configured for key version 2',
      );
    });
  });

  describe('generateToken', () => {
    it('should generate a token matching the standard format and return hash-only storage output', async () => {
      const rowId = 'uuid-row-456';
      const idempotencyHash = 'idemp-hash-789';

      const result = await service.generateToken(rowId, idempotencyHash);

      expect(result.token).toMatch(/^chk_handoff_v2_[A-Za-z0-9_-]{43}$/);
      expect(result.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.keyVersion).toBe(2);
      expect(result.token).not.toEqual(result.tokenHash);
      expect(result.tokenHash).toBe(service.hashToken(result.token));
    });

    it('should produce distinct tokens for different row IDs or idempotency hashes', async () => {
      const result1 = await service.generateToken('row-1', 'idemp-1');
      const result2 = await service.generateToken('row-2', 'idemp-1');
      const result3 = await service.generateToken('row-1', 'idemp-2');

      expect(result1.token).not.toEqual(result2.token);
      expect(result1.tokenHash).not.toEqual(result2.tokenHash);
      expect(result1.token).not.toEqual(result3.token);
      expect(result2.token).not.toEqual(result3.token);
    });

    it('should reject invalid or missing rowId', async () => {
      await expect(service.generateToken('', 'idemp-123')).rejects.toThrow(
        'Invalid rowId or idempotencyHash for token generation',
      );
      await expect(service.generateToken(null as unknown as string, 'idemp-123')).rejects.toThrow(
        'Invalid rowId or idempotencyHash for token generation',
      );
      await expect(service.generateToken(undefined as unknown as string, 'idemp-123')).rejects.toThrow(
        'Invalid rowId or idempotencyHash for token generation',
      );
    });

    it('should reject invalid or missing idempotencyHash', async () => {
      await expect(service.generateToken('row-123', '')).rejects.toThrow(
        'Invalid rowId or idempotencyHash for token generation',
      );
      await expect(service.generateToken('row-123', null as unknown as string)).rejects.toThrow(
        'Invalid rowId or idempotencyHash for token generation',
      );
      await expect(service.generateToken('row-123', undefined as unknown as string)).rejects.toThrow(
        'Invalid rowId or idempotencyHash for token generation',
      );
    });

    it('should throw error when secret is not configured for requested key version', async () => {
      await expect(service.generateToken('row-123', 'idemp-123', 999)).rejects.toThrow(
        'CHAT_HANDOFF_SECRET is not configured for key version 999',
      );
    });
  });

  describe('verifyToken', () => {
    it('should return true for valid token, matching tokenHash, and matching keyVersion', async () => {
      const rowId = 'uuid-row-789';
      const idempotencyHash = 'idemp-hash-abc';

      const generated = await service.generateToken(rowId, idempotencyHash);

      const isValid = await service.verifyToken(
        generated.token,
        generated.tokenHash,
        generated.keyVersion,
      );
      expect(isValid).toBe(true);
    });

    it('should return false for tampered or mismatched token', async () => {
      const rowId = 'uuid-row-789';
      const idempotencyHash = 'idemp-hash-abc';

      const generated = await service.generateToken(rowId, idempotencyHash);
      const tamperedToken = generated.token.slice(0, -1) + (generated.token.endsWith('a') ? 'b' : 'a');

      const isTamperedValid = await service.verifyToken(
        tamperedToken,
        generated.tokenHash,
        generated.keyVersion,
      );
      expect(isTamperedValid).toBe(false);

      const isWrongValid = await service.verifyToken(
        'chk_handoff_v1_completelyWrongTokenCredential1234567890',
        generated.tokenHash,
        generated.keyVersion,
      );
      expect(isWrongValid).toBe(false);
    });

    it('should return false for empty or non-string token', async () => {
      const validHash = 'a'.repeat(64);

      expect(await service.verifyToken('', validHash, 1)).toBe(false);
      expect(await service.verifyToken(null as unknown as string, validHash, 1)).toBe(false);
      expect(await service.verifyToken(undefined as unknown as string, validHash, 1)).toBe(false);
      expect(await service.verifyToken(123 as unknown as string, validHash, 1)).toBe(false);
    });

    it('should return false for empty or non-string storedTokenHash', async () => {
      const validToken = 'chk_handoff_v1_someValidTokenCredential1234567890123';

      expect(await service.verifyToken(validToken, '', 1)).toBe(false);
      expect(await service.verifyToken(validToken, null as unknown as string, 1)).toBe(false);
      expect(await service.verifyToken(validToken, undefined as unknown as string, 1)).toBe(false);
      expect(await service.verifyToken(validToken, 123 as unknown as string, 1)).toBe(false);
    });

    it('should return false for malformed or mismatched length storedTokenHash', async () => {
      const validToken = 'chk_handoff_v1_someValidTokenCredential1234567890123';

      expect(await service.verifyToken(validToken, 'short-hash', 1)).toBe(false);
      expect(await service.verifyToken(validToken, 'a'.repeat(32), 1)).toBe(false);
      expect(await service.verifyToken(validToken, 'z'.repeat(64), 1)).toBe(false);
    });

    it('should return false for invalid or unsupported keyVersion', async () => {
      const validToken = 'chk_handoff_v1_someValidTokenCredential1234567890123';
      const validHash = crypto.createHash('sha256').update(validToken).digest('hex');

      expect(await service.verifyToken(validToken, validHash, 0)).toBe(false);
      expect(await service.verifyToken(validToken, validHash, -1)).toBe(false);
      expect(await service.verifyToken(validToken, validHash, 1.5)).toBe(false);
      expect(await service.verifyToken(validToken, validHash, NaN)).toBe(false);
      expect(await service.verifyToken(validToken, validHash, 999)).toBe(false);
      expect(await service.verifyToken(validToken, validHash, null as unknown as number)).toBe(false);
    });

    it('should return false when secret is missing for the given keyVersion without throwing', async () => {
      const unconfiguredService = await createService({
        CHAT_HANDOFF_SECRET: undefined,
        CHAT_HANDOFF_SECRET_V1: undefined,
      });

      const token = 'chk_handoff_v1_someTokenCredential123456789012345678';
      const hash = crypto.createHash('sha256').update(token).digest('hex');

      const isValid = await unconfiguredService.verifyToken(token, hash, 1);
      expect(isValid).toBe(false);
    });
  });

  describe('Key rotation support', () => {
    it('should support key rotation with version-specific secrets', async () => {
      const rotatedService = await createService({
        CHAT_HANDOFF_SECRET_V1: 'secret-key-version-1',
        CHAT_HANDOFF_SECRET_V2: 'secret-key-version-2',
      });

      const v1Result = await rotatedService.generateToken('row-1', 'idemp-1', 1);
      const v2Result = await rotatedService.generateToken('row-1', 'idemp-1', 2);

      expect(v1Result.token).toMatch(/^chk_handoff_v1_/);
      expect(v1Result.keyVersion).toBe(1);

      expect(v2Result.token).toMatch(/^chk_handoff_v2_/);
      expect(v2Result.keyVersion).toBe(2);

      // Verify v1 token with v1 keyVersion
      expect(
        await rotatedService.verifyToken(v1Result.token, v1Result.tokenHash, 1),
      ).toBe(true);

      // Verify v2 token with v2 keyVersion
      expect(
        await rotatedService.verifyToken(v2Result.token, v2Result.tokenHash, 2),
      ).toBe(true);

      // Verify cross-version token rejection
      expect(
        await rotatedService.verifyToken(v1Result.token, v1Result.tokenHash, 2),
      ).toBe(false);
    });

    it('should fallback to CHAT_HANDOFF_SECRET for version 1 if CHAT_HANDOFF_SECRET_V1 is not set', async () => {
      const fallbackService = await createService({
        CHAT_HANDOFF_SECRET: 'legacy-fallback-secret',
        CHAT_HANDOFF_SECRET_V1: undefined,
      });

      const result = await fallbackService.generateToken('row-1', 'idemp-1', 1);
      expect(result.token).toMatch(/^chk_handoff_v1_/);
      expect(result.keyVersion).toBe(1);

      const isValid = await fallbackService.verifyToken(result.token, result.tokenHash, 1);
      expect(isValid).toBe(true);
    });

    it('should prefer CHAT_HANDOFF_SECRET_V1 over CHAT_HANDOFF_SECRET for version 1 if both exist', async () => {
      const priorityService = await createService({
        CHAT_HANDOFF_SECRET_V1: 'v1-specific-secret',
        CHAT_HANDOFF_SECRET: 'legacy-secret',
      });

      const result = await priorityService.generateToken('row-1', 'idemp-1', 1);

      // Expected token derived with 'v1-specific-secret'
      const expectedCredential = crypto
        .createHmac('sha256', 'v1-specific-secret')
        .update('row-1:idemp-1')
        .digest('base64url');
      const expectedToken = `chk_handoff_v1_${expectedCredential}`;

      expect(result.token).toBe(expectedToken);
    });

    it('should prefer CHAT_HANDOFF_SECRET_CURRENT over CHAT_HANDOFF_SECRET_V2 for version 2 when both are set', async () => {
      const priorityService = await createService({
        CHAT_HANDOFF_SECRET_CURRENT: 'current-secret',
        CHAT_HANDOFF_SECRET_V2: 'v2-specific-secret',
        CHAT_HANDOFF_SECRET: 'legacy-secret',
      });

      const result = await priorityService.generateToken('row-1', 'idemp-1', 2);

      const expectedCredential = crypto
        .createHmac('sha256', 'current-secret')
        .update('row-1:idemp-1')
        .digest('base64url');
      const expectedToken = `chk_handoff_v2_${expectedCredential}`;

      expect(result.token).toBe(expectedToken);
    });

    it('should fallback to CHAT_HANDOFF_SECRET_V2 for version 2 when CHAT_HANDOFF_SECRET_CURRENT is not set', async () => {
      const fallbackService = await createService({
        CHAT_HANDOFF_SECRET_CURRENT: undefined,
        CHAT_HANDOFF_SECRET_V2: 'v2-specific-secret',
        CHAT_HANDOFF_SECRET: 'legacy-secret',
      });

      const result = await fallbackService.generateToken('row-1', 'idemp-1', 2);

      const expectedCredential = crypto
        .createHmac('sha256', 'v2-specific-secret')
        .update('row-1:idemp-1')
        .digest('base64url');
      const expectedToken = `chk_handoff_v2_${expectedCredential}`;

      expect(result.token).toBe(expectedToken);
    });

    it('should prefer CHAT_HANDOFF_SECRET_CURRENT over CHAT_HANDOFF_SECRET_V3 for version 3 when both are set', async () => {
      const priorityService = await createService({
        CHAT_HANDOFF_SECRET_CURRENT: 'current-secret-v3-test',
        CHAT_HANDOFF_SECRET_V3: 'v3-specific-secret',
      });

      const result = await priorityService.generateToken('row-1', 'idemp-1', 3);

      const expectedCredential = crypto
        .createHmac('sha256', 'current-secret-v3-test')
        .update('row-1:idemp-1')
        .digest('base64url');
      const expectedToken = `chk_handoff_v3_${expectedCredential}`;

      expect(result.token).toBe(expectedToken);
    });
  });
});
