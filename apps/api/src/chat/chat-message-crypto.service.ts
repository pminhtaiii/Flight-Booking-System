import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_VERSION = 1;
const NONCE_LENGTH = 12; // 96-bit nonce recommended for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

@Injectable()
export class ChatMessageCryptoService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Returns true if CHAT_ENCRYPTION_KEY is configured.
   */
  isConfigured(): boolean {
    return Boolean(this.configService.get<string>('CHAT_ENCRYPTION_KEY'));
  }

  /**
   * Retrieves and validates the encryption key from config.
   * Throws if not configured (fail-safe).
   */
  private getKey(): Buffer {
    const keyHex = this.configService.get<string>('CHAT_ENCRYPTION_KEY');
    if (!keyHex) {
      throw new Error('CHAT_ENCRYPTION_KEY is not configured');
    }
    const keyBuffer = Buffer.from(keyHex, 'hex');
    if (keyBuffer.length !== 32) {
      throw new Error('CHAT_ENCRYPTION_KEY must be a 64-character hex string (32 bytes for AES-256)');
    }
    return keyBuffer;
  }

  /**
   * Encrypts plaintext using AES-256-GCM with the configured key.
   * @param plaintext - The string to encrypt
   * @param aad - Additional authenticated data (not encrypted, but authenticated)
   * @returns Encrypted payload including ciphertext, nonce, authTag (all hex-encoded), and keyVersion
   */
  async encrypt(
    plaintext: string,
    aad: string,
  ): Promise<{
    ciphertext: string;
    nonce: string;
    authTag: string;
    keyVersion: number;
  }> {
    const key = this.getKey();
    const nonce = crypto.randomBytes(NONCE_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    cipher.setAAD(Buffer.from(aad, 'utf8'));

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString('hex'),
      nonce: nonce.toString('hex'),
      authTag: authTag.toString('hex'),
      keyVersion: KEY_VERSION,
    };
  }

  /**
   * Decrypts ciphertext using AES-256-GCM, verifying the authTag.
   * @param ciphertext - Hex-encoded ciphertext
   * @param nonce - Hex-encoded nonce
   * @param authTag - Hex-encoded authentication tag
   * @param aad - Additional authenticated data used during encryption
   * @param keyVersion - Key version (currently only version 1 is supported)
   * @returns Decrypted plaintext string
   * @throws If key is not configured, keyVersion is unsupported, or auth tag verification fails
   */
  async decrypt(
    ciphertext: string,
    nonce: string,
    authTag: string,
    aad: string,
    keyVersion: number,
  ): Promise<string> {
    if (keyVersion !== KEY_VERSION) {
      throw new Error(`Unsupported key version: ${keyVersion}. Only version ${KEY_VERSION} is supported.`);
    }

    const key = this.getKey();

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(nonce, 'hex'),
      { authTagLength: AUTH_TAG_LENGTH },
    );

    // Must set auth tag before decryption to enforce verification
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'hex')),
      decipher.final(), // throws if auth tag verification fails
    ]);

    return decrypted.toString('utf8');
  }
}
