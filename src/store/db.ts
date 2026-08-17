/**
 * The IndexedDB layer (architecture.md section 8).
 *
 * localForage is a key-value store, not a relational one, so the five stores of
 * section 8 are five instances against one database and every access pattern is
 * either a key lookup or a full scan. That is a deliberate fit rather than a
 * compromise: `itemState` is read whole at session start (72 items today, a few
 * thousand ever), `settings` is one object, `rawMidi` is one blob per session
 * with at most 20 of them, and `sessionLog` grows by one row per session, which
 * is 365 rows a year. Only `repLog` scans, and it scans rows small enough that
 * the volume never becomes the reason anything is slow.
 *
 * **There are no cross-store transactions**, which matters exactly once: a rep
 * and the item state it caused are two writes. The rep is written first, so a
 * crash between them loses a derived value rather than a fact, and the SM-2
 * update is deterministic given the rating sequence, so the item state can be
 * rebuilt by replaying the log.
 *
 * **Durability.** `navigator.storage.persist()` is requested on first run.
 * Chrome evicts IndexedDB under storage pressure otherwise, and losing this
 * data is an adherence bug, not a data bug (section 8): the user does not
 * rebuild a month of practice history, he stops opening the app.
 */

import localforage from 'localforage';
import { SCHEMA_VERSION } from './types.ts';

const DB_NAME = 'learn-piano';

/** The five stores of architecture.md section 8, plus the schema stamp. */
export type StoreName =
  'meta' | 'itemState' | 'repLog' | 'sessionLog' | 'rawMidi' | 'settings';

function instance(name: StoreName): LocalForage {
  return localforage.createInstance({
    name: DB_NAME,
    storeName: name,
    // Chromium only (CLAUDE.md), so the localStorage and WebSQL fallbacks are
    // never wanted. Naming the driver means a browser without IndexedDB fails
    // loudly instead of silently writing a 5MB-capped store that cannot hold
    // the raw MIDI buffer.
    driver: localforage.INDEXEDDB,
  });
}

export const stores: Record<StoreName, LocalForage> = {
  meta: instance('meta'),
  itemState: instance('itemState'),
  repLog: instance('repLog'),
  sessionLog: instance('sessionLog'),
  rawMidi: instance('rawMidi'),
  settings: instance('settings'),
};

/** Every value in a store, in key order. Keys are built so that is time order. */
export async function readAll<T>(store: LocalForage): Promise<T[]> {
  const keys = (await store.keys()).sort();
  const out: T[] = [];
  for (const key of keys) {
    const value = await store.getItem<T>(key);
    if (value !== null) out.push(value);
  }
  return out;
}

export async function clearAll(): Promise<void> {
  await Promise.all(Object.values(stores).map((s) => s.clear()));
}

export interface StorageReport {
  /** Granted persistence means Chrome will not evict this origin silently. */
  persisted: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
}

/**
 * Ask for persistent storage. Chrome may grant it without a prompt (based on
 * engagement heuristics) or refuse; either way this is called once per run and
 * the answer is reported rather than acted on, because there is nothing useful
 * to do about a refusal except tell the user to export a backup.
 */
export async function requestPersistence(): Promise<StorageReport> {
  const s = navigator.storage;
  if (!s) return { persisted: false, usageBytes: null, quotaBytes: null };

  let persisted = (await s.persisted?.()) ?? false;
  if (!persisted && s.persist) persisted = await s.persist();

  const estimate = (await s.estimate?.()) ?? {};
  return {
    persisted,
    usageBytes: estimate.usage ?? null,
    quotaBytes: estimate.quota ?? null,
  };
}

export class SchemaVersionError extends Error {
  readonly found: number;

  constructor(found: number) {
    super(
      `This database was written by a newer version of the app (schema ${found}, ` +
        `this build understands ${SCHEMA_VERSION}). Refusing to open it: reading ` +
        `newer rows as if the fields still meant what they used to is how history ` +
        `gets silently corrupted. Update the app, or import a backup into a fresh profile.`
    );
    this.found = found;
  }
}

/**
 * Read the schema stamp, writing it on a first run. Throws rather than
 * migrating downward: there is no migration for a shape this build has never
 * seen, and guessing at one destroys the only copy of the data.
 */
export async function openSchema(): Promise<{ version: number; firstRun: boolean }> {
  const found = await stores.meta.getItem<number>('schemaVersion');
  if (found === null) {
    await stores.meta.setItem('schemaVersion', SCHEMA_VERSION);
    return { version: SCHEMA_VERSION, firstRun: true };
  }
  if (found > SCHEMA_VERSION) throw new SchemaVersionError(found);
  // Nothing has needed an upward migration yet. When one does, it runs here,
  // between reading the stamp and anything else reading a row.
  return { version: found, firstRun: false };
}
