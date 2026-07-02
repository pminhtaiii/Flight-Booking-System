import { Injectable, UnauthorizedException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { ClaimTokenPayload } from './claim-token.types';
import { User } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class ClaimTokenService {
  private readonly logger = new Logger(ClaimTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  async validateToken(token: string): Promise<User> {
    if (!token) {
      this.logger.warn('Claim token is missing');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Missing user claim token',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      this.logger.warn('Claim token does not have exactly 2 parts');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Malformed claim token',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    const [payloadPart, signaturePart] = parts;

    let payloadStr: string;
    try {
      payloadStr = Buffer.from(payloadPart, 'base64url').toString('utf8');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to base64url-decode payload: ${msg}`);
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid claim token encoding',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    let payload: ClaimTokenPayload;
    try {
      payload = JSON.parse(payloadStr);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to parse payload JSON: ${msg}`);
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid claim token JSON',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    if (!payload || typeof payload.userId !== 'string' || typeof payload.iat !== 'number') {
      this.logger.warn('Claim token payload is missing userId or iat');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid claim token structure',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    const secret = process.env.CLAIM_TOKEN_SECRET;
    if (!secret) {
      this.logger.error('CLAIM_TOKEN_SECRET environment variable is not configured');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid claim token configuration',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    // Recompute HMAC-SHA256 signature
    const computedSignature = crypto
      .createHmac('sha256', secret)
      .update(payloadStr)
      .digest();

    let signatureBuffer: Buffer;
    try {
      signatureBuffer = Buffer.from(signaturePart, 'base64url');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to base64url-decode signature: ${msg}`);
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid claim token signature encoding',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    if (signatureBuffer.length !== computedSignature.length) {
      crypto.timingSafeEqual(computedSignature, computedSignature); // dummy check
      this.logger.warn('Claim token signature length mismatch');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid claim token signature',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    if (!crypto.timingSafeEqual(signatureBuffer, computedSignature)) {
      this.logger.warn('Claim token signature mismatch');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid claim token signature',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    // TTL check
    const ttlSeconds = process.env.CLAIM_TOKEN_TTL_SECONDS
      ? parseInt(process.env.CLAIM_TOKEN_TTL_SECONDS, 10)
      : 300;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - payload.iat > ttlSeconds) {
      this.logger.warn(`Claim token expired (iat: ${payload.iat}, now: ${nowSeconds}, ttl: ${ttlSeconds})`);
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Claim token has expired',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    // Database lookup
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user) {
      this.logger.warn(`User ${payload.userId} not found in database`);
      throw new ForbiddenException({
        statusCode: 403,
        message: 'User not found',
        code: 'USER_INACTIVE',
      });
    }

    if (user.status !== 'ACTIVE') {
      this.logger.warn(`User ${payload.userId} is inactive (status: ${user.status})`);
      throw new ForbiddenException({
        statusCode: 403,
        message: 'User account is inactive',
        code: 'USER_INACTIVE',
      });
    }

    return user;
  }
}
