/**
 * The terminal UI's view of ~/.markdown/state.db — the same store `md serve`
 * uses, so one install has one memory: UI mode, editor `:set` options and the
 * line you stopped reading at.
 *
 * Every accessor is fail-soft. A missing, locked or corrupt state file must
 * never take down the viewer, so reads fall back to defaults and writes are
 * dropped silently; the worst outcome is a session that doesn't remember.
 */

import { readPosition, readPrefs, writePosition, writePrefs } from "./state-db.ts";

function safe<T>(fn: () => T, fallback: T): T {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

export interface TuiPrefs {
    /** Stored UI mode id, if any — CLI flag and env still win over it. */
    uiMode?: string;
    number: boolean;
    relativenumber: boolean;
}

export function loadTuiPrefs(): TuiPrefs {
    return safe<TuiPrefs>(() => {
        const prefs = readPrefs();
        return {
            uiMode: prefs.uiMode,
            // Both default on, matching the editor's own defaults.
            number: prefs.editorNumber !== "0",
            relativenumber: prefs.editorRelativeNumber !== "0",
        };
    }, { number: true, relativenumber: true });
}

export function saveUiMode(id: string): void {
    safe(() => writePrefs({ uiMode: id }), undefined);
}

export function saveEditorOptions(opts: { number?: boolean; relativenumber?: boolean }): void {
    safe(
        () =>
            writePrefs({
                editorNumber: opts.number === false ? "0" : "1",
                editorRelativeNumber: opts.relativenumber === false ? "0" : "1",
            }),
        undefined,
    );
}

export function loadPosition(path: string): number {
    return safe(() => readPosition(path) ?? 0, 0);
}

export function savePosition(path: string, line: number): void {
    safe(() => writePosition(path, line), undefined);
}
