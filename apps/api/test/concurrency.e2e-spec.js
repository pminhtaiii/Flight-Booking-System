"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const common_1 = require("@nestjs/common");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("@/app.module");
const prisma_service_1 = require("@/prisma/prisma.service");
const http_exception_filter_1 = require("@/common/filters/http-exception.filter");
describe('Concurrency and Stress (E2E)', () => {
    jest.setTimeout(30000);
    let app;
    let prisma;
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
        app.useGlobalPipes(new common_1.ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }));
        app.useGlobalFilters(new http_exception_filter_1.HttpExceptionFilter());
        await app.init();
        prisma = moduleFixture.get(prisma_service_1.PrismaService);
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(async () => {
        await prisma.auditLog.deleteMany({});
        await prisma.user.deleteMany({});
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/auth/test/reset-lockout')
            .send({ clearAll: true })
            .expect(200);
        await (0, supertest_1.default)(app.getHttpServer()).post('/auth/register').send({
            email: 'concurrency@example.com',
            password: 'Password123!',
        });
    });
    it('should handle 100 concurrent failed login attempts from the same IP, locking out and remaining stable', async () => {
        const ip = '9.9.9.9';
        const attempts = Array.from({ length: 100 });
        const promises = attempts.map(() => (0, supertest_1.default)(app.getHttpServer()).post('/auth/login').set('X-Forwarded-For', ip).send({
            email: 'concurrency@example.com',
            password: 'WrongPassword!',
        }));
        const responses = await Promise.all(promises);
        let count401 = 0;
        let count429 = 0;
        let otherCount = 0;
        for (const res of responses) {
            if (res.status === 401) {
                count401++;
            }
            else if (res.status === 429) {
                count429++;
            }
            else {
                otherCount++;
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[Concurrency Results] 401: ${count401}, 429: ${count429}, other: ${otherCount}`);
        expect(otherCount).toBe(0);
        expect(count401).toBe(5);
        expect(count429).toBe(95);
        // Verify lockout state is active
        const lockoutRes = await (0, supertest_1.default)(app.getHttpServer())
            .post('/auth/login')
            .set('X-Forwarded-For', ip)
            .send({
            email: 'concurrency@example.com',
            password: 'Password123!',
        })
            .expect(429);
        expect(lockoutRes.body.code).toBe('auth_locked');
    });
});
