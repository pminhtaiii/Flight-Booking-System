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
const cache_service_1 = require("@/cache/cache.service");
const http_exception_filter_1 = require("@/common/filters/http-exception.filter");
describe('Airports (E2E)', () => {
    jest.setTimeout(30000);
    let app;
    let prisma;
    let cacheService;
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new common_1.ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }));
        app.useGlobalFilters(new http_exception_filter_1.HttpExceptionFilter());
        await app.init();
        prisma = moduleFixture.get(prisma_service_1.PrismaService);
        cacheService = moduleFixture.get(cache_service_1.CacheService);
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(async () => {
        // Clear cache and airports table
        const keys = await cacheService.keys('airports:*');
        for (const key of keys) {
            await cacheService.del(key);
        }
        await prisma.airport.deleteMany({});
        // Seed mock airports
        await prisma.airport.createMany({
            data: [
                {
                    iataCode: 'HAN',
                    icaoCode: 'VVNB',
                    name: 'Noi Bai International Airport',
                    city: 'Hanoi',
                    country: 'VN',
                    region: 'VN-HN',
                    latitude: 21.2212,
                    longitude: 105.807,
                    elevation: 39,
                    type: 'LARGE_AIRPORT',
                    timezone: 'Asia/Ho_Chi_Minh',
                },
                {
                    iataCode: 'NRT',
                    icaoCode: 'RJAA',
                    name: 'Narita International Airport',
                    city: 'Tokyo',
                    country: 'JP',
                    region: 'JP-12',
                    latitude: 35.7647,
                    longitude: 140.3864,
                    elevation: 141,
                    type: 'LARGE_AIRPORT',
                    timezone: 'Asia/Tokyo',
                },
                {
                    iataCode: 'DAD',
                    icaoCode: 'VVDN',
                    name: 'Da Nang International Airport',
                    city: 'Da Nang',
                    country: 'VN',
                    region: 'VN-5',
                    latitude: 16.0439,
                    longitude: 108.1994,
                    elevation: 33,
                    type: 'MEDIUM_AIRPORT',
                    timezone: 'Asia/Ho_Chi_Minh',
                },
            ],
        });
    });
    describe('GET /airports/search', () => {
        it('should return matching airports and cache the response', async () => {
            const getSpy = jest.spyOn(cacheService, 'get');
            const setSpy = jest.spyOn(cacheService, 'set');
            // First call (cache miss)
            const res1 = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/search')
                .query({ q: 'Hanoi' })
                .expect(200);
            expect(res1.body).toHaveProperty('data');
            expect(res1.body).toHaveProperty('count', 1);
            expect(res1.body.data[0].iataCode).toBe('HAN');
            expect(res1.body.data[0]).not.toHaveProperty('icaoCode'); // lightweight fields only
            // Verify cache set was called
            expect(setSpy).toHaveBeenCalled();
            // Second call (cache hit)
            getSpy.mockClear();
            setSpy.mockClear();
            const res2 = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/search')
                .query({ q: 'Hanoi' })
                .expect(200);
            expect(res2.body).toEqual(res1.body);
            expect(setSpy).not.toHaveBeenCalled();
            getSpy.mockRestore();
            setSpy.mockRestore();
        });
        it('should perform case-insensitive search by IATA code or city or name', async () => {
            const resIata = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/search')
                .query({ q: 'han' })
                .expect(200);
            expect(resIata.body.count).toBe(1);
            expect(resIata.body.data[0].iataCode).toBe('HAN');
            const resCity = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/search')
                .query({ q: 'tokyo' })
                .expect(200);
            expect(resCity.body.count).toBe(1);
            expect(resCity.body.data[0].iataCode).toBe('NRT');
            const resName = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/search')
                .query({ q: 'Da Nang' })
                .expect(200);
            expect(resName.body.count).toBe(1);
            expect(resName.body.data[0].iataCode).toBe('DAD');
        });
        it('should validate query parameter q minLength 2', async () => {
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/search')
                .query({ q: 'h' })
                .expect(400);
            expect(res.body.message).toContainEqual(expect.stringContaining('q must be at least 2 characters'));
        });
        it('should limit results to the specified limit parameter', async () => {
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/search')
                .query({ q: 'no', limit: 1 })
                .expect(200);
            expect(res.body.data.length).toBeLessThanOrEqual(1);
        });
    });
    describe('GET /airports/nearby', () => {
        it('should find nearby airports within radius using clamped Haversine formula and cache results', async () => {
            const getSpy = jest.spyOn(cacheService, 'get');
            const setSpy = jest.spyOn(cacheService, 'set');
            // Hanoi coordinates
            const res1 = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/nearby')
                .query({ lat: 21.0285, lng: 105.8542, radius: 100 })
                .expect(200);
            expect(res1.body).toHaveProperty('data');
            expect(res1.body.data.length).toBe(1);
            expect(res1.body.data[0].iataCode).toBe('HAN');
            expect(res1.body.data[0]).toHaveProperty('distanceKm');
            expect(res1.body.data[0].distanceKm).toBeLessThanOrEqual(100);
            expect(res1.body.center).toEqual({ lat: 21.0285, lng: 105.8542 });
            expect(res1.body.radiusKm).toBe(100);
            expect(setSpy).toHaveBeenCalled();
            // Second call (cache hit)
            setSpy.mockClear();
            const res2 = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/nearby')
                .query({ lat: 21.0285, lng: 105.8542, radius: 100 })
                .expect(200);
            expect(res2.body).toEqual(res1.body);
            expect(setSpy).not.toHaveBeenCalled();
            getSpy.mockRestore();
            setSpy.mockRestore();
        });
        it('should validate query parameters for nearby check', async () => {
            // Missing lat/lng
            await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/nearby')
                .expect(400);
            // Lat out of range
            await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/nearby')
                .query({ lat: 95, lng: 100 })
                .expect(400);
            // Lng out of range
            await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/nearby')
                .query({ lat: 21.02, lng: -200 })
                .expect(400);
        });
    });
    describe('GET /airports/all', () => {
        it('should return all airports with lightweight schema and cache results', async () => {
            const getSpy = jest.spyOn(cacheService, 'get');
            const setSpy = jest.spyOn(cacheService, 'set');
            const res1 = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/all')
                .expect(200);
            expect(res1.body.count).toBe(3);
            expect(res1.body.data[0]).not.toHaveProperty('icaoCode');
            expect(res1.body.data[0]).toHaveProperty('iataCode');
            expect(setSpy).toHaveBeenCalled();
            setSpy.mockClear();
            const res2 = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/all')
                .expect(200);
            expect(res2.body).toEqual(res1.body);
            expect(setSpy).not.toHaveBeenCalled();
            getSpy.mockRestore();
            setSpy.mockRestore();
        });
    });
    describe('GET /airports/:iataCode', () => {
        it('should return full airport details and cache results', async () => {
            const getSpy = jest.spyOn(cacheService, 'get');
            const setSpy = jest.spyOn(cacheService, 'set');
            // First call (cache miss)
            const res1 = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/HAN')
                .expect(200);
            expect(res1.body.iataCode).toBe('HAN');
            expect(res1.body).toHaveProperty('icaoCode', 'VVNB'); // Full details present
            expect(res1.body).toHaveProperty('elevation', 39);
            expect(setSpy).toHaveBeenCalled();
            // Second call (cache hit)
            setSpy.mockClear();
            const res2 = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/HAN')
                .expect(200);
            expect(res2.body).toEqual(res1.body);
            expect(setSpy).not.toHaveBeenCalled();
            getSpy.mockRestore();
            setSpy.mockRestore();
        });
        it('should support case-insensitive iataCode lookup', async () => {
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/han')
                .expect(200);
            expect(res.body.iataCode).toBe('HAN');
        });
        it('should throw 404 if airport not found', async () => {
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .get('/airports/XYZ')
                .expect(404);
            expect(res.body.message).toBe("Airport with IATA code 'XYZ' not found");
        });
    });
});
