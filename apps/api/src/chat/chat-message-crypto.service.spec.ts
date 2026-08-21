import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ChatMessageCryptoService } from './chat-message-crypto.service';
import * as crypto from 'crypto';

describe('ChatMessageCryptoService', () => {
  let service: ChatMessageCryptoService;

  const TEST_KEY_HEX = crypto.randomBytes(32).toString('hex');

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatMessageCryptoService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'CHAT_ENCRYPTION_KEY') return TEST_KEY_HEX;
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ChatMessageCryptoService>(ChatMessageCryptoService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined and configured', () => {
    expect(service).toBeDefined();
    expect(service.isConfigured()).toBe(true);
  });

  it('should encrypt and decrypt plaintext using AES-256-GCM with correct AAD', async () => {
    const plaintext = 'Sensitive flight prompt and response history';
    const aad = 'ChatMessage:msg-1:session-100:USER:STANDARD:v1';

    const result = await service.encrypt(plaintext, aad);
    expect(result.ciphertext).toBeDefined();
    expect(result.nonce).toBeDefined();
    expect(result.authTag).toBeDefined();
    expect(result.keyVersion).toBe(1);

    const decrypted = await service.decrypt(
      result.ciphertext,
      result.nonce,
      result.authTag,
      aad,
      result.keyVersion,
    );
    expect(decrypted).toBe(plaintext);
  });

  it('should fail decryption when AAD is tampered with (record-bound protection)', async () => {
    const plaintext = 'User identity details';
    const validAad = 'ChatMessage:msg-2:session-100:USER:STANDARD:v1';
    const tamperedAad = 'ChatMessage:msg-2:session-200:USER:STANDARD:v1'; // different session ID

    const result = await service.encrypt(plaintext, validAad);

    await expect(
      service.decrypt(
        result.ciphertext,
        result.nonce,
        result.authTag,
        tamperedAad,
        result.keyVersion,
      ),
    ).rejects.toThrow();
  });

  it('should throw when decryption key version is unsupported', async () => {
    const plaintext = 'Test payload';
    const aad = 'ChatSession:sess-1:v1';
    const result = await service.encrypt(plaintext, aad);

    await expect(
      service.decrypt(
        result.ciphertext,
        result.nonce,
        result.authTag,
        aad,
        99, // unsupported key version
      ),
    ).rejects.toThrow(/Unsupported key version/);
  });

  it('should provide convenience methods for record-bound message content encryption and decryption', async () => {
    const messageId = 'msg-300';
    const sessionId = 'session-500';
    const sender = 'AGENT';
    const type = 'SUMMARY';
    const content = 'Flight to Hanoi confirmed for $450';

    // Calling convenience methods that are expected in T034
    const encrypted = await (service as any).encryptMessageContent(messageId, sessionId, sender, type, content);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.keyVersion).toBe(1);

    const decrypted = await (service as any).decryptMessageContent({
      id: messageId,
      sessionId,
      sender,
      type,
      contentCiphertext: encrypted.ciphertext,
      contentNonce: encrypted.nonce,
      contentAuthTag: encrypted.authTag,
      contentKeyVersion: encrypted.keyVersion,
      content: 'legacy fallback',
    });
    expect(decrypted).toBe(content);
  });

  it('should provide convenience methods for record-bound session title encryption and decryption', async () => {
    const sessionId = 'session-700';
    const title = 'Hanoi Trip Planning';

    const encrypted = await (service as any).encryptSessionTitle(sessionId, title);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.keyVersion).toBe(1);

    const decrypted = await (service as any).decryptSessionTitle({
      id: sessionId,
      titleCiphertext: encrypted.ciphertext,
      titleNonce: encrypted.nonce,
      titleAuthTag: encrypted.authTag,
      titleKeyVersion: encrypted.keyVersion,
    });
    expect(decrypted).toBe(title);
  });

  it('should throw an error on decryptMessageContent when ciphertext is corrupt (no legacy fallback)', async () => {
    const corruptMsg = {
      id: 'msg-err',
      sessionId: 'session-err',
      sender: 'USER',
      type: 'STANDARD',
      contentCiphertext: 'badciphertext1234',
      contentNonce: '0102030405060708090a0b0c',
      contentAuthTag: '0102030405060708090a0b0c0d0e0f10',
      contentKeyVersion: 1,
      content: 'legacy fallback that should NOT be returned',
    };

    await expect(
      (service as any).decryptMessageContent(corruptMsg),
    ).rejects.toThrow();
  });

  it('should throw CryptoKeyUnavailableError when CHAT_ENCRYPTION_KEY is not configured', async () => {
    const unconfiguredModule: TestingModule = await Test.createTestingModule({
      providers: [
        ChatMessageCryptoService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(null),
          },
        },
      ],
    }).compile();

    const unconfiguredService = unconfiguredModule.get<ChatMessageCryptoService>(ChatMessageCryptoService);
    expect(unconfiguredService.isConfigured()).toBe(false);

    await expect(
      unconfiguredService.decryptMessageContent({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        type: 'STANDARD',
        contentCiphertext: 'abcd',
        contentNonce: '1234',
        contentAuthTag: '5678',
        contentKeyVersion: 1,
      }),
    ).rejects.toThrow(/CHAT_ENCRYPTION_KEY is not configured/);
  });
});

