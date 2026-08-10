import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ChatHandoffTokenService } from './chat-handoff-token.service';

describe('ChatHandoffTokenService', () => {
  let service: ChatHandoffTokenService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatHandoffTokenService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'CHAT_HANDOFF_SECRET') return 'super-secret-key-for-handoff';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ChatHandoffTokenService>(ChatHandoffTokenService);
  });

  it('should derive server-side idempotency binding from attestation and index', () => {
    const attestation = 'sel_v1_payload.sig';
    const index = 1;
    const idempotencyHash = service.deriveIdempotencyHash(attestation, index);

    const idempotencyHash2 = service.deriveIdempotencyHash(attestation, index);
    expect(idempotencyHash).toEqual(idempotencyHash2);

    const idempotencyHash3 = service.deriveIdempotencyHash(attestation, 2);
    expect(idempotencyHash).not.toEqual(idempotencyHash3);
  });

  it('should generate a token and return hash-only storage fields', async () => {
    const idempotencyHash = 'idemp-hash-123';
    const rowId = 'uuid-row-123';

    const result = await service.generateToken(rowId, idempotencyHash);

    expect(result.token).toMatch(/^chk_handoff_v1_[A-Za-z0-9_-]{43}$/);
    expect(result.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.keyVersion).toBe(1);
    expect(result.token).not.toEqual(result.tokenHash);
  });

  it('should accept a generated token and reject an incorrect token', async () => {
    const idempotencyHash = 'idemp-hash-123';
    const rowId = 'uuid-row-123';

    const generated = await service.generateToken(rowId, idempotencyHash);

    const isValid = await service.verifyToken(generated.token, generated.tokenHash, generated.keyVersion);
    expect(isValid).toBe(true);

    const isInvalid = await service.verifyToken('wrong-token', generated.tokenHash, generated.keyVersion);
    expect(isInvalid).toBe(false);
  });

  it('should reject tokens if key version is unsupported', async () => {
    const isValid = await service.verifyToken('some-token', 'some-hash', 999);
    expect(isValid).toBe(false);
  });
});
