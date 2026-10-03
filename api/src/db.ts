import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export const DATA_DIR = process.env.DATA_DIR ?? '/data';
export const DB_PATH = path.join(DATA_DIR, 'app.db');

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

/** Open a database at the given path (use ':memory:' for tests). */
export function createDb(dbPath: string) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

export type Database = ReturnType<typeof createDb>;

let cachedDb: Database | null = null;

/** Process-wide database: created on first use, migrated on boot. */
export function getDb(): Database {
  if (!cachedDb) {
    cachedDb = createDb(DB_PATH);
    // Idempotent (IF NOT EXISTS): safe on databases from older app versions.
    migrate(cachedDb, { migrationsFolder });
  }
  return cachedDb;
}

/** Apply migrations to an already-open database (used by tests). */
export function migrateDb(database: Database) {
  migrate(database, { migrationsFolder });
}

export type { DbIngestionRun, DbJob, NewDbJob } from './schema.js';
