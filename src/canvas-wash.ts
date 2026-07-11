/**
 * Canvas wash — modes with `canvas.wash` set the terminal's default background
 * to the mode's bgBase via OSC 11, so the whole screen (not just painted cells)
 * matches the mode. OSC 111 restores the terminal's own background on exit.
 *
 * Same protocol as loop's canvas-wash. Writes use `fs.writeSync(1, …)` so the
 * reset still lands from `process.on("exit")` / signal paths where async
 * `stdout.write` is often dropped (this is exactly why loop's terminal
 * cleanup uses writeSync).
 */

import { writeSync } from "node:fs";
import { uiStyle } from "./ui-mode.ts";

let washApplied = false;

/** Sync write to fd 1 — safe from exit handlers. */
function writeRaw(bytes: string): void {
    try {
        if (!process.stdout.isTTY) return;
        writeSync(1, bytes);
    } catch {
        // stdout closed / redirected — nothing more we can do.
    }
}

/** Apply (or re-apply after a mode change) the active mode's wash. */
export function applyCanvasWash(): void {
    const style = uiStyle();
    if (style.canvas.wash && style.canvas.bgBase.startsWith("#")) {
        writeRaw(`\x1b]11;${style.canvas.bgBase}\x07`);
        washApplied = true;
    } else if (washApplied) {
        resetCanvasWash();
    }
}

/**
 * Restore the terminal's own background (exit path).
 * Always emits OSC 111 when we ever washed (or when `force` is set) so a
 * partial teardown can't leave the shell dark. Safe to call twice.
 */
export function resetCanvasWash(force = false): void {
    if (!force && !washApplied) return;
    // OSC 111 — restore default background (undoes OSC 11 canvas wash).
    // Also show the cursor in case it was left hidden.
    writeRaw("\x1b]111\x07\x1b[?25h");
    washApplied = false;
}
