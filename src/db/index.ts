import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';
import { createMockDb } from './mockDb.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

const hasSqlConfig = Boolean(process.env.SQL_HOST && process.env.SQL_DB_NAME);

export const createPool = (): Pool => {
  if (!global._postgresPool) {
    if (!hasSqlConfig) {
      const mockPool = {
        query: async () => ({ rows: [] }),
        connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
        end: async () => {},
        on: () => mockPool,
      };
      return mockPool as unknown as Pool;
    }

    global._postgresPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 25,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

let pool: Pool;
let db: NodePgDatabase<typeof schema>;

if (hasSqlConfig) {
  try {
    pool = createPool();
    db = drizzle(pool, { schema });
  } catch (err) {
    console.warn('[AI Studio] SQL database connection failed — using in-memory mock database', err);
    pool = createPool();
    db = createMockDb() as unknown as NodePgDatabase<typeof schema>;
  }
} else {
  console.warn('[AI Studio] SQL database not configured — using in-memory mock database');
  pool = createPool();
  db = createMockDb() as unknown as NodePgDatabase<typeof schema>;
}

export { pool, db };
