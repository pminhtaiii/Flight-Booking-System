import { DuffelSignatureService } from './duffel-signature.service';
import * as crypto from 'crypto';

describe('DuffelSignatureService', () => {
  let service: DuffelSignatureService;
  const secret = 'test-secret';
  const rawBody = Buffer.from(JSON.stringify({ event: 'test' }), 'utf8');

  beforeEach(() => {
    service = new DuffelSignatureService();
  });

  const getSignatureHeader = (timestamp: number, body: Buffer, key: string) => {
    const message = Buffer.concat([
      Buffer.from(String(timestamp), 'utf8'),
      Buffer.from('.', 'utf8'),
      body,
    ]);
    const sig = crypto.createHmac('sha256', key).update(message).digest('hex');
    return `t=${timestamp},v1=${sig}`;
  };

  it('should verify signature successfully with valid header and payload', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = getSignatureHeader(now, rawBody, secret);
    const result = service.verifySignature(rawBody, header, secret);
    expect(result).toBe(true);
  });

  it('should throw BadRequestException if signature header is missing', () => {
    expect(() => service.verifySignature(rawBody, undefined, secret)).toThrow(
      expect.objectContaining({
        message: 'Signature header is missing',
        response: expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_MISSING' }),
      }),
    );
  });

  it('should throw BadRequestException if signature header is malformed', () => {
    expect(() => service.verifySignature(rawBody, 't=123', secret)).toThrow(
      expect.objectContaining({
        message: 'Signature header is malformed',
        response: expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_INVALID' }),
      }),
    );
  });

  it('should throw BadRequestException if timestamp is invalid', () => {
    expect(() => service.verifySignature(rawBody, 't=abc,v1=xyz', secret)).toThrow(
      expect.objectContaining({
        message: 'Signature timestamp is invalid',
        response: expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_INVALID' }),
      }),
    );
  });

  it('should throw BadRequestException if signature timestamp is outside tolerance window', () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400;
    const header = getSignatureHeader(oldTimestamp, rawBody, secret);
    expect(() => service.verifySignature(rawBody, header, secret)).toThrow(
      expect.objectContaining({
        message: 'Signature timestamp is outside the tolerance window',
        response: expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_INVALID' }),
      }),
    );
  });

  it('should throw BadRequestException if signature value mismatch', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = `t=${now},v1=wrongsignature`;
    expect(() => service.verifySignature(rawBody, header, secret)).toThrow(
      expect.objectContaining({
        message: 'Signature verification failed',
        response: expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_INVALID' }),
      }),
    );
  });
});
