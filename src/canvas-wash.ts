/**
 * Canvas wash — modes with `canvas.wash` set the terminal's default background
 * to the mode's bgBase via OSC 11, so the whole screen (not just painted cells)
 * matches the mode. OSC 111 restores the terminal's own background on exit.
 *
 * Same protocol as loop's canvas-wash; zero dependencies.
 */

import { uiStyle } from "./ui-mode.ts";

let washApplied = false;

/** Apply (or re-apply after a mode change) the active mode's wash. */
export function applyCanvasWash(out: NodeJS.WriteStream = process.stdout): void {
    const style = uiStyle();
    if (style.canvas.wash && style.canvas.bgBase.startsWith("#")) {
        out.write(`\x1b]11;${style.canvas.bgBase}\x07`);
        washApplied = true;
    } else if (washApplied) {
        resetCanvasWash(out);
    }
}

/** Restore the terminal's own background (exit path — safe to call twice). */
export function resetCanvasWash(out: NodeJS.WriteStream = process.stdout): void {
    if (!washApplied) return;
    out.write("\x1b]111\x07");
    washApplied = false;
}
