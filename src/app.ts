import { readFileSync, writeFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { TUI, ProcessTerminal, matchesKey } from "@earendil-works/pi-tui";
import { Browser } from "./browser.ts";
import { ScrollView } from "./scroll-view.ts";
import { renderMarkdown } from "./render.ts";
import { findMarkdownFiles } from "./file-list.ts";
import { VimEditor, type VimOptions } from "./editor/vim-editor.ts";

// SGR mouse reporting (button + wheel). pi-tui's stdin buffer forwards these
// sequences to the focused component; we just turn reporting on.
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";

/**
 * Drives the interactive UI. Screens (browser, viewer, editor) are swapped as
 * the single focused child of the TUI; the controller owns enough state to
 * rebuild any screen on demand.
 */
class App {
    private root: string;
    private tui: TUI | null = null;
    private quitting = false;
    // One browser instance, kept alive across viewer trips so it remembers the
    // folder you were in.
    private browser: Browser | null = null;
    // Editor view options (number/relativenumber). Session-only — markdown has
    // no settings store of its own; toggles via :set persist until exit.
    private editorOptions: VimOptions = { number: true, relativenumber: true };

    constructor(root: string) {
        this.root = root;
        // Some terminals deliver Ctrl+C as a SIGINT signal rather than as \x03
        // input data; catch that path too so quitting always works.
        process.on("SIGINT", () => this.quit());
    }

    private mountTui(): TUI {
        const tui = new TUI(new ProcessTerminal());
        this.tui = tui;
        // Quit on Ctrl+C from any screen. Under the Kitty keyboard protocol it
        // arrives as a CSI-u sequence (matchesKey), and as the raw \x03 byte
        // otherwise — handle both.
        tui.addInputListener((data) => {
            if (matchesKey(data, "ctrl+c") || data === "\x03") {
                this.quit();
                return { consume: true };
            }
            return undefined;
        });
        process.stdout.write(ENABLE_MOUSE);
        tui.start();
        return tui;
    }

    private teardownTui(): void {
        process.stdout.write(DISABLE_MOUSE);
        this.tui?.stop();
        this.tui = null;
    }

    private quit(): void {
        if (this.quitting) {
            return;
        }
        this.quitting = true;
        this.teardownTui();
        process.exit(0);
    }

    showBrowser(): void {
        const tui = this.tui ?? this.mountTui();
        if (!this.browser) {
            this.browser = new Browser(this.root);
            this.browser.onOpenFile = (absPath) => this.showViewer(absPath);
        }
        tui.clear();
        tui.addChild(this.browser);
        tui.setFocus(this.browser);
        tui.requestRender();
    }

    private showViewer(absPath: string): void {
        const tui = this.tui ?? this.mountTui();
        const title = relative(this.root, absPath) || basename(absPath);
        const viewer = new ScrollView(title, (width) => renderMarkdown(readFileSync(absPath, "utf8"), width));
        viewer.onBack = () => this.showBrowser();
        viewer.onEdit = () => this.edit(absPath, () => this.showViewer(absPath));
        tui.clear();
        tui.addChild(viewer);
        tui.setFocus(viewer);
        tui.requestRender();
    }

    /** Single-file mode: there is no browser to fall back to, so back quits. */
    showSingle(path: string): void {
        const tui = this.mountTui();
        const viewer = new ScrollView(basename(path), (width) => renderMarkdown(readFileSync(path, "utf8"), width));
        viewer.onBack = () => this.quit();
        // Rebuilding the whole single-file view re-mounts the TUI and re-reads
        // the (possibly edited) file from disk.
        viewer.onEdit = () => this.edit(path, () => this.showSingle(path));
        tui.addChild(viewer);
        tui.setFocus(viewer);
        tui.requestRender();
    }

    /** Open the file in the in-app modal (vim) editor; `rebuild` re-shows after. */
    private edit(path: string, rebuild: () => void): void {
        const tui = this.tui ?? this.mountTui();
        const title = relative(this.root, path) || basename(path);
        const editor = new VimEditor({
            title,
            text: readFileSync(path, "utf8"),
            filetype: "markdown",
            options: this.editorOptions,
            onOptionsChange: (opts) => {
                this.editorOptions = opts;
            },
            requestRender: () => this.tui?.requestRender(),
            onSave: (text) => {
                writeFileSync(path, text);
                return `written ${basename(path)}`;
            },
            onQuit: () => rebuild(),
        });
        tui.clear();
        tui.addChild(editor);
        tui.setFocus(editor);
        tui.requestRender();
    }
}

export function runBrowser(root: string): void {
    if (findMarkdownFiles(root).length === 0) {
        process.stderr.write(`No markdown files found under ${root}\n`);
        process.exit(1);
    }
    new App(root).showBrowser();
}

export function runViewer(filePath: string): void {
    new App(filePath).showSingle(filePath);
}
