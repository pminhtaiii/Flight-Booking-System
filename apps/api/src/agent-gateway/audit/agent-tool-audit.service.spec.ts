import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AgentToolAuditService } from './agent-tool-audit.service';
import { AgentToolAuditRecord } from './agent-tool-audit.types';

describe('AgentToolAuditService', () => {
  let service: AgentToolAuditService;
  let mockPrismaService: {
    auditLog: {
      create: jest.Mock;
    };
  };

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  beforeEach(async () => {
    mockPrismaService = {
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-log-1' }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentToolAuditService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<AgentToolAuditService>(AgentToolAuditService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('recordToolExecution', () => {
    it('should successfully record tool execution with allowlisted metadata and provided IDs', async () => {
      const record: AgentToolAuditRecord = {
        toolName: 'flight_search',
        outcome: 'SUCCESS',
        durationMs: 245,
        responseSizeBytes: 4096,
        traceId: 'trace-123',
        correlationId: 'corr-456',
        actorId: 'user-789',
        occurredAt: '2026-08-25T10:00:00.000Z',
      };

      await service.recordToolExecution(record);

      expect(mockPrismaService.auditLog.create).toHaveBeenCalledTimes(1);
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-789',
          action: 'AGENT_TOOL_CALL',
          resourceType: 'agent-gateway',
          resourceId: 'flight_search',
          metadata: {
            toolName: 'flight_search',
            outcome: 'SUCCESS',
            durationMs: 245,
            responseSizeBytes: 4096,
            occurredAt: '2026-08-25T10:00:00.000Z',
          },
          traceId: 'trace-123',
          correlationId: 'corr-456',
        },
      });
    });

    it('should include errorCode in metadata when outcome is FAILURE and errorCode is provided', async () => {
      const record: AgentToolAuditRecord = {
        toolName: 'booking_create',
        outcome: 'FAILURE',
        durationMs: 512,
        responseSizeBytes: 128,
        traceId: 'trace-abc',
        correlationId: 'corr-xyz',
        actorId: 'agent-007',
        errorCode: 'DUFFEL_RATE_LIMIT_EXCEEDED',
        occurredAt: '2026-08-25T10:05:00.000Z',
      };

      await service.recordToolExecution(record);

      expect(mockPrismaService.auditLog.create).toHaveBeenCalledTimes(1);
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: {
          userId: 'agent-007',
          action: 'AGENT_TOOL_CALL',
          resourceType: 'agent-gateway',
          resourceId: 'booking_create',
          metadata: {
            toolName: 'booking_create',
            outcome: 'FAILURE',
            durationMs: 512,
            responseSizeBytes: 128,
            occurredAt: '2026-08-25T10:05:00.000Z',
            errorCode: 'DUFFEL_RATE_LIMIT_EXCEEDED',
          },
          traceId: 'trace-abc',
          correlationId: 'corr-xyz',
        },
      });
    });

    it('should enforce negative privacy by ignoring un-allowlisted or PII-bearing fields', async () => {
      // Create a payload with sensitive fields injected beyond the type definition
      const recordWithPii = {
        toolName: 'ancillary_selection',
        outcome: 'SUCCESS' as const,
        durationMs: 150,
        responseSizeBytes: 2048,
        traceId: 'trace-sec-1',
        correlationId: 'corr-sec-2',
        actorId: 'user-vip',
        occurredAt: '2026-08-25T10:10:00.000Z',
        // Un-allowlisted / sensitive fields:
        passengerDetails: [{ firstName: 'Jane', lastName: 'Doe', passportNumber: 'P987654321' }],
        creditCard: { cardNumber: '4111-2222-3333-4444', cvv: '123' },
        duffelOfferId: 'off_duffel_secret_123',
        customerMessage: 'Please book flight to London for Jane Doe',
        rawPayload: { query: 'London to Paris' },
      } as unknown as AgentToolAuditRecord;

      await service.recordToolExecution(recordWithPii);

      expect(mockPrismaService.auditLog.create).toHaveBeenCalledTimes(1);
      const callData = mockPrismaService.auditLog.create.mock.calls[0][0].data;

      // Metadata must only contain strictly allowlisted fields
      expect(callData.metadata).toEqual({
        toolName: 'ancillary_selection',
        outcome: 'SUCCESS',
        durationMs: 150,
        responseSizeBytes: 2048,
        occurredAt: '2026-08-25T10:10:00.000Z',
      });

      // Explicitly verify sensitive properties are not present anywhere in metadata
      const metadata = callData.metadata as Record<string, unknown>;
      expect(metadata['passengerDetails']).toBeUndefined();
      expect(metadata['creditCard']).toBeUndefined();
      expect(metadata['duffelOfferId']).toBeUndefined();
      expect(metadata['customerMessage']).toBeUndefined();
      expect(metadata['rawPayload']).toBeUndefined();
    });

    it('should generate fallback UUIDs when traceId or correlationId is missing or null', async () => {
      const record: AgentToolAuditRecord = {
        toolName: 'preferences_get',
        outcome: 'SUCCESS',
        durationMs: 80,
        responseSizeBytes: 512,
        traceId: null,
        correlationId: null,
        actorId: null,
        occurredAt: '2026-08-25T10:15:00.000Z',
      };

      await service.recordToolExecution(record);

      expect(mockPrismaService.auditLog.create).toHaveBeenCalledTimes(1);
      const callData = mockPrismaService.auditLog.create.mock.calls[0][0].data;

      expect(callData.userId).toBeNull();
      expect(callData.traceId).toBeDefined();
      expect(callData.traceId).toMatch(UUID_REGEX);
      expect(callData.correlationId).toBeDefined();
      expect(callData.correlationId).toMatch(UUID_REGEX);
    });

    it('should generate fallback UUIDs when traceId and correlationId are undefined', async () => {
      const record: AgentToolAuditRecord = {
        toolName: 'flight_details',
        outcome: 'SUCCESS',
        durationMs: 95,
        responseSizeBytes: 1024,
        occurredAt: '2026-08-25T10:20:00.000Z',
      };

      await service.recordToolExecution(record);

      expect(mockPrismaService.auditLog.create).toHaveBeenCalledTimes(1);
      const callData = mockPrismaService.auditLog.create.mock.calls[0][0].data;

      expect(callData.userId).toBeNull();
      expect(callData.traceId).toMatch(UUID_REGEX);
      expect(callData.correlationId).toMatch(UUID_REGEX);
    });

    it('should catch database errors and log them without throwing unhandled exceptions', async () => {
      const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      mockPrismaService.auditLog.create.mockRejectedValueOnce(new Error('DB connection failed'));

      const record: AgentToolAuditRecord = {
        toolName: 'flight_search',
        outcome: 'FAILURE',
        durationMs: 300,
        responseSizeBytes: 0,
        occurredAt: '2026-08-25T10:25:00.000Z',
      };

      await expect(service.recordToolExecution(record)).resolves.not.toThrow();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to record agent tool execution audit log: DB connection failed'),
        expect.any(String),
      );

      loggerErrorSpy.mockRestore();
    });
  });
});
