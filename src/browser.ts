import { basename, dirname, relative, resolve } from "node:path";
import chalk from "chalk";
import { type Component, SelectList, fuzzyFilter, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "./theme.ts";
import { listDirectory } from "./file-list.ts";

interface Entry {
    value: string; // absolute path
    label: string; // display name (folders end with "/")
    isDir: boolean;
}

/**
 * A directory browser. Folders and markdown files are listed for the current
 * directory; entering a folder descends into it, and `esc` walks back up to the
 * parent. At the root it does nothing — quitting is Ctrl+C only.
 */
export class Browser implements Component {
    private root: string;
    private currentDir: string;
    private filter = "";
    private list: SelectList;
    private dirSet = new Set<string>();

    public onOpenFile?: (absPath: string) => void;

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

    private select(value: string): void {
        if (this.dirSet.has(value)) {
            this.currentDir = value;
            this.filter = "";
            this.rebuild();
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
    }

    invalidate(): void {
        this.list.invalidate();
    }

    handleInput(data: string): void {
        if (matchesKey(data, "escape")) {
            this.goUp();
            return;
        }
        if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter")) {
            this.list.handleInput?.(data);
            return;
        }
        if (data.startsWith("\x1b[<")) {
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
        const here = relative(this.root, this.currentDir);
        const crumb = here ? `${basename(this.root)}/${here}` : basename(this.root);
        const heading = chalk.cyan.bold(`  ${crumb}`);

        const queryLabel = chalk.gray("  filter: ");
        const query = this.filter ? chalk.cyan(this.filter) : chalk.gray("(type to search)");

        const atRoot = resolve(this.currentDir) === this.root;
        const back = atRoot ? "" : " · esc up";
        const hint = chalk.gray(`  ↑/↓ move · enter open${back} · ctrl+c quit`);

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
