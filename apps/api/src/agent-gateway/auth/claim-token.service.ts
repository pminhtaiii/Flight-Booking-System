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
    } catch {
      this.logger.warn('Failed to base64url-decode claim token payload');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid claim token encoding',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    let payload: ClaimTokenPayload;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      this.logger.warn('Failed to parse claim token payload JSON');
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

    // Support candidate key ring
    const candidateSecrets = [
      process.env.CLAIM_TOKEN_SECRET_CURRENT,
      process.env.CLAIM_TOKEN_SECRET,
      process.env.CLAIM_TOKEN_SECRET_PREVIOUS,
      process.env.CLAIM_TOKEN_SECRET_V2,
      process.env.CLAIM_TOKEN_SECRET_V1,
    ].filter((k): k is string => typeof k === 'string' && k.trim().length > 0);

    if (candidateSecrets.length === 0) {
      this.logger.error('CLAIM_TOKEN_SECRET environment variable is not configured');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid claim token configuration',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    let signatureBuffer: Buffer;
    try {
      signatureBuffer = Buffer.from(signaturePart, 'base64url');
    } catch {
      this.logger.warn('Failed to base64url-decode claim token signature');
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid claim token signature encoding',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    let isSignatureValid = false;
    for (const secret of candidateSecrets) {
      const computedSignature = crypto.createHmac('sha256', secret).update(payloadStr).digest();

      if (
        signatureBuffer.length === computedSignature.length &&
        crypto.timingSafeEqual(signatureBuffer, computedSignature)
      ) {
        isSignatureValid = true;
        break;
      }
    }

    if (!isSignatureValid) {
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
      this.logger.warn(
        `Claim token expired (iat: ${payload.iat}, now: ${nowSeconds}, ttl: ${ttlSeconds})`,
      );
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
      this.logger.warn('User not found in database for claim token');
      throw new ForbiddenException({
        statusCode: 403,
        message: 'User not found',
        code: 'USER_INACTIVE',
      });
    }

    if (user.status !== 'ACTIVE') {
      this.logger.warn(`User account is inactive for claim token (status: ${user.status})`);
      throw new ForbiddenException({
        statusCode: 403,
        message: 'User account is inactive',
        code: 'USER_INACTIVE',
      });
    }

    return user;
  }
}
