import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  hashValue(val: string): string {
    return crypto.createHash('sha256').update(val).digest('hex');
  }

  private safeSanitize(val: unknown, visited = new Set<unknown>()): unknown {
    if (val === null || typeof val !== 'object') {
      return val;
    }
    if (visited.has(val)) {
      return '[Circular]';
    }
    visited.add(val);

    if (Array.isArray(val)) {
      const copy = val.map((item) => this.safeSanitize(item, visited));
      visited.delete(val);
      return copy;
    }

    const obj = val as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const lowerKey = key.toLowerCase();
        const value = obj[key];

        if (lowerKey.includes('email')) {
          if (typeof value === 'string') {
            const hashKey = lowerKey === 'email' ? 'emailHash' : `${key}Hash`;
            copy[hashKey] = this.hashValue(value.trim().toLowerCase());
          }
        } else if (
          lowerKey.includes('password') ||
          lowerKey.includes('jwt') ||
          lowerKey.includes('token') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('authorization') ||
          lowerKey.includes('cookie') ||
          lowerKey.includes('set-cookie') ||
          lowerKey.includes('ipaddress') ||
          lowerKey.includes('ip_address') ||
          lowerKey.includes('ip-address')
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

  sanitizeMetadata(metadata: unknown): Prisma.JsonObject {
    if (!metadata) return {};
    const sanitized = this.safeSanitize(metadata);
    return typeof sanitized === 'object' && sanitized !== null
      ? (sanitized as Prisma.JsonObject)
      : {};
  }

  async createLog(
    prismaClient: Prisma.TransactionClient | PrismaService | null,
    data: {
      userId?: string | null;
      action: string;
      resourceType: string;
      resourceId?: string | null;
      metadata?: unknown;
      traceId?: string | null;
      correlationId?: string | null;
      ipAddress?: string | null;
    },
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
