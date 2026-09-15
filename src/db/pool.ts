import { Pool } from "pg";

export function createPool(databaseUrl: string, connectionTimeoutMs: number): Pool {
  if (!Number.isSafeInteger(connectionTimeoutMs) || connectionTimeoutMs <= 0) {
    throw new Error("connectionTimeoutMs must be a positive safe integer.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectionTimeoutMs,
  });

  pool.on("error", (error: Error) => {
    console.error("Unexpected error on an idle PostgreSQL connection.", error);
  });

  return pool;
}
