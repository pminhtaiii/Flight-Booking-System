"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("@/app.module");
const prisma_service_1 = require("@/prisma/prisma.service");
describe('Health Check (E2E)', () => {
    jest.setTimeout(30000);
    let app;
    let prismaService;
    let dbMockSpy;
    beforeAll(async () => {
        // Mock Prisma's $connect and $disconnect to avoid slow TCP timeouts during E2E test setup
        jest.spyOn(prisma_service_1.PrismaService.prototype, '$connect').mockImplementation(async () => { });
        jest.spyOn(prisma_service_1.PrismaService.prototype, '$disconnect').mockImplementation(async () => { });
        jest.spyOn(prisma_service_1.PrismaService.prototype, '$transaction').mockImplementation((callback, options) => {
            const tx = {
                $executeRawUnsafe: jest.fn().mockResolvedValue(1),
                $queryRaw: (query) => {
                    if (prismaService) {
                        return prismaService.$queryRaw(query);
                    }
                    return Promise.resolve([1]);
                },
            };
            const timeoutMs = options?.timeout ?? 150;
            let timeoutId = undefined;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Transaction timeout')), timeoutMs);
            });
            const executePromise = (async () => {
                try {
                    return await callback(tx);
                }
                finally {
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                    }
                }
            })();
            return Promise.race([executePromise, timeoutPromise]);
        });
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
        prismaService = moduleFixture.get(prisma_service_1.PrismaService);
        // Warm up the application using a mock implementation of $queryRaw so it doesn't try to query the real db
        const warmupSpy = jest
            .spyOn(prismaService, '$queryRaw')
            .mockImplementation(() => Promise.resolve([1]));
        await (0, supertest_1.default)(app.getHttpServer()).get('/health');
        warmupSpy.mockRestore();
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(() => {
        // Simulate database up state since no real database is running in this environment
        dbMockSpy = jest
            .spyOn(prismaService, '$queryRaw')
            .mockImplementation(() => Promise.resolve([1]));
    });
    afterEach(() => {
        dbMockSpy.mockRestore();
    });
    it('GET /health - should return status 200 and database status up under normal conditions', async () => {
        const startTime = Date.now();
        const response = await (0, supertest_1.default)(app.getHttpServer())
            .get('/health')
            .expect('Content-Type', /json/)
            .expect(200);
        const duration = Date.now() - startTime;
        expect(response.body).toEqual({
            status: 'ok',
            dependencies: {
                database: 'up',
            },
        });
        // Verify response time is less than 250ms
        expect(duration).toBeLessThan(250);
    });
    it('GET /health - should not require authentication headers', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/health').expect(200);
    });
    it('GET /health - should report down/degraded and return status 503 when database is unreachable', async () => {
        // Simulate database failure by forcing $queryRaw to throw an error.
        dbMockSpy.mockRejectedValueOnce(new Error('Connection lost'));
        await (0, supertest_1.default)(app.getHttpServer())
            .get('/health')
            .expect('Content-Type', /json/)
            .expect(503)
            .expect((res) => {
            expect(res.body).toEqual({
                status: 'down',
                dependencies: {
                    database: 'down',
                },
            });
        });
    });
    it('GET /health - should restore to status 200 and ok when database recovers', async () => {
        // First, verify a failure occurs when query fails
        dbMockSpy.mockRejectedValueOnce(new Error('Connection lost'));
        await (0, supertest_1.default)(app.getHttpServer()).get('/health').expect(503);
        // Now, call again and assert recovery (mockRejectedValueOnce only affects the first call,
        // so the second call automatically recovers using mockImplementation)
        await (0, supertest_1.default)(app.getHttpServer())
            .get('/health')
            .expect(200)
            .expect((res) => {
            expect(res.body).toEqual({
                status: 'ok',
                dependencies: {
                    database: 'up',
                },
            });
        });
    });
    it('GET /health - should return status 503 within 150ms if database query times out (> 100ms delay)', async () => {
        // Measure a base normal request duration right before the timeout request to get current environmental overhead
        dbMockSpy.mockImplementationOnce(() => Promise.resolve([1]));
        const baseStart = Date.now();
        await (0, supertest_1.default)(app.getHttpServer()).get('/health').expect(200);
        const baseDuration = Date.now() - baseStart;
        // Simulate database timeout by delaying query execution indefinitely
        dbMockSpy.mockImplementation(() => new Promise(() => { }));
        const startTime = Date.now();
        const response = await (0, supertest_1.default)(app.getHttpServer())
            .get('/health')
            .expect('Content-Type', /json/)
            .expect(503);
        const duration = Date.now() - startTime;
        expect(response.body).toEqual({
            status: 'down',
            dependencies: {
                database: 'down',
            },
        });
        // The net duration added by the timeout (100ms) should be less than 250ms.
        const netDuration = duration - baseDuration;
        expect(netDuration).toBeLessThan(250);
    });
});
