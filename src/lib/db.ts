import { createClient } from "@libsql/client/node";
import type { Client, Transaction } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

type Gate = {
  acquire: () => Promise<() => void>;
  references: number;
};
const processState = globalThis as typeof globalThis & { medcollectDatabaseGates?: Map<string, Gate> };
const gates = processState.medcollectDatabaseGates ??= new Map<string, Gate>();

function createGate(onIdle?: () => void): Gate {
  let tail = Promise.resolve();
  let pending = 0;
  const gate: Gate = {
    references: 0,
    async acquire() {
      pending++;
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>((done) => { unlock = done; });
      await previous;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending--;
        unlock();
        if (!pending && gate.references === 0) onIdle?.();
      };
    },
  };
  return gate;
}

/** Canonicalize file identity so separate request clients share the same local writer. */
function databasePath(url: string): string | null {
  if (!url.startsWith("file:") || /(?:^file::memory:|[?&]mode=memory(?:&|$))/.test(url)) return null;
  return url.startsWith("file://") ? fileURLToPath(url) : resolve(decodeURIComponent(url.slice(5).split("?")[0]));
}

function serializeLocalClient(raw: Client, gate: Gate): Client {
  const transactions = new Set<Transaction>();
  const cache = new Map<PropertyKey, unknown>();
  let closed = false;
  gate.references++;

  const wrapTransaction = (transaction: Transaction, release: () => void): Transaction => {
    const methods = new Map<PropertyKey, unknown>();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      transactions.delete(wrapped);
      release();
    };
    const wrapped = new Proxy(transaction, {
      get(target, property) {
        if (methods.has(property)) return methods.get(property);
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        let method;
        if (property === "close" || property === Symbol.dispose) {
          method = () => { try { return value.call(target); } finally { finish(); } };
        } else if (property === "commit" || property === "rollback") {
          method = async () => { try { return await value.call(target); } finally { finish(); } };
        } else {
          method = value.bind(target);
        }
        methods.set(property, method);
        return method;
      },
    });
    transactions.add(wrapped);
    return wrapped;
  };

  return new Proxy(raw, {
    get(target, property) {
      if (cache.has(property)) return cache.get(property);
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      let method;
      if (property === "close" || property === Symbol.dispose) {
        method = () => {
          if (closed) return;
          closed = true;
          try {
            for (const transaction of transactions) transaction.close();
            value.call(target);
          } finally {
            gate.references--;
            // An empty acquire also schedules removal after any earlier pending work.
            void gate.acquire().then((release) => release());
          }
        };
      } else if (property === "transaction") {
        method = async (...args: unknown[]) => {
          const release = await gate.acquire();
          try { return wrapTransaction(await value.apply(target, args), release); }
          catch (error) { release(); throw error; }
        };
      } else {
        method = async (...args: unknown[]) => {
          const release = await gate.acquire();
          try { return await value.apply(target, args); }
          finally { release(); }
        };
      }
      cache.set(property, method);
      return method;
    },
  });
}

export function createDatabase(url: string) {
  const path = databasePath(url);
  if (path) mkdirSync(dirname(path), { recursive: true });
  let gate: Gate;
  if (path) {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    gate = gates.get(key) ?? createGate(() => { if (gates.get(key) === gate) gates.delete(key); });
    gates.set(key, gate);
  } else {
    // Each anonymous memory database is independent, but its own operations still serialize.
    gate = createGate();
  }
  // libSQL 0.18's native file pool can leave a failed BEGIN statement active when
  // competing writers run on the same JS thread. Queue the whole transaction (not
  // just BEGIN), as well as independent auth/session writes, across local clients.
  // SQLite transactions and unique constraints remain the durable authority.
  const client = serializeLocalClient(createClient({ url, concurrency: 1 }), gate);
  const ready = (async () => {
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA journal_mode = WAL");
  })();
  const db = drizzle(client, { schema });
  return { db, client, ready };
}

type Connection = ReturnType<typeof createDatabase>;
const globalDb = globalThis as typeof globalThis & { medcollectDb?: Connection };
const connection = globalDb.medcollectDb ?? createDatabase(process.env.DATABASE_URL || "file:./data/medcollect.db");
if (process.env.NODE_ENV !== "production") globalDb.medcollectDb = connection;
export const db = connection.db;
export const client = connection.client;
export const databaseReady = connection.ready;
export type Database = typeof db;
