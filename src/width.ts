/**
 * How wide is a grapheme cluster, really?
 *
 * pi-tui measures a cluster as its base codepoint, which is right for Latin
 * and CJK and wrong for scripts that stack: "भाषा" is भ + ा + ष + ा, and a
 * terminal draws four cells while upstream counts two. Every layout that
 * depends on the answer — table borders, wrapped prose, our code frames, the
 * viewer's column slicing — then drifts, which is the "Devanagari breaks the
 * UI" bug.
 *
 * There is no single right answer: cluster layout is genuinely unstandardized
 * across terminals, so this module holds the model and `probeTerminalWidths()`
 * (see width-probe.ts) calibrates it against the terminal actually in use.
 * Defaults are the wcwidth-style per-codepoint sum, which is what most
 * terminals do. Installed into pi-tui via the package patch, so every layer
 * measures the same way.
 *
 * Ported from loop's TUI fork (packages/tui/src/utils.ts), which fixed this
 * first; kept in sync deliberately rather than duplicated by accident.
 */

import { eastAsianWidth } from "get-east-asian-width";
import { setGraphemeWidthOverride } from "@earendil-works/pi-tui/dist/utils.js";

// Nonspacing (Mn) and enclosing (Me) marks take no cell; spacing marks (Mc,
// e.g. the matras ा ी ो) do, which is exactly what upstream misses.
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mn}|\p{Me}|\p{Surrogate})+$/v;
const zeroCellRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Cf}\p{Mn}\p{Me}\p{Surrogate}]$/v;
const spacingMarkRegex = /^\p{Mc}$/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;

export interface WidthCalibration {
    /** Cells a spacing combining mark (Mc, e.g. Devanagari matra ी) occupies. */
    spacingMarkWidth: 0 | 1;
    /** True when the terminal shapes a whole cluster into one cell (प्रे = 1). */
    shapedClusters: boolean;
    /**
     * True when the terminal attaches a cluster to a single cell pair, capping
     * it at 2 cells however many spacing codepoints it holds (स्त्र = 2, not 3)
     * — Ghostty's unicode width mode does this.
     */
    clampClusters: boolean;
}

let spacingMarkCellWidth: 0 | 1 = 1;
let shapedClusterTerminal = false;
let clampClusterCells = false;

/**
 * Adopt what the startup probe measured. Returns true when the model changed,
 * in which case callers must throw away anything already laid out.
 */
export function setWidthCalibration(calibration: WidthCalibration): boolean {
    if (
        calibration.spacingMarkWidth === spacingMarkCellWidth &&
        calibration.shapedClusters === shapedClusterTerminal &&
        calibration.clampClusters === clampClusterCells
    ) {
        return false;
    }
    spacingMarkCellWidth = calibration.spacingMarkWidth;
    shapedClusterTerminal = calibration.shapedClusters;
    clampClusterCells = calibration.clampClusters;
    // Re-installing clears pi-tui's memoised widths, which were measured with
    // the old model.
    installWidthModel();
    return true;
}

/** Cells one grapheme cluster occupies under the current calibration. */
export function graphemeWidth(segment: string): number {
    if (segment === "\t") return 3;
    if (zeroWidthRegex.test(segment)) return 0;
    if (rgiEmojiRegex.test(segment)) return 2;

    const first = segment.codePointAt(0);
    if (first === undefined) return 0;
    // Regional indicators render as full-width flags in most terminals.
    if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2;

    // Shaping terminals fit the whole cluster in the base codepoint's cells.
    if (shapedClusterTerminal) return eastAsianWidth(first);

    let width = 0;
    for (const char of segment) {
        const cp = char.codePointAt(0);
        if (cp === undefined || zeroCellRegex.test(char)) continue;
        // Hangul V/T jamo compose into the preceding leading jamo's cell.
        if ((cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff)) continue;
        width += spacingMarkRegex.test(char) ? spacingMarkCellWidth : eastAsianWidth(cp);
    }

    if (clampClusterCells && width > 2) return 2;
    return width;
}

/** Point pi-tui's measurement at this model (idempotent). */
export function installWidthModel(): void {
    setGraphemeWidthOverride(graphemeWidth);
}
