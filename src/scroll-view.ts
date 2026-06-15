import chalk from "chalk";
import { type Component, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

type LineProvider = (width: number) => string[];

/**
 * A scrollable viewport for pre-rendered lines. Owns the full terminal height,
 * draws a filename header bar and a footer, and scrolls with keyboard + wheel.
 */
export class ScrollView implements Component {
    private title: string;
    private provider: LineProvider;
    private offset = 0;
    private cachedWidth = -1;
    private cachedLines: string[] = [];
    // Left/right gutter inside the preview. Some terminals add their own
    // padding, but many (and VS Code's) sit flush against the edge.
    private margin = 2;

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
        this.cachedWidth = -1;
        this.cachedLines = [];
    }

    invalidate(): void {
        this.cachedWidth = -1;
        this.cachedLines = [];
    }

    private getLines(width: number): string[] {
        if (this.cachedWidth !== width) {
            this.cachedLines = this.provider(width);
            this.cachedWidth = width;
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

    private clampOffset(totalLines: number): void {
        this.offset = Math.min(Math.max(0, this.offset), this.maxOffset(totalLines));
    }

    handleInput(data: string): void {
        const width = this.cachedWidth < 0 ? Math.max(1, (process.stdout.columns || 80) - this.margin * 2) : this.cachedWidth;
        const lines = this.getLines(width);
        const page = Math.max(1, this.viewportHeight() - 1);

        if (matchesKey(data, "up") || matchesKey(data, "k")) {
            this.offset -= 1;
        } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
            this.offset += 1;
        } else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
            this.offset -= page;
        } else if (matchesKey(data, "pageDown") || matchesKey(data, "space") || matchesKey(data, "f")) {
            this.offset += page;
        } else if (matchesKey(data, "g") || matchesKey(data, "home")) {
            this.offset = 0;
        } else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) {
            this.offset = this.maxOffset(lines.length);
        } else if (matchesKey(data, "e")) {
            this.onEdit?.();
            return;
        } else if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "backspace")) {
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
        const height = this.viewportHeight();
        this.clampOffset(lines.length);

        const window = lines.slice(this.offset, this.offset + height);
        while (window.length < height) {
            window.push("");
        }
        const body = window.map((line) => `${gutter}${line}`);

        const total = Math.max(1, lines.length);
        const shown = Math.min(this.offset + height, total);
        const percent = Math.round((shown / total) * 100);

        const header = padLine(chalk.bgCyan.black.bold(` ${this.title} `), width);
        const rule = chalk.dim.gray("─".repeat(width));
        const hint = chalk.gray("↑/↓ scroll · space page · g/G top/bottom · e edit · esc back");
        const footer = padLine(`${gutter}${hint}  ${chalk.cyan(`${percent}%`)}`, width);

        return [header, rule, ...body, footer];
    }
}

function padLine(text: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(text));
    return text + " ".repeat(pad);
}
