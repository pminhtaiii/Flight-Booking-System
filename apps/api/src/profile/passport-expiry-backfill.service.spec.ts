import { Test, TestingModule } from '@nestjs/testing';
import { PassportExpiryBackfillService } from './passport-expiry-backfill.service';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/encryption.service';

describe('PassportExpiryBackfillService', () => {
  let service: PassportExpiryBackfillService;
  let prisma: PrismaService;
  let encryptionService: EncryptionService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PassportExpiryBackfillService,
        {
          provide: PrismaService,
          useValue: {
            travelerProfile: {
              findMany: jest.fn(),
              updateMany: jest.fn(),
            },
          },
        },
        {
          provide: EncryptionService,
          useValue: {
            encryptBound: jest.fn(),
            decryptBound: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PassportExpiryBackfillService>(PassportExpiryBackfillService);
    prisma = module.get<PrismaService>(PrismaService);
    encryptionService = module.get<EncryptionService>(EncryptionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('performs shadowing by targeting only profiles with non-null expiry and null ciphertext shadow', async () => {
    const mockProfiles = [
      {
        id: '1',
        revision: 1,
        passportExpiry: new Date('2026-08-01'),
        passportExpiryCiphertext: null,
      },
    ];
    jest.spyOn(prisma.travelerProfile, 'findMany').mockResolvedValue(mockProfiles as any);
    jest.spyOn(prisma.travelerProfile, 'updateMany').mockResolvedValue({ count: 1 });
    jest.spyOn(encryptionService, 'encryptBound').mockReturnValue('v1:encrypted');
    jest.spyOn(encryptionService, 'decryptBound').mockReturnValue('2026-08-01');

    const result = await service.backfill({ batchSize: 10 });

    expect(prisma.travelerProfile.findMany).toHaveBeenCalledWith({
      where: {
        passportExpiry: { not: null },
        passportExpiryCiphertext: null,
      },
      take: 10,
    });
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.quarantined).toBe(0);
  });

  it('skips profiles if they are null (skipped nulls is handled by findMany query)', async () => {
    jest.spyOn(prisma.travelerProfile, 'findMany').mockResolvedValue([]);
    const result = await service.backfill({ batchSize: 10 });
    expect(result.processed).toBe(0);
    expect(encryptionService.encryptBound).not.toHaveBeenCalled();
  });

  it('handles CAS revision checks and increments skipped when updateMany affects 0 rows', async () => {
    const mockProfiles = [
      {
        id: '1',
        revision: 1,
        passportExpiry: new Date('2026-08-01'),
        passportExpiryCiphertext: null,
      },
    ];
    jest.spyOn(prisma.travelerProfile, 'findMany').mockResolvedValue(mockProfiles as any);
    jest.spyOn(prisma.travelerProfile, 'updateMany').mockResolvedValue({ count: 0 }); // Concurrent change
    jest.spyOn(encryptionService, 'encryptBound').mockReturnValue('v1:encrypted');

    const result = await service.backfill({ batchSize: 10 });

    expect(prisma.travelerProfile.updateMany).toHaveBeenCalledWith({
      where: {
        id: '1',
        revision: 1,
        passportExpiry: mockProfiles[0].passportExpiry,
        passportExpiryCiphertext: null,
      },
      data: {
        passportExpiryCiphertext: 'v1:encrypted',
      },
    });
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.quarantined).toBe(0);
  });

  it('quarantines profile if decrypted date does not match legacy date (mismatched date)', async () => {
    const mockProfiles = [
      {
        id: '1',
        revision: 1,
        passportExpiry: new Date('2026-08-01'),
        passportExpiryCiphertext: null,
      },
    ];
    jest.spyOn(prisma.travelerProfile, 'findMany').mockResolvedValue(mockProfiles as any);
    jest.spyOn(prisma.travelerProfile, 'updateMany').mockResolvedValue({ count: 1 });
    jest.spyOn(encryptionService, 'encryptBound').mockReturnValue('v1:encrypted');
    jest.spyOn(encryptionService, 'decryptBound').mockReturnValue('2027-08-01'); // Mismatch!

    const result = await service.backfill({ batchSize: 10, abortThresholdRatio: 1.0 });

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.quarantined).toBe(1);
  });

  it('quarantines profile if decryption throws an error (bad tag/key)', async () => {
    const mockProfiles = [
      {
        id: '1',
        revision: 1,
        passportExpiry: new Date('2026-08-01'),
        passportExpiryCiphertext: null,
      },
    ];
    jest.spyOn(prisma.travelerProfile, 'findMany').mockResolvedValue(mockProfiles as any);
    jest.spyOn(prisma.travelerProfile, 'updateMany').mockResolvedValue({ count: 1 });
    jest.spyOn(encryptionService, 'encryptBound').mockReturnValue('v1:encrypted');
    jest.spyOn(encryptionService, 'decryptBound').mockImplementation(() => {
      throw new Error('Decryption failed');
    });

    const result = await service.backfill({ batchSize: 10, abortThresholdRatio: 1.0 });

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.quarantined).toBe(1);
  });

  it('aborts processing if quarantine ratio exceeds threshold', async () => {
    // 5 profiles: 2 succeed, 2 quarantined (mismatched), 1 skipped.
    // Total attempted = 4. Quarantined = 2. Ratio = 2/4 = 50%
    const mockProfiles = [
      {
        id: '1',
        revision: 1,
        passportExpiry: new Date('2026-08-01'),
        passportExpiryCiphertext: null,
      },
      {
        id: '2',
        revision: 1,
        passportExpiry: new Date('2026-08-02'),
        passportExpiryCiphertext: null,
      },
      {
        id: '3',
        revision: 1,
        passportExpiry: new Date('2026-08-03'),
        passportExpiryCiphertext: null,
      },
      {
        id: '4',
        revision: 1,
        passportExpiry: new Date('2026-08-04'),
        passportExpiryCiphertext: null,
      },
      {
        id: '5',
        revision: 1,
        passportExpiry: new Date('2026-08-05'),
        passportExpiryCiphertext: null,
      },
    ];
    jest.spyOn(prisma.travelerProfile, 'findMany').mockResolvedValue(mockProfiles as any);

    // Profile 1 and 2 succeed: update count 1, decrypt matches
    // Profile 3 and 4 quarantine: update count 1, decrypt mismatches
    // Profile 5 skips: update count 0
    jest
      .spyOn(prisma.travelerProfile, 'updateMany')
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    jest.spyOn(encryptionService, 'encryptBound').mockReturnValue('v1:encrypted');
    jest
      .spyOn(encryptionService, 'decryptBound')
      .mockReturnValueOnce('2026-08-01') // matches 1
      .mockReturnValueOnce('2026-08-02') // matches 2
      .mockReturnValueOnce('2027-08-03') // mismatch 3
      .mockReturnValueOnce('2027-08-04'); // mismatch 4

    // threshold is 10% (0.1), so 50% should abort!
    await expect(service.backfill({ batchSize: 10, abortThresholdRatio: 0.1 })).rejects.toThrow(
      /Backfill aborted due to high quarantine ratio/,
    );
  });
});
