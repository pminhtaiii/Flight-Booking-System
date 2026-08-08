import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface TokenGenerationResult {
  token: string;
  tokenHash: string;
  keyVersion: number;
}

@Injectable()
export class ChatHandoffTokenService {
  private readonly CURRENT_KEY_VERSION = 1;

  constructor(private configService: ConfigService) {}

  private get secretKey(): string {
    const secret = this.configService.get<string>('CHAT_HANDOFF_SECRET');
    if (!secret) {
      throw new Error('CHAT_HANDOFF_SECRET is not configured');
    }
    return secret;
  }

  deriveIdempotencyHash(attestation: string, index: number): string {
    const payload = JSON.stringify({ attestation, index });
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(payload)
      .digest('hex');
  }

  async generateToken(rowId: string, idempotencyHash: string): Promise<TokenGenerationResult> {
    const tokenPayload = `${rowId}:${idempotencyHash}`;
    
    // High-entropy HMAC credential
    const token = crypto
      .createHmac('sha256', this.secretKey)
      .update(tokenPayload)
      .digest('base64url');

    // Hash the token for storage (hash-only)
    const tokenHash = this.hashToken(token);

    return {
      token,
      tokenHash,
      keyVersion: this.CURRENT_KEY_VERSION,
    };
  }

  async verifyToken(token: string, storedTokenHash: string, keyVersion: number): Promise<boolean> {
    if (keyVersion !== this.CURRENT_KEY_VERSION) {
      return false;
    }

    const tokenHash = this.hashToken(token);
    
    try {
      // Constant-time verification
      return crypto.timingSafeEqual(
        Buffer.from(tokenHash, 'hex'),
        Buffer.from(storedTokenHash, 'hex')
      );
    } catch (e) {
      // Catch error if lengths are different
      return false;
    }
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
