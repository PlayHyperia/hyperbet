/** Adapt the hash-pinned keeper's SQLite calls to Durable Object SQL storage. */
export function createDurableSqlDatabase(storage) {
  return {
    run(sql) {
      // Workerd owns journaling and durability. These are the exact startup
      // pragmas in the pinned SQLite module, not arbitrary remote SQL input.
      if (sql === "PRAGMA journal_mode = WAL" ||
          sql === "PRAGMA synchronous = NORMAL" ||
          sql === "PRAGMA foreign_keys = ON") return;
      storage.sql.exec(sql);
    },
    prepare(sql) {
      return {
        all(...args) {
          return storage.sql.exec(sql, ...args).toArray();
        },
        run(named) {
          const bindings = [];
          // All prepared statements come from the hash-verified db.ts. Its
          // named parameters occur only as value placeholders, never literals.
          const positional = sql.replace(/\$[a-zA-Z][a-zA-Z0-9]*/g, (name) => {
            if (!Object.hasOwn(named, name)) throw new Error("Missing keeper SQL binding");
            const value = named[name];
            if (value !== null && typeof value !== "string" &&
                !(typeof value === "number" && Number.isFinite(value))) {
              throw new Error("Invalid keeper SQL binding");
            }
            bindings.push(value);
            return "?";
          });
          storage.sql.exec(positional, ...bindings);
          const row = storage.sql.exec("SELECT last_insert_rowid() AS id").one();
          return { lastInsertRowid: row.id };
        },
      };
    },
    transaction(fn) {
      return (...args) => storage.transactionSync(() => fn(...args));
    },
  };
}
