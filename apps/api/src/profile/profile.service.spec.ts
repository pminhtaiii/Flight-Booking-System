import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProfileService } from './profile.service';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/encryption.service';
import { AuditService } from '../audit/audit.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

describe('ProfileService', () => {
  let service: ProfileService;
  let prisma: PrismaService;
  let encryptionService: EncryptionService;
  let auditService: AuditService;
  let configService: ConfigService;
  let dbProfile: any = null;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileService,
        {
          provide: PrismaService,
          useValue: {
            travelerProfile: {
              findUnique: jest.fn(),
              update: jest.fn(),
              create: jest.fn(),
            },
            $transaction: jest.fn((cb: any) => cb(prisma)),
          },
        },
        {
          provide: EncryptionService,
          useValue: {
            encrypt: jest.fn(),
            decrypt: jest.fn(),
            encryptBound: jest.fn(),
            decryptBound: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: {
            createLog: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get(key: string) {
              if (key === 'FEATURE_FLAG_BOOKING_READINESS') {
                return 'true'; // Enabled by default in tests except where explicitly disabled
              }
              return undefined;
            },
          },
        },
      ],
    }).compile();

    service = module.get<ProfileService>(ProfileService);
    prisma = module.get<PrismaService>(PrismaService);
    encryptionService = module.get<EncryptionService>(EncryptionService);
    auditService = module.get<AuditService>(AuditService);
    configService = module.get<ConfigService>(ConfigService);
  });

  beforeEach(() => {
    dbProfile = null;

    jest.spyOn(prisma.travelerProfile, 'findUnique').mockImplementation((async (args: any) => {
      if (dbProfile && args.where.userId === dbProfile.userId) {
        return dbProfile;
      }
      return null;
    }) as any);

    jest.spyOn(prisma.travelerProfile, 'create').mockImplementation((async (args: any) => {
      dbProfile = {
        id: 'profile-123',
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data,
      };
      return dbProfile;
    }) as any);

    jest.spyOn(prisma.travelerProfile, 'update').mockImplementation((async (args: any) => {
      if (!dbProfile || args.where.userId !== dbProfile.userId) {
        const p2025Err: any = new Error('Record to update not found');
        p2025Err.code = 'P2025';
        throw p2025Err;
      }

      if (args.where.revision !== undefined && args.where.revision !== dbProfile.revision) {
        const p2025Err: any = new Error('Record to update not found');
        p2025Err.code = 'P2025';
        throw p2025Err; // Simulate Prisma P2025 mismatch
      }

      let newRevision = dbProfile.revision;
      if (args.data.revision?.increment) {
        newRevision += args.data.revision.increment;
      } else if (typeof args.data.revision === 'number') {
        newRevision = args.data.revision;
      }

      const updateData = { ...args.data };
      delete updateData.revision;

      dbProfile = {
        ...dbProfile,
        ...updateData,
        revision: newRevision,
        updatedAt: new Date(),
      };
      return dbProfile;
    }) as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('Feature Flag', () => {
    it('throws NotFoundException when FEATURE_FLAG_BOOKING_READINESS is false', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('false');

      await expect(service.getProfile('user-123')).rejects.toThrow(NotFoundException);
      await expect(service.updateProfile('user-123', { expectedRevision: 1 })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('Owner Scoping', () => {
    it('queries only the profile owned by the authenticated user ID on GET', async () => {
      dbProfile = null;
      const result = await service.getProfile('authenticated-user-123');

      expect(prisma.travelerProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: 'authenticated-user-123' },
      });
      expect(result.profileId).toBeNull();
    });

    it('updates only the profile owned by the authenticated user ID on PATCH', async () => {
      dbProfile = { id: 'profile-123', userId: 'authenticated-user-123', revision: 1 };

      const updateDto: UpdateProfileDto = {
        expectedRevision: 1,
        identity: {
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990-01-01',
          gender: 'male',
          title: 'Mr',
        },
      };

      await service.updateProfile('authenticated-user-123', updateDto);

      expect(prisma.travelerProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'authenticated-user-123', revision: 1 },
        }),
      );
    });
  });

  describe('Revision CAS (Optimistic Concurrency Control)', () => {
    it('successfully updates and increments revision if expectedRevision matches', async () => {
      dbProfile = { id: 'profile-123', userId: 'user-123', revision: 1 };

      const result = await service.updateProfile('user-123', { expectedRevision: 1 });

      expect(prisma.travelerProfile.update).toHaveBeenCalledWith({
        where: { userId: 'user-123', revision: 1 },
        data: expect.objectContaining({
          revision: { increment: 1 },
        }),
      });
      expect(result.revision).toBe(2);
    });

    it('throws ConflictException (409) if expectedRevision does not match current profile revision', async () => {
      dbProfile = { id: 'profile-123', userId: 'user-123', revision: 2 }; // DB has revision 2

      await expect(
        service.updateProfile('user-123', { expectedRevision: 1 }), // Client expected 1
      ).rejects.toThrow(ConflictException);

      expect(prisma.travelerProfile.update).not.toHaveBeenCalled();
    });

    it('throws ConflictException (409) if the profile does not exist but client expected non-zero revision', async () => {
      dbProfile = null;

      await expect(service.updateProfile('user-123', { expectedRevision: 1 })).rejects.toThrow(
        ConflictException,
      );

      expect(prisma.travelerProfile.create).not.toHaveBeenCalled();
    });

    it('creates profile with revision 1 if profile does not exist and client expected revision 0', async () => {
      dbProfile = null;

      const result = await service.updateProfile('user-123', {
        expectedRevision: 0,
        identity: {
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990-01-01',
          gender: 'male',
          title: 'Mr',
        },
      });

      expect(prisma.travelerProfile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-123',
          revision: 1,
          givenName: 'John',
          familyName: 'Doe',
        }),
      });
      expect(result.revision).toBe(1);
    });
  });

  describe('Document Atomicity', () => {
    it('sets all travelDocument fields to null when travelDocument section is explicitly null', async () => {
      dbProfile = { id: 'profile-123', userId: 'user-123', revision: 1 };

      await service.updateProfile('user-123', {
        expectedRevision: 1,
        travelDocument: null,
      });

      expect(prisma.travelerProfile.update).toHaveBeenCalledWith({
        where: { userId: 'user-123', revision: 1 },
        data: expect.objectContaining({
          documentType: null,
          passportNumber: null,
          passportExpiry: null,
          passportExpiryCiphertext: null,
          issuingCountry: null,
          nationality: null,
          revision: { increment: 1 },
        }),
      });
    });

    it('updates all travelDocument fields atomically when travelDocument section is provided', async () => {
      dbProfile = { id: 'profile-123', userId: 'user-123', revision: 1 };
      jest.spyOn(encryptionService, 'encryptBound').mockReturnValue('v1:encrypted-passport');

      await service.updateProfile('user-123', {
        expectedRevision: 1,
        travelDocument: {
          documentType: 'passport',
          passportNumber: 'AB1234567',
          passportExpiry: '2030-01-01',
          issuingCountry: 'US',
          nationality: 'US',
        },
      });

      expect(prisma.travelerProfile.update).toHaveBeenCalledWith({
        where: { userId: 'user-123', revision: 1 },
        data: expect.objectContaining({
          documentType: 'passport',
          passportNumber: 'v1:encrypted-passport', // encrypted
          passportExpiry: new Date('2030-01-01'), // DateTime
          passportExpiryCiphertext: expect.any(String), // dual-write ciphertext shadow
          issuingCountry: 'US',
          nationality: 'US',
        }),
      });
    });
  });

  describe('Dual-Write and Shadow Read', () => {
    it('writes both plain passportExpiry and encrypted passportExpiryCiphertext shadow', async () => {
      dbProfile = { id: 'profile-123', userId: 'user-123', revision: 1 };
      jest
        .spyOn(encryptionService, 'encryptBound')
        .mockReturnValueOnce('v1:encrypted-passport-number')
        .mockReturnValueOnce('v1:encrypted-passport-expiry');

      await service.updateProfile('user-123', {
        expectedRevision: 1,
        travelDocument: {
          documentType: 'passport',
          passportNumber: 'AB123456',
          passportExpiry: '2028-12-31',
          issuingCountry: 'US',
          nationality: 'US',
        },
      });

      expect(encryptionService.encryptBound).toHaveBeenCalledWith('2028-12-31', {
        userId: 'user-123',
        fieldName: 'passportExpiry',
      });

      expect(prisma.travelerProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            passportExpiry: new Date('2028-12-31'),
            passportExpiryCiphertext: 'v1:encrypted-passport-expiry',
          }),
        }),
      );
    });

    it('shadow reads from passportExpiryCiphertext and decrypts it when present', async () => {
      dbProfile = {
        id: 'profile-123',
        userId: 'user-123',
        revision: 1,
        passportExpiry: new Date('2028-12-31'),
        passportExpiryCiphertext: 'v1:encrypted-passport-expiry-2028',
      };
      jest.spyOn(encryptionService, 'decryptBound').mockReturnValue('2028-12-31');

      const result = await service.getProfile('user-123');

      expect(encryptionService.decryptBound).toHaveBeenCalledWith(
        'v1:encrypted-passport-expiry-2028',
        {
          userId: 'user-123',
          fieldName: 'passportExpiry',
        },
      );
      expect(result.travelDocument?.passportExpiry).toBe('2028-12-31');
    });

    it('falls back to legacy plain passportExpiry date when passportExpiryCiphertext shadow is missing', async () => {
      dbProfile = {
        id: 'profile-123',
        userId: 'user-123',
        revision: 1,
        passportExpiry: new Date('2028-12-31'),
        passportExpiryCiphertext: null, // missing shadow
      };

      const result = await service.getProfile('user-123');

      expect(encryptionService.decryptBound).not.toHaveBeenCalled();
      expect(result.travelDocument?.passportExpiry).toBe('2028-12-31');
    });
  });

  describe('Safe Audits (PII Protection)', () => {
    it('audits updates without writing PII values to audit log metadata', async () => {
      dbProfile = { id: 'profile-123', userId: 'user-123', revision: 1 };

      const updateDto: UpdateProfileDto = {
        expectedRevision: 1,
        identity: {
          givenName: 'John', // PII
          familyName: 'Doe', // PII
          dateOfBirth: '1990-01-01', // PII
          gender: 'male',
          title: 'Mr',
        },
      };

      await service.updateProfile('user-123', updateDto, 'trace-123', 'correlation-456');

      expect(auditService.createLog).toHaveBeenCalledWith(
        expect.any(Object), // transaction client
        expect.objectContaining({
          userId: 'user-123',
          action: 'update_profile',
          resourceType: 'TravelerProfile',
          traceId: 'trace-123',
          correlationId: 'correlation-456',
          metadata: expect.any(Object),
        }),
      );

      const call = (auditService.createLog as jest.Mock).mock.calls[0];
      const metadata = call[1].metadata;

      const metadataString = JSON.stringify(metadata);
      expect(metadataString).not.toContain('John');
      expect(metadataString).not.toContain('Doe');
      expect(metadataString).not.toContain('1990-01-01');

      expect(metadata.changedFields).toContain('identity');
    });

    it('wraps profile mutation and audit log insertion in a single transaction', async () => {
      dbProfile = null;

      await service.updateProfile('user-123', {
        expectedRevision: 0,
        identity: {
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990-01-01',
          gender: 'male',
          title: 'Mr',
        },
      });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(auditService.createLog).toHaveBeenCalledWith(
        expect.anything(), // tx client passed
        expect.objectContaining({
          action: 'create_profile',
        }),
      );
    });
  });

  describe('Concurrent Create & Decryption Failure Handling', () => {
    it('throws ConflictException (409) if concurrent create violates unique constraint (P2002)', async () => {
      dbProfile = null;
      const p2002Err: any = new Error('Unique constraint failed');
      p2002Err.code = 'P2002';
      jest.spyOn(prisma.travelerProfile, 'create').mockRejectedValueOnce(p2002Err);

      await expect(service.updateProfile('user-123', { expectedRevision: 0 })).rejects.toThrow(
        ConflictException,
      );
    });

    it('rethrows generic database errors on create without converting to ConflictException', async () => {
      dbProfile = null;
      const genericErr = new Error('Database connection lost');
      jest.spyOn(prisma.travelerProfile, 'create').mockRejectedValueOnce(genericErr);

      await expect(service.updateProfile('user-123', { expectedRevision: 0 })).rejects.toThrow(
        'Database connection lost',
      );
    });

    it('rethrows generic database errors on update without converting to ConflictException', async () => {
      dbProfile = { id: 'profile-123', userId: 'user-123', revision: 1 };
      const genericErr = new Error('Database timeout');
      jest.spyOn(prisma.travelerProfile, 'update').mockRejectedValueOnce(genericErr);

      await expect(service.updateProfile('user-123', { expectedRevision: 1 })).rejects.toThrow(
        'Database timeout',
      );
    });

    it('returns null for passportNumber when decryption fails', async () => {
      dbProfile = {
        id: 'profile-123',
        userId: 'user-123',
        revision: 1,
        documentType: 'passport',
        passportNumber: 'corrupted-ciphertext',
      };
      jest.spyOn(encryptionService, 'decryptBound').mockImplementation(() => {
        throw new Error('Invalid key');
      });
      jest.spyOn(encryptionService, 'decrypt').mockImplementation(() => {
        throw new Error('Invalid key');
      });

      const result = await service.getProfile('user-123');

      expect(result.travelDocument?.passportNumber).toBeNull();
    });
  });
});
