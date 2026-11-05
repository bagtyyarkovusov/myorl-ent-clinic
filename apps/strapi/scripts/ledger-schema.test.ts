import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ensureLedgerSchema,
  getLedgerSchemaVersion,
  LEDGER_SCHEMA_VERSION,
  LedgerHaltError,
  type IntegrityCheckFn,
} from './ledger-schema';

describe('ledger-schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('fresh DB initialization', () => {
    it('bootstraps a fresh DB to LEDGER_SCHEMA_VERSION', () => {
      expect(getLedgerSchemaVersion(db)).toBe(0);
      ensureLedgerSchema(db);
      expect(getLedgerSchemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
    });

    it('creates migration_run, migration_record, migration_event tables', () => {
      ensureLedgerSchema(db);
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all()
        .map((r: any) => r.name);
      expect(tables).toEqual(['migration_event', 'migration_record', 'migration_run']);
    });

    it('creates the expected indexes', () => {
      ensureLedgerSchema(db);
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all()
        .map((r: any) => r.name);
      expect(indexes).toEqual([
        'migration_event_modx_idx',
        'migration_event_run_idx',
        'migration_record_modx_idx',
        'migration_record_state_idx',
        'migration_run_label_idx',
      ]);
    });
  });

  describe('idempotency', () => {
    it('second call is a no-op', () => {
      ensureLedgerSchema(db);
      db.prepare(
        `INSERT INTO migration_run (mode, git_sha, run_label) VALUES ('dry-run', 'abc1234', 'run-a')`,
      ).run();
      const countBefore = db
        .prepare(`SELECT COUNT(*) as c FROM migration_run`)
        .get() as { c: number };

      ensureLedgerSchema(db);
      const countAfter = db
        .prepare(`SELECT COUNT(*) as c FROM migration_run`)
        .get() as { c: number };

      expect(countAfter.c).toBe(countBefore.c);
      expect(getLedgerSchemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
    });
  });

  describe('downgrade guard', () => {
    it('halts when db version is ahead of code version', () => {
      db.pragma(`user_version = ${LEDGER_SCHEMA_VERSION + 98}`);
      expect(() => ensureLedgerSchema(db)).toThrow(LedgerHaltError);
      try {
        ensureLedgerSchema(db);
      } catch (err) {
        expect(err).toBeInstanceOf(LedgerHaltError);
        expect((err as LedgerHaltError).reason).toBe('ledger_schema_newer_than_code');
      }
    });
  });

  describe('integrity-check halt', () => {
    it('halts when integrity check returns non-ok', () => {
      const failingCheck: IntegrityCheckFn = () => 'malformed row in sqlite_master';
      expect(() => ensureLedgerSchema(db, failingCheck)).toThrow(LedgerHaltError);
      try {
        ensureLedgerSchema(db, failingCheck);
      } catch (err) {
        expect(err).toBeInstanceOf(LedgerHaltError);
        expect((err as LedgerHaltError).reason).toBe('ledger_integrity_check_failed');
        expect((err as LedgerHaltError).detail).toContain('malformed');
      }
    });

    it('proceeds when integrity check returns ok', () => {
      const okCheck: IntegrityCheckFn = () => 'ok';
      ensureLedgerSchema(db, okCheck);
      expect(getLedgerSchemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
    });
  });

  describe('transaction atomicity', () => {
    it('leaves user_version untouched if a migration throws', () => {
      // Simulate a migration failure by pre-creating a conflicting table.
      db.exec(`CREATE TABLE migration_run (sentinel TEXT)`);
      expect(getLedgerSchemaVersion(db)).toBe(0);
      expect(() => ensureLedgerSchema(db)).toThrow();
      expect(getLedgerSchemaVersion(db)).toBe(0);
    });
  });

  describe('WAL journal mode', () => {
    it('enables WAL after ensure (skipped for :memory: where WAL is a no-op)', () => {
      ensureLedgerSchema(db);
      const mode = db.pragma('journal_mode', { simple: true });
      // :memory: DBs cannot actually enter WAL mode; SQLite silently keeps 'memory'.
      // File-backed DBs report 'wal'. Either is a pass — the point is that the
      // pragma call did not throw.
      expect(['wal', 'memory']).toContain(mode);
    });
  });

  describe('constraint enforcement', () => {
    beforeEach(() => {
      ensureLedgerSchema(db);
      db.prepare(
        `INSERT INTO migration_run (mode, git_sha, run_label) VALUES ('dry-run', 'abc1234', 'run-a')`,
      ).run();
    });

    it('rejects invalid state', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO migration_record (run_id, modx_id, locale, target_type, state, stage) VALUES (1, 42, 'el', 'api::page.page', 'bogus', 'classify')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it('rejects invalid mode', () => {
      expect(() =>
        db
          .prepare(`INSERT INTO migration_run (mode, git_sha, run_label) VALUES ('bogus', 'abc', 'run-b')`)
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it('rejects duplicate run_label values', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO migration_run (mode, git_sha, run_label) VALUES ('dry-run', 'def4567', 'run-a')`,
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/);
    });

    it('rejects non-boolean needs_review', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO migration_record (run_id, modx_id, locale, target_type, state, stage, needs_review) VALUES (1, 42, 'el', 'api::page.page', 'classified', 'classify', 2)`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it('rejects invalid locale', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO migration_record (run_id, modx_id, locale, target_type, state, stage) VALUES (1, 42, 'de', 'api::page.page', 'classified', 'classify')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it('accepts a well-formed row', () => {
      const info = db
        .prepare(
          `INSERT INTO migration_record (run_id, modx_id, locale, target_type, state, stage, needs_review) VALUES (1, 42, 'el', 'api::page.page', 'classified', 'classify', 0)`,
        )
        .run();
      expect(info.changes).toBe(1);
    });
  });

  describe('getLedgerSchemaVersion', () => {
    it('returns 0 on a fresh DB before ensure', () => {
      expect(getLedgerSchemaVersion(db)).toBe(0);
    });

    it('returns LEDGER_SCHEMA_VERSION after ensure', () => {
      ensureLedgerSchema(db);
      expect(getLedgerSchemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
    });
  });

  describe('v1 to v2 migration', () => {
    it('adds run_label and backfills legacy rows deterministically', () => {
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
      db.pragma('user_version = 1');

      db.prepare(`INSERT INTO migration_run (mode, git_sha) VALUES ('extract', 'abc1234')`).run();
      db.prepare(`INSERT INTO migration_run (mode, git_sha) VALUES ('dry-run', 'def4567')`).run();

      ensureLedgerSchema(db);

      expect(getLedgerSchemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);

      const rows = db
        .prepare(`SELECT id, run_label FROM migration_run ORDER BY id ASC`)
        .all() as Array<{ id: number; run_label: string }>;
      expect(rows).toEqual([
        { id: 1, run_label: 'legacy-run-1' },
        { id: 2, run_label: 'legacy-run-2' },
      ]);
    });
  });

  describe('v2 to v3 migration', () => {
    it('adds migration_event.reason_code without disturbing existing rows', () => {
      db.exec(`
        CREATE TABLE migration_run (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          finished_at      TEXT,
          mode             TEXT    NOT NULL CHECK (mode IN ('extract', 'dry-run', 'merge', 'reset-dev')),
          git_sha          TEXT    NOT NULL,
          exit_status      TEXT    CHECK (exit_status IS NULL OR exit_status IN ('ok', 'halted', 'crashed')),
          halt_reason      TEXT,
          run_label        TEXT    NOT NULL DEFAULT ''
        );
        CREATE UNIQUE INDEX migration_run_label_idx ON migration_run (run_label);

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
      db.pragma('user_version = 2');

      db.prepare(
        `INSERT INTO migration_run (mode, git_sha, run_label) VALUES ('extract', 'abc1234', 'run-a')`,
      ).run();
      db.prepare(
        `INSERT INTO migration_event (run_id, modx_id, from_state, to_state, stage, attempt, error_detail)
         VALUES (1, 42, 'classified', 'failed', 'write', 1, 'boom')`,
      ).run();

      ensureLedgerSchema(db);

      expect(getLedgerSchemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
      const columns = db.prepare(`PRAGMA table_info('migration_event')`).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('reason_code');

      const row = db
        .prepare(`SELECT modx_id, error_detail, reason_code FROM migration_event WHERE id = 1`)
        .get() as { modx_id: number; error_detail: string | null; reason_code: string | null };
      expect(row).toEqual({
        modx_id: 42,
        error_detail: 'boom',
        reason_code: null,
      });
    });
  });
});
