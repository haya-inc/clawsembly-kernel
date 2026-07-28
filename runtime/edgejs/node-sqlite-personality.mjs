import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

function capabilityError(databasePath, allowedPathRoots) {
  const error = new Error(
    `SQLite path capability denied for ${databasePath}; allowed roots: ${allowedPathRoots.join(", ")}`
  );
  error.code = "ERR_CLAWSEMBLY_CAPABILITY_DENIED";
  return error;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeAllowedRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new TypeError("node:sqlite requires at least one allowedPathRoot capability");
  }
  return Object.freeze(roots.map((root) => path.resolve(root)));
}

function normalizeRow(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("SQLite returned a non-object row");
  }
  return { ...value };
}

function isNamedParameters(value) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(value instanceof Uint8Array);
}

function parametersFrom(args) {
  if (args.length === 0) return undefined;
  if (args.length === 1 && isNamedParameters(args[0])) return args[0];
  return args;
}

function bind(statement, parameters) {
  if (parameters !== undefined) statement.bind(parameters);
}

function internalFilenameFor(realPath) {
  const digest = createHash("sha256").update(realPath).digest("hex");
  return `/clawsembly-${digest}.sqlite3`;
}

function sqliteVersion(sqlite3) {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  try {
    return String(database.selectValue("SELECT sqlite_version()"));
  } finally {
    database.close();
  }
}

