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
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable no-console */
const client_1 = require("@prisma/client");
const bcrypt = __importStar(require("bcrypt"));
const prisma = new client_1.PrismaClient();
async function main() {
    console.log('Seeding mock data for agent tools...');
    // 1. Create/find test user
    const email = 'agent.test@example.com';
    const hashedPassword = await bcrypt.hash('password123', 10);
    const user = await prisma.user.upsert({
        where: { email },
        update: { password: hashedPassword, status: 'ACTIVE' },
        create: {
            email,
            password: hashedPassword,
            status: 'ACTIVE',
        },
    });
    console.log(`User created/updated: ${user.id} (${user.email})`);
    // 2. Create TravelerProfile
    await prisma.travelerProfile.upsert({
        where: { userId: user.id },
        update: {
            seatPreference: 'window',
            classPreference: 'business',
            preferredAirlines: ['VN', 'NH'],
            blacklistedAirlines: ['XY'],
            dietaryNeeds: 'vegetarian',
            nationality: 'VN',
            passportNumber: 'N1234567',
            passportExpiry: new Date('2032-12-31T00:00:00Z'),
        },
        create: {
            userId: user.id,
            seatPreference: 'window',
            classPreference: 'business',
            preferredAirlines: ['VN', 'NH'],
            blacklistedAirlines: ['XY'],
            dietaryNeeds: 'vegetarian',
            nationality: 'VN',
            passportNumber: 'N1234567',
            passportExpiry: new Date('2032-12-31T00:00:00Z'),
        },
    });
    console.log(`TravelerProfile created/updated for user ${user.id}`);
    // 3. Clear existing bookings for this user to ensure clean state
    // await prisma.booking.deleteMany({ where: { userId: user.id } });
    // 4. Create Bookings (Temporarily commented out due to new Booking schema changes in Feature 11)
    /*
    const booking1 = await prisma.booking.create({
      data: {
        userId: user.id,
        pnrCode: 'PNR123',
        eTicketNumber: 'ETKT123456789',
        status: BookingStatus.CONFIRMED,
        airline: 'VN',
        flightNumber: 'VN310',
        origin: 'HAN',
        destination: 'NRT',
        departureTime: new Date('2026-08-15T08:30:00Z'),
        arrivalTime: new Date('2026-08-15T15:00:00Z'),
        duration: 330,
        stops: 0,
        fareClass: 'Business',
        price: 1250.00,
        currency: 'USD',
        passengers: 1,
        baggageAllowance: '32kg checked + 7kg carry-on',
        paymentReference: 'PAY-VN-310-XYZ',
      },
    });
  
    const booking2 = await prisma.booking.create({
      data: {
        userId: user.id,
        pnrCode: 'PNR456',
        eTicketNumber: 'ETKT987654321',
        status: BookingStatus.CONFIRMED,
        airline: 'NH',
        flightNumber: 'NH856',
        origin: 'NRT',
        destination: 'HAN',
        departureTime: new Date('2026-08-22T11:00:00Z'),
        arrivalTime: new Date('2026-08-22T14:30:00Z'),
        duration: 330,
        stops: 0,
        fareClass: 'Business',
        price: 1180.00,
        currency: 'USD',
        passengers: 1,
        baggageAllowance: '32kg checked + 7kg carry-on',
        paymentReference: 'PAY-NH-856-ABC',
      },
    });
  
    console.log(`Bookings seeded: ${booking1.id}, ${booking2.id}`);
    */
    console.log('Bookings seeding skipped due to new schema requirements.');
    console.log('Seeding finished successfully.');
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
