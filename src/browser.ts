import chalk from "chalk";
import { type Component, SelectList, fuzzyFilter, visibleWidth } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "./theme.ts";

/**
 * A file browser: a SelectList plus type-to-filter (fuzzy). SelectList alone
 * handles navigation/enter/escape, so we layer the filter on top and rebuild
 * its items as the query changes.
 */
export class Browser implements Component {
    private files: string[];
    private filter = "";
    private list: SelectList;
    private root: string;

    public onOpen?: (relativePath: string) => void;
    public onQuit?: () => void;

    constructor(root: string, files: string[]) {
        this.root = root;
        this.files = files;
        this.list = this.buildList(files);
    }

    // 0.79.4's SelectList has no setItems(), so we rebuild it when the query
    // changes, rewiring the callbacks each time.
    private buildList(files: string[]): SelectList {
        const list = new SelectList(this.toItems(files), this.maxVisible(), getSelectListTheme());
        list.onSelect = (item) => this.onOpen?.(item.value);
        list.onCancel = () => this.onQuit?.();
        return list;
    }

    private maxVisible(): number {
        const rows = process.stdout.rows || 24;
        return Math.max(3, rows - 4);
    }

    private toItems(files: string[]) {
        return files.map((file) => ({ value: file, label: file }));
    }

    private applyFilter(): void {
        const matches = this.filter ? fuzzyFilter(this.files, this.filter, (f) => f) : this.files;
        this.list = this.buildList(matches);
    }

    invalidate(): void {
        this.list.invalidate();
    }

    handleInput(data: string): void {
        // Navigation, selection, and cancel belong to the list.
        if (
            data === "\x1b[A" ||
            data === "\x1b[B" ||
            data === "\r" ||
            data === "\x1b" ||
            data.startsWith("\x1b[<")
        ) {
            this.list.handleInput?.(data);
            return;
        }
        if (data === "\x7f" || data === "\b") {
            this.filter = this.filter.slice(0, -1);
            this.applyFilter();
            return;
        }
        // Printable single characters extend the filter query.
        if (data.length === 1 && data >= " " && data !== "\x7f") {
            this.filter += data;
            this.applyFilter();
            return;
        }
    }

    render(width: number): string[] {
        const heading = chalk.cyan.bold(`  markdown · ${this.files.length} file${this.files.length === 1 ? "" : "s"}`);
        const queryLabel = chalk.gray("  filter: ");
        const query = this.filter ? chalk.cyan(this.filter) : chalk.gray("(type to search)");
        const lines = [padLine(heading, width), padLine(`${queryLabel}${query}`, width), ""];
        lines.push(...this.list.render(width));
        lines.push("");
        lines.push(padLine(chalk.gray("  ↑/↓ move · enter open · esc quit"), width));
        return lines;
    }
}

function padLine(text: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(text));
    return text + " ".repeat(pad);
}
