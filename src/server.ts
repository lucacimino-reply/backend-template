import type { Server } from "node:http";

import { createApp } from "./app.js";
import { getConfig } from "./config/environment.js";
import { runDatabaseMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  const pool = createPool(config.databaseUrl, config.connectionTimeoutMs);
  
  let server: Server | undefined;
  let cleanupPromise: Promise<boolean> | undefined;

  const cleanup = (): Promise<boolean> => {
    if (cleanupPromise !== undefined) {
      return cleanupPromise;
    }

    cleanupPromise = (async () => {
      let succeeded = true;
      const shutdownTimer = setTimeout(() => {
        console.error(`Shutdown exceeded ${config.shutdownTimeoutMs}ms; forcing process termination.`);
        try {
          server?.closeAllConnections();
        } finally {
          process.exit(1);
        }
      }, config.shutdownTimeoutMs);
      // Bound cleanup without keeping an otherwise finished process alive.
      shutdownTimer.unref();

      try {
        if (server !== undefined) {
          await closeServer(server);
        }
      } catch (error) {
        console.error("Failed to close HTTP server.", error);
        process.exitCode = 1;
        succeeded = false;
      }

      try {
        await pool.end();
      } catch (error) {
        console.error("Failed to close PostgreSQL pool.", error);
        process.exitCode = 1;
        succeeded = false;
      }

      if (succeeded) {
        clearTimeout(shutdownTimer);
      }
      return succeeded;
    })();

    return cleanupPromise;
  };

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (cleanupPromise !== undefined) {
      return;
    }
    if (await cleanup()) {
      console.log(`Server stopped after ${signal}.`);
    }
  };

  try {
    await runDatabaseMigrations(pool);

    const app = createApp(pool);
    server = app.listen(config.port, () => {
      console.log(`Server listening on port ${config.port}.`);
    });

    server.once("error", (error) => {
      console.error("Server failed.", error);
      process.exitCode = 1;
      void cleanup();
    });

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    await cleanup();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error("Application startup failed.", error);
  process.exitCode = 1;
});
