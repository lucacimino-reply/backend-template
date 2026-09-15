import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { exampleMigration } from "./migrations/001-example.js";

// Applied migrations are immutable. Add a new version for every schema change.
const migrations = [
  { version: 1, name: "001-example", sql: exampleMigration },
].map((migration) => ({
  ...migration,
  checksum: createHash("sha256").update(migration.sql, "utf8").digest("hex"),
}));

type AppliedMigration = {
  version: number;
  name: string;
  checksum: string;
};

const MIGRATION_LOCK_ID = 4_286_319;
const CONNECTION_RETRY_DELAY_MS = 500;
const MIGRATION_TIMEOUT_MS = 60_000;

function remainingMilliseconds(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Database initialization timed out.");
  }
  return remaining;
}

async function connectBeforeDeadline(pool: Pool, deadline: number): Promise<PoolClient> {
  let lastError: unknown;

  while (true) {
    const remaining = remainingMilliseconds(deadline);
    let timeout: NodeJS.Timeout | undefined;
    const connection = pool.connect();

    try {
      return await Promise.race([
        connection,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Database connection attempt timed out.")), remaining);
        }),
      ]);
    } catch (error) {
      lastError = error;
      void connection.then((client) => client.release()).catch(() => undefined);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }

    const retryDelay = Math.min(CONNECTION_RETRY_DELAY_MS, deadline - Date.now());
    if (retryDelay <= 0) {
      throw new Error("Timed out connecting to PostgreSQL.", { cause: lastError });
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
}

async function applyMigrations(client: PoolClient, deadline: number): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = await client.query<AppliedMigration>("SELECT version, name, checksum FROM schema_migrations");
  const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  // Validate the full recorded history before executing any pending migration.
  for (const recorded of applied.rows) {
    const migration = migrationsByVersion.get(recorded.version);
    if (migration === undefined) {
      throw new Error(`Applied migration ${recorded.version} is missing from the migration registry.`);
    }
    if (recorded.name !== migration.name || recorded.checksum !== migration.checksum) {
      throw new Error(
        `Applied migration ${recorded.version} (${migration.name}) has been modified. ` +
          "Restore its original name and SQL, then add a new migration for the change.",
      );
    }
  }
  const appliedVersions = new Set(applied.rows.map((migration) => migration.version));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    await client.query("BEGIN");
    try {
      const statementTimeout = `${remainingMilliseconds(deadline)}ms`;
      await client.query("SELECT set_config('statement_timeout', $1, true)", [statementTimeout]);
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
        migration.version,
        migration.name,
        migration.checksum,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

export async function runDatabaseMigrations(pool: Pool): Promise<void> {
  const deadline = Date.now() + MIGRATION_TIMEOUT_MS;
  const client = await connectBeforeDeadline(pool, deadline);
  let lockAcquired = false;

  try {
    const advisoryLockTimeout = `${remainingMilliseconds(deadline)}ms`;
    await client.query("SELECT set_config('lock_timeout', $1, false)", [advisoryLockTimeout]);
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    const migrationLockTimeout = `${remainingMilliseconds(deadline)}ms`;
    await client.query("SELECT set_config('lock_timeout', $1, false)", [migrationLockTimeout]);
    await applyMigrations(client, deadline);
  } finally {
    try {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
      }
    } finally {
      try {
        await client.query("RESET lock_timeout");
      } finally {
        client.release();
      }
    }
  }
}
