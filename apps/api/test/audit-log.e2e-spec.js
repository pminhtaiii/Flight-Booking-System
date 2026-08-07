"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const common_1 = require("@nestjs/common");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("@/app.module");
const prisma_service_1 = require("@/prisma/prisma.service");
const crypto = __importStar(require("crypto"));
const http_exception_filter_1 = require("@/common/filters/http-exception.filter");
describe('Audit Log (E2E)', () => {
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
    });
    it('should create audit logs for registration, login, failed login, and logout', async () => {
        const email = 'audit@example.com';
        const password = 'Password123!';
        const ip = '1.2.3.4';
        // 1. Registration
        const regRes = await (0, supertest_1.default)(app.getHttpServer())
            .post('/auth/register')
            .set('X-Forwarded-For', ip)
            .send({ email, password })
            .expect(201);
        const userId = regRes.body.user.id;
        const regLogs = await prisma.auditLog.findMany({ where: { userId, action: 'registration' } });
        expect(regLogs.length).toBe(1);
        // 2. Failed Login
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/auth/login')
            .set('X-Forwarded-For', ip)
            .send({ email, password: 'WrongPassword!' })
            .expect(401);
        const failedLogs = await prisma.auditLog.findMany({ where: { action: 'failed_login' } });
        expect(failedLogs.length).toBe(1);
        // 3. Successful Login
        const loginRes = await (0, supertest_1.default)(app.getHttpServer())
            .post('/auth/login')
            .set('X-Forwarded-For', ip)
            .send({ email, password })
            .expect(200);
        const loginToken = loginRes.body.token;
        const loginLogs = await prisma.auditLog.findMany({ where: { userId, action: 'login' } });
        expect(loginLogs.length).toBe(1);
        // 4. Logout
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/auth/logout')
            .set('Authorization', `Bearer ${loginToken}`)
            .expect(204);
        const logoutLogs = await prisma.auditLog.findMany({ where: { userId, action: 'logout' } });
        expect(logoutLogs.length).toBe(1);
    });
    it('should ensure audit log metadata is PII-free (no plaintext passwords, emails, etc.)', async () => {
        const email = 'sensitive@example.com';
        const password = 'Password123!';
        await (0, supertest_1.default)(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
        const logs = await prisma.auditLog.findMany({});
        expect(logs.length).toBeGreaterThan(0);
        for (const log of logs) {
            const metadata = log.metadata ? JSON.parse(JSON.stringify(log.metadata)) : {};
            // Email check
            expect(metadata.email).toBeUndefined();
            expect(JSON.stringify(metadata)).not.toContain(email);
            // Password check
            expect(metadata.password).toBeUndefined();
            expect(metadata.rawPassword).toBeUndefined();
            expect(metadata.plainTextPassword).toBeUndefined();
            expect(JSON.stringify(metadata)).not.toContain(password);
        }
    });
    it('should store client IP as a SHA-256 hash in audit log metadata rather than raw IP', async () => {
        const ip = '192.168.1.100';
        const expectedHash = crypto.createHash('sha256').update(ip).digest('hex');
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/auth/register')
            .set('X-Forwarded-For', ip)
            .send({ email: 'iphash@example.com', password: 'Password123!' })
            .expect(201);
        const log = await prisma.auditLog.findFirst({
            where: { action: 'registration' },
        });
        expect(log).toBeDefined();
        const metadata = log?.metadata;
        expect(metadata).toBeDefined();
        expect(metadata?.ipAddress).toBe(expectedHash);
        expect(metadata?.ipAddress).not.toBe(ip);
    });
    it('should propagate correlation ID / trace ID from headers to audit log metadata', async () => {
        const traceId = 'test-trace-12345';
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/auth/register')
            .set('X-Correlation-Id', traceId)
            .send({ email: 'trace@example.com', password: 'Password123!' })
            .expect(201);
        const log = await prisma.auditLog.findFirst({
            where: { action: 'registration' },
        });
        expect(log).toBeDefined();
        const metadata = log?.metadata;
        expect(metadata?.correlationId).toBe(traceId);
    });
    it('should rollback audit log entry if the database transaction fails (e.g. duplicate user ID constraint)', async () => {
        // We register the first user
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/auth/register')
            .send({ email: 'duplicate@example.com', password: 'Password123!' })
            .expect(201);
        const initialUserCount = await prisma.user.count();
        const initialLogCount = await prisma.auditLog.count();
        // Attempting registration again with duplicate email will trigger constraint failure
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/auth/register')
            .send({ email: 'duplicate@example.com', password: 'Password123!' })
            .expect(409);
        // Verify transaction rollback: count should remain the same
        const finalUserCount = await prisma.user.count();
        const finalLogCount = await prisma.auditLog.count();
        expect(finalUserCount).toBe(initialUserCount);
        // Any registration audit log attempted during the second registration should have been rolled back
        expect(finalLogCount).toBe(initialLogCount);
    });
});
