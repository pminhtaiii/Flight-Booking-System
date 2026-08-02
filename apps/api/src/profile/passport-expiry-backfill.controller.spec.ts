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
});
