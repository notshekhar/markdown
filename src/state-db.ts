/**
 * Persistent UI state for `markdown serve`, in one WAL SQLite file under
 * ~/.markdown (loop's packages/core/src/sessions/db.ts, scaled down).
 *
 * The web UI used to keep everything in localStorage, which made the state
 * browser-bound: a different browser, a private window or a cleared site
 * storage lost your theme, open tabs and expanded folders. Now the server
 * owns it — the page ships with the state inlined and POSTs changes back.
 *
 * Two scopes: `prefs` is global (theme, font, sidebar) and `root_state` /
 * `recent` are per served root, keyed by its absolute path.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prefs (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    path           TEXT NOT NULL UNIQUE,
    last_opened_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS root_state (
    root_id    INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (root_id, key)
);

CREATE TABLE IF NOT EXISTS recent (
    root_id   INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    path      TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    PRIMARY KEY (root_id, path)
);
CREATE INDEX IF NOT EXISTS idx_recent_root ON recent(root_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS positions (
    path       TEXT PRIMARY KEY,
    line       INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_seen ON positions(updated_at DESC);
`;

/** Per-root keys the client is allowed to store (JSON values). */
const ROOT_KEYS = new Set(["expanded", "emptyDirs", "buffers"]);
/**
 * Global keys any caller may store (string values). theme/font/sidebar are the
 * web UI's; uiMode/editorNumber/editorRelativeNumber are the terminal UI's —
 * one store, so `md` and `md serve` are the same install, not two apps.
 */
const PREF_KEYS = new Set(["theme", "font", "sidebar", "uiMode", "editorNumber", "editorRelativeNumber"]);
/** Recent list is capped so the table can't grow without bound. */
const RECENT_LIMIT = 20;
/** Ditto for remembered reading positions. */
const POSITION_LIMIT = 500;

export const DB_FILE_NAME = "state.db";

/** ~/.markdown, or $MARKDOWN_CONFIG_DIR (tests, throwaway roots). */
export function configDir(): string {
    return process.env.MARKDOWN_CONFIG_DIR || join(homedir(), ".markdown");
}

let db: Database | null = null;

export function getDb(): Database {
    if (!db) db = openDb(join(configDir(), DB_FILE_NAME));
    return db;
}

export function closeDb(): void {
    db?.close();
    db = null;
}

/**
 * Open → pragmas → schema as one retried unit: two `md serve` processes can
 * create the file at the same time, and the first WAL switch on a fresh file
 * can return SQLITE_BUSY even with busy_timeout set.
 */
function openDb(path: string, recovered = false): Database {
    // SQLite creates the file but never its parent directory.
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
        let candidate: Database | null = null;
        try {
            candidate = new Database(path, { create: true });
            candidate.exec("PRAGMA busy_timeout = 5000");
            candidate.exec("PRAGMA journal_mode = WAL");
            candidate.exec("PRAGMA synchronous = NORMAL");
            candidate.exec("PRAGMA foreign_keys = ON");
            candidate.exec(SCHEMA);
            candidate.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [
                String(SCHEMA_VERSION),
            ]);
            // Every migration so far has been "a new table", which the SCHEMA
            // exec above already created — the stamp is the whole migration.
            // A db from a newer build is left alone rather than half-read.
            const row = candidate
                .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
                .get();
            const version = Number(row?.value ?? SCHEMA_VERSION);
            if (version > SCHEMA_VERSION) {
                throw new Error(
                    `state db ${path} is schema v${version}, newer than this build (v${SCHEMA_VERSION}) — upgrade markdown`,
                );
            }
            if (version < SCHEMA_VERSION) {
                candidate.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION)]);
            }
            return candidate;
        } catch (err) {
            candidate?.close();
            lastErr = err;
            const msg = String((err as Error)?.message ?? err);
            // UI state is disposable — a damaged file is moved aside rather
            // than salvaged, and the next open starts clean.
            if (!recovered && path !== ":memory:" && /malformed|not a database|corrupt/i.test(msg)) {
                for (const suffix of ["", "-wal", "-shm"]) {
                    try {
                        if (existsSync(path + suffix)) renameSync(path + suffix, `${path}.corrupt${suffix}`);
                    } catch {}
                }
                return openDb(path, true);
            }
            if (!/SQLITE_BUSY|database is locked/i.test(msg)) throw err;
            Bun.sleepSync(25);
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`could not open state db at ${path}: ${lastErr}`);
}

function rootId(root: string): number {
    const now = Date.now();
    getDb().run(
        `INSERT INTO roots (path, last_opened_at) VALUES (?, ?)
         ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at`,
        [root, now],
    );
    const row = getDb().query<{ id: number }, [string]>("SELECT id FROM roots WHERE path = ?").get(root);
    if (!row) throw new Error(`root row vanished for ${root}`);
    return row.id;
}

