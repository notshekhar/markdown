/**
 * `markdown serve` — local HTTP preview with a polished reading UI.
 *
 * Bun.serve + one embedded SPA. Client renders markdown (marked + shiki +
 * KaTeX + mermaid). .tex converted server-side via existing texToMarkdown.
 *
 * Theme mirrors oboe.chat (shadcn zinc palette, Geist font, indigo accent);
 * code highlighting uses shiki with dark-plus / github-light (oboe parity).
 *
 * UI: command palette (⌘K) with fuzzy file search + live content search +
 * recent files, a collapsible file tree with filter, clickable breadcrumbs,
 * an "on this page" table of contents with scroll-spy, reading-progress bar,
 * copy buttons on code, heading anchors, and serif/sans + light/dark toggles.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { docKind, findViewableFiles, isViewablePath, listDirectory } from "./file-list.ts";
import { texToMarkdown } from "./tex.ts";
import { getVersion } from "./commands.ts";

export interface ServeOptions {
    root: string;
    /** Absolute path of a single file to open on load, if any. */
    initialFile?: string;
    port?: number;
    host?: string;
    open?: boolean;
}

export async function runServe(opts: ServeOptions): Promise<void> {
    const root = resolve(opts.root);
    if (!existsSync(root)) {
        process.stderr.write(`md: no such file or directory: ${root}\n`);
        process.exit(1);
    }
    const rootStat = statSync(root);
    // Allow `markdown serve file.md` — root becomes parent dir, open that file.
    let serveRoot = root;
    let initialFile = opts.initialFile;
    if (rootStat.isFile()) {
        if (!isViewablePath(root)) {
            process.stderr.write(`md: not a markdown/tex file: ${root}\n`);
            process.exit(1);
        }
        serveRoot = dirname(root);
        initialFile = root;
    } else if (!rootStat.isDirectory()) {
        process.stderr.write(`md: not a file or directory: ${root}\n`);
        process.exit(1);
    }

    const host = opts.host ?? "127.0.0.1";
    const preferred = opts.port ?? 9876;
    const openBrowser = opts.open !== false;

    const server = startServer(host, preferred, (req) => handle(req, serveRoot, initialFile));

    const url = `http://${host}:${server.port}/`;
    process.stdout.write(`md serve v${getVersion()} → ${url}\n`);
    process.stdout.write(`  root: ${serveRoot}\n`);
    if (initialFile) {
        process.stdout.write(`  file: ${relative(serveRoot, initialFile) || basename(initialFile)}\n`);
    }
    process.stdout.write(`  ctrl+c to stop\n`);

    if (openBrowser) {
        openUrl(url);
    }

    // Keep process alive.
    await new Promise<void>(() => {});
}

/** Bind preferred port; on EADDRINUSE walk up a few ports. */
function startServer(
    host: string,
    preferred: number,
    fetch: (req: Request) => Response | Promise<Response>,
): ReturnType<typeof Bun.serve> {
    const maxTries = 20;
    let lastErr: unknown;
    for (let i = 0; i < maxTries; i++) {
        const port = preferred + i;
        try {
            return Bun.serve({
                hostname: host,
                port,
                fetch,
                error(err) {
                    return new Response(String(err), { status: 500 });
                },
            });
        } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            if (!/EADDRINUSE|already in use|Failed to start server/i.test(msg)) {
                throw err;
            }
        }
    }
    throw lastErr instanceof Error
        ? lastErr
        : new Error(`could not bind port near ${preferred}`);
}

async function handle(req: Request, root: string, initialFile?: string): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/favicon.ico") {
        return new Response(null, { status: 204 });
    }

    if (pathname === "/" || pathname === "/index.html") {
        const boot = initialFile
            ? relative(root, initialFile).split(sep).join("/")
            : "";
        return html(pageHtml(boot, basename(root) || root));
    }

    if (pathname === "/api/list") {
        const rel = url.searchParams.get("path") ?? ".";
        const dir = safeJoin(root, rel);
        if (!dir) return json({ error: "invalid path" }, 400);
        try {
            const st = statSync(dir);
            if (!st.isDirectory()) return json({ error: "not a directory" }, 400);
        } catch {
            return json({ error: "not found" }, 404);
        }
        const { dirs, files } = listDirectory(dir);
        return json({
            path: relPath(root, dir) || ".",
            parent: dir === root ? null : relPath(root, dirname(dir)) || ".",
            dirs: dirs.map((d) => ({
                name: basename(d),
                path: relPath(root, d),
            })),
            files: files.map((f) => ({
                name: basename(f),
                path: relPath(root, f),
                kind: docKind(f),
            })),
        });
    }

    // Flat list of every viewable file under root — powers the file tree and
    // the command palette's fuzzy finder.
    if (pathname === "/api/all") {
        const files = findViewableFiles(root);
        return json({
            files: files.map((rel) => ({
                path: rel,
                name: basename(rel),
                kind: docKind(rel),
            })),
        });
    }

    // Live full-text search across viewable files. One hit per file, capped.
    if (pathname === "/api/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (q.length < 2) return json({ results: [] });
        const needle = q.toLowerCase();
        const files = findViewableFiles(root);
        const results: Array<{ path: string; name: string; line: number; snippet: string }> = [];
        const max = 50;
        for (const rel of files) {
            if (results.length >= max) break;
            const abs = safeJoin(root, rel);
            if (!abs) continue;
            let raw: string;
            try {
                raw = readFileSync(abs, "utf8");
            } catch {
                continue;
            }
            const lines = raw.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const idx = lines[i].toLowerCase().indexOf(needle);
                if (idx >= 0) {
                    const start = Math.max(0, idx - 30);
                    const snippet = lines[i].slice(start, start + 160).trim();
                    results.push({ path: rel, name: basename(rel), line: i + 1, snippet });
                    break; // one hit per file keeps the list tight
                }
            }
        }
        return json({ results });
    }

    if (pathname === "/api/file") {
        const rel = url.searchParams.get("path");
        if (!rel) return json({ error: "path required" }, 400);
        const file = safeJoin(root, rel);
        if (!file || !isViewablePath(file)) return json({ error: "invalid path" }, 400);
        try {
            const st = statSync(file);
            if (!st.isFile()) return json({ error: "not a file" }, 400);
            const raw = readFileSync(file, "utf8");
            const kind = docKind(file);
            const markdown = kind === "tex" ? texToMarkdown(raw) : raw;
            return json({
                path: relPath(root, file),
                name: basename(file),
                kind,
                markdown,
                // Raw only for markdown (edit/download later); tex stays converted.
                raw: kind === "markdown" ? raw : undefined,
            });
        } catch {
            return json({ error: "not found" }, 404);
        }
    }

    // Relative assets next to served markdown (images, etc.).
    if (pathname.startsWith("/raw/")) {
        const rel = decodeURIComponent(pathname.slice("/raw/".length));
        const file = safeJoin(root, rel);
        if (!file) return new Response("bad path", { status: 400 });
        try {
            const st = statSync(file);
            if (!st.isFile()) return new Response("not found", { status: 404 });
            const bunFile = Bun.file(file);
            return new Response(bunFile, {
                headers: {
                    "Content-Type": bunFile.type || guessMime(file),
                    "Cache-Control": "no-cache",
                },
            });
        } catch {
            return new Response("not found", { status: 404 });
        }
    }

    // Real-URL routing: serve the SPA for any other GET path so deep links like
    // /guides/getting-started.md load directly and survive a reload. The client
    // reads location.pathname to open the file (or the home view at "/").
    if (req.method === "GET" || req.method === "HEAD") {
        let boot = "";
        try {
            boot = decodeURIComponent(pathname.replace(/^\/+/, ""));
        } catch {
            boot = pathname.replace(/^\/+/, "");
        }
        return html(pageHtml(boot, basename(root) || root));
    }

    return new Response("not found", { status: 404 });
}

