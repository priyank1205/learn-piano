/**
 * The persistence layer's public surface (architecture.md section 8).
 *
 * `db.ts` is deliberately not re-exported. Everything outside this directory
 * goes through `store`, so there is exactly one place that decides the order a
 * rep and the state it caused are written in.
 */

export * from './types.ts';
export * from './weeks.ts';
export * from './backup.ts';
export { store, useProgressStore, ROLLING_WINDOW, BACKUP_NUDGE_MS } from './store.ts';
export type { RepInput, StoreStatus } from './store.ts';
export { SchemaVersionError, clearAll } from './db.ts';
export type { StorageReport } from './db.ts';
