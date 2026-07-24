#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runBrowser, runViewer } from "./app.ts";
import { renderDocument } from "./render.ts";
import { prewarmHighlighter } from "./highlight.ts";
import { docKind } from "./file-list.ts";
import { getVersion, runUpgrade } from "./commands.ts";
import { resolveUiModeFromEnv, setActiveUiMode } from "./ui-mode.ts";
import { loadTuiPrefs } from "./tui-state.ts";
import { installWidthModel } from "./width.ts";
import { runServe } from "./serve.ts";

// Measure complex scripts (Devanagari, Thai, Hangul jamo) the way terminals
// actually lay them out, before anything renders. The interactive UI refines
// this with a live probe; print mode keeps these defaults.
installWidthModel();

const HELP = `markdown — render markdown (and tex) in your terminal

Usage:
  markdown                 Browse markdown/tex files in the current folder
  markdown <dir>           Browse under <dir>
  markdown <file.md>       Open a markdown file in the interactive viewer
  markdown <file.tex>      Open a LaTeX file as a readable preview (no TeX engine)
  markdown <file> -p       Print the rendered file and exit (no UI)
  markdown serve [path]    Start a local web preview (opens browser)

Commands:
  serve [path]             Web preview with light/dark themes (default: .)
  update, upgrade          Update to the latest version
  version                  Print the version
  help                     Show this help

Options:
  -p, --print        Print to stdout instead of the interactive viewer
  --ui <md|noir>     UI mode (default: md). Alias: MD_UI_MODE env
  --port <n>         Port for serve (default: 9876)
  --host <addr>      Host for serve (default: 127.0.0.1)
  --no-open          Do not open a browser on serve
  -v, --version      Print the version
  -h, --help         Show this help

Interactive keys:
  ↑/↓ or j/k         scroll          space/b   page down/up
  g/G                top/bottom      e         edit
  u                  cycle UI mode   enter     open
  esc                back / quit

UI modes (like loop):
  md     classic cyan header, no canvas wash (default)
  noir   dark cockpit: OSC 11 wash, ◆ header, ┃ gutters

Web serve:
  markdown serve                 preview cwd in the browser
  markdown serve ./docs          preview a folder
  markdown serve README.md       open one file
  markdown serve --port 8080     pick a port
  light/dark toggle in the header (remembers preference)`;

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.includes("-h") || args.includes("--help")) {
        process.stdout.write(`${HELP}\n`);
        return;
    }
    if (args.includes("-v") || args.includes("--version")) {
        process.stdout.write(`${getVersion()}\n`);
        return;
    }

    // Subcommands (mirrors pi: update/upgrade/version/help).
    switch (args[0]) {
        case "serve": {
            const serveArgs = args.slice(1);
            let port: number | undefined;
            let host: string | undefined;
            let open = true;
            const rest: string[] = [];
            for (let i = 0; i < serveArgs.length; i++) {
                const a = serveArgs[i];
                if (a === "--port" && serveArgs[i + 1]) {
                    port = Number(serveArgs[++i]);
                } else if (a.startsWith("--port=")) {
                    port = Number(a.slice("--port=".length));
                } else if (a === "--host" && serveArgs[i + 1]) {
                    host = serveArgs[++i];
                } else if (a.startsWith("--host=")) {
                    host = a.slice("--host=".length);
                } else if (a === "--no-open") {
                    open = false;
                } else if (a === "-h" || a === "--help") {
                    process.stdout.write(`${HELP}\n`);
                    return;
                } else if (!a.startsWith("-")) {
                    rest.push(a);
                }
            }
            if (port !== undefined && (!Number.isFinite(port) || port <= 0)) {
                process.stderr.write("md: invalid --port\n");
                process.exit(1);
            }
            await runServe({
                root: rest[0] ? resolve(rest[0]) : process.cwd(),
                port,
                host,
                open,
            });
            return;
        }
        case "update":
        case "upgrade":
            runUpgrade({ force: args.includes("--force") });
            return;
        case "version":
            process.stdout.write(`${getVersion()}\n`);
            return;
        case "help":
            process.stdout.write(`${HELP}\n`);
            return;
    }

    const printMode = args.includes("-p") || args.includes("--print");
    // --ui <mode> or --ui=<mode>
    let uiFlag: string | null = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--ui" && args[i + 1]) {
            uiFlag = args[i + 1];
            i++;
        } else if (args[i]?.startsWith("--ui=")) {
            uiFlag = args[i].slice("--ui=".length);
        }
    }
    setActiveUiMode(resolveUiModeFromEnv(uiFlag, loadTuiPrefs().uiMode));

    const flagTakesValue = new Set(["--ui", "--port", "--host"]);
    const positional = args.filter(
        (arg, i) =>
            !arg.startsWith("-") &&
            !flagTakesValue.has(args[i - 1] ?? ""),
    );
    const target = positional[0] ? resolve(positional[0]) : process.cwd();

    // Piped output (e.g. `md file.md | less`) always prints.
    const forcePrint = printMode || !process.stdout.isTTY;

    if (!existsSync(target)) {
        process.stderr.write(`md: no such file or directory: ${target}\n`);
        process.exit(1);
    }

    const stats = statSync(target);

    if (stats.isDirectory()) {
        if (forcePrint) {
            process.stderr.write("md: refusing to print a directory; pass a file or run interactively\n");
            process.exit(1);
        }
        runBrowser(target);
        return;
    }

    if (forcePrint) {
        const source = readFileSync(target, "utf8");
        const width = process.stdout.columns || 80;
        const kind = docKind(target);
        // .tex → pure JS markdown conversion (no TeX engine). Markdown still
        // prewarms Shiki for fenced code blocks inside the document.
        if (kind !== "tex") {
            // Mermaid image rendering shells out to the mermaid CLI (heavy: pulls a
            // headless browser), so it's opt-in via MD_MERMAID_IMAGES=1.
            // Load grammars for the languages this document uses before rendering,
            // since highlightCode() runs synchronously inside the renderer.
            await prewarmHighlighter(source);
        }
        const images = process.env.MD_MERMAID_IMAGES === "1";
        const lines = renderDocument(source, width, kind, { images });
        process.stdout.write(`${lines.join("\n")}\n`);
        return;
    }

    runViewer(target);
}

main().catch((err) => {
    process.stderr.write(`md: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
