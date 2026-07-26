import type {
  BindingSpec,
  Database,
  PreparedStatement,
  Sqlite3Static
} from "@sqlite.org/sqlite-wasm";

type Bindable = null | number | bigint | string | Uint8Array;
type NamedParameters = Record<string, Bindable>;
type Parameters = Bindable[] | NamedParameters | undefined;

type RawDatabase = Database;

export type DatabaseSyncOptions = {
  allowExtension?: boolean;
  open?: boolean;
  readOnly?: boolean;
  timeout?: number;
};

export type RunResult = {
  lastInsertRowid: number | bigint;
  changes: number;
};

export type ColumnMetadata = {
  column: string | null;
  database: string | null;
  name: string;
  origin: string | null;
  table: string | null;
  type: string | null;
};

function isNamedParameters(value: unknown): value is NamedParameters {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(value instanceof Uint8Array);
}

function parametersFrom(args: Bindable[] | [NamedParameters]): Parameters {
  if (args.length === 0) return undefined;
  if (args.length === 1 && isNamedParameters(args[0])) return args[0];
  return args as Bindable[];
}

function normalRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("SQLite returned a non-object row");
  }
  return { ...value };
}

function bind(raw: PreparedStatement, parameters: Parameters): void {
  if (parameters !== undefined) raw.bind(parameters as BindingSpec);
}

export function createNodeSqliteModule(
  sqlite3: Sqlite3Static,
  vfsName: string
) {
  class StatementSync {
    readonly #database: RawDatabase;
    readonly #sql: string;

    constructor(database: RawDatabase, sql: string) {
      this.#database = database;
      this.#sql = sql;
    }

    all(...args: Bindable[] | [NamedParameters]): Record<string, unknown>[] {
      const statement = this.#database.prepare(this.#sql);
      try {
        bind(statement, parametersFrom(args));
        const rows: Record<string, unknown>[] = [];
        while (statement.step()) rows.push(normalRow(statement.get(Object.create(null))));
        return rows;
      } finally {
        statement.finalize();
      }
    }

    columns(): ColumnMetadata[] {
      const statement = this.#database.prepare(this.#sql);
      try {
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

    get(...args: Bindable[] | [NamedParameters]): Record<string, unknown> | undefined {
      const statement = this.#database.prepare(this.#sql);
      try {
        bind(statement, parametersFrom(args));
        return statement.step()
          ? normalRow(statement.get(Object.create(null)))
          : undefined;
      } finally {
        statement.finalize();
      }
    }

    *iterate(...args: Bindable[] | [NamedParameters]): IterableIterator<Record<string, unknown>> {
      const statement = this.#database.prepare(this.#sql);
      try {
        bind(statement, parametersFrom(args));
        while (statement.step()) yield normalRow(statement.get(Object.create(null)));
      } finally {
        statement.finalize();
      }
    }

    run(...args: Bindable[] | [NamedParameters]): RunResult {
      const statement = this.#database.prepare(this.#sql);
      try {
        bind(statement, parametersFrom(args));
        while (statement.step()) {
          // Node's run() discards RETURNING rows but executes to completion.
        }
      } finally {
        statement.finalize();
      }
      const result = this.#database.selectObject(
        "SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid"
      );
      return {
        changes: Number(result?.changes ?? 0),
        lastInsertRowid: result?.lastInsertRowid as number | bigint
      };
    }
  }

  class DatabaseSync {
    readonly #database: RawDatabase;
    #open = true;

    constructor(path: string, options: DatabaseSyncOptions = {}) {
      if (options.open === false) {
        throw new Error("DatabaseSync open:false is not implemented in milestone 0");
      }
      if (path === ":memory:") {
        this.#database = new sqlite3.oo1.DB(":memory:", "c");
      } else {
        const flags = options.readOnly ? "r" : "c";
        this.#database = new sqlite3.oo1.DB({
          filename: path,
          flags,
          vfs: vfsName
        });
      }
    }

    get isOpen(): boolean {
      return this.#open;
    }

    close(): void {
      if (!this.#open) return;
      this.#database.close();
      this.#open = false;
    }

    exec(sql: string): void {
      this.#assertOpen();
      this.#database.exec(sql);
    }

    prepare(sql: string): StatementSync {
      this.#assertOpen();
      return new StatementSync(this.#database, sql);
    }

    enableLoadExtension(_allow: boolean): void {
      throw new Error("SQLite extensions are not implemented in milestone 0");
    }

    loadExtension(_path: string): void {
      throw new Error("SQLite extensions are not implemented in milestone 0");
    }

    #assertOpen(): void {
      if (!this.#open) throw new Error("The database is not open");
    }
  }

  return Object.freeze({ DatabaseSync, StatementSync });
}

export type NodeSqliteModule = ReturnType<typeof createNodeSqliteModule>;
