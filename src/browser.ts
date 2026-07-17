import { basename, dirname, relative, resolve } from "node:path";
import { type Component, SelectList, fuzzyFilter, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "./theme.ts";
import { listDirectory } from "./file-list.ts";
import { activeUiMode, cycleUiMode, uiStyle } from "./ui-mode.ts";
import { applyCanvasWash } from "./canvas-wash.ts";

interface Entry {
    value: string; // absolute path
    label: string; // display name (folders end with "/")
    isDir: boolean;
}

/**
 * Drops wheel-generated arrow bursts right after a screen transition.
 *
 * Mouse-wheel scrolling in the viewer works via the terminal's alternate
 * scroll mode, which encodes wheel ticks as plain up/down arrow sequences.
 * With macOS inertial scrolling those keep arriving for a second or more
 * after the flick — so escaping back to the list mid-scroll used to whip the
 * selection around (and wrap it top↔bottom) until the momentum died out.
 *
 * While armed, arrow events that arrive in a rapid burst are dropped; the
 * first arrow after a quiet gap is a real keystroke, which disarms the guard
 * and is handled normally.
 */
export class WheelBurstGuard {
    private armed = false;
    private last = 0;

    constructor(private quietMs = 250) {}

    arm(now = Date.now()): void {
        this.armed = true;
        this.last = now;
    }

    /** True when this arrow event is part of the armed burst and must be dropped. */
    shouldDrop(now = Date.now()): boolean {
        if (!this.armed) {
            return false;
        }
        const rapid = now - this.last < this.quietMs;
        this.last = now;
        if (!rapid) {
            this.armed = false;
        }
        return rapid;
    }
}

/**
 * A directory browser. Folders and viewable files (markdown, tex) are listed
 * for the current directory; entering a folder descends into it, and `esc`
 * walks back up to the parent. At the root it does nothing — quitting is
 * Ctrl+C only.
 */
export class Browser implements Component {
    private root: string;
    private currentDir: string;
    private filter = "";
    private list: SelectList;
    private dirSet = new Set<string>();
    private wheelGuard = new WheelBurstGuard();

    public onOpenFile?: (absPath: string) => void;
    /** Host re-render after UI mode cycle. */
    public onUiModeChange?: () => void;

    constructor(root: string) {
        this.root = resolve(root);
        this.currentDir = this.root;
        this.list = this.rebuild();
    }

    private maxVisible(): number {
        const rows = process.stdout.rows || 24;
        return Math.max(3, rows - 5);
    }

    private entries(): Entry[] {
        const { dirs, files } = listDirectory(this.currentDir);
        return [
            ...dirs.map((dir) => ({ value: dir, label: `${basename(dir)}/`, isDir: true })),
            ...files.map((file) => ({ value: file, label: basename(file), isDir: false })),
        ];
    }

    private rebuild(): SelectList {
        let entries = this.entries();
        this.dirSet = new Set(entries.filter((entry) => entry.isDir).map((entry) => entry.value));
        if (this.filter) {
            entries = fuzzyFilter(entries, this.filter, (entry) => entry.label);
        }
        // Theme follows the active UI mode (rebuilt after `u`).
        const list = new SelectList(
            entries.map((entry) => ({ value: entry.value, label: entry.label })),
            this.maxVisible(),
            getSelectListTheme(),
        );
        list.onSelect = (item) => this.select(item.value);
        list.onCancel = () => this.goUp();
        this.list = list;
        return list;
    }

    /** Called by the host whenever the browser becomes the visible screen. */
    noteShown(): void {
        this.wheelGuard.arm();
    }

    private select(value: string): void {
        if (this.dirSet.has(value)) {
            this.currentDir = value;
            this.filter = "";
            this.rebuild();
            this.wheelGuard.arm();
        } else {
            this.onOpenFile?.(value);
        }
    }

    private goUp(): void {
        // At the root there is nowhere to go; esc never quits.
        if (resolve(this.currentDir) === this.root) {
            return;
        }
        this.currentDir = dirname(this.currentDir);
        this.filter = "";
        this.rebuild();
        this.wheelGuard.arm();
    }

    invalidate(): void {
        this.list.invalidate();
    }

    handleInput(data: string): void {
        if (matchesKey(data, "escape")) {
            this.goUp();
            return;
        }
        if (matchesKey(data, "u")) {
            cycleUiMode();
            applyCanvasWash();
            this.rebuild();
            this.onUiModeChange?.();
            return;
        }
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
            // Leftover wheel momentum from the screen we just left arrives as
            // arrow bursts; drop those instead of spinning the selection.
            if (this.wheelGuard.shouldDrop()) {
                return;
            }
            this.list.handleInput?.(data);
            return;
        }
        if (matchesKey(data, "enter")) {
            this.list.handleInput?.(data);
            return;
        }
        if (matchesKey(data, "backspace")) {
            this.filter = this.filter.slice(0, -1);
            this.rebuild();
            return;
        }
        if (data.length === 1 && data >= " " && data !== "\x7f") {
            this.filter += data;
            this.rebuild();
            return;
        }
    }

    render(width: number): string[] {
        const c = uiStyle().colors;
        const here = relative(this.root, this.currentDir);
        const crumb = here ? `${basename(this.root)}/${here}` : basename(this.root);
        const modeTag = uiStyle().chrome.modeBadge
            ? c.muted(`  [${activeUiMode().id}]`)
            : "";
        const heading = c.browserHeading(`  ${crumb}`) + modeTag;

        const queryLabel = c.muted("  filter: ");
        const query = this.filter ? c.accent(this.filter) : c.muted("(type to search)");

        const atRoot = resolve(this.currentDir) === this.root;
        const back = atRoot ? "" : " · esc up";
        const hint = c.muted(`  ↑/↓ move · enter open · u ui${back} · ctrl+c quit`);

        const lines = [padLine(heading, width), padLine(`${queryLabel}${query}`, width), ""];
        lines.push(...this.list.render(width));
        lines.push("");
        lines.push(padLine(hint, width));
        return lines;
    }
}

function padLine(text: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(text));
    return text + " ".repeat(pad);
}
