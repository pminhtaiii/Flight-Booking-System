import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer;

  constructor() {
    this.key = this.loadKey();
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');

    if (parts.length !== 3) {
      throw new Error('Invalid encrypted payload format.');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;

    if (!ivHex || !authTagHex) {
      throw new Error('Invalid encrypted payload format.');
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivHex, 'hex'),
    );

    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, 'hex')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  encryptBound(plaintext: string, context: Record<string, string | number>): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);

    const sortedKeys = Object.keys(context).sort();
    const sortedContext: Record<string, string | number> = {};
    for (const key of sortedKeys) {
      sortedContext[key] = context[key];
    }
    const aad = Buffer.from(JSON.stringify(sortedContext), 'utf8');
    cipher.setAAD(aad);

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return ['v1', iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
  }

  decryptBound(payload: string, context: Record<string, string | number>): string {
    if (!payload.startsWith('v1:')) {
      // Backward compatibility: decrypt legacy unbound ciphertext
      return this.decrypt(payload);
    }

    const parts = payload.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted payload format.');
    }

    const [version, ivHex, authTagHex, encryptedHex] = parts;
    if (version !== 'v1' || !ivHex || !authTagHex) {
      throw new Error('Invalid encrypted payload format.');
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivHex, 'hex'),
    );

    const sortedKeys = Object.keys(context).sort();
    const sortedContext: Record<string, string | number> = {};
    for (const key of sortedKeys) {
      sortedContext[key] = context[key];
    }
    const aad = Buffer.from(JSON.stringify(sortedContext), 'utf8');
    decipher.setAAD(aad);

    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, 'hex')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  private loadKey(): Buffer {
    const encodedKey = process.env.ENCRYPTION_KEY;

    if (!encodedKey || !/^[0-9a-fA-F]{64}$/.test(encodedKey)) {
      throw new Error('ENCRYPTION_KEY must be a 64-character hexadecimal string.');
    }

    const key = Buffer.from(encodedKey, 'hex');

    if (key.length !== 32) {
      this.logger.error('ENCRYPTION_KEY must decode to exactly 32 bytes.');
      throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes.');
    }

    return key;
  }
}