/** Resolve path under root; null if it escapes. */
function safeJoin(root: string, rel: string): string | null {
    const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    if (cleaned.split("/").some((p) => p === "..")) return null;
    const full = resolve(root, cleaned === "." || cleaned === "" ? "." : cleaned);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (full !== root && !full.startsWith(rootWithSep)) return null;
    return full;
}

function relPath(root: string, abs: string): string {
    return relative(root, abs).split(sep).join("/");
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
    });
}

function html(body: string): Response {
    return new Response(body, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    });
}

function guessMime(path: string): string {
    const ext = extname(path).toLowerCase();
    const map: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
        ".css": "text/css",
        ".js": "text/javascript",
        ".json": "application/json",
        ".txt": "text/plain",
        ".md": "text/markdown",
    };
    return map[ext] ?? "application/octet-stream";
}

function openUrl(url: string): void {
    const platform = process.platform;
    const cmd =
        platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
    const args = platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    } catch {
        process.stderr.write(`md: could not open browser; visit ${url}\n`);
    }
}

function pageHtml(bootPath: string, rootName: string): string {
    const data = JSON.stringify({ boot: bootPath, root: rootName });
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark" data-font="sans">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>md serve</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400..600&display=swap" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css" />
<style>
/* oboe.chat-matched zinc palette (shadcn zinc base) + indigo accent */
:root, [data-theme="dark"] {
  --bg: oklch(0.19 0.004 285.9);
  --bg-elev: oklch(0.216 0.006 285.9);
  --bg-sidebar: oklch(0.174 0.004 285.9);
  --bg-hover: oklch(1 0 0 / 6%);
  --fg: oklch(0.985 0 0);
  --fg-muted: oklch(0.705 0.015 286.1);
  --fg-faint: oklch(0.554 0.016 285.9);
  --border: oklch(1 0 0 / 10%);
  --border-soft: oklch(1 0 0 / 6%);
  --accent: oklch(0.68 0.16 277);
  --accent-strong: oklch(0.75 0.15 277);
  --accent-soft: oklch(0.68 0.16 277 / 15%);
  --heading: oklch(0.985 0 0);
  --code-bg: oklch(0.163 0.004 285.9);
  --code-head-bg: oklch(0.2 0.005 285.9);
  --code-border: oklch(1 0 0 / 8%);
  --quote-border: oklch(0.68 0.16 277);
  --link: oklch(0.72 0.15 277);
  --mark: oklch(0.68 0.16 277 / 24%);
  --shadow-lg: 0 24px 60px -12px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.05);
  --glow: radial-gradient(1200px 520px at 80% -10%, oklch(0.68 0.16 277 / 8%), transparent 60%);
  --sel: oklch(0.68 0.16 277 / 24%);
  color-scheme: dark;
}
[data-theme="light"] {
  --bg: oklch(1 0 0);
  --bg-elev: oklch(0.985 0 0);
  --bg-sidebar: oklch(0.985 0.001 286.4);
  --bg-hover: oklch(0.141 0.005 285.8 / 5%);
  --fg: oklch(0.21 0.006 285.9);
  --fg-muted: oklch(0.552 0.016 285.9);
  --fg-faint: oklch(0.65 0.014 286);
  --border: oklch(0.92 0.004 286.3);
  --border-soft: oklch(0.95 0.003 286.3);
  --accent: oklch(0.51 0.23 277);
  --accent-strong: oklch(0.45 0.24 277);
  --accent-soft: oklch(0.51 0.23 277 / 9%);
  --heading: oklch(0.145 0.005 285.8);
  --code-bg: oklch(0.985 0.001 286.4);
  --code-head-bg: oklch(0.967 0.001 286.4);
  --code-border: oklch(0.92 0.004 286.3);
  --quote-border: oklch(0.51 0.23 277);
  --link: oklch(0.51 0.23 277);
  --mark: oklch(0.51 0.23 277 / 15%);
  --shadow-lg: 0 24px 60px -12px rgba(15,23,42,.18), 0 0 0 1px rgba(15,23,42,.05);
  --glow: radial-gradient(1200px 520px at 80% -10%, oklch(0.51 0.23 277 / 6%), transparent 60%);
  --sel: oklch(0.51 0.23 277 / 14%);
  color-scheme: light;
}
* { box-sizing: border-box; }
::selection { background: var(--sel); }
html { scroll-padding-top: 70px; }
html, body { margin: 0; }
body {
  --side-w: 288px;
  --toc-w: 240px;
  --bar-h: 52px;
  --font-sans: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--fg);
  min-height: 100%;
  -webkit-font-smoothing: antialiased;
}
/* faint grain + top glow for atmosphere */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background: var(--glow);
}
body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: .5;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.024'/%3E%3C/svg%3E");
}
body > * { position: relative; z-index: 1; }

/* reading progress */
#progress {
  position: fixed;
  top: 0; left: 0;
  height: 2px;
  width: 0;
  background: linear-gradient(90deg, var(--accent), var(--accent-strong));
  z-index: 60;
  transition: width .08s linear;
}

/* ── top bar ─────────────────────────────────────────────── */
.appbar {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: .5rem;
  padding: 0 .75rem 0 1rem;
  height: var(--bar-h);
  background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
  backdrop-filter: saturate(140%) blur(14px);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: .55rem;
  font-weight: 650;
  letter-spacing: .01em;
  color: var(--fg);
  cursor: pointer;
  padding-right: .35rem;
  user-select: none;
  flex-shrink: 0;
}
.brand svg { color: var(--accent); flex-shrink: 0; }
.brand .root { color: var(--fg-muted); font-weight: 500; font-size: .9rem; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brand:hover .root { color: var(--fg); }

.crumbs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: .1rem;
  font-size: .82rem;
  font-family: var(--font-mono);
  overflow: hidden;
  color: var(--fg-faint);
  padding-left: .35rem;
}
.crumbs .seg {
  color: var(--fg-muted);
  padding: .12rem .32rem;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}
