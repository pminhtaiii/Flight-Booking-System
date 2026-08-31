import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '@/prisma/prisma.module';
import { PrismaService } from '@/prisma/prisma.service';

const MIGRATION_PATH = path.join(
  __dirname,
  '../prisma/migrations/20260831000000_add_flight_match_preferences/migration.sql',
);

const PROFILE_COLUMNS = [
  'preferredDepartureWindow',
  'preferredArrivalWindow',
  'maxStops',
  'priceSensitivity',
  'requiresCheckedBaggage',
] as const;

type ProfileColumn = (typeof PROFILE_COLUMNS)[number];

type ProfileAfterMigration = Record<ProfileColumn, unknown> & {
  revision: number;
};

function assertDisposableDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for the migration verifier.');
  }

  let databaseName: string;
  try {
    databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (
    !/(?:^|[_-])(test|e2e|flight_booking)(?:[_-]|$)/i.test(databaseName) &&
    process.env.NODE_ENV !== 'test'
  ) {
    throw new Error(
      'This migration verifier may only run against a database explicitly named as a disposable test or e2e database.',
    );
  }
}

async function executeSqlScript(sql: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to execute migration SQL.');
  }

  const prismaCliPath = require.resolve('prisma/build/index.js');
  const prismaProcess = spawn(
    process.execPath,
    [prismaCliPath, 'db', 'execute', '--stdin', '--url', databaseUrl],
    {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        ...process.env,
        CHECKPOINT_DISABLE: '1',
        PRISMA_TELEMETRY_INFORMATION: '0',
        PRISMA_HIDE_UPDATE_MESSAGE: 'true',
        NODE_OPTIONS: '',
      },
    },
  );
  let stderr = '';
  let processError: Error | undefined;
  prismaProcess.stderr.on('data', (chunk: Buffer | string): void => {
    stderr += chunk.toString();
  });
  prismaProcess.once('error', (error: Error): void => {
    processError = error;
  });
  prismaProcess.stdin.end(sql);

  await new Promise<void>((resolve, reject) => {
    prismaProcess.once('close', (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (processError) {
        reject(new Error(`Prisma db execute could not start: ${processError.message}`));
      } else if (exitCode === 0) {
        resolve();
      } else {
        const termination = signal ? ` (terminated by ${signal})` : '';
        reject(
          new Error(
            `Prisma db execute failed with exit code ${String(exitCode)}${termination}: ${stderr.trim() || 'No stderr output was produced.'}`,
          ),
        );
      }
    });
  });
}

