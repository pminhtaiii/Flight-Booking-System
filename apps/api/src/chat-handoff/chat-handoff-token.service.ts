import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export type TokenGenerationResult = {
  token: string;
  tokenHash: string;
  keyVersion: number;
};

@Injectable()
export class ChatHandoffTokenService {
  private readonly logger = new Logger(ChatHandoffTokenService.name);
  public readonly CURRENT_KEY_VERSION = 1;

  constructor(private readonly configService: ConfigService) {}

  getCurrentKeyVersion(): number {
    return this.CURRENT_KEY_VERSION;
  }

  private getSecretKey(version: number = this.CURRENT_KEY_VERSION): string {
    if (typeof version !== 'number' || version < 1 || !Number.isInteger(version)) {
      throw new Error(`CHAT_HANDOFF_SECRET is not configured for key version ${version}`);
    }

    let secret: string | undefined | null;
    if (version === 1) {
      secret =
        this.configService.get<string>('CHAT_HANDOFF_SECRET_V1') ||
        this.configService.get<string>('CHAT_HANDOFF_SECRET') ||
        this.configService.get<string>('CHAT_HANDOFF_SECRET_PREVIOUS');
    } else if (version === 2) {
      secret =
        this.configService.get<string>('CHAT_HANDOFF_SECRET_V2') ||
        this.configService.get<string>('CHAT_HANDOFF_SECRET_CURRENT') ||
        this.configService.get<string>('CHAT_HANDOFF_SECRET');
    } else {
      secret =
        this.configService.get<string>(`CHAT_HANDOFF_SECRET_V${version}`) ||
        this.configService.get<string>('CHAT_HANDOFF_SECRET_CURRENT');
    }

    if (!secret || secret.trim().length === 0) {
      throw new Error(`CHAT_HANDOFF_SECRET is not configured for key version ${version}`);
    }

    return secret;
  }

  deriveIdempotencyHash(
    attestation: string,
    index: number,
    keyVersion: number = this.CURRENT_KEY_VERSION,
  ): string {
    if (
      !attestation ||
      typeof attestation !== 'string' ||
      typeof index !== 'number' ||
      index < 1 ||
      !Number.isInteger(index)
    ) {
      throw new Error('Invalid attestation or offer index for idempotency derivation');
    }

    const attestationDigest = this.hashToken(attestation);
    const payload = `${attestationDigest}:${index}`;
    return crypto
      .createHmac('sha256', this.getSecretKey(keyVersion))
      .update(payload)
      .digest('hex');
  }

  computeIdempotencyHash(
    attestation: string,
    index: number,
    keyVersion: number = this.CURRENT_KEY_VERSION,
  ): string {
    return this.deriveIdempotencyHash(attestation, index, keyVersion);
  }


  async generateToken(
    rowId: string,
    idempotencyHash: string,
    keyVersion: number = this.CURRENT_KEY_VERSION,
  ): Promise<TokenGenerationResult> {
    if (
      !rowId ||
      typeof rowId !== 'string' ||
      !idempotencyHash ||
      typeof idempotencyHash !== 'string'
    ) {
      throw new Error('Invalid rowId or idempotencyHash for token generation');
    }

    const secret = this.getSecretKey(keyVersion);
    const tokenPayload = `${rowId}:${idempotencyHash}`;
    const credential = crypto
      .createHmac('sha256', secret)
      .update(tokenPayload)
      .digest('base64url');
    const token = `chk_handoff_v${keyVersion}_${credential}`;
    const tokenHash = this.hashToken(token);

    return {
      token,
      tokenHash,
      keyVersion,
    };
  }

  async verifyToken(
    token: string,
    storedTokenHash: string,
    keyVersion: number,
  ): Promise<boolean> {
    if (
      !token ||
      typeof token !== 'string' ||
      !storedTokenHash ||
      typeof storedTokenHash !== 'string' ||
      typeof keyVersion !== 'number' ||
      keyVersion < 1 ||
      !Number.isInteger(keyVersion)
    ) {
      return false;
    }

    if (!token.startsWith(`chk_handoff_v${keyVersion}_`)) {
      return false;
    }

    try {
      this.getSecretKey(keyVersion);
    } catch (err: unknown) {
      this.logger.warn(`[verifyToken] Secret key resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    const candidateTokenHash = this.hashToken(token);

    try {
      const candidateBuffer = Buffer.from(candidateTokenHash, 'hex');
      const storedBuffer = Buffer.from(storedTokenHash, 'hex');
      if (candidateBuffer.length !== storedBuffer.length || candidateBuffer.length !== 32) {
        return false;
      }
      return crypto.timingSafeEqual(candidateBuffer, storedBuffer);
    } catch (err: unknown) {
      this.logger.warn(`[verifyToken] Constant-time comparison failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  hashToken(token: string): string {
    if (!token || typeof token !== 'string') {
      return '';
    }
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