.crumbs .seg:hover { color: var(--accent); background: var(--accent-soft); }
.crumbs .seg.file { color: var(--fg); cursor: default; }
.crumbs .seg.file:hover { background: none; color: var(--fg); }
.crumbs .sep { color: var(--fg-faint); opacity: .6; }

.search-btn {
  display: flex;
  align-items: center;
  gap: .5rem;
  min-width: 210px;
  height: 34px;
  padding: 0 .5rem 0 .7rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--fg-muted);
  cursor: pointer;
  font-size: .82rem;
  transition: border-color .15s, color .15s;
}
.search-btn:hover { border-color: var(--accent); color: var(--fg); }
.search-btn svg { flex-shrink: 0; opacity: .8; }
.search-btn .lbl { flex: 1; text-align: left; }
.search-btn kbd {
  font-family: var(--font-mono);
  font-size: .7rem;
  color: var(--fg-faint);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: .05rem .3rem;
  background: var(--bg-elev);
}
.tools { display: flex; align-items: center; gap: .3rem; flex-shrink: 0; }
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px; height: 34px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-muted);
  border-radius: 8px;
  cursor: pointer;
  font-size: .82rem;
  font-weight: 600;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--fg); }
.icon-btn.active { color: var(--accent); background: var(--accent-soft); }

/* ── layout ──────────────────────────────────────────────── */
.layout {
  display: grid;
  grid-template-columns: var(--side-w) minmax(0,1fr) var(--toc-w);
  align-items: start;
}
.layout.no-sidebar { grid-template-columns: 0 minmax(0,1fr) var(--toc-w); }
.layout.no-toc { grid-template-columns: var(--side-w) minmax(0,1fr) 0; }
.layout.no-sidebar.no-toc { grid-template-columns: 0 minmax(0,1fr) 0; }

/* ── sidebar ─────────────────────────────────────────────── */
.sidebar {
  position: sticky;
  top: var(--bar-h);
  height: calc(100vh - var(--bar-h));
  border-right: 1px solid var(--border);
  background: var(--bg-sidebar);
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.layout.no-sidebar .sidebar { display: none; }
.side-search {
  position: sticky;
  top: 0;
  background: var(--bg-sidebar);
  padding: .7rem .75rem .55rem;
  border-bottom: 1px solid var(--border-soft);
  z-index: 2;
}
.side-search input {
  width: 100%;
  height: 32px;
  padding: 0 .6rem;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
  font-size: .82rem;
  outline: none;
}
.side-search input:focus { border-color: var(--accent); }
.tree { padding: .4rem .4rem 2rem; }
.tree .lbl-sec {
  font-size: .68rem;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--fg-faint);
  padding: .5rem .55rem .3rem;
  font-weight: 700;
}
details.dir { }
details.dir > summary {
  display: flex;
  align-items: center;
  gap: .35rem;
  list-style: none;
  cursor: pointer;
  padding: .3rem .5rem;
  border-radius: 6px;
  font-size: .84rem;
  color: var(--fg);
  font-weight: 550;
  user-select: none;
}
details.dir > summary::-webkit-details-marker { display: none; }
details.dir > summary:hover { background: var(--bg-hover); }
details.dir > summary .chev {
  transition: transform .15s;
  color: var(--fg-faint);
  flex-shrink: 0;
}
details.dir[open] > summary .chev { transform: rotate(90deg); }
.dir-children { padding-left: .8rem; border-left: 1px solid var(--border-soft); margin-left: .78rem; }
.file-item {
  display: flex;
  align-items: center;
  gap: .45rem;
  padding: .3rem .5rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: .84rem;
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-item .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--fg-faint); flex-shrink: 0; opacity: .6; }
.file-item.tex .dot { background: #d9a441; opacity: .9; }
.file-item:hover { background: var(--bg-hover); color: var(--fg); }
.file-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.file-item.active .dot { background: var(--accent); opacity: 1; }
.file-item .nm { overflow: hidden; text-overflow: ellipsis; }
.tree-empty { color: var(--fg-faint); font-size: .82rem; padding: 1rem .6rem; }

/* ── main reading column ─────────────────────────────────── */
.main {
  /* Always the middle track. Without this, when the sidebar is position:absolute
     (mobile) and the toc is display:none, main auto-places into the 0px column. */
  grid-column: 2;
  min-width: 0;
  min-height: calc(100vh - var(--bar-h));
}
.article {
  max-width: 760px;
  margin: 0 auto;
  padding: 3rem 2.5rem 6rem;
}
[data-font="serif"] .article {
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, ui-serif, serif;
  font-size: 1.06rem;
}
.doc-head { margin-bottom: 1.6rem; }
.doc-kicker {
  font-size: .7rem;
  text-transform: uppercase;
  letter-spacing: .12em;
  color: var(--fg-faint);
  font-family: var(--font-mono);
  font-weight: 600;
  margin-bottom: .5rem;
}

/* landing / home */
.home { max-width: 780px; margin: 0 auto; padding: 3.5rem 2.5rem 5rem; }
.home h1 { font-size: 1.7rem; color: var(--heading); margin: 0 0 .35rem; letter-spacing: -.01em; }
.home .sub { color: var(--fg-muted); margin: 0 0 2rem; font-size: .95rem; }
.home .sec-t { font-size: .72rem; text-transform: uppercase; letter-spacing: .1em; color: var(--fg-faint); font-weight: 700; margin: 1.8rem 0 .7rem; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px,1fr)); gap: .7rem; }
.card {
  display: flex;
  flex-direction: column;
  gap: .25rem;
  padding: .85rem 1rem;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--bg-elev);
  cursor: pointer;
  transition: border-color .15s, transform .12s, box-shadow .15s;
}
.card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: var(--shadow-lg); }
.card .c-name { font-weight: 600; color: var(--fg); font-size: .92rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .c-path { font-size: .74rem; color: var(--fg-faint); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--fg-muted); text-align: center; padding: 5rem 1rem; font-size: .95rem; }