export interface UiState {
    /** Global UI prefs — theme, font, sidebar. */
    prefs: Record<string, string>;
    /** Per-root JSON blobs — expanded, emptyDirs, buffers. */
    root: Record<string, unknown>;
    /** Most-recently-opened paths for this root, newest first. */
    recent: string[];
}

/** Everything the page needs at boot, for one served root. */
export function readState(root: string): UiState {
    const id = rootId(root);
    const prefs: Record<string, string> = {};
    for (const r of getDb().query<{ key: string; value: string }, []>("SELECT key, value FROM prefs").all()) {
        prefs[r.key] = r.value;
    }
    const rootState: Record<string, unknown> = {};
    const rows = getDb()
        .query<{ key: string; value: string }, [number]>("SELECT key, value FROM root_state WHERE root_id = ?")
        .all(id);
    for (const r of rows) {
        try {
            rootState[r.key] = JSON.parse(r.value);
        } catch {
            // A hand-edited or truncated value just falls back to "unset".
        }
    }
    const recent = getDb()
        .query<{ path: string }, [number, number]>(
            "SELECT path FROM recent WHERE root_id = ? ORDER BY opened_at DESC LIMIT ?",
        )
        .all(id, RECENT_LIMIT)
        .map((r) => r.path);
    return { prefs, root: rootState, recent };
}

/** Global prefs only — the terminal UI has no served root to scope to. */
export function readPrefs(): Record<string, string> {
    const prefs: Record<string, string> = {};
    for (const r of getDb().query<{ key: string; value: string }, []>("SELECT key, value FROM prefs").all()) {
        prefs[r.key] = r.value;
    }
    return prefs;
}

export function writePrefs(patch: Record<string, unknown>): void {
    const now = Date.now();
    for (const [key, value] of Object.entries(patch)) {
        if (!PREF_KEYS.has(key)) continue;
        getDb().run(
            `INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [key, String(value), now],
        );
    }
}

export function writeRootState(root: string, patch: Record<string, unknown>): void {
    const id = rootId(root);
    const now = Date.now();
    for (const [key, value] of Object.entries(patch)) {
        if (!ROOT_KEYS.has(key)) continue;
        getDb().run(
            `INSERT INTO root_state (root_id, key, value, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(root_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [id, key, JSON.stringify(value), now],
        );
    }
}

/**
 * Reading position (top visible line) for a file, keyed by absolute path — the
 * terminal viewer reopens where you left off. Absent → start at the top.
 */
export function readPosition(path: string): number | null {
    const row = getDb().query<{ line: number }, [string]>("SELECT line FROM positions WHERE path = ?").get(path);
    return row ? row.line : null;
}

export function writePosition(path: string, line: number): void {
    if (!path) return;
    // Line 0 is the default view, so it is stored as "forget this file"
    // rather than as a position to restore.
    if (line <= 0) {
        getDb().run("DELETE FROM positions WHERE path = ?", [path]);
        return;
    }
    // Forced past the newest row rather than trusting the clock: several files
    // touched inside one millisecond would otherwise tie, and the trim below
    // would then evict arbitrary rows instead of the oldest.
    getDb().run(
        `INSERT INTO positions (path, line, updated_at)
         VALUES (?, ?, MAX(?, COALESCE((SELECT MAX(updated_at) FROM positions) + 1, 0)))
         ON CONFLICT(path) DO UPDATE SET line = excluded.line, updated_at = excluded.updated_at`,
        [path, Math.floor(line), Date.now()],
    );
    getDb().run(
        `DELETE FROM positions WHERE path NOT IN
         (SELECT path FROM positions ORDER BY updated_at DESC LIMIT ?)`,
        [POSITION_LIMIT],
    );
}

/** Record a file open; re-opening an old file moves it back to the front. */
export function pushRecent(root: string, path: string): void {
    if (!path) return;
    const id = rootId(root);
    // Same-millisecond pushes (a migration replaying a list) must still order,
    // so the stamp is forced past the newest row rather than trusting the clock.
    getDb().run(
        `INSERT INTO recent (root_id, path, opened_at)
         VALUES (?, ?, MAX(?, COALESCE((SELECT MAX(opened_at) FROM recent WHERE root_id = ?) + 1, 0)))
         ON CONFLICT(root_id, path) DO UPDATE SET opened_at = excluded.opened_at`,
        [id, path, Date.now(), id],
    );
    getDb().run(
        `DELETE FROM recent WHERE root_id = ? AND path NOT IN
         (SELECT path FROM recent WHERE root_id = ? ORDER BY opened_at DESC LIMIT ?)`,
        [id, id, RECENT_LIMIT],
    );
}
