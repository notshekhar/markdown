import chalk from "chalk";
import { type Component, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { sliceByColumn } from "@earendil-works/pi-tui/dist/utils.js";
import { activeUiMode, cycleUiMode, uiStyle } from "./ui-mode.ts";
import { applyCanvasWash } from "./canvas-wash.ts";

type LineProvider = (width: number) => string[];

/** One search hit: which rendered line, the visible column it starts at, and its length. */
interface Match {
    line: number;
    col: number;
    len: number;
}

/** normal = case-insensitive substring, exact = case-sensitive, regex = JS regexp. */
type SearchMode = "normal" | "exact" | "regex";
const SEARCH_MODES: SearchMode[] = ["normal", "exact", "regex"];

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
    // ── search state ─────────────────────────────────────────────────────────
    private searching = false; // typing a query in the footer
    private query = "";
    /** Caret position within `query` (0..query.length) while editing it. */
    private queryCursor = 0;
    private matches: Match[] = [];
    private matchIndex = 0;
    /** Width the current `matches` were computed for; recompute when it changes. */
    private matchWidth = -1;
    /** How the query is interpreted; cycled with Tab. Persists across searches. */
    private searchMode: SearchMode = "normal";
    /** True when a regex query failed to compile (shown in the footer). */
    private badPattern = false;
    // ── replace state ─────────────────────────────────────────────────────────
    private replacing = false; // editing the replacement field in the footer
    private replacement = "";
    private replacementCursor = 0;
    /** Transient one-line status (e.g. "replaced 4"), cleared on the next key. */
    private message = "";

    public onBack?: () => void;
    public onEdit?: () => void;
    /**
     * Line to reopen at, from the state db. Applied on the first render, once
     * the document has been laid out and the line count is known — clamped, so
     * a file that shrank since last time still opens somewhere sensible.
     */
    public restoreLine = 0;
    /** Top visible line, reported whenever it changes, for persistence. */
    public onScrollChange?: (line: number) => void;
    private pendingRestore = true;
    private reportedOffset = -1;
    /** Called after a UI mode cycle so the host can re-paint children. */
    public onUiModeChange?: () => void;
    /** Source text + writer for find-and-replace; absent → replace is disabled. */
    public getSource?: () => string;
    public onReplaceSource?: (text: string) => void;

    constructor(title: string, provider: LineProvider) {
        this.title = title;
        this.provider = provider;
    }

    setContent(title: string, provider: LineProvider): void {
        this.title = title;
        this.provider = provider;
        this.offset = 0;
        this.hoffset = 0;
        this.pendingRestore = true;
        this.reportedOffset = -1;
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

    /** Body content width for a full terminal row width (mode-aware gutters). */
    private contentWidthFor(termWidth: number): number {
        const style = uiStyle();
        const leftPad = style.body.margin;
        const gutterCols = style.body.gutter ? visibleWidth(style.body.gutter) + 1 : 0;
        return Math.max(1, termWidth - leftPad - gutterCols - leftPad);
    }

    handleInput(data: string): void {
        const termW = process.stdout.columns || 80;
        const width =
            this.cachedWidth < 0 ? this.contentWidthFor(termW) : this.cachedWidth;
        const lines = this.getLines(width);
        const page = Math.max(1, this.viewportHeight() - 1);
        this.message = ""; // any keypress dismisses the transient status line

        // While editing the find/replace fields, the footer owns the keyboard.
        if (this.searching) {
            this.handleSearchInput(data, width);
            return;
        }
        if (this.replacing) {
            this.handleReplaceInput(data, width);
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
        } else if (matchesKey(data, "shift+r") && this.onReplaceSource && this.query) {
            this.openReplace(width);
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
        } else if (matchesKey(data, "u")) {
            // Cycle UI mode (md ↔ noir), same idea as loop's /ui.
            cycleUiMode();
            applyCanvasWash();
            this.invalidate(); // re-render body with the new markdown theme
            this.message = `ui: ${activeUiMode().name}`;
            this.onUiModeChange?.();
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
        } else {
            return;
        }
        this.clampOffset(lines.length);
    }

    // ── search ────────────────────────────────────────────────────────────────
    private openSearch(width: number): void {
        this.searching = true;
        this.replacing = false;
        this.queryCursor = this.query.length;
        this.recomputeMatches(width);
    }

    private clearSearch(): void {
        this.searching = false;
        this.replacing = false;
        this.query = "";
        this.queryCursor = 0;
        this.matches = [];
        this.matchIndex = 0;
        this.matchWidth = -1;
        this.badPattern = false;
    }

    private handleSearchInput(data: string, width: number): void {
        if (matchesKey(data, "escape")) {
            this.clearSearch();
        } else if (matchesKey(data, "tab") || data === "\t") {
            // Cycle normal → exact → regex without disturbing the query.
            this.searchMode = SEARCH_MODES[(SEARCH_MODES.indexOf(this.searchMode) + 1) % SEARCH_MODES.length];
            this.recomputeMatches(width);
        } else if (matchesKey(data, "enter")) {
            // Commit the query and jump to the first hit at/after the viewport.
            this.searching = false;
            if (this.matches.length > 0) {
                this.matchIndex = this.nearestMatch();
                this.scrollToMatch(width);
            }
        } else {
            const edited = editLine(this.query, this.queryCursor, data);
            if (edited) {
                this.query = edited.text;
                this.queryCursor = edited.cursor;
                if (edited.changed) this.recomputeMatches(width);
            }
        }
    }

    // ── replace ───────────────────────────────────────────────────────────────
    /** Enter the replacement field; the find pattern is the current query. */
    private openReplace(width: number): void {
        this.searching = false;
        this.replacing = true;
        this.replacementCursor = this.replacement.length;
        this.recomputeMatches(width); // refresh the match count shown alongside
    }

    private handleReplaceInput(data: string, width: number): void {
        if (matchesKey(data, "escape")) {
            this.replacing = false; // keep the find + matches; just leave replace
        } else if (matchesKey(data, "tab") || data === "\t") {
            this.searching = true; // hop back to edit the find field
            this.replacing = false;
            this.queryCursor = this.query.length;
        } else if (matchesKey(data, "enter")) {
            this.applyReplace();
        } else {
            const edited = editLine(this.replacement, this.replacementCursor, data);
            if (edited) {
                this.replacement = edited.text;
                this.replacementCursor = edited.cursor;
            }
        }
    }

    /**
     * Replace every match in the *source* document and write it back. Regex mode
     * honours `$1`/`$2` backreferences (JS semantics, same as VS Code); literal
     * modes insert the replacement verbatim. The provider re-reads the file on
     * the next render, so the view refreshes itself.
     */
    private applyReplace(): void {
        if (!this.getSource || !this.onReplaceSource) {
            this.message = "replace unavailable";
            return;
        }
        if (!this.query) {
            this.message = "no search pattern";
            return;
        }
        let re: RegExp;
        let replacement = this.replacement;
        try {
            if (this.searchMode === "regex") {
                re = new RegExp(this.query, "gi"); // case-insensitive, matching the find
            } else {
                const flags = this.searchMode === "exact" ? "g" : "gi";
                re = new RegExp(escapeRegExp(this.query), flags);
                replacement = replacement.replace(/\$/g, "$$$$"); // literal $ (no backrefs)
            }
        } catch {
            this.badPattern = true;
            this.message = "bad pattern";
            return;
        }
        const source = this.getSource();
        const count = (source.match(re) ?? []).length;
        if (count === 0) {
            this.message = "no matches";
            return;
        }
        try {
            this.onReplaceSource(source.replace(re, replacement));
        } catch (err) {
            this.message = `write failed: ${(err as Error).message}`;
            return;
        }
        this.invalidate(); // force a re-read + re-render of the edited file
        this.replacing = false;
        this.query = "";
        this.queryCursor = 0;
        this.replacement = "";
        this.replacementCursor = 0;
        this.matches = [];
        this.matchIndex = 0;
        this.message = `replaced ${count}`;
    }

    /** Find every occurrence of the query across all lines, per the active mode. */
    private recomputeMatches(width: number): void {
        this.getLines(width); // ensure plainLines are current for this width
        this.matches = [];
        this.matchWidth = width;
        this.badPattern = false;
        if (!this.query) {
            this.matchIndex = 0;
            return;
        }
        if (this.searchMode === "regex") {
            this.collectRegexMatches();
        } else {
            this.collectLiteralMatches(this.searchMode === "exact");
        }
        // Keep the selection near where the user is looking.
        this.matchIndex = this.matches.length > 0 ? this.nearestMatch() : 0;
        if (this.matches.length > 0) {
            this.scrollToMatch(width);
        }
    }

    /** Plain substring search; case-sensitive in exact mode, folded otherwise. */
    private collectLiteralMatches(caseSensitive: boolean): void {
        const needle = caseSensitive ? this.query : this.query.toLowerCase();
        this.plainLines.forEach((line, lineIdx) => {
            const hay = caseSensitive ? line : line.toLowerCase();
            let from = 0;
            for (;;) {
                const at = hay.indexOf(needle, from);
                if (at === -1) break;
                this.matches.push({ line: lineIdx, col: at, len: needle.length });
                from = at + needle.length;
            }
        });
    }

    /** Regex search (case-insensitive, global). Invalid patterns match nothing. */
    private collectRegexMatches(): void {
        let re: RegExp;
        try {
            re = new RegExp(this.query, "gi");
        } catch {
            this.badPattern = true;
            return;
        }
        this.plainLines.forEach((line, lineIdx) => {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(line)) !== null) {
                if (m[0].length === 0) {
                    re.lastIndex++; // zero-width match (e.g. `a*`) — step past to avoid a loop
                    continue;
                }
                this.matches.push({ line: lineIdx, col: m.index, len: m[0].length });
            }
        });
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
        // `width` is content width when called from recomputeMatches / step.
        const cw = Math.max(1, this.cachedWidth > 0 ? this.cachedWidth : width);
        if (m.col < this.hoffset || m.col + m.len > this.hoffset + cw) {
            this.hoffset = Math.max(0, m.col - Math.floor(cw / 2));
        }
        this.clampOffset(this.cachedLines.length);
    }

    render(width: number): string[] {
        const style = uiStyle();
        const c = style.colors;
        // Content width accounts for left margin + optional accent gutter.
        const gutterGlyph = style.body.gutter
            ? c.gutter(style.body.gutter) + " "
            : "";
        const leftPad = style.body.margin;
        const leftCols =
            leftPad +
            (style.body.gutter ? visibleWidth(style.body.gutter) + 1 : 0);
        const contentWidth = Math.max(1, width - leftCols - leftPad);
        const side = " ".repeat(leftPad);
        const lines = this.getLines(contentWidth);
        if (this.query && this.matchWidth !== contentWidth) {
            this.recomputeMatches(contentWidth);
        }
        const height = this.viewportHeight();
        if (this.pendingRestore) {
            this.pendingRestore = false;
            if (this.restoreLine > 0) {
                this.offset = Math.min(this.restoreLine, this.maxOffset(lines.length));
            }
        }
        this.clampOffset(lines.length);
        // Reported from render (not the key handler) so search jumps, resizes
        // and clamping all report the line the reader actually ends up on.
        if (this.offset !== this.reportedOffset) {
            this.reportedOffset = this.offset;
            this.onScrollChange?.(this.offset);
        }

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
            body.push(
                `${side}${gutterGlyph}${sliceByColumn(styled, this.hoffset, contentWidth)}`,
            );
        }

        const total = Math.max(1, lines.length);
        const shown = Math.min(this.offset + height, total);
        const percent = Math.round((shown / total) * 100);

        const prefix = style.header.prefix;
        const titleText = ` ${prefix}${this.title} `;
        const header =
            style.header.style === "bar"
                ? padLine(c.headerBg(titleText), width)
                : padLine(c.headerBg(titleText), width);
        const rule = style.chrome.rule ? c.rule("─".repeat(width)) : "";
        const footer = padLine(`${side}${this.footer(percent)}`, width);

        return rule ? [header, rule, ...body, footer] : [header, ...body, footer];
    }

    private footer(percent: number): string {
        const c = uiStyle().colors;
        const mode = c.accent(`${this.searchMode}`);
        const find = `${c.accent("/")}${mode} `;
        if (this.replacing) {
            const findField = `${find}${this.query}`;
            const replField = `${c.accent("→")} ${caret(this.replacement, this.replacementCursor)}`;
            return `${findField}  ${replField}  ${c.accent(this.matchCount())}  ${c.muted("enter replace all · tab find · esc cancel")}`;
        }
        if (this.searching) {
            const count = this.query ? c.accent(`  ${this.matchCount()}`) : "";
            return `${find}${caret(this.query, this.queryCursor)}${count}  ${c.muted("tab mode · enter find · esc cancel")}`;
        }
        if (this.message) {
            return c.accent(this.message);
        }
        if (this.matches.length > 0 || this.query) {
            const repl = this.onReplaceSource ? " · R replace" : "";
            const hint = c.muted(`n/N next/prev${repl} · esc clear`);
            return `${find}${this.query}  ${c.accent(this.matchCount())}  ${hint}  ${c.accent(`${percent}%`)}`;
        }
        const badge = uiStyle().chrome.modeBadge
            ? c.muted(` · ui:${activeUiMode().id}`)
            : "";
        const hint = c.muted(
            `↑/↓ scroll · ←/→ pan · g/G top/bottom · / find · u ui · e edit · esc back${badge}`,
        );
        return `${hint}  ${c.accent(`${percent}%`)}`;
    }

    private matchCount(): string {
        if (this.badPattern) return "bad pattern";
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
        const c = uiStyle().colors;
        out += isCurrent ? c.searchCurrent(text) : c.searchHit(text);
        cursor = r.col + r.len;
    }
    out += sliceByColumn(styled, cursor, Number.MAX_SAFE_INTEGER);
    return out;
}