/* ── on-this-page toc ────────────────────────────────────── */
.toc {
  position: sticky;
  top: var(--bar-h);
  height: calc(100vh - var(--bar-h));
  overflow: auto;
  padding: 3rem 1rem 3rem 0;
  border-left: 1px solid var(--border-soft);
}
.layout.no-toc .toc { display: none; }
.toc .toc-t {
  font-size: .68rem;
  text-transform: uppercase;
  letter-spacing: .1em;
  color: var(--fg-faint);
  font-weight: 700;
  padding: 0 .9rem .6rem;
}
.toc a {
  display: block;
  padding: .28rem .9rem;
  font-size: .8rem;
  color: var(--fg-muted);
  text-decoration: none;
  border-left: 2px solid transparent;
  line-height: 1.35;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toc a.lvl-3 { padding-left: 1.6rem; font-size: .77rem; }
.toc a:hover { color: var(--fg); }
.toc a.active { color: var(--accent); border-left-color: var(--accent); background: var(--accent-soft); }
.toc-empty { color: var(--fg-faint); font-size: .78rem; padding: 0 .9rem; }

/* ── markdown body ───────────────────────────────────────── */
.article h1, .article h2, .article h3, .article h4, .article h5, .article h6 {
  color: var(--heading);
  line-height: 1.25;
  margin: 2em 0 .7em;
  font-weight: 680;
  letter-spacing: -.01em;
  scroll-margin-top: 80px;
  position: relative;
}
.article h1 { font-size: 2rem; margin-top: 0; letter-spacing: -.02em; }
.article h2 { font-size: 1.5rem; border-bottom: 1px solid var(--border-soft); padding-bottom: .3em; }
.article h3 { font-size: 1.22rem; }
.article h4 { font-size: 1.05rem; }
.article .anchor {
  position: absolute;
  left: -1.15em;
  top: 0;
  color: var(--fg-faint);
  opacity: 0;
  text-decoration: none;
  font-weight: 400;
  transition: opacity .12s;
  padding-right: .3em;
}
.article h1:hover .anchor, .article h2:hover .anchor,
.article h3:hover .anchor, .article h4:hover .anchor { opacity: .6; }
.article .anchor:hover { color: var(--accent); opacity: 1; }
.article p, .article li { line-height: 1.75; }
.article p { margin: 0 0 1.1em; }
.article a { color: var(--link); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--link) 35%, transparent); }
.article a:hover { border-bottom-color: var(--link); }
.article strong { color: var(--fg); font-weight: 680; }
.article mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 .15em; }
.article code {
  font-family: var(--font-mono);
  font-size: .85em;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 6px;
  padding: .12em .4em;
}
/* code blocks — oboe.chat style: rounded card, header row, shiki body */
.code-wrap {
  margin: 1.4em 0;
  border: 1px solid var(--code-border);
  border-radius: 16px;
  overflow: hidden;
  background: var(--code-bg);
}
.code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: .45rem .55rem .45rem .95rem;
  background: var(--code-head-bg);
  border-bottom: 1px solid var(--code-border);
}
.code-lang {
  font-family: var(--font-mono);
  font-size: .68rem;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--fg-faint);
  font-weight: 600;
}
.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: .32rem;
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-muted);
  border-radius: 8px;
  padding: .22rem .55rem;
  font-size: .72rem;
  cursor: pointer;
  font-family: var(--font-mono);
  transition: background .12s, color .12s;
}
.copy-btn:hover { color: var(--fg); background: var(--bg-hover); }
.copy-btn.done { color: #22c55e; }
.article pre {
  margin: 0;
  padding: 1rem 1.15rem;
  overflow-x: auto;
  background: transparent;
  border: none;
}
.article pre code {
  background: none;
  border: none;
  padding: 0;
  font-size: .84rem;
  line-height: 1.65;
  font-family: var(--font-mono);
}
.article .shiki { background: transparent !important; }
html[data-theme="dark"] .article .shiki,
html[data-theme="dark"] .article .shiki span { color: var(--shiki-dark) !important; }
.article blockquote {
  margin: 1.3em 0;
  padding: .3em 0 .3em 1.15em;
  border-left: 3px solid var(--quote-border);
  color: var(--fg-muted);
}
.article blockquote p:last-child { margin-bottom: 0; }
.article ul, .article ol { padding-left: 1.4em; }
.article li { margin: .3em 0; }
.article table {
  border-collapse: collapse;
  width: 100%;
  margin: 1.4em 0;
  font-size: .92rem;
  display: block;
  overflow-x: auto;
}
.article th, .article td {
  border: 1px solid var(--border);
  padding: .5em .75em;
  text-align: left;
}
.article th { background: var(--bg-elev); font-weight: 650; color: var(--fg); }
.article tr:nth-child(2n) td { background: var(--bg-hover); }
.article hr { border: none; border-top: 1px solid var(--border); margin: 2.5em 0; }
.article img { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--border-soft); }
.article .katex-display { overflow-x: auto; overflow-y: hidden; padding: .5em 0; }
.mermaid {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1.1rem;
  margin: 1.4em 0;
  text-align: center;
  overflow-x: auto;
}
.mermaid svg { max-width: 100%; height: auto; }

