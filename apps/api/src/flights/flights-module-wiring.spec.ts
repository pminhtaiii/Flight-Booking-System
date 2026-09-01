import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FlightMatchModule } from '../flight-match/flight-match.module';
import { FlightMatchScorerService } from '../flight-match/flight-match-scorer.service';
import { FlightsModule } from './flights.module';
import { FlightsService } from './flights.service';
import { FlightSearchOrchestratorService } from './flight-search-orchestrator.service';
import { ProfileModule } from '../profile/profile.module';
import { ProfileService } from '../profile/profile.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CacheModule } from '../cache/cache.module';
import { CacheService } from '../cache/cache.service';
import { DuffelModule } from '../duffel/duffel.module';
import { DuffelService } from '../duffel/duffel.service';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';

describe('FlightMatchModule Wiring (T035)', () => {
  it('registers and exports FlightMatchScorerService', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, FlightMatchModule) ?? []) as unknown[];
    const exports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, FlightMatchModule) ?? []) as unknown[];

    expect(providers).toContain(FlightMatchScorerService);
    expect(exports).toContain(FlightMatchScorerService);
  });

  it('maintains zero-infrastructure invariant (imports is empty)', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, FlightMatchModule) ?? []) as unknown[];
    expect(imports).toEqual([]);
  });
});

describe('FlightsModule Wiring (T035)', () => {
  it('imports FlightMatchModule, ProfileModule, and required infrastructure modules', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, FlightsModule) ?? []) as unknown[];

    expect(imports).toContain(FlightMatchModule);
    expect(imports).toContain(ProfileModule);
    expect(imports).toContain(PrismaModule);
    expect(imports).toContain(CacheModule);
    expect(imports).toContain(DuffelModule);
    expect(imports).toContain(AuditModule);
  });

  it('provides and exports FlightSearchOrchestratorService and FlightsService', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, FlightsModule) ?? []) as unknown[];
    const exports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, FlightsModule) ?? []) as unknown[];

    expect(providers).toContain(FlightSearchOrchestratorService);
    expect(providers).toContain(FlightsService);
    expect(exports).toContain(FlightSearchOrchestratorService);
    expect(exports).toContain(FlightsService);
  });
});

describe('FlightsModule Dependency Graph & Cycle Avoidance (T035)', () => {
  it('compiles FlightsModule cleanly and resolves FlightSearchOrchestratorService and FlightsService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        FlightsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(CacheService)
      .useValue({})
      .overrideProvider(DuffelService)
      .useValue({})
      .overrideProvider(AuditService)
      .useValue({ createLog: jest.fn() })
      .overrideProvider(ConfigService)
      .useValue({ get: jest.fn().mockReturnValue('true') })
      .compile();

    expect(moduleRef).toBeDefined();

    const orchestrator = moduleRef.get<FlightSearchOrchestratorService>(FlightSearchOrchestratorService);
    expect(orchestrator).toBeDefined();
    expect(orchestrator).toBeInstanceOf(FlightSearchOrchestratorService);

    const flightsService = moduleRef.get<FlightsService>(FlightsService);
    expect(flightsService).toBeDefined();
    expect(flightsService).toBeInstanceOf(FlightsService);

    const scorerService = moduleRef.get<FlightMatchScorerService>(FlightMatchScorerService);
    expect(scorerService).toBeDefined();
    expect(scorerService).toBeInstanceOf(FlightMatchScorerService);

    const profileService = moduleRef.get<ProfileService>(ProfileService);
    expect(profileService).toBeDefined();
    expect(profileService).toBeInstanceOf(ProfileService);
  });
});
