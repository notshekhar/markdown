import chalk from "chalk";
import { type Component, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { sliceByColumn } from "@earendil-works/pi-tui/dist/utils.js";

type LineProvider = (width: number) => string[];

/** One search hit: which rendered line, the visible column it starts at, and its length. */
interface Match {
    line: number;
    col: number;
    len: number;
}

const HSTEP = 8;
/** SGR codes used to mark search hits (current vs the rest). */
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * A scrollable viewport for pre-rendered lines. Owns the full terminal height,
 * draws a filename header bar and a footer, and scrolls with keyboard + wheel.
 *
 * Rendered markdown contains lines wider than the viewport (long code, tables,
 * links). Those are *not* wrapped here, so the body is sliced to the exact
 * viewport width — panning horizontally with ←/→ — which keeps every visual row
 * one terminal row tall. Without that clamp a wide line wraps and shoves the
 * rows below it down, which is what made scrolling "break" on large documents.
 *
 * Shift+F (or `/`) opens an in-document search: type to filter, enter/n/N to
 * walk the hits, esc to clear.
 */
export class ScrollView implements Component {
    private title: string;
    private provider: LineProvider;
    private offset = 0;
    private hoffset = 0;
    private cachedWidth = -1;
    private cachedLines: string[] = [];
    /** ANSI-stripped copy of cachedLines, for searching (built lazily). */
    private plainLines: string[] = [];
    // Left/right gutter inside the preview. Some terminals add their own
    // padding, but many (and VS Code's) sit flush against the edge.
    private margin = 2;

    // ── search state ─────────────────────────────────────────────────────────
    private searching = false; // typing a query in the footer
    private query = "";
    private matches: Match[] = [];
    private matchIndex = 0;
    /** Width the current `matches` were computed for; recompute when it changes. */
    private matchWidth = -1;

    public onBack?: () => void;
    public onEdit?: () => void;

    constructor(title: string, provider: LineProvider) {
        this.title = title;
        this.provider = provider;
    }

    setContent(title: string, provider: LineProvider): void {
        this.title = title;
        this.provider = provider;
        this.offset = 0;
        this.hoffset = 0;
        this.cachedWidth = -1;
        this.cachedLines = [];
        this.plainLines = [];
        this.clearSearch();
    }

    invalidate(): void {
        this.cachedWidth = -1;
        this.cachedLines = [];
        this.plainLines = [];
        this.matchWidth = -1;
    }

    private getLines(width: number): string[] {
        if (this.cachedWidth !== width) {
            this.cachedLines = this.provider(width);
            this.plainLines = this.cachedLines.map((l) => l.replace(ANSI, ""));
            this.cachedWidth = width;
            this.matchWidth = -1; // columns shifted; matches need recomputing
        }
        return this.cachedLines;
    }

    private viewportHeight(): number {
        const rows = process.stdout.rows || 24;
        // Reserve: header bar, rule, footer, and one safety row so filling the
        // screen never nudges the terminal into scrolling.
        return Math.max(1, rows - 4);
    }

    private maxOffset(totalLines: number): number {
        return Math.max(0, totalLines - this.viewportHeight());
    }

    private maxHoffset(): number {
        return this.plainLines.reduce((max, line) => Math.max(max, line.length), 0);
    }

    private clampOffset(totalLines: number): void {
        this.offset = Math.min(Math.max(0, this.offset), this.maxOffset(totalLines));
        this.hoffset = Math.min(Math.max(0, this.hoffset), this.maxHoffset());
    }

    handleInput(data: string): void {
        const width = this.cachedWidth < 0 ? Math.max(1, (process.stdout.columns || 80) - this.margin * 2) : this.cachedWidth;
        const lines = this.getLines(width);
        const page = Math.max(1, this.viewportHeight() - 1);

        // While typing a query, the footer owns the keyboard.
        if (this.searching) {
            this.handleSearchInput(data, width);
            return;
        }

        if (matchesKey(data, "up") || matchesKey(data, "k")) {
            this.offset -= 1;
        } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
            this.offset += 1;
        } else if (matchesKey(data, "left") || matchesKey(data, "h")) {
            this.hoffset -= HSTEP;
        } else if (matchesKey(data, "right") || matchesKey(data, "l")) {
            this.hoffset += HSTEP;
        } else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
            this.offset -= page;
        } else if (matchesKey(data, "pageDown") || matchesKey(data, "space") || matchesKey(data, "f")) {
            this.offset += page;
        } else if (matchesKey(data, "g") || matchesKey(data, "home")) {
            this.offset = 0;
            this.hoffset = 0;
        } else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) {
            this.offset = this.maxOffset(lines.length);
        } else if (matchesKey(data, "shift+f") || data === "/") {
            this.openSearch(width);
            return;
        } else if (this.matches.length > 0 && (matchesKey(data, "n") || matchesKey(data, "enter"))) {
            this.step(1);
            return;
        } else if (this.matches.length > 0 && matchesKey(data, "shift+n")) {
            this.step(-1);
            return;
        } else if (matchesKey(data, "e")) {
            this.onEdit?.();
            return;
        } else if (matchesKey(data, "backspace")) {
            // Backspace edits the query in search mode and otherwise dismisses an
            // active search — but never exits the file (that surprised people).
            if (this.query || this.matches.length > 0) {
                this.clearSearch();
            }
            return;
        } else if (matchesKey(data, "escape") || matchesKey(data, "q")) {
            // esc first dismisses an active search, then leaves the viewer.
            if (this.query || this.matches.length > 0) {
                this.clearSearch();
                return;
            }
            this.onBack?.();
            return;
        } else if (data.startsWith("\x1b[<")) {
            this.handleMouse(data);
            return;
        } else {
            return;
        }
        this.clampOffset(lines.length);
    }

    // ── search ────────────────────────────────────────────────────────────────
    private openSearch(width: number): void {
        this.searching = true;
        this.recomputeMatches(width);
    }

    private clearSearch(): void {
        this.searching = false;
        this.query = "";
        this.matches = [];
        this.matchIndex = 0;
        this.matchWidth = -1;
    }

    private handleSearchInput(data: string, width: number): void {
        if (matchesKey(data, "escape")) {
            this.clearSearch();
        } else if (matchesKey(data, "enter")) {
            // Commit the query and jump to the first hit at/after the viewport.
            this.searching = false;
            if (this.matches.length > 0) {
                this.matchIndex = this.nearestMatch();
                this.scrollToMatch(width);
            }
        } else if (matchesKey(data, "backspace")) {
            this.query = this.query.slice(0, -1);
            this.recomputeMatches(width);
        } else if (data.length === 1 && data >= " " && data !== "\x7f") {
            this.query += data;
            this.recomputeMatches(width);
        }
    }

    /** Find every occurrence of the query (case-insensitive) across all lines. */
    private recomputeMatches(width: number): void {
        this.getLines(width); // ensure plainLines are current for this width
        this.matches = [];
        this.matchWidth = width;
        const needle = this.query.toLowerCase();
        if (!needle) {
            this.matchIndex = 0;
            return;
        }
        this.plainLines.forEach((line, lineIdx) => {
            const hay = line.toLowerCase();
            let from = 0;
            for (;;) {
                const at = hay.indexOf(needle, from);
                if (at === -1) break;
                this.matches.push({ line: lineIdx, col: at, len: needle.length });
                from = at + needle.length;
            }
        });
        // Keep the selection near where the user is looking.
        this.matchIndex = this.matches.length > 0 ? this.nearestMatch() : 0;
        if (this.matches.length > 0) {
            this.scrollToMatch(width);
        }
    }

    /** Index of the first hit on or after the current top of the viewport. */
    private nearestMatch(): number {
        const idx = this.matches.findIndex((m) => m.line >= this.offset);
        return idx === -1 ? 0 : idx;
    }

    private step(delta: number): void {
        if (this.matches.length === 0) return;
        this.matchIndex = (this.matchIndex + delta + this.matches.length) % this.matches.length;
        this.scrollToMatch(this.cachedWidth);
    }

    /** Scroll vertically (and horizontally) so the active hit is on screen. */
    private scrollToMatch(width: number): void {
        const m = this.matches[this.matchIndex];
        if (!m) return;
        const height = this.viewportHeight();
        if (m.line < this.offset || m.line >= this.offset + height) {
            this.offset = Math.max(0, m.line - Math.floor(height / 2));
        }
        const contentWidth = Math.max(1, width - this.margin * 2);
        if (m.col < this.hoffset || m.col + m.len > this.hoffset + contentWidth) {
            this.hoffset = Math.max(0, m.col - Math.floor(contentWidth / 2));
        }
        this.clampOffset(this.cachedLines.length);
    }

    private handleMouse(data: string): void {
        // SGR mouse: ESC [ < button ; col ; row (M|m)
        const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
        if (!match) {
            return;
        }
        const button = Number(match[1]);
        if (button === 64) {
            this.offset -= 3; // wheel up
        } else if (button === 65) {
            this.offset += 3; // wheel down
        } else {
            return;
        }
        this.clampOffset(this.getLines(this.cachedWidth).length);
    }

    render(width: number): string[] {
        // Content is rendered into the gutter-reduced width, then indented.
        const contentWidth = Math.max(1, width - this.margin * 2);
        const gutter = " ".repeat(this.margin);
        const lines = this.getLines(contentWidth);
        if (this.query && this.matchWidth !== contentWidth) {
            this.recomputeMatches(contentWidth);
        }
        const height = this.viewportHeight();
        this.clampOffset(lines.length);

        // Group matches by line so each visible row is highlighted in one pass.
        const byLine = new Map<number, Match[]>();
        for (const m of this.matches) {
            (byLine.get(m.line) ?? byLine.set(m.line, []).get(m.line)!).push(m);
        }
        const current = this.matches[this.matchIndex];

        const body: string[] = [];
        for (let i = 0; i < height; i++) {
            const lineIdx = this.offset + i;
            const raw = lines[lineIdx] ?? "";
            const styled = byLine.has(lineIdx)
                ? highlightLine(raw, this.plainLines[lineIdx] ?? "", byLine.get(lineIdx)!, current)
                : raw;
            body.push(`${gutter}${sliceByColumn(styled, this.hoffset, contentWidth)}`);
        }

        const total = Math.max(1, lines.length);
        const shown = Math.min(this.offset + height, total);
        const percent = Math.round((shown / total) * 100);

        const header = padLine(chalk.bgCyan.black.bold(` ${this.title} `), width);
        const rule = chalk.dim.gray("─".repeat(width));
        const footer = padLine(`${gutter}${this.footer(percent)}`, width);

        return [header, rule, ...body, footer];
    }

    private footer(percent: number): string {
        if (this.searching) {
            const count = this.query ? chalk.cyan(`  ${this.matchCount()}`) : "";
            return `${chalk.cyan("/")} ${this.query}${chalk.cyan("▏")}${count}  ${chalk.gray("enter next · esc cancel")}`;
        }
        if (this.matches.length > 0 || this.query) {
            const hint = chalk.gray("n/N next/prev · esc clear");
            return `${chalk.cyan("/")} ${this.query}  ${chalk.cyan(this.matchCount())}  ${hint}  ${chalk.cyan(`${percent}%`)}`;
        }
        const hint = chalk.gray("↑/↓ scroll · ←/→ pan · g/G top/bottom · / find · e edit · esc back");
        return `${hint}  ${chalk.cyan(`${percent}%`)}`;
    }

    private matchCount(): string {
        if (this.matches.length === 0) return this.query ? "no matches" : "";
        return `[${this.matchIndex + 1}/${this.matches.length}]`;
    }
}

/**
 * Re-emit a styled line with its search hits highlighted. Walks the line in
 * visible-column order: untouched spans keep their original styling (sliced
 * ANSI-aware), hit spans are drawn as plain text on a coloured background, with
 * the active hit a brighter colour than the rest.
 */
function highlightLine(styled: string, plain: string, ranges: Match[], current: Match | undefined): string {
    const sorted = [...ranges].sort((a, b) => a.col - b.col);
    let out = "";
    let cursor = 0;
    for (const r of sorted) {
        if (r.col < cursor) continue; // skip overlaps (shouldn't happen for plain substrings)
        if (r.col > cursor) {
            out += sliceByColumn(styled, cursor, r.col - cursor);
        }
        const text = plain.slice(r.col, r.col + r.len);
        const isCurrent = current && current.line === r.line && current.col === r.col;
        out += isCurrent ? chalk.black.bgYellow(text) : chalk.black.bgCyan(text);
        cursor = r.col + r.len;
    }
    out += sliceByColumn(styled, cursor, Number.MAX_SAFE_INTEGER);
    return out;
}

function padLine(text: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(text));
    return text + " ".repeat(pad);
}