/* ── command palette ─────────────────────────────────────── */
.palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(3,4,8,.55);
  backdrop-filter: blur(3px);
  display: none;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
}
.palette-overlay.open { display: flex; }
.palette {
  width: min(640px, 92vw);
  max-height: 68vh;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.palette-in {
  display: flex;
  align-items: center;
  gap: .6rem;
  padding: .85rem 1rem;
  border-bottom: 1px solid var(--border);
}
.palette-in svg { color: var(--fg-muted); flex-shrink: 0; }
.palette-in input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  color: var(--fg);
  font-size: 1rem;
}
.palette-in .hint { font-size: .68rem; color: var(--fg-faint); font-family: var(--font-mono); border: 1px solid var(--border); border-radius: 5px; padding: .1rem .35rem; }
.palette-list { overflow: auto; padding: .4rem; }
.p-sec { font-size: .66rem; text-transform: uppercase; letter-spacing: .09em; color: var(--fg-faint); font-weight: 700; padding: .6rem .7rem .3rem; }
.p-item {
  display: flex;
  align-items: center;
  gap: .6rem;
  padding: .5rem .7rem;
  border-radius: 8px;
  cursor: pointer;
  color: var(--fg);
}
.p-item .p-ico { color: var(--fg-faint); flex-shrink: 0; display: flex; }
.p-item.tex .p-ico { color: #d9a441; }
.p-item .p-main { min-width: 0; flex: 1; }
.p-item .p-name { font-size: .88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-item .p-name b { color: var(--accent); font-weight: 700; }
.p-item .p-sub { font-size: .74rem; color: var(--fg-faint); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-item .p-snip { font-size: .76rem; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-item .p-snip mark { background: var(--mark); color: var(--fg); border-radius: 2px; }
.p-item.sel { background: var(--accent-soft); }
.p-item.sel .p-sub { color: var(--accent); }
.p-empty { color: var(--fg-faint); padding: 1.4rem; text-align: center; font-size: .86rem; }
.palette-foot { display: flex; gap: 1rem; padding: .5rem .9rem; border-top: 1px solid var(--border); font-size: .7rem; color: var(--fg-faint); }
.palette-foot kbd { font-family: var(--font-mono); border: 1px solid var(--border); border-radius: 4px; padding: 0 .28rem; }

@media (max-width: 1080px) {
  .layout, .layout.no-sidebar { grid-template-columns: var(--side-w) minmax(0,1fr) 0; }
  .layout.no-sidebar { grid-template-columns: 0 minmax(0,1fr) 0; }
  .toc { display: none; }
}
@media (max-width: 760px) {
  .appbar { padding: 0 .6rem; gap: .35rem; }
  .brand .root, .crumbs { display: none; }
  .search-btn { min-width: 0; width: 34px; padding: 0; justify-content: center; }
  .search-btn .lbl, .search-btn kbd { display: none; }
  /* full-bleed reading column; match specificity of the tablet rule so these win */
  .layout, .layout.no-sidebar, .layout.no-toc, .layout.no-sidebar.no-toc { grid-template-columns: 0 minmax(0,1fr) 0; }
  .sidebar { position: absolute; inset: var(--bar-h) 0 0 0; width: min(320px, 86vw); z-index: 40; box-shadow: var(--shadow-lg); }
  .layout.no-sidebar .sidebar { display: none; }
  .layout:not(.no-sidebar) .sidebar { display: flex; }
  .article { padding: 1.75rem 1.15rem 4rem; }
  .home { padding: 2rem 1.15rem; }
}
</style>
</head>
<body>
<div id="progress"></div>
<div class="appbar">
  <div class="brand" id="brand" title="Home">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.6l2.1 6.9 6.9 2.1 .5.4-.5.4-6.9 2.1L12 22.4l-2.1-6.9-6.9-2.1-.5-.4.5-.4 6.9-2.1L12 1.6z"/></svg>
    <span class="root" id="root-name"></span>
  </div>
  <nav class="crumbs" id="crumbs" aria-label="breadcrumb"></nav>
  <button class="search-btn" id="search-btn" title="Search (⌘K)">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    <span class="lbl">Search files &amp; content…</span>
    <kbd id="kbd-hint">⌘K</kbd>
  </button>
  <div class="tools">
    <button class="icon-btn" id="btn-font" title="Toggle serif / sans">Aa</button>
    <button class="icon-btn" id="btn-theme" title="Toggle theme (t)">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    </button>
    <button class="icon-btn active" id="btn-sidebar" title="Toggle files (\\)">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
    </button>
  </div>
</div>

<div class="layout" id="layout">
  <aside class="sidebar" id="sidebar">
    <div class="side-search">
      <input id="tree-filter" type="text" placeholder="Filter files…" spellcheck="false" autocomplete="off" />
    </div>
    <div class="tree" id="tree"></div>
  </aside>
  <main class="main" id="main">
    <div class="empty">loading…</div>
  </main>
  <aside class="toc" id="toc"></aside>
</div>

<div class="palette-overlay" id="palette-overlay">
  <div class="palette" role="dialog" aria-modal="true">
    <div class="palette-in">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input id="palette-input" type="text" placeholder="Search files and content…" spellcheck="false" autocomplete="off" />
      <span class="hint">esc</span>
    </div>
    <div class="palette-list" id="palette-list"></div>
    <div class="palette-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span><kbd>↵</kbd> open</span>
      <span><kbd>esc</kbd> close</span>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/marked@14.1.4/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/contrib/auto-render.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>
const DATA = ${data};
const $ = (id) => document.getElementById(id);
const sidebar = $("sidebar");
const main = $("main");
const layout = $("layout");
const tocEl = $("toc");
const crumbsEl = $("crumbs");

let currentFile = null;
let allFiles = [];
let mermaidId = 0;
let headings = [];
let spyRAF = 0;

// ── platform key hint ──────────────────────────────────────
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$("kbd-hint").textContent = isMac ? "⌘K" : "Ctrl K";

// ── theme + font ───────────────────────────────────────────
function systemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("md-theme", t);
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, theme: t === "dark" ? "dark" : "default", securityLevel: "loose" });
  }
}
function applyFont(f) {
  document.documentElement.setAttribute("data-font", f);
  localStorage.setItem("md-font", f);
  $("btn-font").classList.toggle("active", f === "serif");
}
const savedTheme = localStorage.getItem("md-theme");
applyTheme(savedTheme === "light" || savedTheme === "dark" ? savedTheme : systemTheme());
const savedFont = localStorage.getItem("md-font");
applyFont(savedFont === "serif" ? "serif" : "sans");

$("btn-theme").onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  // Code re-colors instantly via shiki dual-theme CSS vars; re-render the
  // cached doc only to re-theme mermaid, preserving scroll position.
  if (lastDoc) { const y = window.scrollY; renderDoc(lastDoc); window.scrollTo(0, y); }
};
$("btn-font").onclick = () => {
  const next = document.documentElement.getAttribute("data-font") === "serif" ? "sans" : "serif";
  applyFont(next);
};
$("btn-sidebar").onclick = toggleSidebar;
$("brand").onclick = () => showHome();

function toggleSidebar() {
  const hidden = layout.classList.toggle("no-sidebar");
  $("btn-sidebar").classList.toggle("active", !hidden);
  localStorage.setItem("md-sidebar", hidden ? "0" : "1");
}
if (localStorage.getItem("md-sidebar") === "0") {
  layout.classList.add("no-sidebar");
  $("btn-sidebar").classList.remove("active");
}

