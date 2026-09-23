import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  ChatMessageCryptoService,
  CryptoKeyUnavailableError,
  UnsupportedKeyVersionError,
} from '@/chat/chat-message-crypto.service';

describe('ChatMessageCryptoService (common)', () => {
  let service: ChatMessageCryptoService;
  const TEST_KEY_HEX = crypto.randomBytes(32).toString('hex');
  const randomHex = (bytes: number): string => crypto.randomBytes(bytes).toString('hex');
  const mockNonce = (): string => randomHex(12);
  const mockAuthTag = (): string => randomHex(16);
  const mockCiphertext = (): string => randomHex(16);

  const createServiceWithKey = async (
    key: string | null = TEST_KEY_HEX,
  ): Promise<ChatMessageCryptoService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatMessageCryptoService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((configKey: string) => {
              if (configKey === 'CHAT_ENCRYPTION_KEY') return key;
              return null;
            }),
          },
        },
      ],
    }).compile();

    return module.get<ChatMessageCryptoService>(ChatMessageCryptoService);
  };

  beforeEach(async () => {
    service = await createServiceWithKey(TEST_KEY_HEX);
  });

  describe('isConfigured()', () => {
    it('returns true when CHAT_ENCRYPTION_KEY is present', () => {
      expect(service.isConfigured()).toBe(true);
    });

    it('returns false when CHAT_ENCRYPTION_KEY is absent', async () => {
      const unconfigured = await createServiceWithKey(null);
      expect(unconfigured.isConfigured()).toBe(false);
    });
  });

  describe('AES-256-GCM encryption & envelope format', () => {
    it('encrypts plaintext into hex envelope with 12-byte nonce, 16-byte authTag, keyVersion 1, record-bound AAD', async () => {
      const plaintext = 'Sensitive flight prompt and response history';
      const aad = 'ChatMessage:msg-1:session-100:USER:STANDARD:v1';

      const result = await service.encrypt(plaintext, aad);

      expect(result.keyVersion).toBe(1);
      // 12-byte nonce => 24 hex characters
      expect(result.nonce).toMatch(/^[0-9a-f]{24}$/i);
      // 16-byte authTag => 32 hex characters
      expect(result.authTag).toMatch(/^[0-9a-f]{32}$/i);
      // Ciphertext should be valid hex
      expect(result.ciphertext).toMatch(/^[0-9a-f]+$/i);
    });
  });

  describe('decryption & tampering resistance', () => {
    it('decrypts ciphertext with matching AAD', async () => {
      const plaintext = 'Sensitive booking data';
      const aad = 'ChatMessage:msg-1:session-100:USER:STANDARD:v1';

      const encrypted = await service.encrypt(plaintext, aad);
      const decrypted = await service.decrypt(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        aad,
        encrypted.keyVersion,
      );

      expect(decrypted).toBe(plaintext);
    });

    it('throws error when AAD is tampered with', async () => {
      const plaintext = 'User identity details';
      const validAad = 'ChatMessage:msg-2:session-100:USER:STANDARD:v1';
      const tamperedAad = 'ChatMessage:msg-2:session-200:USER:STANDARD:v1';

      const encrypted = await service.encrypt(plaintext, validAad);

      await expect(
        service.decrypt(
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          tamperedAad,
          encrypted.keyVersion,
        ),
      ).rejects.toThrow();
    });

    it('throws error when auth tag is tampered with', async () => {
      const plaintext = 'Payment card reference';
      const aad = 'ChatMessage:msg-3:session-100:USER:STANDARD:v1';

      const encrypted = await service.encrypt(plaintext, aad);
      const tamperedAuthTag = crypto.randomBytes(16).toString('hex');

      await expect(
        service.decrypt(
          encrypted.ciphertext,
          encrypted.nonce,
          tamperedAuthTag,
          aad,
          encrypted.keyVersion,
        ),
      ).rejects.toThrow();
    });

    it('throws error when ciphertext is tampered with', async () => {
      const plaintext = 'Flight itinerary summary';
      const aad = 'ChatMessage:msg-4:session-100:USER:STANDARD:v1';

      const encrypted = await service.encrypt(plaintext, aad);
      const tamperedCiphertext =
        encrypted.ciphertext.slice(0, -2) +
        (encrypted.ciphertext.endsWith('00') ? 'ff' : '00');

      await expect(
        service.decrypt(
          tamperedCiphertext,
          encrypted.nonce,
          encrypted.authTag,
          aad,
          encrypted.keyVersion,
        ),
      ).rejects.toThrow();
    });
  });

  describe('empty plaintext envelope handling', () => {
    it('encrypts and decrypts empty plaintext with complete envelope', async () => {
      const aad = 'ChatMessage:msg-empty:session-empty:AGENT:STANDARD:v1';

      const encrypted = await service.encrypt('', aad);
      expect(encrypted.ciphertext).toBe('');
      expect(encrypted.nonce).toMatch(/^[0-9a-f]{24}$/i);
      expect(encrypted.authTag).toMatch(/^[0-9a-f]{32}$/i);
      expect(encrypted.keyVersion).toBe(1);

      const decrypted = await service.decrypt(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        aad,
        encrypted.keyVersion,
      );
      expect(decrypted).toBe('');

      const msgEncrypted = await service.encryptMessageContent(
        'msg-empty',
        'session-empty',
        'AGENT',
        'STANDARD',
        '',
      );
      expect(msgEncrypted.ciphertext).toBe('');
      expect(msgEncrypted.nonce).toMatch(/^[0-9a-f]{24}$/i);
      expect(msgEncrypted.authTag).toMatch(/^[0-9a-f]{32}$/i);
      expect(msgEncrypted.keyVersion).toBe(1);

      const msgDecrypted = await service.decryptMessageContent({
        id: 'msg-empty',
        sessionId: 'session-empty',
        sender: 'AGENT',
        type: 'STANDARD',
        contentCiphertext: msgEncrypted.ciphertext,
        contentNonce: msgEncrypted.nonce,
        contentAuthTag: msgEncrypted.authTag,
        contentKeyVersion: msgEncrypted.keyVersion,
      });
      expect(msgDecrypted).toBe('');
    });

    it('rejects incomplete/corrupt empty-content envelope', async () => {
      const encrypted = await service.encryptMessageContent(
        'msg-incomplete',
        'session-incomplete',
        'AGENT',
        'STANDARD',
        '',
      );
      const completeEnvelope = {
        id: 'msg-incomplete',
        sessionId: 'session-incomplete',
        sender: 'AGENT',
        type: 'STANDARD',
        contentCiphertext: encrypted.ciphertext,
        contentNonce: encrypted.nonce,
        contentAuthTag: encrypted.authTag,
        contentKeyVersion: encrypted.keyVersion,
      };

      for (const field of [
        'contentCiphertext',
        'contentNonce',
        'contentAuthTag',
        'contentKeyVersion',
      ] as const) {
        await expect(
          service.decryptMessageContent({
            ...completeEnvelope,
            [field]: null,
          }),
        ).rejects.toThrow(/missing ciphertext envelope or is corrupted/);
      }
    });
  });

  describe('unsupported key version handling', () => {
    it('throws UnsupportedKeyVersionError when decrypting with unsupported key version', async () => {
      const plaintext = 'Test payload';
      const aad = 'ChatSession:sess-1:v1';
      const encrypted = await service.encrypt(plaintext, aad);

      await expect(
        service.decrypt(
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          aad,
          99,
        ),
      ).rejects.toThrow(UnsupportedKeyVersionError);

      await expect(
        service.decrypt(
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          aad,
          99,
        ),
      ).rejects.toThrow(/Unsupported key version: 99/);
    });

    it('throws UnsupportedKeyVersionError in decryptMessageContent for unsupported version', async () => {
      await expect(
        service.decryptMessageContent({
          id: 'msg-unsupported',
          sessionId: 'session-unsupported',
          sender: 'USER',
          type: 'STANDARD',
          contentCiphertext: mockCiphertext(),
          contentNonce: mockNonce(),
          contentAuthTag: mockAuthTag(),
          contentKeyVersion: 2,
        }),
      ).rejects.toThrow(UnsupportedKeyVersionError);
    });

    it('throws UnsupportedKeyVersionError in decryptSessionTitle for unsupported version', async () => {
      await expect(
        service.decryptSessionTitle({
          id: 'session-unsupported',
          titleCiphertext: mockCiphertext(),
          titleNonce: mockNonce(),
          titleAuthTag: mockAuthTag(),
          titleKeyVersion: 3,
        }),
      ).rejects.toThrow(UnsupportedKeyVersionError);
    });
  });

  describe('missing / invalid key handling', () => {
    it('throws CryptoKeyUnavailableError when CHAT_ENCRYPTION_KEY is not configured', async () => {
      const unconfigured = await createServiceWithKey(null);
      expect(unconfigured.isConfigured()).toBe(false);

      await expect(unconfigured.encrypt('hello', 'aad')).rejects.toThrow(
        CryptoKeyUnavailableError,
      );

      await expect(
        unconfigured.decrypt(
          randomHex(1),
          mockNonce(),
          mockAuthTag(),
          'aad',
          1,
        ),
      ).rejects.toThrow(CryptoKeyUnavailableError);

      await expect(
        unconfigured.decryptMessageContent({
          id: 'msg-1',
          sessionId: 'session-1',
          sender: 'USER',
          type: 'STANDARD',
          contentCiphertext: mockCiphertext(),
          contentNonce: mockNonce(),
          contentAuthTag: mockAuthTag(),
          contentKeyVersion: 1,
        }),
      ).rejects.toThrow(CryptoKeyUnavailableError);

      await expect(
        unconfigured.decryptSessionTitle({
          id: 'session-1',
          titleCiphertext: mockCiphertext(),
          titleNonce: mockNonce(),
          titleAuthTag: mockAuthTag(),
          titleKeyVersion: 1,
        }),
      ).rejects.toThrow(CryptoKeyUnavailableError);
    });

    it('throws CryptoKeyUnavailableError when key length is invalid', async () => {
      const shortKey = await createServiceWithKey(randomHex(5));
      await expect(shortKey.encrypt('hello', 'aad')).rejects.toThrow(
        CryptoKeyUnavailableError,
      );
    });
  });

  describe('helper methods', () => {
    it('encrypts and decrypts message content using encryptMessageContent and decryptMessageContent', async () => {
      const messageId = 'msg-300';
      const sessionId = 'session-500';
      const sender = 'AGENT';
      const type = 'SUMMARY';
      const content = 'Flight to Hanoi confirmed for $450';

      const encrypted = await service.encryptMessageContent(
        messageId,
        sessionId,
        sender,
        type,
        content,
      );
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.nonce).toMatch(/^[0-9a-f]{24}$/i);
      expect(encrypted.authTag).toMatch(/^[0-9a-f]{32}$/i);
      expect(encrypted.keyVersion).toBe(1);

      const decrypted = await service.decryptMessageContent({
        id: messageId,
        sessionId,
        sender,
        type,
        contentCiphertext: encrypted.ciphertext,
        contentNonce: encrypted.nonce,
        contentAuthTag: encrypted.authTag,
        contentKeyVersion: encrypted.keyVersion,
      });
      expect(decrypted).toBe(content);
    });

    it('fails decryptMessageContent when metadata / AAD does not match', async () => {
      const encrypted = await service.encryptMessageContent(
        'msg-400',
        'session-600',
        'USER',
        'STANDARD',
        'Secret travel plan',
      );

      await expect(
        service.decryptMessageContent({
          id: 'msg-400',
          sessionId: 'different-session',
          sender: 'USER',
          type: 'STANDARD',
          contentCiphertext: encrypted.ciphertext,
          contentNonce: encrypted.nonce,
          contentAuthTag: encrypted.authTag,
          contentKeyVersion: encrypted.keyVersion,
        }),
      ).rejects.toThrow(/Failed to decrypt ChatMessage content/);
    });

    it('fails decryptMessageContent when ciphertext is corrupt', async () => {
      const corruptMsg = {
        id: 'msg-err',
        sessionId: 'session-err',
        sender: 'USER',
        type: 'STANDARD',
        contentCiphertext: mockCiphertext(),
        contentNonce: mockNonce(),
        contentAuthTag: mockAuthTag(),
        contentKeyVersion: 1,
      };

      await expect(service.decryptMessageContent(corruptMsg)).rejects.toThrow(
        /Failed to decrypt ChatMessage content/,
      );
    });

    it('encrypts and decrypts session title using encryptSessionTitle and decryptSessionTitle', async () => {
      const sessionId = 'session-700';
      const title = 'Hanoi Trip Planning';

      const encrypted = await service.encryptSessionTitle(sessionId, title);
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.nonce).toMatch(/^[0-9a-f]{24}$/i);
      expect(encrypted.authTag).toMatch(/^[0-9a-f]{32}$/i);
      expect(encrypted.keyVersion).toBe(1);

      const decrypted = await service.decryptSessionTitle({
        id: sessionId,
        titleCiphertext: encrypted.ciphertext,
        titleNonce: encrypted.nonce,
        titleAuthTag: encrypted.authTag,
        titleKeyVersion: encrypted.keyVersion,
      });
      expect(decrypted).toBe(title);
    });

    it('returns null from decryptSessionTitle when title envelope fields are absent', async () => {
      const result = await service.decryptSessionTitle({
        id: 'session-no-title',
        titleCiphertext: null,
        titleNonce: null,
        titleAuthTag: null,
        titleKeyVersion: null,
      });
      expect(result).toBeNull();
    });

    it('throws error in decryptSessionTitle when session envelope is corrupt', async () => {
      await expect(
        service.decryptSessionTitle({
          id: 'session-corrupt',
          titleCiphertext: mockCiphertext(),
          titleNonce: mockNonce(),
          titleAuthTag: mockAuthTag(),
          titleKeyVersion: 1,
        }),
      ).rejects.toThrow(/Failed to decrypt ChatSession title/);
    });

    it('throws error in decryptSessionTitle when envelope is incomplete', async () => {
      await expect(
        service.decryptSessionTitle({
          id: 'session-incomplete',
          titleCiphertext: mockCiphertext(),
          titleNonce: null,
          titleAuthTag: mockAuthTag(),
          titleKeyVersion: 1,
        }),
      ).rejects.toThrow(
        /ChatSession title is missing ciphertext envelope or is corrupted/,
      );
    });
  });
});
