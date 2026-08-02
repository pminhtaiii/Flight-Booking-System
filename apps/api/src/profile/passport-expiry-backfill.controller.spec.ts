import { Test, TestingModule } from '@nestjs/testing';
import { PassportExpiryBackfillController } from './passport-expiry-backfill.controller';
import { PassportExpiryBackfillService, BackfillResult } from './passport-expiry-backfill.service';

describe('PassportExpiryBackfillController', () => {
  let controller: PassportExpiryBackfillController;
  let service: PassportExpiryBackfillService;

  const mockBackfillResult: BackfillResult = {
    processed: 5,
    skipped: 2,
    quarantined: 1,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PassportExpiryBackfillController],
      providers: [
        {
          provide: PassportExpiryBackfillService,
          useValue: {
            backfill: jest.fn().mockResolvedValue(mockBackfillResult),
          },
        },
      ],
    }).compile();

    controller = module.get<PassportExpiryBackfillController>(PassportExpiryBackfillController);
    service = module.get<PassportExpiryBackfillService>(PassportExpiryBackfillService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should call service.backfill and return the result', async () => {
    const options = { batchSize: 50, abortThresholdRatio: 0.2 };
    const result = await controller.runBackfill(options);

    expect(service.backfill).toHaveBeenCalledWith(options);
    expect(result).toEqual(mockBackfillResult);
  });

  it('should call service.backfill with undefined options if none are passed', async () => {
    const result = await controller.runBackfill(undefined);

    expect(service.backfill).toHaveBeenCalledWith(undefined);
    expect(result).toEqual(mockBackfillResult);
  });

  describe('BackfillOptionsDto validation', () => {
    const { validate } = require('class-validator');
    const { BackfillOptionsDto } = require('./dto/backfill-options.dto');

    it('should pass with valid options', async () => {
      const dto = new BackfillOptionsDto();
      dto.batchSize = 100;
      dto.abortThresholdRatio = 0.15;

      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should fail with negative batchSize', async () => {
      const dto = new BackfillOptionsDto();
      dto.batchSize = -5;

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('batchSize');
    });

    it('should fail with non-integer batchSize', async () => {
      const dto = new BackfillOptionsDto();
      dto.batchSize = 5.5;

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('batchSize');
    });

    it('should fail with abortThresholdRatio less than 0', async () => {
      const dto = new BackfillOptionsDto();
      dto.abortThresholdRatio = -0.1;

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('abortThresholdRatio');
    });

    it('should fail with abortThresholdRatio greater than 1', async () => {
      const dto = new BackfillOptionsDto();
      dto.abortThresholdRatio = 1.1;

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('abortThresholdRatio');
    });
  });
});