// ── marked + highlight ─────────────────────────────────────
const renderer = {
  code({ text, lang }) {
    const language = (lang || "").trim().split(/\\s+/)[0];
    if (language === "mermaid") {
      const id = "mmd-" + (++mermaidId);
      const safe = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      return '<div class="mermaid" id="'+id+'">'+safe+'</div>';
    }
    // Emit a plain, escaped placeholder immediately; shiki upgrades it after
    // the DOM is inserted (see highlightCode). textContent recovers the raw
    // source for the highlighter and the copy button.
    const label = language || "text";
    const safe = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    return '<div class="code-wrap" data-lang="'+esc(language)+'">'+
      '<div class="code-head"><span class="code-lang">'+esc(label)+'</span>'+
      '<button class="copy-btn" type="button">'+copyIcon()+'Copy</button></div>'+
      '<pre class="raw-code"><code>'+safe+'</code></pre></div>';
  },
  image({ href, title, text }) {
    const src = rewriteAsset(href);
    const t = title ? ' title="'+esc(title)+'"' : "";
    return '<img src="'+esc(src)+'" alt="'+esc(text||"")+'"'+t+' loading="lazy" />';
  },
  link({ href, title, text }) {
    const h = href || "";
    let dest = h;
    if (h && !/^(https?:|mailto:|#|\\/)/i.test(h) && !/\\.(md|markdown|mdx|tex|latex|ltx)$/i.test(h)) {
      dest = rewriteAsset(h);
    }
    const t = title ? ' title="'+esc(title)+'"' : "";
    const ext = /^(https?:)/i.test(dest) ? ' target="_blank" rel="noopener"' : "";
    return '<a href="'+esc(dest)+'"'+t+ext+'>'+text+'</a>';
  },
};
marked.use({ gfm: true, breaks: false, renderer });

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function rewriteAsset(href) {
  if (!href || /^(https?:|data:|mailto:|#|\\/)/i.test(href)) return href;
  const base = currentFile ? currentFile.replace(/[^/]+$/, "") : "";
  const joined = (base + href).replace(/\\/+/g, "/");
  const parts = [];
  for (const p of joined.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return "/raw/" + parts.map(encodeURIComponent).join("/");
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── recent files ───────────────────────────────────────────
function getRecent() {
  try { return JSON.parse(localStorage.getItem("md-recent") || "[]"); } catch { return []; }
}
function pushRecent(path) {
  let r = getRecent().filter((p) => p !== path);
  r.unshift(path);
  r = r.slice(0, 8);
  localStorage.setItem("md-recent", JSON.stringify(r));
}

// ── file tree ──────────────────────────────────────────────
function fileKind(path) {
  return /\\.(tex|latex|ltx)$/i.test(path) ? "tex" : "markdown";
}
function buildTree(files) {
  const root = { dirs: {}, files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node.dirs[parts[i]] = node.dirs[parts[i]] || { dirs: {}, files: [] };
      node = node.dirs[parts[i]];
    }
    node.files.push(f);
  }
  return root;
}
function renderTree() {
  const filter = $("tree-filter").value.trim().toLowerCase();
  const treeEl = $("tree");
  if (!allFiles.length) { treeEl.innerHTML = '<div class="tree-empty">No markdown files found.</div>'; return; }
  if (filter) {
    const hits = allFiles.filter((f) => f.path.toLowerCase().includes(filter));
    if (!hits.length) { treeEl.innerHTML = '<div class="tree-empty">No matches.</div>'; return; }
    treeEl.innerHTML = hits.map(fileRow).join("");
  } else {
    const tree = buildTree(allFiles);
    treeEl.innerHTML = renderNode(tree, "", 0);
  }
  bindTreeEvents(treeEl);
}
function renderNode(node, prefix, depth) {
  let html = "";
  const dirNames = Object.keys(node.dirs).sort((a, b) => a.localeCompare(b));
  for (const name of dirNames) {
    const path = prefix ? prefix + "/" + name : name;
    const open = depth < 1 || (currentFile && currentFile.startsWith(path + "/")) ? " open" : "";
    html += '<details class="dir"'+open+' data-dir="'+esc(path)+'">'+
      '<summary><svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>'+esc(name)+'</summary>'+
      '<div class="dir-children">'+renderNode(node.dirs[name], path, depth + 1)+'</div>'+
      '</details>';
  }
  const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const f of files) html += fileRow(f);
  return html;
}
function fileRow(f) {
  const active = f.path === currentFile ? " active" : "";
  const kind = f.kind || fileKind(f.path);
  return '<div class="file-item '+kind+active+'" data-path="'+esc(f.path)+'" title="'+esc(f.path)+'">'+
    '<span class="dot"></span><span class="nm">'+esc(f.name)+'</span></div>';
}
function bindTreeEvents(treeEl) {
  treeEl.querySelectorAll(".file-item").forEach((el) => {
    el.addEventListener("click", () => openFile(el.getAttribute("data-path")));
  });
  // persist open/closed dir state per session
  treeEl.querySelectorAll("details.dir").forEach((d) => {
    d.addEventListener("toggle", () => {});
  });
}
$("tree-filter").addEventListener("input", renderTree);

// ── breadcrumbs ────────────────────────────────────────────
function renderCrumbs(path) {
  if (!path) { crumbsEl.innerHTML = ""; return; }
  const parts = path.split("/");
  let html = '<span class="seg" data-home="1">'+esc(DATA.root || ".")+'</span>';
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    acc = acc ? acc + "/" + parts[i] : parts[i];
    const isFile = i === parts.length - 1;
    html += '<span class="sep">/</span>';
    html += '<span class="seg'+(isFile ? " file" : "")+'" data-dir="'+esc(isFile ? "" : acc)+'">'+esc(parts[i])+'</span>';
  }
  crumbsEl.innerHTML = html;
  crumbsEl.querySelectorAll(".seg").forEach((el) => {
    if (el.getAttribute("data-home")) { el.onclick = () => showHome(); return; }
    const dir = el.getAttribute("data-dir");
    if (dir) el.onclick = () => { $("tree-filter").value = ""; renderTree(); expandTo(dir); };
  });
}
function expandTo(dir) {
  $("tree").querySelectorAll("details.dir").forEach((d) => {
    const dp = d.getAttribute("data-dir");
    if (dir === dp || dir.startsWith(dp + "/")) d.open = true;
  });
}

// ── table of contents + scroll spy ─────────────────────────
function slugify(t) {
  return t.toLowerCase().trim()
    .replace(/[^a-z0-9\\s-]/g, "")
    .replace(/\\s+/g, "-")
    .replace(/-+/g, "-") || "section";
}
function buildToc() {
  headings = [];
  const used = {};
  const nodes = main.querySelectorAll(".article h2, .article h3");
  nodes.forEach((h) => {
    let id = slugify(h.textContent || "");
    if (used[id]) { used[id]++; id = id + "-" + used[id]; } else used[id] = 1;
    h.id = id;
    const a = document.createElement("a");
    a.className = "anchor";
    a.textContent = "#";
    a.setAttribute("aria-label", "Link to section");
    a.addEventListener("click", (e) => { e.preventDefault(); scrollToEl(h); });
    h.prepend(a);
    headings.push({ id, el: h, level: h.tagName === "H3" ? 3 : 2, text: h.textContent.replace(/^#/, "") });
  });
  if (!headings.length) { tocEl.innerHTML = ""; layout.classList.add("no-toc"); return; }
  layout.classList.remove("no-toc");
  let html = '<div class="toc-t">On this page</div>';
  for (const h of headings) {
    html += '<a class="lvl-'+h.level+'" data-id="'+esc(h.id)+'">'+esc(h.text)+'</a>';
  }
  tocEl.innerHTML = html;
  tocEl.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const t = headings.find((x) => x.id === a.getAttribute("data-id"));
      if (t) scrollToEl(t.el);
    });
  });
}
function scrollToEl(el) {
  const top = el.getBoundingClientRect().top + window.scrollY - 68;
  window.scrollTo({ top, behavior: "smooth" });
}
function updateSpy() {
  spyRAF = 0;
  const denom = document.documentElement.scrollHeight - window.innerHeight;
  $("progress").style.width = (denom > 0 ? Math.min(100, (window.scrollY / denom) * 100) : 0) + "%";
  if (!headings.length) return;
  let active = headings[0].id;
  for (const h of headings) {
    if (h.el.getBoundingClientRect().top < 120) active = h.id;
    else break;
  }
  tocEl.querySelectorAll("a").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("data-id") === active);
  });
}
window.addEventListener("scroll", () => {
  if (!spyRAF) spyRAF = requestAnimationFrame(updateSpy);
}, { passive: true });

