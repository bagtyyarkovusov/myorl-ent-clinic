/**
 * Phase 6.5 migration ledger — schema module.
 *
 * Forward-only SQLite migration framework for the external ledger DB at
 * apps/strapi/scripts/.migration-ledger.sqlite (gitignored). Version
 * tracking is via `PRAGMA user_version`; every schema change adds a new
 * migration function and bumps LEDGER_SCHEMA_VERSION. Past migrations
 * are never edited.
 *
 * See plans/pr-preparation/pr-6-ledger-schema.md for the design
 * rationale and the Q6 grill transcript.
 */

import type Database from 'better-sqlite3';

export const LEDGER_SCHEMA_VERSION = 3;

export const LEDGER_EXIT = {
  OK: 0,
  INTEGRITY_CHECK_FAILED: 10,
  SCHEMA_NEWER_THAN_CODE: 11,
} as const;

export type LedgerHaltReason =
  | 'ledger_integrity_check_failed'
  | 'ledger_schema_newer_than_code';

export class LedgerHaltError extends Error {
  readonly reason: LedgerHaltReason;
  readonly detail?: string;

  constructor(reason: LedgerHaltReason, detail?: string) {
    super(`[ledger] HALT: ${reason}${detail ? ` — ${detail}` : ''}`);
    this.name = 'LedgerHaltError';
    this.reason = reason;
    this.detail = detail;
  }
}

type MigrationFn = (db: Database.Database) => void;

/**
 * Baseline (v1) — introduces the three core ledger tables and their indexes.
 * Columns match the locked Q5/Q6 grill spec verbatim.
 */
const migration001: MigrationFn = (db) => {
  db.exec(`
    CREATE TABLE migration_run (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      finished_at      TEXT,
      mode             TEXT    NOT NULL CHECK (mode IN ('extract', 'dry-run', 'merge', 'reset-dev')),
      git_sha          TEXT    NOT NULL,
      exit_status      TEXT    CHECK (exit_status IS NULL OR exit_status IN ('ok', 'halted', 'crashed')),
      halt_reason      TEXT
    );

    CREATE TABLE migration_record (
      run_id           INTEGER NOT NULL REFERENCES migration_run(id) ON DELETE RESTRICT,
      modx_id          INTEGER NOT NULL,
      locale           TEXT    NOT NULL CHECK (locale IN ('el', 'ru')),
      target_type      TEXT    NOT NULL,
      state            TEXT    NOT NULL CHECK (state IN (
                         'discovered', 'classified', 'validated', 'writing',
                         'succeeded', 'failed', 'skipped', 'superseded'
                       )),
      stage            TEXT    NOT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0,
      reason_code      TEXT,
      last_error       TEXT,
      strapi_doc_id    TEXT,
      content_hash     TEXT,
      needs_review     INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
      updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (run_id, modx_id)
    );

    CREATE INDEX migration_record_modx_idx ON migration_record (modx_id);
    CREATE INDEX migration_record_state_idx ON migration_record (state);

    CREATE TABLE migration_event (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id           INTEGER NOT NULL REFERENCES migration_run(id) ON DELETE RESTRICT,
      modx_id          INTEGER NOT NULL,
      from_state       TEXT,
      to_state         TEXT    NOT NULL,
      stage            TEXT    NOT NULL,
      attempt          INTEGER NOT NULL,
      at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      error_detail     TEXT
    );

    CREATE INDEX migration_event_modx_idx ON migration_event (modx_id);
    CREATE INDEX migration_event_run_idx ON migration_event (run_id);
  `);
};

/**
 * v2 — adds a stable external run label alongside the internal integer PK.
 * Existing rows are backfilled deterministically so the unique index can be
 * created without manual cleanup.
 */
const migration002: MigrationFn = (db) => {
  db.exec(`
    ALTER TABLE migration_run
      ADD COLUMN run_label TEXT NOT NULL DEFAULT '';

    UPDATE migration_run
      SET run_label = 'legacy-run-' || id
      WHERE run_label = '';

    CREATE UNIQUE INDEX migration_run_label_idx ON migration_run (run_label);
  `);
};

/**
 * v3 — adds per-event reason codes so merge runs can distinguish lenient
 * annotations from hard failures without overloading `error_detail`.
 */
const migration003: MigrationFn = (db) => {
  db.exec(`
    ALTER TABLE migration_event
      ADD COLUMN reason_code TEXT;
  `);
};

const migrations: MigrationFn[] = [migration001, migration002, migration003];

/**
 * Read-only helper. Returns the current PRAGMA user_version value.
 * A fresh DB reports 0; post-migrate reports LEDGER_SCHEMA_VERSION.
 */
export function getLedgerSchemaVersion(db: Database.Database): number {
  const result = db.pragma('user_version', { simple: true });
  return typeof result === 'number' ? result : 0;
}

/**
 * Test seam: by default runs `PRAGMA integrity_check`. Production callers pass
 * no second argument. Tests may inject a stub to force the halt path.
 */
export type IntegrityCheckFn = (db: Database.Database) => string;

const defaultIntegrityCheck: IntegrityCheckFn = (db) => {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  return rows[0]?.integrity_check ?? 'unknown';
};

/**
 * Idempotent startup ritual for the ledger DB.
 *
 * 1. PRAGMA integrity_check        → halt on non-'ok'
 * 2. PRAGMA journal_mode = WAL     → idempotent
 * 3. read user_version
 * 4. if user_version > LEDGER_SCHEMA_VERSION → halt (downgrade guard)
 * 5. apply migrations[current..LEDGER_SCHEMA_VERSION) in transactions
 *
 * @throws LedgerHaltError on either halt condition.
 */
export function ensureLedgerSchema(
  db: Database.Database,
  integrityCheck: IntegrityCheckFn = defaultIntegrityCheck,
): void {
  const integrity = integrityCheck(db);
  if (integrity !== 'ok') {
    throw new LedgerHaltError('ledger_integrity_check_failed', integrity);
  }

  db.pragma('journal_mode = WAL');

  const current = getLedgerSchemaVersion(db);
  if (current > LEDGER_SCHEMA_VERSION) {
    throw new LedgerHaltError(
      'ledger_schema_newer_than_code',
      `db=${current} code=${LEDGER_SCHEMA_VERSION}`,
    );
  }

  for (let v = current + 1; v <= LEDGER_SCHEMA_VERSION; v++) {
    const apply = migrations[v - 1];
    if (!apply) {
      throw new Error(`[ledger] missing migration function for version ${v}`);
    }
    const tx = db.transaction(() => {
      apply(db);
      db.pragma(`user_version = ${v}`);
    });
    tx();
  }
}
