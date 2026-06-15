#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runBrowser, runViewer } from "./app.ts";
import { renderMarkdown } from "./render.ts";
import { getVersion, runUpgrade } from "./commands.ts";

const HELP = `markdown — render markdown in your terminal

Usage:
  markdown                 Browse markdown files in the current folder
  markdown <dir>           Browse markdown files under <dir>
  markdown <file.md>       Open a file in the interactive viewer
  markdown <file.md> -p    Print the rendered file and exit (no UI)

Commands:
  update, upgrade          Update to the latest version
  version                  Print the version
  help                     Show this help

Options:
  -p, --print        Print to stdout instead of the interactive viewer
  -v, --version      Print the version
  -h, --help         Show this help

Interactive keys:
  ↑/↓ or j/k         scroll          space/b   page down/up
  g/G                top/bottom      e         edit in $EDITOR
  enter              open            esc       back (folders) / quit`;

function main(): void {
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
    const positional = args.filter((arg) => !arg.startsWith("-"));
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
        // Mermaid image rendering shells out to the mermaid CLI (heavy: pulls a
        // headless browser), so it's opt-in via MD_MERMAID_IMAGES=1.
        const images = process.env.MD_MERMAID_IMAGES === "1";
        const lines = renderMarkdown(source, width, { images });
        process.stdout.write(`${lines.join("\n")}\n`);
        return;
    }

    runViewer(target);
}

main();