// ── copy buttons ───────────────────────────────────────────
function copyIcon() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
}
function bindCopyButtons() {
  main.querySelectorAll(".code-wrap").forEach((wrap) => {
    const btn = wrap.querySelector(".copy-btn");
    if (!btn) return;
    btn.onclick = () => {
      const pre = wrap.querySelector("pre");
      const text = pre ? pre.innerText : "";
      navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = copyIcon() + "Copied";
        btn.classList.add("done");
        setTimeout(() => { btn.innerHTML = copyIcon() + "Copy"; btn.classList.remove("done"); }, 1400);
      });
    };
  });
}

// ── shiki syntax highlighting (oboe.chat parity: dark-plus / github-light) ──
let shikiMod = null;
let shikiTried = false;
async function loadShiki() {
  if (shikiMod) return shikiMod;
  if (shikiTried) return null;
  shikiTried = true;
  try { shikiMod = await import("https://esm.sh/shiki@3"); return shikiMod; }
  catch { return null; }
}
async function shikiHtml(code, lang) {
  const mod = await loadShiki();
  if (!mod) return null;
  const opts = { themes: { light: "github-light", dark: "dark-plus" }, defaultColor: "light" };
  try { return await mod.codeToHtml(code, Object.assign({ lang: lang || "text" }, opts)); }
  catch {
    try { return await mod.codeToHtml(code, Object.assign({ lang: "text" }, opts)); }
    catch { return null; }
  }
}
let highlightRun = 0;
async function highlightCode() {
  const run = ++highlightRun;
  const wraps = Array.from(main.querySelectorAll(".code-wrap"));
  for (const wrap of wraps) {
    if (run !== highlightRun) return; // a newer render superseded us
    const pre = wrap.querySelector("pre.raw-code");
    if (!pre) continue;
    const codeEl = pre.querySelector("code");
    const raw = codeEl ? codeEl.textContent : pre.textContent;
    const html = await shikiHtml(raw, wrap.getAttribute("data-lang"));
    if (run !== highlightRun) return;
    if (html) pre.outerHTML = html;
  }
}

// ── render a fetched doc ───────────────────────────────────
let lastDoc = null;
function renderDoc(doc) {
  document.title = doc.name + " · md";
  const kicker = doc.kind === "tex" ? "LaTeX · " + doc.path : doc.path;
  const body = marked.parse(doc.markdown);
  main.innerHTML = '<article class="article"><div class="doc-head"><div class="doc-kicker">'+esc(kicker)+'</div></div>'+body+'</article>';
  if (window.renderMathInElement) {
    renderMathInElement(main, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\\\[", right: "\\\\]", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\\\(", right: "\\\\)", display: false },
      ],
      throwOnError: false,
    });
  }
  const nodes = main.querySelectorAll(".mermaid");
  if (nodes.length && window.mermaid) {
    const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default";
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: "loose" });
    mermaid.run({ nodes }).catch(() => {});
  }
  bindCopyButtons();
  buildToc();
  updateSpy();
  highlightCode(); // async, upgrades placeholders in place
}

// ── open a file ────────────────────────────────────────────
// nav: "push" (new history entry, default), "replace" (in place), "none" (from popstate)
async function openFile(rel, nav) {
  if (!rel) return;
  currentFile = rel;
  renderCrumbs(rel);
  markActive();
  pushRecent(rel);
  if (window.innerWidth <= 760) layout.classList.add("no-sidebar");
  const url = relToUrl(rel);
  if (nav === "replace") history.replaceState({ rel }, "", url);
  else if (nav !== "none") history.pushState({ rel }, "", url);
  main.innerHTML = '<div class="empty">loading…</div>';
  try {
    const doc = await api("/api/file?path=" + encodeURIComponent(rel));
    lastDoc = doc;
    renderDoc(doc);
    window.scrollTo(0, 0);
  } catch (err) {
    lastDoc = null;
    main.innerHTML = '<div class="empty">Failed to load <code>'+esc(rel)+'</code><br><br>'+esc(String(err.message || err))+'</div>';
    layout.classList.add("no-toc");
  }
}
function markActive() {
  $("tree").querySelectorAll(".file-item").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-path") === currentFile);
  });
}

// ── home / landing ─────────────────────────────────────────
function showHome(nav) {
  currentFile = null;
  lastDoc = null;
  document.title = (DATA.root || "md") + " · md";
  if (nav === "replace") history.replaceState({ rel: "" }, "", "/");
  else if (nav !== "none") history.pushState({ rel: "" }, "", "/");
  renderCrumbs("");
  markActive();
  layout.classList.add("no-toc");
  window.scrollTo(0, 0);
  $("progress").style.width = "0%";
  const recent = getRecent().filter((p) => allFiles.some((f) => f.path === p));
  const card = (f) => '<div class="card" data-path="'+esc(f.path)+'"><div class="c-name">'+esc(f.name)+'</div><div class="c-path">'+esc(f.path)+'</div></div>';
  let html = '<div class="home"><h1>'+esc(DATA.root || "Documents")+'</h1>'+
    '<p class="sub">'+allFiles.length+' document'+(allFiles.length === 1 ? "" : "s")+' · press <kbd>'+(isMac ? "⌘K" : "Ctrl K")+'</kbd> to search</p>';
  if (recent.length) {
    html += '<div class="sec-t">Recent</div><div class="card-grid">'+recent.map((p) => card(allFiles.find((f) => f.path === p))).join("")+'</div>';
  }
  html += '<div class="sec-t">All files</div>';
  if (allFiles.length) html += '<div class="card-grid">'+allFiles.map(card).join("")+'</div>';
  else html += '<div class="tree-empty">No markdown or tex files under this folder.</div>';
  html += '</div>';
  main.innerHTML = html;
  main.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("click", () => openFile(el.getAttribute("data-path")));
  });
}

