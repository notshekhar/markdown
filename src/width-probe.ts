/**
 * Startup calibration for the width model: print three Devanagari canaries and
 * ask the terminal where its cursor ended up. Cluster layout is unstandardized
 * — Ghostty caps a cluster at one cell pair, some terminals shape a whole
 * conjunct into one cell, most lay out every spacing codepoint — so the only
 * reliable answer comes from the terminal in front of us.
 *
 * The probe paints inside a synchronized update, on the current line, and
 * erases itself; nothing is visible even when replies never arrive.
 */

import { setWidthCalibration } from "./width.ts";

// की   → matra in its own cell?     col 3 = yes, 2 = no
// प्रे  → whole conjunct shaped?      col 2 = yes
// स्त्र  → cluster capped at 2 cells?  col 3 (not 4) = yes
const CANARIES = "\x1b[?2026h\x1b7\rकी\x1b[6n\r\x1b[2Kप्रे\x1b[6n\r\x1b[2Kस्त्र\x1b[6n\r\x1b[2K\x1b8\x1b[?2026l";
const CPR = /^\x1b\[(\d+);(\d+)R/;
const REPLY_TIMEOUT_MS = 2000;

export interface WidthProbe {
    /** Feed raw input; returns it with any probe replies consumed. */
    consume(data: string): string;
    /** True while replies are still expected (input must be routed here). */
    get pending(): boolean;
    cancel(): void;
}

/**
 * Start a probe. `onCalibrated` fires only when the terminal disagrees with the
 * current model — the caller must then discard every cached layout and repaint.
 */
export function probeTerminalWidths(
    write: (data: string) => void,
    onCalibrated: () => void,
): WidthProbe {
    let remaining = 3;
    const cols: number[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        // No answer: stop intercepting CPR-shaped input (it collides with
        // modified-F3 key reports) and keep the defaults.
        remaining = 0;
        timer = undefined;
    }, REPLY_TIMEOUT_MS);

    const cancel = () => {
        remaining = 0;
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    write(CANARIES);

    return {
        get pending() {
            return remaining > 0;
        },
        cancel,
        consume(data: string): string {
            let rest = data;
            while (remaining > 0) {
                const match = CPR.exec(rest);
                if (!match) break;
                cols.push(parseInt(match[2] ?? "0", 10));
                remaining -= 1;
                rest = rest.slice(match[0].length);
            }
            if (remaining === 0 && cols.length === 3) {
                cancel();
                // Columns are 1-based and each canary starts at column 1, so
                // rendered width = reported column - 1.
                const [matraCol = 0, conjunctCol = 0, clampCol = 0] = cols;
                cols.length = 0;
                const changed = setWidthCalibration({
                    spacingMarkWidth: matraCol >= 3 ? 1 : 0,
                    shapedClusters: conjunctCol <= 2,
                    clampClusters: clampCol <= 3,
                });
                if (changed) onCalibrated();
            }
            return rest;
        },
    };
}
