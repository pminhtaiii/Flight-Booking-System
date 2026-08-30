import { Injectable, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class DuffelSignatureService {
  verifySignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    secret: string,
    toleranceSeconds = 300, // 5 minutes default
  ): boolean {
    if (!signatureHeader) {
      throw new BadRequestException({
        message: 'Signature header is missing',
        error: 'WEBHOOK_SIGNATURE_MISSING',
      });
    }

    const parts = signatureHeader.split(',');
    let timestampStr: string | undefined;
    let signatureStr: string | undefined;

    for (const part of parts) {
      const trimmed = part.trim();
      const [key, val] = trimmed.split('=');
      if (key === 't') timestampStr = val;
      if (key === 'v1') signatureStr = val;
    }

    if (!timestampStr || !signatureStr) {
      throw new BadRequestException({
        message: 'Signature header is malformed',
        error: 'WEBHOOK_SIGNATURE_INVALID',
      });
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      throw new BadRequestException({
        message: 'Signature timestamp is invalid',
        error: 'WEBHOOK_SIGNATURE_INVALID',
      });
    }

    // Check replay tolerance
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      throw new BadRequestException({
        message: 'Signature timestamp is outside the tolerance window',
        error: 'WEBHOOK_SIGNATURE_INVALID',
      });
    }

    // Reconstruct the message: timestamp + "." + rawBody
    const message = Buffer.concat([
      Buffer.from(timestampStr, 'utf8'),
      Buffer.from('.', 'utf8'),
      rawBody,
    ]);

    const expectedSignature = crypto.createHmac('sha256', secret).update(message).digest('hex');

    // Constant-time comparison
    const sigBuffer = Buffer.from(signatureStr, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      throw new BadRequestException({
        message: 'Signature verification failed',
        error: 'WEBHOOK_SIGNATURE_INVALID',
      });
    }

    return true;
  }
}
