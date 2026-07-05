import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient, AirportType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const csvPath = path.resolve(__dirname, '../../../../specs/005-map-integration/airports.csv');
  console.log(`Reading airports from: ${csvPath}`);
  
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found at ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\r?\n/);
  
  const airportsToInsert = [];
  
  function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const fields = parseCsvLine(line);
    if (fields.length < 14) continue;
    
    const typeRaw = fields[2].replace(/"/g, '').trim();
    const iataCodeRaw = fields[13].replace(/"/g, '').trim();
    
    if (!iataCodeRaw || (typeRaw !== 'large_airport' && typeRaw !== 'medium_airport')) {
      continue;
    }
    
    const name = fields[3].replace(/"/g, '').trim();
    const latitude = parseFloat(fields[4].replace(/"/g, '').trim());
    const longitude = parseFloat(fields[5].replace(/"/g, '').trim());
    
    const elevationRaw = fields[6].replace(/"/g, '').trim();
    const elevation = elevationRaw ? parseInt(elevationRaw, 10) : null;
    
    const country = fields[8].replace(/"/g, '').trim();
    const region = fields[9].replace(/"/g, '').trim();
    const city = fields[10].replace(/"/g, '').trim();
    
    const icaoCodeRaw = fields[1].replace(/"/g, '').trim();
    const icaoCode = (icaoCodeRaw && icaoCodeRaw.length === 4) ? icaoCodeRaw : null;
    
    const type = typeRaw === 'large_airport' ? AirportType.LARGE_AIRPORT : AirportType.MEDIUM_AIRPORT;
    
    airportsToInsert.push({
      iataCode: iataCodeRaw.toUpperCase(),
      icaoCode: icaoCode ? icaoCode.toUpperCase() : null,
      name,
      city,
      country: country.toUpperCase(),
      region,
      latitude,
      longitude,
      elevation,
      type,
    });
  }
  
  console.log(`Parsed ${airportsToInsert.length} airports. Seeding database...`);
  
  const batchSize = 1000;
  let seededCount = 0;
  
  for (let i = 0; i < airportsToInsert.length; i += batchSize) {
    const batch = airportsToInsert.slice(i, i + batchSize);
    
    const result = await prisma.airport.createMany({
      data: batch,
      skipDuplicates: true,
    });
    
    seededCount += result.count;
    console.log(`Seeded batch ${i / batchSize + 1}: +${result.count} airports`);
  }
  
  console.log(`Seeding finished. Total airports inserted: ${seededCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