function padLine(text: string, width: number): string {
    // Truncate first — footers can grow past the terminal when we append keys.
    const clipped =
        visibleWidth(text) > width ? sliceByColumn(text, 0, width) : text;
    const pad = Math.max(0, width - visibleWidth(clipped));
    return clipped + " ".repeat(pad);
}

/** Render a one-line input field with a visible caret at `cursor`. */
function caret(text: string, cursor: number): string {
    const at = Math.max(0, Math.min(cursor, text.length));
    return text.slice(0, at) + chalk.cyan("▏") + text.slice(at);
}

/**
 * Apply one key to a single-line text field (the find/replace inputs): cursor
 * motion, insert, and delete. Returns the new `{ text, cursor }` plus whether
 * the text actually changed, or null when the key isn't an edit/motion key.
 */
function editLine(text: string, cursor: number, data: string): { text: string; cursor: number; changed: boolean } | null {
    const move = (c: number) => ({ text, cursor: Math.max(0, Math.min(text.length, c)), changed: false });
    if (matchesKey(data, "left") || matchesKey(data, "ctrl+b")) return move(cursor - 1);
    if (matchesKey(data, "right") || matchesKey(data, "ctrl+f")) return move(cursor + 1);
    if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) return move(0);
    if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) return move(text.length);
    if (matchesKey(data, "backspace")) {
        if (cursor === 0) return { text, cursor, changed: false };
        return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1, changed: true };
    }
    if (matchesKey(data, "delete")) {
        if (cursor >= text.length) return { text, cursor, changed: false };
        return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor, changed: true };
    }
    if (data.length === 1 && data >= " " && data !== "\x7f") {
        return { text: text.slice(0, cursor) + data + text.slice(cursor), cursor: cursor + 1, changed: true };
    }
    return null;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
