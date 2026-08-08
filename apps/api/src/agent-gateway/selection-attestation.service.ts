import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class SelectionAttestationService {
  constructor(private configService: ConfigService) {}

  private get secretKey(): string {
    const secret = this.configService.get<string>('ATTESTATION_SECRET');
    if (!secret) {
      throw new Error('ATTESTATION_SECRET is not configured');
    }
    return secret;
  }

  async signSelectionAttestation(
    userId: string,
    sessionId: string,
    version: number,
    expiresAt: string,
    offers: { flightOfferId: string; duffelOfferId: string }[],
  ): Promise<string> {
    const payload = JSON.stringify({ userId, sessionId, version, expiresAt, offers });
    const signature = crypto
      .createHmac('sha256', this.secretKey)
      .update(payload)
      .digest('hex');

    const base64Payload = Buffer.from(payload).toString('base64url');
    return `sel_v1_${base64Payload}.${signature}`;
  }

  async verifySelectionAttestation(
    attestation: string,
    userId: string,
    sessionId: string,
    version: number,
    offers: { flightOfferId: string; duffelOfferId: string }[],
  ): Promise<boolean> {
    const parts = attestation.split('_v1_');
    if (parts.length !== 2) throw new UnauthorizedException('Invalid attestation format');

    const [payloadBase64, signature] = parts[1].split('.');
    if (!payloadBase64 || !signature) throw new UnauthorizedException('Invalid attestation format');

    const payloadStr = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    let payload;
    try {
      payload = JSON.parse(payloadStr);
    } catch (e) {
      throw new UnauthorizedException('Invalid attestation payload');
    }

    if (payload.userId !== userId) throw new UnauthorizedException('User mismatch');
    if (payload.sessionId !== sessionId) throw new UnauthorizedException('Session mismatch');
    if (payload.version !== version) throw new UnauthorizedException('Version mismatch');
    
    if (new Date(payload.expiresAt) < new Date()) throw new UnauthorizedException('Attestation expired');
    
    if (JSON.stringify(payload.offers) !== JSON.stringify(offers)) {
      throw new UnauthorizedException('Offers mismatch');
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.secretKey)
      .update(payloadStr)
      .digest('hex');

    let isValid = false;
    try {
      isValid = crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );
    } catch (e) {
      isValid = false;
    }

    if (!isValid) {
      throw new UnauthorizedException('Invalid signature');
    }

    return true;
  }
}
