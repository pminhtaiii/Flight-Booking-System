import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  hashValue(val: string): string {
    return crypto.createHash('sha256').update(val).digest('hex');
  }

  private safeSanitize(val: any, visited = new Set<any>()): any {
    if (val === null || typeof val !== 'object') {
      return val;
    }
    if (visited.has(val)) {
      return '[Circular]';
    }
    visited.add(val);

    if (Array.isArray(val)) {
      const copy = val.map(item => this.safeSanitize(item, visited));
      visited.delete(val);
      return copy;
    }

    const copy: Record<string, any> = {};
    for (const key in val) {
      if (Object.prototype.hasOwnProperty.call(val, key)) {
        const lowerKey = key.toLowerCase();
        const value = val[key];

        if (lowerKey.includes('email')) {
          if (typeof value === 'string') {
            const hashKey = lowerKey === 'email' ? 'emailHash' : `${key}Hash`;
            copy[hashKey] = this.hashValue(value.trim().toLowerCase());
          }
        } else if (
          lowerKey.includes('password') ||
          lowerKey.includes('jwt') ||
          lowerKey.includes('token') ||
          lowerKey.includes('secret')
        ) {
          // Exclude these sensitive keys
        } else {
          copy[key] = this.safeSanitize(value, visited);
        }
      }
    }
    visited.delete(val);
    return copy;
  }

  sanitizeMetadata(metadata: any): any {
    if (!metadata) return {};
    return this.safeSanitize(metadata);
  }

  async createLog(
    prismaClient: any,
    data: {
      userId?: string | null;
      action: string;
      resourceType: string;
      resourceId?: string | null;
      metadata?: any;
      traceId?: string | null;
      correlationId?: string | null;
      ipAddress?: string | null;
    }
  ) {
    const client = prismaClient || this.prisma;
    
    // 1. Sanitize metadata
    const sanitizedMetadata = this.sanitizeMetadata(data.metadata || {});

    // Hash IP Address if provided and put it in metadata.ipAddress
    if (data.ipAddress) {
      sanitizedMetadata.ipAddress = this.hashValue(data.ipAddress);
    }

    // Put correlationId and traceId in metadata if provided
    if (data.correlationId) {
      sanitizedMetadata.correlationId = data.correlationId;
    }
    if (data.traceId) {
      sanitizedMetadata.traceId = data.traceId;
    }

    // 2. Resolve traceId and correlationId
    const traceId = data.traceId || crypto.randomUUID();
    const correlationId = data.correlationId || crypto.randomUUID();

    // 3. Write to database
    return client.auditLog.create({
      data: {
        userId: data.userId || null,
        action: data.action,
        resourceType: data.resourceType,
        resourceId: data.resourceId || null,
        metadata: sanitizedMetadata,
        traceId,
        correlationId,
      },
    });
  }
}
