import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly primaryKey: Buffer;
  private readonly candidateKeys: Buffer[];

  constructor() {
    const { primaryKey, candidateKeys } = this.loadKeys();
    this.primaryKey = primaryKey;
    this.candidateKeys = candidateKeys;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.primaryKey, iv);
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

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    let lastError: Error | null = null;
    for (const key of this.candidateKeys) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
        return decrypted.toString('utf8');
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error('Decryption failed.');
  }

  encryptBound(plaintext: string, context: Record<string, string | number>): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.primaryKey, iv);

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

    const sortedKeys = Object.keys(context).sort();
    const sortedContext: Record<string, string | number> = {};
    for (const key of sortedKeys) {
      sortedContext[key] = context[key];
    }
    const aad = Buffer.from(JSON.stringify(sortedContext), 'utf8');

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    let lastError: Error | null = null;
    for (const key of this.candidateKeys) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
        return decrypted.toString('utf8');
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error('Decryption failed.');
  }

  private loadKeys(): { primaryKey: Buffer; candidateKeys: Buffer[] } {
    const primaryEnvNames = [
      'ENCRYPTION_KEY_CURRENT',
      'ENCRYPTION_KEY',
      'ENCRYPTION_KEY_V2',
      'ENCRYPTION_KEY_V1',
    ];
    const candidateEnvNames = [
      'ENCRYPTION_KEY_CURRENT',
      'ENCRYPTION_KEY',
      'ENCRYPTION_KEY_PREVIOUS',
      'ENCRYPTION_KEY_V2',
      'ENCRYPTION_KEY_V1',
    ];

    // Validate any explicitly configured key environment variable (fail-fast)
    for (const envName of candidateEnvNames) {
      const val = process.env[envName];
      if (val !== undefined && val.trim().length > 0) {
        if (!/^[0-9a-fA-F]{64}$/.test(val)) {
          throw new Error(`${envName} must be a 64-character hexadecimal string.`);
        }
      }
    }

    let primaryKeyHex: string | null = null;
    for (const envName of primaryEnvNames) {
      const val = process.env[envName];
      if (val && val.trim().length > 0) {
        primaryKeyHex = val;
        break;
      }
    }

    if (!primaryKeyHex) {
      throw new Error('ENCRYPTION_KEY must be a 64-character hexadecimal string.');
    }

    const primaryKey = Buffer.from(primaryKeyHex, 'hex');
    if (primaryKey.length !== 32) {
      this.logger.error('ENCRYPTION_KEY must decode to exactly 32 bytes.');
      throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes.');
    }

    const candidateKeyHexes = new Set<string>();
    candidateKeyHexes.add(primaryKeyHex.toLowerCase());

    for (const envName of candidateEnvNames) {
      const val = process.env[envName];
      if (val && val.trim().length > 0) {
        candidateKeyHexes.add(val.toLowerCase());
      }
    }

    const candidateKeys: Buffer[] = [];
    for (const hex of candidateKeyHexes) {
      const keyBuf = Buffer.from(hex, 'hex');
      if (keyBuf.length === 32) {
        candidateKeys.push(keyBuf);
      }
    }

    return { primaryKey, candidateKeys };
  }
}