// ── command palette ────────────────────────────────────────
const overlay = $("palette-overlay");
const pInput = $("palette-input");
const pList = $("palette-list");
let pItems = [];
let pSel = 0;
let searchTimer = 0;

function openPalette() {
  overlay.classList.add("open");
  pInput.value = "";
  pInput.focus();
  renderPalette([]);
}
function closePalette() { overlay.classList.remove("open"); }
$("search-btn").onclick = openPalette;
overlay.addEventListener("click", (e) => { if (e.target === overlay) closePalette(); });

function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  let qi = 0, score = 0, run = 0, start = -1;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) {
      if (start < 0) start = si;
      run++;
      const boundary = si === 0 || /[/_\\-. ]/.test(s[si - 1]);
      score += 1 + run + (boundary ? 5 : 0);
      qi++;
    } else run = 0;
  }
  if (qi < q.length) return -1;
  return score - start * 0.15;
}
function highlightMatch(name, q) {
  if (!q) return esc(name);
  const lc = name.toLowerCase(), lq = q.toLowerCase();
  let out = "", qi = 0;
  for (let i = 0; i < name.length; i++) {
    if (qi < lq.length && lc[i] === lq[qi]) { out += "<b>" + esc(name[i]) + "</b>"; qi++; }
    else out += esc(name[i]);
  }
  return out;
}
function fileIco() {
  return '<span class="p-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg></span>';
}

function renderPalette(items) {
  pItems = items;
  pSel = 0;
  if (!items.length) {
    const q = pInput.value.trim();
    pList.innerHTML = '<div class="p-empty">'+(q ? "No results for &ldquo;"+esc(q)+"&rdquo;" : "Start typing to search…")+'</div>';
    return;
  }
  let html = "";
  let lastSec = "";
  items.forEach((it, i) => {
    if (it.section !== lastSec) { html += '<div class="p-sec">'+esc(it.section)+'</div>'; lastSec = it.section; }
    html += '<div class="p-item '+(it.kind === "tex" ? "tex " : "")+(i === 0 ? "sel" : "")+'" data-i="'+i+'">'+fileIco()+
      '<div class="p-main"><div class="p-name">'+it.nameHtml+'</div>'+
      (it.snippet ? '<div class="p-snip">'+it.snippet+'</div>' : '<div class="p-sub">'+esc(it.path)+'</div>')+
      '</div></div>';
  });
  pList.innerHTML = html;
  pList.querySelectorAll(".p-item").forEach((el) => {
    el.addEventListener("click", () => choose(parseInt(el.getAttribute("data-i"), 10)));
    el.addEventListener("mousemove", () => setSel(parseInt(el.getAttribute("data-i"), 10)));
  });
}
function setSel(i) {
  pSel = i;
  pList.querySelectorAll(".p-item").forEach((el, idx) => el.classList.toggle("sel", idx === i));
}
function choose(i) {
  const it = pItems[i];
  if (!it) return;
  closePalette();
  openFile(it.path);
}
function localFileResults(q) {
  if (!q) {
    const recent = getRecent().filter((p) => allFiles.some((f) => f.path === p));
    const list = recent.length ? recent.map((p) => allFiles.find((f) => f.path === p)) : allFiles.slice(0, 12);
    return list.map((f) => ({ section: recent.length ? "Recent" : "Files", path: f.path, kind: f.kind, nameHtml: esc(f.name), sub: f.path }));
  }
  const scored = [];
  for (const f of allFiles) {
    const s = Math.max(fuzzy(q, f.name), fuzzy(q, f.path) - 2);
    if (s > 0) scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 8).map(({ f }) => ({
    section: "Files", path: f.path, kind: f.kind, nameHtml: highlightMatch(f.name, q), sub: f.path,
  }));
}
function snippetHtml(snippet, q) {
  const lc = snippet.toLowerCase(), lq = q.toLowerCase();
  const idx = lc.indexOf(lq);
  if (idx < 0) return esc(snippet);
  return esc(snippet.slice(0, idx)) + "<mark>" + esc(snippet.slice(idx, idx + q.length)) + "</mark>" + esc(snippet.slice(idx + q.length));
}

pInput.addEventListener("input", () => {
  const q = pInput.value.trim();
  renderPalette(localFileResults(q));
  clearTimeout(searchTimer);
  if (q.length >= 2) {
    searchTimer = setTimeout(async () => {
      if (pInput.value.trim() !== q) return;
      try {
        const data = await api("/api/search?q=" + encodeURIComponent(q));
        if (pInput.value.trim() !== q) return;
        const content = data.results.map((r) => ({
          section: "In content", path: r.path, kind: fileKind(r.path),
          nameHtml: esc(r.name), snippet: snippetHtml(r.snippet, q),
        }));
        renderPalette(localFileResults(q).concat(content));
      } catch {}
    }, 160);
  }
});
pInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); if (pItems.length) { setSel((pSel + 1) % pItems.length); scrollSel(); } }
  else if (e.key === "ArrowUp") { e.preventDefault(); if (pItems.length) { setSel((pSel - 1 + pItems.length) % pItems.length); scrollSel(); } }
  else if (e.key === "Enter") { e.preventDefault(); choose(pSel); }
  else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
});
function scrollSel() {
  const el = pList.querySelectorAll(".p-item")[pSel];
  if (el) el.scrollIntoView({ block: "nearest" });
}

// ── global keyboard ────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (inField || overlay.classList.contains("open")) return;
  if (e.key === "/") { e.preventDefault(); openPalette(); }
  else if (e.key === "t") { $("btn-theme").click(); }
  else if (e.key === "\\\\") { toggleSidebar(); }
});

// ── real-URL routing (browser back/forward works) ──────────
function relToUrl(rel) {
  return "/" + rel.split("/").map(encodeURIComponent).join("/");
}
function pathToRel() {
  let p = location.pathname.replace(/^\\/+/, "");
  try { p = decodeURIComponent(p); } catch {}
  return p; // "" at the site root
}
window.addEventListener("popstate", (e) => {
  const rel = (e.state && typeof e.state.rel === "string") ? e.state.rel : pathToRel();
  if (rel) { if (rel !== currentFile) openFile(rel, "none"); }
  else showHome("none");
});

// ── boot ───────────────────────────────────────────────────
(async function boot() {
  $("root-name").textContent = DATA.root || ".";
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      theme: document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default",
      securityLevel: "loose",
    });
  }
  try {
    const data = await api("/api/all");
    allFiles = data.files || [];
  } catch { allFiles = []; }
  renderTree();
  const start = pathToRel() || DATA.boot || null;
  if (start) await openFile(start, "replace");
  else showHome("replace");
})();
</script>
</body>
</html>`;
}
