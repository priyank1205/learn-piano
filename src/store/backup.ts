/**
 * One-tap JSON export and import (architecture.md section 8).
 *
 * The store owns what a backup contains; this owns getting it in and out of a
 * file. Kept apart because the store is testable without a DOM and these two
 * functions are nothing but DOM.
 *
 * There is no cloud, no sync and no server (CLAUDE.md: single user, single
 * machine, no deploy target). A file in Downloads is the entire disaster
 * recovery plan, which is why section 8 asks for a nudge once a week: persisted
 * storage makes eviction unlikely, not impossible, and the thing being
 * protected is months of practice history whose loss the user does not recover
 * from by re-entering data.
 */

import type { Backup } from './types.ts';

export function backupFilename(at: number = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `learn-piano-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

export function downloadBackup(backup: Backup): void {
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFilename(backup.exportedAt);
  a.click();
  // Revoked on the next frame rather than immediately: the click is
  // synchronous but the fetch of the blob is not, and revoking too early
  // produces an empty file on some Chromium builds.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

/**
 * Parse a chosen file, checking enough of the shape to refuse the wrong JSON
 * outright. Import replaces everything, so "is this actually a backup" has to
 * be answered before anything is cleared, not after.
 */
export async function readBackupFile(file: File): Promise<Backup> {
  const parsed: unknown = JSON.parse(await file.text());
  if (!isBackup(parsed)) {
    throw new Error(
      `${file.name} is not a learn-piano backup: it has no schemaVersion and no itemState array.`
    );
  }
  return parsed;
}

function isBackup(value: unknown): value is Backup {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Backup>;
  return (
    typeof v.schemaVersion === 'number' &&
    Array.isArray(v.itemState) &&
    Array.isArray(v.repLog) &&
    Array.isArray(v.sessionLog)
  );
}
