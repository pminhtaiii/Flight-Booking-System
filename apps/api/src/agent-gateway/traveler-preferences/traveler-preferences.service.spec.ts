import { Test, TestingModule } from '@nestjs/testing';
import { TravelerPreferencesService } from './traveler-preferences.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';
import { NotFoundException, HttpException } from '@nestjs/common';

describe('TravelerPreferencesService', () => {
  let service: TravelerPreferencesService;
  let prismaService: any;
  let agentToolAuditService: any;

  beforeEach(async () => {
    prismaService = {
      travelerProfile: {
        findUnique: jest.fn(),
      },
    };
    agentToolAuditService = {
      recordToolExecution: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TravelerPreferencesService,
        { provide: PrismaService, useValue: prismaService },
        { provide: AgentToolAuditService, useValue: agentToolAuditService },
      ],
    }).compile();

    service = module.get<TravelerPreferencesService>(TravelerPreferencesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return allowlisted preferences and record audit log on success', async () => {
    const mockProfile = {
      seatPreference: 'AISLE',
      classPreference: 'BUSINESS',
      preferredAirlines: ['VN', 'QH'],
      blacklistedAirlines: ['VJ'],
      dietaryNeeds: 'Halal',
    };
    prismaService.travelerProfile.findUnique.mockResolvedValueOnce(mockProfile);

    const result = await service.getUserPreferences('user-1', 'trace-test-1', 'corr-test-1');

    expect(result).toEqual(mockProfile);
    expect(prismaService.travelerProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: {
        seatPreference: true,
        classPreference: true,
        preferredAirlines: true,
        blacklistedAirlines: true,
        dietaryNeeds: true,
      },
    });

    expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith({
      toolName: 'users/preferences',
      actorId: 'user-1',
      outcome: 'SUCCESS',
      durationMs: expect.any(Number),
      responseSizeBytes: Buffer.byteLength(JSON.stringify(mockProfile)),
      occurredAt: expect.any(String),
      errorCode: undefined,
      traceId: 'trace-test-1',
      correlationId: 'corr-test-1',
    });

    const passedAuditRecord = agentToolAuditService.recordToolExecution.mock.calls[0][0];
    expect((passedAuditRecord as any).parameters).toBeUndefined();
    expect((passedAuditRecord as any).params).toBeUndefined();
    expect((passedAuditRecord as any).passportNumber).toBeUndefined();
  });

  it('should throw NotFoundException and record FAILURE audit log when profile does not exist', async () => {
    prismaService.travelerProfile.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.getUserPreferences('user-2', 'trace-test-2', 'corr-test-2'),
    ).rejects.toThrow(NotFoundException);

    expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith({
      toolName: 'users/preferences',
      actorId: 'user-2',
      outcome: 'FAILURE',
      durationMs: expect.any(Number),
      responseSizeBytes: 0,
      occurredAt: expect.any(String),
      errorCode: 'PROFILE_NOT_FOUND',
      traceId: 'trace-test-2',
      correlationId: 'corr-test-2',
    });
  });

  it('should record generic HTTP status code when HttpException has no string code', async () => {
    prismaService.travelerProfile.findUnique.mockRejectedValueOnce(
      new HttpException('Forbidden', 403),
    );

    await expect(
      service.getUserPreferences('user-3', 'trace-test-3', 'corr-test-3'),
    ).rejects.toThrow(HttpException);

    expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'users/preferences',
        actorId: 'user-3',
        outcome: 'FAILURE',
        errorCode: 'HTTP_403',
      }),
    );
  });

  it('should record INTERNAL_ERROR when error is a non-HttpException', async () => {
    prismaService.travelerProfile.findUnique.mockRejectedValueOnce(
      new Error('Prisma database connection lost'),
    );

    await expect(
      service.getUserPreferences('user-4', 'trace-test-4', 'corr-test-4'),
    ).rejects.toThrow(Error);

    expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'users/preferences',
        actorId: 'user-4',
        outcome: 'FAILURE',
        errorCode: 'INTERNAL_ERROR',
      }),
    );
  });
});
