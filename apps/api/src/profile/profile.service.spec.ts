import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ProfileService } from './profile.service';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/encryption.service';
import { AuditService } from '../audit/audit.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  BookingReadinessMetricsService,
  BOOKING_READINESS_METRIC_COUNTERS,
} from '../common/observability/booking-readiness.metrics';

describe('ProfileService', () => {
  let service: ProfileService;
  let prisma: PrismaService;
  let encryptionService: EncryptionService;
  let auditService: AuditService;
  let configService: ConfigService;
  let metricsService: { increment: jest.Mock };
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
        {
          provide: BookingReadinessMetricsService,
          useValue: {
            increment: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ProfileService>(ProfileService);
    prisma = module.get<PrismaService>(PrismaService);
    encryptionService = module.get<EncryptionService>(EncryptionService);
    auditService = module.get<AuditService>(AuditService);
    configService = module.get<ConfigService>(ConfigService);
    metricsService = module.get(BookingReadinessMetricsService);
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

  describe('Scoring Preferences Projection', () => {
    it('returns empty scoring preferences without requiring the booking readiness flag', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('false');

      await expect(service.getScoringPreferences('user-123')).resolves.toEqual({
        preferredAirlines: [],
        blacklistedAirlines: [],
        classPreference: null,
        preferredDepartureWindow: null,
        preferredArrivalWindow: null,
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      });
    });

    it('selects only scoring columns and never projects profile PII', async () => {
      dbProfile = {
        id: 'profile-123',
        userId: 'user-123',
        revision: 4,
        preferredAirlines: ['SQ'],
        blacklistedAirlines: ['XX'],
        classPreference: 'BUSINESS',
        preferredDepartureWindow: { start: 8, end: 12 },
        preferredArrivalWindow: { start: 18, end: 22 },
        maxStops: 1,
        priceSensitivity: 'MODERATE',
        requiresCheckedBaggage: true,
        passportNumber: 'SECRET-PASSPORT',
        email: 'private@example.com',
        phoneNumber: '+123456789',
        address: 'private address',
      };

      const result = await service.getScoringPreferences('user-123');

      expect(prisma.travelerProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
        select: {
          preferredAirlines: true,
          blacklistedAirlines: true,
          classPreference: true,
          preferredDepartureWindow: true,
          preferredArrivalWindow: true,
          maxStops: true,
          priceSensitivity: true,
          requiresCheckedBaggage: true,
        },
      });
      expect(result).toEqual({
        preferredAirlines: ['SQ'],
        blacklistedAirlines: ['XX'],
        classPreference: 'BUSINESS',
        preferredDepartureWindow: { start: 8, end: 12 },
        preferredArrivalWindow: { start: 18, end: 22 },
        maxStops: 1,
        priceSensitivity: 'MODERATE',
        requiresCheckedBaggage: true,
      });
      expect(JSON.stringify(result)).not.toContain('SECRET-PASSPORT');
      expect(JSON.stringify(result)).not.toContain('private@example.com');
      expect(encryptionService.decryptBound).not.toHaveBeenCalled();
      expect(encryptionService.decrypt).not.toHaveBeenCalled();
    });

    it('preserves ordinary and overnight hour windows', async () => {
      dbProfile = {
        userId: 'user-123',
        preferredAirlines: [],
        blacklistedAirlines: [],
        classPreference: null,
        preferredDepartureWindow: { start: 22, end: 6 },
        preferredArrivalWindow: { start: 9, end: 17 },
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      };

      await expect(service.getScoringPreferences('user-123')).resolves.toMatchObject({
        preferredDepartureWindow: { start: 22, end: 6 },
        preferredArrivalWindow: { start: 9, end: 17 },
      });
    });

    it('fails closed to null for malformed stored hour windows', async () => {
      dbProfile = {
        userId: 'user-123',
        preferredAirlines: [],
        blacklistedAirlines: [],
        classPreference: null,
        preferredDepartureWindow: { start: '22', end: 6 },
        preferredArrivalWindow: { start: 24, end: 17 },
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      };

      await expect(service.getScoringPreferences('user-123')).resolves.toMatchObject({
        preferredDepartureWindow: null,
        preferredArrivalWindow: null,
      });
    });

    it('fails closed when a stored hour window contains an unknown key', async () => {
      dbProfile = {
        userId: 'user-123',
        preferredAirlines: [],
        blacklistedAirlines: [],
        classPreference: null,
        preferredDepartureWindow: { start: 8, end: 12, timezone: 'UTC' },
        preferredArrivalWindow: null,
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      };

      await expect(service.getScoringPreferences('user-123')).resolves.toMatchObject({
        preferredDepartureWindow: null,
      });
    });

    it('increments the bounded integrity counter once per malformed stored window', async () => {
      dbProfile = {
        userId: 'user-123',
        preferredAirlines: [],
        blacklistedAirlines: [],
        classPreference: null,
        preferredDepartureWindow: { start: 8, end: 12, timezone: 'UTC' },
        preferredArrivalWindow: { start: 24, end: 12 },
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      };

      await service.getScoringPreferences('user-123');

      expect(metricsService.increment).toHaveBeenCalledTimes(2);
      expect(metricsService.increment).toHaveBeenNthCalledWith(
        1,
        BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_SCORING_WINDOW_INTEGRITY_FAILURES,
      );
      expect(metricsService.increment).toHaveBeenNthCalledWith(
        2,
        BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_SCORING_WINDOW_INTEGRITY_FAILURES,
      );
    });
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

  describe('Scoring Preference Public Profile Mapping', () => {
    it('returns stored scoring preferences from the public profile read', async () => {
      dbProfile = {
        id: 'profile-123',
        userId: 'user-123',
        revision: 3,
        preferredAirlines: ['VN'],
        blacklistedAirlines: ['AA'],
        preferredDepartureWindow: { start: 22, end: 6 },
        preferredArrivalWindow: { start: 9, end: 17 },
        maxStops: 1,
        priceSensitivity: 'FLEXIBLE',
        requiresCheckedBaggage: false,
      };

      await expect(service.getProfile('user-123')).resolves.toMatchObject({
        preferences: {
          seatPreference: null,
          classPreference: null,
          preferredAirlines: ['VN'],
          blacklistedAirlines: ['AA'],
          preferredDepartureWindow: { start: 22, end: 6 },
          preferredArrivalWindow: { start: 9, end: 17 },
          maxStops: 1,
          priceSensitivity: 'FLEXIBLE',
          requiresCheckedBaggage: false,
        },
      });
    });

    it('persists only supplied preference keys and preserves omitted preferences', async () => {
      dbProfile = {
        id: 'profile-123',
        userId: 'user-123',
        revision: 3,
        seatPreference: 'AISLE',
        classPreference: 'BUSINESS',
        preferredAirlines: ['VN'],
        blacklistedAirlines: ['AA'],
        preferredDepartureWindow: { start: 22, end: 6 },
        preferredArrivalWindow: { start: 9, end: 17 },
        maxStops: 2,
        priceSensitivity: 'BUDGET',
        requiresCheckedBaggage: true,
      };

      const result = await service.updateProfile('user-123', {
        expectedRevision: 3,
        preferences: {
          preferredAirlines: ['SQ'],
          maxStops: null,
          requiresCheckedBaggage: false,
        },
      });

      expect(prisma.travelerProfile.update).toHaveBeenCalledWith({
        where: { userId: 'user-123', revision: 3 },
        data: expect.objectContaining({
          preferredAirlines: ['SQ'],
          maxStops: null,
          requiresCheckedBaggage: false,
          revision: { increment: 1 },
        }),
      });
      expect((prisma.travelerProfile.update as jest.Mock).mock.calls[0][0].data).not.toHaveProperty(
        'seatPreference',
      );
      expect(result.preferences).toMatchObject({
        seatPreference: 'AISLE',
        classPreference: 'BUSINESS',
        preferredAirlines: ['SQ'],
        blacklistedAirlines: ['AA'],
        preferredDepartureWindow: { start: 22, end: 6 },
        preferredArrivalWindow: { start: 9, end: 17 },
        maxStops: null,
        priceSensitivity: 'BUDGET',
        requiresCheckedBaggage: false,
      });
    });

    it('clears every preference field when preferences is explicitly null', async () => {
      dbProfile = {
        id: 'profile-123',
        userId: 'user-123',
        revision: 3,
        seatPreference: 'AISLE',
        classPreference: 'BUSINESS',
        preferredAirlines: ['VN'],
        blacklistedAirlines: ['AA'],
        preferredDepartureWindow: { start: 22, end: 6 },
        preferredArrivalWindow: { start: 9, end: 17 },
        maxStops: 2,
        priceSensitivity: 'BUDGET',
        requiresCheckedBaggage: true,
      };

      const result = await service.updateProfile('user-123', {
        expectedRevision: 3,
        preferences: null,
      });

      expect(prisma.travelerProfile.update).toHaveBeenCalledWith({
        where: { userId: 'user-123', revision: 3 },
        data: expect.objectContaining({
          seatPreference: null,
          classPreference: null,
          preferredAirlines: [],
          blacklistedAirlines: [],
          preferredDepartureWindow: Prisma.DbNull,
          preferredArrivalWindow: Prisma.DbNull,
          maxStops: null,
          priceSensitivity: null,
          requiresCheckedBaggage: null,
          revision: { increment: 1 },
        }),
      });
      expect(result.preferences).toBeNull();
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

    it('returns PROFILE_REVISION_CONFLICT for stale revisions and CAS races', async () => {
      dbProfile = { id: 'profile-123', userId: 'user-123', revision: 2 };

      let staleRevisionError: unknown;
      try {
        await service.updateProfile('user-123', { expectedRevision: 1 });
      } catch (error) {
        staleRevisionError = error;
      }

      expect(staleRevisionError).toBeInstanceOf(ConflictException);
      if (!(staleRevisionError instanceof ConflictException)) {
        throw staleRevisionError;
      }
      expect(staleRevisionError.getResponse()).toMatchObject({
        message: 'PROFILE_REVISION_CONFLICT',
      });

      dbProfile = { id: 'profile-123', userId: 'user-123', revision: 1 };
      const p2025Error = Object.assign(new Error('Record to update not found'), { code: 'P2025' });
      jest.spyOn(prisma.travelerProfile, 'update').mockRejectedValueOnce(p2025Error);

      let raceError: unknown;
      try {
        await service.updateProfile('user-123', { expectedRevision: 1 });
      } catch (error) {
        raceError = error;
      }

      expect(raceError).toBeInstanceOf(ConflictException);
      if (!(raceError instanceof ConflictException)) {
        throw raceError;
      }
      expect(raceError.getResponse()).toMatchObject({ message: 'PROFILE_REVISION_CONFLICT' });

      dbProfile = null;
      const p2002Error = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      jest.spyOn(prisma.travelerProfile, 'create').mockRejectedValueOnce(p2002Error);

      let createRaceError: unknown;
      try {
        await service.updateProfile('user-123', { expectedRevision: 0 });
      } catch (error) {
        createRaceError = error;
      }

      expect(createRaceError).toBeInstanceOf(ConflictException);
      if (!(createRaceError instanceof ConflictException)) {
        throw createRaceError;
      }
      expect(createRaceError.getResponse()).toMatchObject({ message: 'PROFILE_REVISION_CONFLICT' });
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

    it('records only a preference section marker and revision for scoring preference updates', async () => {
      dbProfile = { id: 'profile-123', userId: 'user-123', revision: 3 };

      await service.updateProfile('user-123', {
        expectedRevision: 3,
        preferences: {
          preferredAirlines: ['VN'],
          blacklistedAirlines: ['AA'],
          preferredDepartureWindow: { start: 22, end: 6 },
          preferredArrivalWindow: { start: 9, end: 17 },
          maxStops: 1,
          priceSensitivity: 'FLEXIBLE',
          requiresCheckedBaggage: true,
        },
      });

      const call = (auditService.createLog as jest.Mock).mock.calls[0];
      const metadata = call[1].metadata;

      expect(metadata).toEqual({ changedFields: ['preferences'], revision: 4 });
      const metadataString = JSON.stringify(metadata);
      expect(metadataString).not.toContain('VN');
      expect(metadataString).not.toContain('AA');
      expect(metadataString).not.toContain('22');
      expect(metadataString).not.toContain('FLEXIBLE');
      expect(metadataString).not.toContain('true');
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