describe('Traveler profile flight-match migration (E2E)', (): void => {
  jest.setTimeout(60_000);

  let testingModule: TestingModule | undefined;
  let prisma: PrismaService;
  let originalColumns: ProfileColumn[] = [];
  let fixtureUserId: string | undefined;

  async function profileColumns(): Promise<ProfileColumn[]> {
    const rows = await prisma.$queryRaw<Array<{ columnName: ProfileColumn }>>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'traveler_profiles'
        AND column_name IN (
          'preferredDepartureWindow',
          'preferredArrivalWindow',
          'maxStops',
          'priceSensitivity',
          'requiresCheckedBaggage'
        )
      ORDER BY column_name;
    `;
    return rows.map((row) => row.columnName);
  }

  async function restorePreMigrationSurface(): Promise<void> {
    for (const column of PROFILE_COLUMNS) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "traveler_profiles" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }

  async function restoreOriginalSurface(): Promise<void> {
    const definitions: Record<ProfileColumn, string> = {
      preferredDepartureWindow: 'JSONB',
      preferredArrivalWindow: 'JSONB',
      maxStops: 'INTEGER',
      priceSensitivity: 'TEXT',
      requiresCheckedBaggage: 'BOOLEAN',
    };
    const currentColumns = new Set(await profileColumns());

    for (const column of PROFILE_COLUMNS) {
      if (originalColumns.includes(column) && !currentColumns.has(column)) {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "traveler_profiles" ADD COLUMN "${column}" ${definitions[column]}`,
        );
      }
      if (!originalColumns.includes(column) && currentColumns.has(column)) {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "traveler_profiles" DROP COLUMN "${column}"`,
        );
      }
    }
  }

  async function userTables(): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ tableName: string }>>`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `;
    return rows.map((row) => row.tableName);
  }

  async function scoreColumnsFor(tableName: 'bookings' | 'flights'): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ columnName: string }>>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${tableName}
        AND column_name ILIKE '%score%'
      ORDER BY column_name;
    `;
    return rows.map((row) => row.columnName);
  }

  async function profileAfterMigration(profileId: string): Promise<ProfileAfterMigration> {
    const rows = await prisma.$queryRaw<ProfileAfterMigration[]>`
      SELECT
        "revision",
        "preferredDepartureWindow",
        "preferredArrivalWindow",
        "maxStops",
        "priceSensitivity",
        "requiresCheckedBaggage"
      FROM "traveler_profiles"
      WHERE "id" = ${profileId};
    `;
    if (!rows[0]) {
      throw new Error('The pre-migration traveler profile was not found after migration.');
    }
    return rows[0];
  }

  async function legacyProfileRevision(profileId: string): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ revision: number }>>`
      SELECT "revision"
      FROM "traveler_profiles"
      WHERE "id" = ${profileId};
    `;
    if (!rows[0]) {
      throw new Error('The pre-migration traveler profile was not created.');
    }
    return rows[0].revision;
  }

  beforeAll(async (): Promise<void> => {
    assertDisposableDatabase();
    testingModule = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = testingModule.get<PrismaService>(PrismaService);
    await testingModule.init();
    originalColumns = await profileColumns();
  });

  afterAll(async (): Promise<void> => {
    try {
      if (fixtureUserId && prisma) {
        await prisma.$executeRaw`DELETE FROM "users" WHERE "id" = ${fixtureUserId}`;
      }
      if (prisma) {
        await restoreOriginalSurface();
      }
    } finally {
      await testingModule?.close();
    }
  });

  it('adds nullable profile preferences without changing existing rows or persisting scores', async (): Promise<void> => {
    await restorePreMigrationSurface();
    const beforeTables = await userTables();
    const marker = randomUUID();
    const userId = randomUUID();
    const profileId = randomUUID();
    const legacyRevision = 7;
    fixtureUserId = userId;

    // Generated Prisma clients select post-migration columns, so this verifier creates its legacy fixture through parameterized SQL.
    await prisma.$executeRaw`
      INSERT INTO "users" ("id", "email", "password", "updatedAt")
      VALUES (${userId}, ${`flight-match-migration-${marker}@example.test`}, 'migration-test-password', NOW());
    `;
    await prisma.$executeRaw`
      INSERT INTO "traveler_profiles" (
        "id",
        "userId",
        "preferredAirlines",
        "blacklistedAirlines",
        "revision",
        "updatedAt"
      )
      VALUES (${profileId}, ${userId}, ARRAY[]::TEXT[], ARRAY[]::TEXT[], ${legacyRevision}, NOW());
    `;
    const beforeMigration = { revision: await legacyProfileRevision(profileId) };
    expect(beforeMigration.revision).toBe(legacyRevision);

    await executeSqlScript(fs.readFileSync(MIGRATION_PATH, 'utf8'));

    const afterMigration = await profileAfterMigration(profileId);
    const afterTables = await userTables();

    expect(afterMigration).toEqual(
      expect.objectContaining({
        preferredDepartureWindow: null,
        preferredArrivalWindow: null,
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      }),
    );
    expect(afterMigration.revision).toBe(beforeMigration.revision);
    expect(afterMigration.revision).toBe(legacyRevision);
    expect(afterTables).toEqual(beforeTables);
    expect(afterTables).not.toContain('flight_match_scores');
    expect(await scoreColumnsFor('bookings')).toEqual([]);
    expect(await scoreColumnsFor('flights')).toEqual([]);
  });
});