export function createNodeSqlitePersonality(sqlite3, options) {
  const allowedPathRoots = normalizeAllowedRoots(options?.allowedPathRoots);
  let atomicWriteSequence = 0;

  class StatementSync {
    #owner;
    #sql;

    constructor(owner, sql) {
      this.#owner = owner;
      this.#sql = sql;
    }

    all(...args) {
      return this.#execute(args, (statement) => {
        const rows = [];
        while (statement.step()) rows.push(normalizeRow(statement.get(Object.create(null))));
        return rows;
      });
    }

    columns() {
      const statement = this.#owner.raw.prepare(this.#sql);
      try {
        if (statement.columnCount === 0) return [];
        return statement.getColumnNames().map((name) => ({
          column: name,
          database: null,
          name,
          origin: null,
          table: null,
          type: null
        }));
      } finally {
        statement.finalize();
      }
    }

    get(...args) {
      return this.#execute(
        args,
        (statement) => statement.step()
          ? normalizeRow(statement.get(Object.create(null)))
          : undefined
      );
    }

    *iterate(...args) {
      const statement = this.#owner.raw.prepare(this.#sql);
      try {
        bind(statement, parametersFrom(args));
        while (statement.step()) yield normalizeRow(statement.get(Object.create(null)));
      } finally {
        statement.finalize();
        this.#owner.afterStatement();
      }
    }

    run(...args) {
      const statement = this.#owner.raw.prepare(this.#sql);
      try {
        bind(statement, parametersFrom(args));
        while (statement.step()) {
          // node:sqlite discards RETURNING rows from run(), but executes them.
        }
      } finally {
        statement.finalize();
      }
      const result = this.#owner.raw.selectObject(
        "SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid"
      );
      this.#owner.afterStatement();
      return {
        changes: Number(result?.changes ?? 0),
        lastInsertRowid: result?.lastInsertRowid ?? 0
      };
    }

    #execute(args, execute) {
      const statement = this.#owner.raw.prepare(this.#sql);
      try {
        bind(statement, parametersFrom(args));
        return execute(statement);
      } finally {
        statement.finalize();
        this.#owner.afterStatement();
      }
    }
  }

  class DatabaseSync {
    #raw;
    #realPath;
    #readOnly;
    #open = true;
    #dirty = false;

    constructor(databasePath, databaseOptions = {}) {
      if (databaseOptions.open === false) {
        throw new Error("DatabaseSync open:false is not implemented by the Edge.js personality");
      }
      if (databaseOptions.allowExtension === true) {
        throw new Error("SQLite native extensions are outside the kernel capability boundary");
      }

      this.#readOnly = databaseOptions.readOnly === true;
      if (databasePath === ":memory:") {
        this.#realPath = null;
        this.#raw = new sqlite3.oo1.DB(":memory:", "c");
      } else {
        if (typeof databasePath !== "string") {
          throw new TypeError("DatabaseSync path must be a string");
        }
        const realPath = path.resolve(databasePath);
        if (!allowedPathRoots.some((root) => isWithinRoot(realPath, root))) {
          throw capabilityError(realPath, allowedPathRoots);
        }
        if (this.#readOnly && !existsSync(realPath)) {
          const error = new Error(`SQLite database does not exist: ${realPath}`);
          error.code = "SQLITE_CANTOPEN";
          throw error;
        }

        this.#realPath = realPath;
        const internalFilename = internalFilenameFor(realPath);
        if (existsSync(realPath)) {
          sqlite3.capi.sqlite3_js_posix_create_file(
            internalFilename,
            new Uint8Array(readFileSync(realPath))
          );
        }
        this.#raw = new sqlite3.oo1.DB(internalFilename, this.#readOnly ? "r" : "c");
        // The nested official SQLite Wasm build uses its POSIX/MEMFS VFS.
        // Exclusive locking is the storage precondition that makes WAL safe
        // before the unmodified OpenClaw artifact issues its first SQL.
        this.#raw.exec("PRAGMA locking_mode=EXCLUSIVE;");
      }

      if (databaseOptions.timeout !== undefined) {
        if (!Number.isInteger(databaseOptions.timeout) || databaseOptions.timeout < 0) {
          throw new TypeError("DatabaseSync timeout must be a non-negative integer");
        }
        this.#raw.exec(`PRAGMA busy_timeout=${databaseOptions.timeout};`);
      }
    }

    get raw() {
      this.#assertOpen();
      return this.#raw;
    }

    get isOpen() {
      return this.#open;
    }

    afterStatement() {
      this.#dirty = true;
      this.#flushIfAutocommit();
    }

    close() {
      if (!this.#open) return;
      this.#flush(true);
      this.#raw.close();
      this.#open = false;
    }

    exec(sql) {
      this.#assertOpen();
      this.#raw.exec(sql);
      this.#dirty = true;
      this.#flushIfAutocommit();
    }

    prepare(sql) {
      this.#assertOpen();
      return new StatementSync(this, sql);
    }

    enableLoadExtension() {
      throw new Error("SQLite native extensions are outside the kernel capability boundary");
    }

    loadExtension() {
      throw new Error("SQLite native extensions are outside the kernel capability boundary");
    }

    #assertOpen() {
      if (!this.#open) throw new Error("The database is not open");
    }

    #flushIfAutocommit() {
      if (sqlite3.capi.sqlite3_get_autocommit(this.#raw.pointer)) this.#flush(false);
    }

    #flush(force) {
      if (
        this.#readOnly
        || this.#realPath === null
        || (!force && !this.#dirty)
      ) {
        return;
      }
      if (!sqlite3.capi.sqlite3_get_autocommit(this.#raw.pointer)) {
        if (force) throw new Error("Cannot close a DatabaseSync with an active transaction");
        return;
      }

      // Fold committed WAL pages into the serialized main database before
      // crossing from the nested SQLite Wasm filesystem to the Edge.js host.
      this.#raw.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      const bytes = sqlite3.capi.sqlite3_js_db_export(this.#raw.pointer);
      mkdirSync(path.dirname(this.#realPath), { recursive: true });
      atomicWriteSequence += 1;
      const temporaryPath = `${this.#realPath}.clawsembly-${process.pid}-${atomicWriteSequence}.tmp`;
      writeFileSync(temporaryPath, bytes, { mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.#realPath);
      this.#dirty = false;
    }
  }

  const personality = {
    DatabaseSync,
    StatementSync,
    clawsembly: Object.freeze({
      allowedPathRoots,
      persistence: "sqlite-wasm-posix-export",
      sqliteVersion: sqliteVersion(sqlite3)
    })
  };
  return Object.freeze(personality);
}
