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
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
async function main() {
    console.log('Running database seeding...');
    // 1. Seed agent tools mock data
    const seedAgentToolsPath = path.resolve(__dirname, 'seed-agent-tools.ts');
    console.log(`Running: tsx "${seedAgentToolsPath}"`);
    (0, child_process_1.execSync)(`npx tsx "${seedAgentToolsPath}"`, { stdio: 'inherit' });
    // 2. Seed airports data
    const seedAirportsPath = path.resolve(__dirname, 'seed/airports.ts');
    console.log(`Running: tsx "${seedAirportsPath}"`);
    (0, child_process_1.execSync)(`npx tsx "${seedAirportsPath}"`, { stdio: 'inherit' });
    console.log('All seeding completed successfully.');
}
main().catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
});
