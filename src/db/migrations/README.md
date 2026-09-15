# Migration history

## Instructions for coding agents

- Register each migration in `db/migrate.ts` with a version, stable name, and SQL.
- Once a migration has been applied, keep its version, name, and SQL unchanged.
  Add a new migration for every subsequent schema change.
- Keep applied migrations in the registry. Startup rejects missing, renamed, or
  modified applied migrations before running pending migrations.
- The runner records a SHA-256 checksum of the exported SQL string encoded as
  UTF-8, including whitespace and comments. It does not hash the TypeScript file.
- Do not update stored checksums to make an edited migration pass validation.

Checksums detect changes to migration source. They do not detect manual schema
changes made directly in PostgreSQL.
