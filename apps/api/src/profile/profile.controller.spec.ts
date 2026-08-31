import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileResponsePreferencesDto } from './dto/profile-response.dto';

type PreferredWindowField = 'preferredDepartureWindow' | 'preferredArrivalWindow';

const INVALID_WINDOW_SHAPES: Array<[PreferredWindowField, unknown]> = [
  ['preferredDepartureWindow', []],
  ['preferredDepartureWindow', [{ start: 6, end: 10 }]],
  ['preferredArrivalWindow', []],
  ['preferredArrivalWindow', [{ start: 16, end: 20 }]],
];

describe('ProfileController', () => {
  let controller: ProfileController;
  let service: ProfileService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProfileController],
      providers: [
        {
          provide: ProfileService,
          useValue: {
            getProfile: jest.fn(),
            updateProfile: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'FEATURE_FLAG_BOOKING_READINESS') {
                return 'true';
              }
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    controller = module.get<ProfileController>(ProfileController);
    service = module.get<ProfileService>(ProfileService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('Feature Flag', () => {
    it('returns 404 (throws NotFoundException) when feature flag is disabled', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('false');
      const req = { user: { id: 'user-123' } } as any;
      const res = { setHeader: jest.fn(), removeHeader: jest.fn() } as any;

      await expect(controller.getProfile(req, res)).rejects.toThrow(NotFoundException);
      await expect(controller.updateProfile(req, {}, { expectedRevision: 1 }, res)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('Cache Control Headers', () => {
    it('sets no-store/private cache-control headers on GET', async () => {
      const req = { user: { id: 'user-123' } } as any;
      const res = {
        setHeader: jest.fn(),
        removeHeader: jest.fn(),
      } as any;
      jest.spyOn(service, 'getProfile').mockResolvedValue({} as any);

      await controller.getProfile(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
      expect(res.removeHeader).toHaveBeenCalledWith('ETag');
    });

    it('sets no-store/private cache-control headers on PATCH', async () => {
      const req = { user: { id: 'user-123' } } as any;
      const res = {
        setHeader: jest.fn(),
        removeHeader: jest.fn(),
      } as any;
      const dto: UpdateProfileDto = { expectedRevision: 1 };
      jest.spyOn(service, 'updateProfile').mockResolvedValue({} as any);

      await controller.updateProfile(req, {}, dto, res);

      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
      expect(res.removeHeader).toHaveBeenCalledWith('ETag');
    });
  });

  describe('Trace and Correlation Propagation', () => {
    it('extracts and propagates x-trace-id and x-correlation-id to service', async () => {
      const req = { user: { id: 'user-123' } } as any;
      const res = {
        setHeader: jest.fn(),
        removeHeader: jest.fn(),
      } as any;
      const headers = {
        'x-trace-id': 'test-trace-id',
        'x-correlation-id': 'test-correlation-id',
      };
      const dto: UpdateProfileDto = { expectedRevision: 1 };

      await controller.updateProfile(req, headers, dto, res);

      expect(service.updateProfile).toHaveBeenCalledWith(
        'user-123',
        dto,
        'test-trace-id',
        'test-correlation-id',
      );
    });
  });

  describe('UpdateProfileDto Validation', () => {
    it('passes validation with valid data', async () => {
      const payload = {
        expectedRevision: 1,
        identity: {
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990-01-01',
          gender: 'male',
          title: 'Mr',
        },
        contact: {
          email: 'john.doe@example.com',
          phoneCountryCode: '+1',
          phoneNumber: '5551234567',
        },
        travelDocument: {
          documentType: 'passport',
          passportNumber: 'AB123456',
          passportExpiry: '2030-01-01',
          issuingCountry: 'US',
          nationality: 'US',
        },
      };

      const dto = plainToInstance(UpdateProfileDto, payload);
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('passes validation with valid preferred departure and arrival windows', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: {
          preferredDepartureWindow: { start: 6, end: 10 },
          preferredArrivalWindow: { start: 22, end: 6 },
        },
      });

      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

      expect(errors).toHaveLength(0);
    });

    it('passes validation when preferred departure and arrival windows are explicitly null', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: {
          preferredDepartureWindow: null,
          preferredArrivalWindow: null,
        },
      });

      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

      expect(errors).toHaveLength(0);
    });

    it.each(INVALID_WINDOW_SHAPES)(
      'rejects %s when it is not a single hour-window object',
      async (field: PreferredWindowField, window: unknown): Promise<void> => {
        const dto = plainToInstance(UpdateProfileDto, {
          expectedRevision: 1,
          preferences: { [field]: window },
        });

        const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe('preferences');
        expect(errors[0].children?.[0].property).toBe(field);
      },
    );

    it('accepts valid scalar scoring preferences', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: {
          maxStops: 0,
          priceSensitivity: 'BUDGET',
          requiresCheckedBaggage: false,
        },
      });

      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

      expect(errors).toHaveLength(0);
    });

    it('accepts explicitly null scalar scoring preferences', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: {
          maxStops: null,
          priceSensitivity: null,
          requiresCheckedBaggage: null,
        },
      });

      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

      expect(errors).toHaveLength(0);
    });

    it('rejects maxStops below zero', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { maxStops: -1 },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
    });

    it('rejects maxStops above eight', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { maxStops: 9 },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
    });

    it('rejects a fractional maxStops value', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { maxStops: 1.5 },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
    });

    it('rejects an unsupported price sensitivity', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { priceSensitivity: 'CHEAPEST' },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
    });

    it('trims and uppercases price sensitivity before exact validation', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { priceSensitivity: ' moderate ' },
      });

      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

      expect(dto.preferences?.priceSensitivity).toBe('MODERATE');
      expect(errors).toHaveLength(0);
    });

    it('rejects a non-string price sensitivity', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { priceSensitivity: 1 },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
    });

    it('rejects a non-boolean checked-baggage preference', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { requiresCheckedBaggage: 'yes' },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
    });

    it('canonicalizes and deduplicates preferred and blacklisted airline codes', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: {
          preferredAirlines: [' vn ', 'VN', 'qf'],
          blacklistedAirlines: [' aa ', 'AA'],
        },
      });

      expect(dto.preferences?.preferredAirlines).toEqual(['VN', 'QF']);
      expect(dto.preferences?.blacklistedAirlines).toEqual(['AA']);
      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    });

    it('declares all scoring preference fields in the profile response contract', (): void => {
      const preferences: ProfileResponsePreferencesDto = {
        preferredAirlines: ['VN'],
        blacklistedAirlines: ['AA'],
        preferredDepartureWindow: { start: 6, end: 10 },
        preferredArrivalWindow: null,
        maxStops: 0,
        priceSensitivity: 'MODERATE',
        requiresCheckedBaggage: false,
      };

      expect(preferences).toEqual({
        preferredAirlines: ['VN'],
        blacklistedAirlines: ['AA'],
        preferredDepartureWindow: { start: 6, end: 10 },
        preferredArrivalWindow: null,
        maxStops: 0,
        priceSensitivity: 'MODERATE',
        requiresCheckedBaggage: false,
      });
    });

    it('rejects a one-character airline code', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { preferredAirlines: ['V'] },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
    });

    it('accepts two-character and three-character airline codes', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { preferredAirlines: ['VN', 'VNA'] },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    });

    it('rejects a four-character airline code', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { preferredAirlines: ['VNAR'] },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
    });

    it('rejects an airline code with punctuation', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { blacklistedAirlines: ['V!'] },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
    });

    it('rejects a non-string airline code entry', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: { blacklistedAirlines: [12] },
      });

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
    });

    it.each([
      ['start is below zero', { start: -1, end: 10 }],
      ['start is above 23', { start: 24, end: 10 }],
      ['end is below zero', { start: 6, end: -1 }],
      ['end is above 23', { start: 6, end: 24 }],
    ])(
      'fails validation when a preferred departure window %s',
      async (
        _description: string,
        window: { start: number; end: number },
      ): Promise<void> => {
        const dto = plainToInstance(UpdateProfileDto, {
          expectedRevision: 1,
          preferences: { preferredDepartureWindow: window },
        });

        const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe('preferences');
        expect(errors[0].children?.[0].property).toBe('preferredDepartureWindow');
      },
    );

    it.each([
      ['string start', { start: '6', end: 10 }],
      ['string end', { start: 6, end: '10' }],
      ['floating-point start', { start: 6.5, end: 10 }],
      ['floating-point end', { start: 6, end: 10.5 }],
    ])(
      'fails validation for a preferred departure window with a %s',
      async (
        _description: string,
        window: { start: number | string; end: number | string },
      ): Promise<void> => {
        const dto = plainToInstance(UpdateProfileDto, {
          expectedRevision: 1,
          preferences: { preferredDepartureWindow: window },
        });

        const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe('preferences');
        expect(errors[0].children?.[0].property).toBe('preferredDepartureWindow');
      },
    );

    it('fails validation for an unknown nested hour-window property', async (): Promise<void> => {
      const dto = plainToInstance(UpdateProfileDto, {
        expectedRevision: 1,
        preferences: {
          preferredDepartureWindow: { start: 6, end: 10, timezone: 'Asia/Ho_Chi_Minh' },
        },
      });

      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('preferences');
      expect(errors[0].children?.[0].property).toBe('preferredDepartureWindow');
      expect(errors[0].children?.[0].children?.[0].property).toBe('timezone');
    });

    it('fails when expectedRevision is missing', async () => {
      const payload = {
        identity: {
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990-01-01',
          gender: 'male',
          title: 'Mr',
        },
      };

      const dto = plainToInstance(UpdateProfileDto, payload);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('expectedRevision');
    });

    it('fails when identity has invalid date of birth format', async () => {
      const payload = {
        expectedRevision: 1,
        identity: {
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '01/01/1990', // invalid format
          gender: 'male',
          title: 'Mr',
        },
      };

      const dto = plainToInstance(UpdateProfileDto, payload);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      // errors[0] is the nested identity object, let's check its children
      const identityError = errors.find((e) => e.property === 'identity');
      expect(identityError).toBeDefined();
      expect(identityError?.children?.find((c) => c.property === 'dateOfBirth')).toBeDefined();
    });

    it('passes when travelDocument is explicitly null', async () => {
      const payload = {
        expectedRevision: 1,
        travelDocument: null,
      };

      const dto = plainToInstance(UpdateProfileDto, payload);
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('fails when travelDocument has missing fields', async () => {
      const payload = {
        expectedRevision: 1,
        travelDocument: {
          documentType: 'passport',
          passportNumber: 'AB123456',
          // passportExpiry missing
          issuingCountry: 'US',
          nationality: 'US',
        },
      };

      const dto = plainToInstance(UpdateProfileDto, payload);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      const docError = errors.find((e) => e.property === 'travelDocument');
      expect(docError).toBeDefined();
      expect(docError?.children?.find((c) => c.property === 'passportExpiry')).toBeDefined();
    });

    it('fails when travelDocument issuingCountry is not a valid 2-character country code', async () => {
      const payload = {
        expectedRevision: 1,
        travelDocument: {
          documentType: 'passport',
          passportNumber: 'AB123456',
          passportExpiry: '2030-01-01',
          issuingCountry: 'USA', // invalid, must be 2-chars uppercase
          nationality: 'US',
        },
      };

      const dto = plainToInstance(UpdateProfileDto, payload);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      const docError = errors.find((e) => e.property === 'travelDocument');
      expect(docError?.children?.find((c) => c.property === 'issuingCountry')).toBeDefined();
    });
  });
});
