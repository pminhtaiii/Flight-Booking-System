import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { BookingIntentModule } from './booking-intent.module';
import { PassengerSourceResolverService } from './passenger-source-resolver.service';
import { PassengerSnapshotService } from './passenger-snapshot.service';

describe('BookingIntentModule Phase 7 providers', () => {
  it('registers and exports source resolver and snapshot builder without replacing intent orchestration', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BookingIntentModule) as unknown[];
    const exports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, BookingIntentModule) as unknown[];

    expect(providers).toEqual(expect.arrayContaining([PassengerSourceResolverService, PassengerSnapshotService]));
    expect(exports).toEqual(expect.arrayContaining([PassengerSourceResolverService, PassengerSnapshotService]));
  });
});
