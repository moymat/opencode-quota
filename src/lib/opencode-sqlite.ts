export interface SqliteConn {
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
  close(): void;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface BunSqliteDatabase {
  query(sql: string): SqliteStatement;
  close(): void;
}

interface BunSqliteModule {
  Database: new (
    path: string,
    options?: { readonly?: boolean; create?: boolean },
  ) => BunSqliteDatabase;
}

interface NodeSqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: {
      readOnly?: boolean;
      enableForeignKeyConstraints?: boolean;
      open?: boolean;
    },
  ) => NodeSqliteDatabase;
}

function toParams(params?: unknown[]): unknown[] {
  return Array.isArray(params) ? params : [];
}

function runBunPragma(db: BunSqliteDatabase, sql: string): void {
  try {
    db.query(sql).run();
  } catch {
    // ignore
  }
}

function runNodePragma(db: NodeSqliteDatabase, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // ignore
  }
}

async function openWithNodeSqlite(dbPath: string): Promise<SqliteConn> {
  const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  const db = new mod.DatabaseSync(dbPath, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    open: true,
  });

  // Keep reads deterministic and avoid accidental writes.
  runNodePragma(db, "PRAGMA query_only = ON;");

  // Avoid transient SQLITE_BUSY errors (WAL).
  runNodePragma(db, "PRAGMA busy_timeout = 5000;");

  return {
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      const stmt = db.prepare(sql);
      return stmt.all(...toParams(params)) as T[];
    },

    get<T = unknown>(sql: string, params?: unknown[]): T | null {
      const stmt = db.prepare(sql);
      const row = stmt.get(...toParams(params)) as T | undefined;
      return row ?? null;
    },

    close(): void {
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}

async function openWithBunSqlite(dbPath: string): Promise<SqliteConn> {
  const mod = (await import("bun:sqlite")) as unknown as BunSqliteModule;
  const db = new mod.Database(dbPath, { readonly: true });

  // Keep reads deterministic and avoid accidental writes.
  runBunPragma(db, "PRAGMA query_only = ON;");

  // Avoid transient SQLITE_BUSY errors (WAL).
  runBunPragma(db, "PRAGMA busy_timeout = 5000;");

  return {
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      const stmt = db.query(sql);
      return stmt.all(...toParams(params)) as T[];
    },

    get<T = unknown>(sql: string, params?: unknown[]): T | null {
      const stmt = db.query(sql);
      const row = stmt.get(...toParams(params)) as T | undefined;
      return row ?? null;
    },

    close(): void {
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}

async function openCopyWithNodeSqlite(dbPath: string): Promise<SqliteConn> {
  const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  // Read-write open so SQLite recovers a copied WAL; queries are locked
  // read-only right after.
  const db = new mod.DatabaseSync(dbPath, {
    readOnly: false,
    enableForeignKeyConstraints: false,
    open: true,
  });

  runNodePragma(db, "PRAGMA query_only = ON;");
  runNodePragma(db, "PRAGMA busy_timeout = 5000;");

  return {
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      const stmt = db.prepare(sql);
      return stmt.all(...toParams(params)) as T[];
    },

    get<T = unknown>(sql: string, params?: unknown[]): T | null {
      const stmt = db.prepare(sql);
      const row = stmt.get(...toParams(params)) as T | undefined;
      return row ?? null;
    },

    close(): void {
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}

async function openCopyWithBunSqlite(dbPath: string): Promise<SqliteConn> {
  const mod = (await import("bun:sqlite")) as unknown as BunSqliteModule;
  // Read-write open so SQLite recovers a copied WAL; queries are locked
  // read-only right after. No options object: the default open is read-write,
  // and explicit flags (`readonly: false`, `readwrite: true`) throw
  // SQLITE_MISUSE on some Bun builds.
  let db: BunSqliteDatabase;
  try {
    db = new mod.Database(dbPath);
  } catch {
    db = new mod.Database(dbPath, { create: true });
  }

  runBunPragma(db, "PRAGMA query_only = ON;");
  runBunPragma(db, "PRAGMA busy_timeout = 5000;");

  return {
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      const stmt = db.query(sql);
      return stmt.all(...toParams(params)) as T[];
    },

    get<T = unknown>(sql: string, params?: unknown[]): T | null {
      const stmt = db.query(sql);
      const row = stmt.get(...toParams(params)) as T | undefined;
      return row ?? null;
    },

    close(): void {
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Open OpenCode's SQLite database read-only.
 * Inside OpenCode 2 (Bun) this uses bun:sqlite; the Node CLI uses node:sqlite.
 */
export async function openOpenCodeSqliteReadOnly(dbPath: string): Promise<SqliteConn> {
  if ("Bun" in globalThis) {
    return openWithBunSqlite(dbPath);
  }

  return openWithNodeSqlite(dbPath);
}

/**
 * Open a copied SQLite database for reading. Unlike a direct read-only open,
 * this works on a live WAL database copied without its shared-memory file: the
 * copy is opened read-write so SQLite recovers the copied WAL, then queries
 * are locked read-only. Only ever point this at a temporary copy, never at a
 * database owned by a running application.
 */
export async function openSqliteCopyReadOnly(dbPath: string): Promise<SqliteConn> {
  if ("Bun" in globalThis) {
    return openCopyWithBunSqlite(dbPath);
  }

  return openCopyWithNodeSqlite(dbPath);
}
