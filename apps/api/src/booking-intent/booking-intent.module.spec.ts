import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { BookingIntentModule } from './booking-intent.module';
import { PassengerSourceResolverService } from './passenger-source-resolver.service';
import { PassengerSnapshotService } from './passenger-snapshot.service';
import { BookingPassengerFinalValidatorService } from './booking-passenger-final-validator.service';

describe('BookingIntentModule Phase 7 and Phase 11 providers', () => {
  it('registers and exports source resolver, snapshot builder, and final validator without replacing intent orchestration', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      BookingIntentModule,
    ) as unknown[];
    const exports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, BookingIntentModule) as unknown[];

    expect(providers).toEqual(
      expect.arrayContaining([
        PassengerSourceResolverService,
        PassengerSnapshotService,
        BookingPassengerFinalValidatorService,
      ]),
    );
    expect(exports).toEqual(
      expect.arrayContaining([
        PassengerSourceResolverService,
        PassengerSnapshotService,
        BookingPassengerFinalValidatorService,
      ]),
    );
  });
});
