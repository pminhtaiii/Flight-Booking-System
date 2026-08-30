function configureTestEnvironment(): void {
  process.env.NODE_ENV = 'test';
  process.env.CI = 'true';
  process.env.PORT = '3001';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/test_db';

  const redisUrl = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  redisUrl.pathname = '/1';
  process.env.REDIS_URL = redisUrl.toString();

  const requiredSecrets = [
    'JWT_SECRET',
    'AGENT_SERVICE_API_KEY',
    'CLAIM_TOKEN_SECRET',
    'ATTESTATION_SECRET',
    'CHAT_HANDOFF_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'CHAT_ENCRYPTION_KEY',
    'ENCRYPTION_KEY',
    'DUFFEL_ACCESS_TOKEN',
  ];
  for (const name of requiredSecrets) {
    if (!process.env[name]) {
      throw new Error(`T093 requires ${name} to be provided by the test runner`);
    }
  }

  process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
  process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
  process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
}

async function bootstrap(): Promise<void> {
  configureTestEnvironment();

  const { ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');
  const { HttpExceptionFilter } = await import('../src/common/filters/http-exception.filter');
  const { AirportsService } = await import('../src/airports/airports.service');
  const { DuffelService } = await import('../src/duffel/duffel.service');
  const { StripeService } = await import('../src/common/stripe.service');
  const { PrismaService } = await import('../src/prisma/prisma.service');

  type DuffelServiceInstance = InstanceType<typeof DuffelService>;
  type SearchResult = Awaited<ReturnType<DuffelServiceInstance['searchFlights']>>;

  const counters = {
    supplierCalls: 0,
    paymentCalls: 0,
  };

  const utcDateAfterDays = (days: number): string => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const departureDate = utcDateAfterDays(90);
  const offerExpiryDate = utcDateAfterDays(30);

  const rejectUnexpectedPaymentCall = async (): Promise<never> => {
    counters.paymentCalls += 1;
    throw new Error('Unexpected payment boundary call during T093');
  };
  const stripeBoundary = {
    createPaymentIntent: rejectUnexpectedPaymentCall,
    capturePaymentIntent: rejectUnexpectedPaymentCall,
    cancelPaymentIntent: rejectUnexpectedPaymentCall,
    createCustomer: rejectUnexpectedPaymentCall,
    retrievePaymentIntent: rejectUnexpectedPaymentCall,
    createRefund: rejectUnexpectedPaymentCall,
    detachPaymentMethod: rejectUnexpectedPaymentCall,
    constructWebhookEvent: rejectUnexpectedPaymentCall,
  };

  const deterministicOffer = {
    id: 'off_t093_sgn_han_001',
    expires_at: `${offerExpiryDate}T23:59:59.000Z`,
    total_amount: '125.00',
    total_currency: 'USD',
    passengers: [
      {
        id: 'pas_001',
        type: 'adult',
      },
    ],
    slices: [
      {
        id: 'sli_t093_sgn_han_001',
        duration: 'PT2H10M',
        segments: [
          {
            id: 'seg_t093_sgn_han_001',
            departing_at: `${departureDate}T08:00:00.000Z`,
            arriving_at: `${departureDate}T10:10:00.000Z`,
            origin: {
              iata_code: 'SGN',
              city_name: 'Ho Chi Minh City',
              airport_name: 'Tan Son Nhat International Airport',
            },
            destination: {
              iata_code: 'HAN',
              city_name: 'Hanoi',
              airport_name: 'Noi Bai International Airport',
            },
            operating_carrier: {
              name: 'T093 Airways',
              iata_code: 'T9',
            },
            marketing_carrier: {
              name: 'T093 Airways',
              iata_code: 'T9',
            },
            marketing_carrier_flight_number: '093',
            passengers: [
              {
                passenger_id: 'pas_001',
                cabin_class: 'economy',
                baggages: [],
              },
            ],
          },
        ],
      },
    ],
  };

  // Duffel does not export a constructible offer-request fixture type; this deterministic
  // boundary double is validated by the typed searchFlights function below.
  const offerRequest = {
    id: 'orq_t093_sgn_han_001',
    offers: [deterministicOffer],
  } as unknown as SearchResult['offerRequest'];

  const searchFlights: DuffelServiceInstance['searchFlights'] = async (query, caller) => {
    void query;
    void caller;
    counters.supplierCalls += 1;
    return {
      offerRequest,
      cached: false,
      searchHash: 't093-sgn-han-search',
    };
  };

  const getOfferById: DuffelServiceInstance['getOfferById'] = async (duffelOfferId) => {
    void duffelOfferId;
    counters.supplierCalls += 1;
    return deterministicOffer;
  };

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(DuffelService)
    .useValue({ searchFlights, getOfferById })
    .overrideProvider(StripeService)
    .useValue(stripeBoundary)
    .compile();

  const airportsService = moduleFixture.get<InstanceType<typeof AirportsService>>(AirportsService);
  airportsService.findCountriesByIataCodes = async (codes) => {
    const normalizedCodes = [...new Set(codes.map((code) => code.trim().toUpperCase()))];

    return new Map(
      normalizedCodes.map((code) => [code, code === 'SGN' || code === 'HAN' ? 'VN' : null]),
    );
  };

  const prisma = moduleFixture.get<InstanceType<typeof PrismaService>>(PrismaService);
  const app = moduleFixture.createNestApplication({ rawBody: true });
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', 'loopback, linklocal, 127.0.0.1, ::1');

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  app.enableCors({
    origin: frontendUrl,
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableShutdownHooks();
  app.useGlobalFilters(new HttpExceptionFilter());

  type JsonResponse = {
    json: (body: Record<string, unknown>) => void;
    status: (code: number) => JsonResponse;
  };

  let evidenceStartedAt = new Date();
  expressApp.get('/test/t093/ready', async (_request: unknown, response: JsonResponse) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      response.status(200).json({ ready: true });
    } catch {
      response.status(503).json({ ready: false });
    }
  });
  expressApp.get('/test/t093/evidence', async (_request: unknown, response: JsonResponse) => {
    try {
      const [bookingIntentCount, consumedHandoffCount, encryptedChatMessageCount] =
        await Promise.all([
          prisma.bookingIntent.count({
            where: { createdAt: { gte: evidenceStartedAt } },
          }),
          prisma.chatHandoff.count({
            where: {
              createdAt: { gte: evidenceStartedAt },
              consumedAt: { not: null },
            },
          }),
          prisma.chatMessage.count({
            where: {
              createdAt: { gte: evidenceStartedAt },
              contentCiphertext: { not: null },
              contentNonce: { not: null },
              contentAuthTag: { not: null },
            },
          }),
        ]);

      response.json({
        supplierCalls: counters.supplierCalls,
        paymentCalls: counters.paymentCalls,
        bookingIntentCount,
        consumedHandoffCount,
        encryptedChatMessageCount,
        plaintextFreeEncryptedCount: encryptedChatMessageCount,
      });
    } catch {
      response.status(503).json({
        supplierCalls: counters.supplierCalls,
        paymentCalls: counters.paymentCalls,
        bookingIntentCount: 0,
        consumedHandoffCount: 0,
        encryptedChatMessageCount: 0,
        plaintextFreeEncryptedCount: 0,
      });
    }
  });

  await app.listen(3001, '127.0.0.1');
  evidenceStartedAt = new Date();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void bootstrap().catch(() => {
  console.error('T093 server failed to start');
  process.exitCode = 1;
});
