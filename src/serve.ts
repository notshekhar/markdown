/**
 * `markdown serve` — local HTTP preview with a polished reading UI.
 *
 * Bun.serve + one embedded SPA. Client renders markdown (marked + shiki +
 * KaTeX + mermaid). .tex converted server-side via existing texToMarkdown.
 *
 * Theme mirrors oboe.chat (shadcn zinc palette, Geist font, jade accent);
 * code highlighting uses shiki with dark-plus / github-light (oboe parity).
 *
 * UI: command palette (⌘K) with fuzzy file search + live content search +
 * recent files, a collapsible file tree with filter, clickable breadcrumbs,
 * an "on this page" table of contents with scroll-spy, reading-progress bar,
 * copy buttons on code, heading anchors, and serif/sans + light/dark toggles.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { docKind, findViewableFiles, isMarkdownPath, isViewablePath, listDirectory } from "./file-list.ts";
import { texToMarkdown } from "./tex.ts";
import { getVersion } from "./commands.ts";
import {
    configDir,
    DB_FILE_NAME,
    pushRecent,
    readState,
    type UiState,
    writePrefs,
    writeRootState,
} from "./state-db.ts";

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
    process.stdout.write(`  state: ${join(configDir(), DB_FILE_NAME)}\n`);
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
        return html(pageHtml(boot, basename(root) || root, root));
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

    // Save edits back to a markdown file on disk (from the in-browser editor).
    if (pathname === "/api/save" && req.method === "POST") {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return json({ error: "invalid json" }, 400);
        }
        const b = body as { path?: unknown; content?: unknown };
        if (typeof b.path !== "string" || typeof b.content !== "string") {
            return json({ error: "path and content required" }, 400);
        }
        const file = safeJoin(root, b.path);
        if (!file || !isMarkdownPath(file)) {
            return json({ error: "not an editable markdown file" }, 400);
        }
        try {
            const st = statSync(file);
            if (!st.isFile()) return json({ error: "not a file" }, 400);
            writeFileSync(file, b.content, "utf8");
            return json({ ok: true, path: relPath(root, file), bytes: Buffer.byteLength(b.content) });
        } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    }

    // Persisted UI state (theme, font, sidebar, open tabs, expanded folders,
    // recent files). Lives in ~/.markdown/state.db, not the browser.
    if (pathname === "/api/state") {
        if (req.method === "GET") return json(readState(root));
        if (req.method === "POST") {
            const b = (await readBody(req)) as {
                prefs?: unknown;
                root?: unknown;
                recent?: unknown;
            };
            if (!b) return json({ error: "body required" }, 400);
            try {
                if (b.prefs && typeof b.prefs === "object") writePrefs(b.prefs as Record<string, unknown>);
                if (b.root && typeof b.root === "object") writeRootState(root, b.root as Record<string, unknown>);
                // Oldest first — the last one pushed ends up newest.
                for (const p of Array.isArray(b.recent) ? b.recent : [b.recent]) {
                    if (typeof p === "string") pushRecent(root, p);
                }
                return json({ ok: true });
            } catch (e) {
                return json({ error: e instanceof Error ? e.message : String(e) }, 500);
            }
        }
    }

    // Create a new markdown file or folder (from the sidebar "new" actions).
    if (pathname === "/api/create" && req.method === "POST") {
        const b = (await readBody(req)) as { path?: unknown; dir?: unknown; content?: unknown };
        if (!b || typeof b.path !== "string") return json({ error: "path required" }, 400);
        const target = safeJoin(root, b.path);
        if (!target || target === root) return json({ error: "invalid path" }, 400);
        const asDir = b.dir === true;
        if (!asDir && !isMarkdownPath(target)) {
            return json({ error: "new files must be markdown (.md, .markdown, .mdx)" }, 400);
        }
        if (existsSync(target)) return json({ error: "already exists" }, 409);
        try {
            if (asDir) {
                mkdirSync(target, { recursive: true });
            } else {
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, typeof b.content === "string" ? b.content : "", "utf8");
            }
            return json({ ok: true, path: relPath(root, target), dir: asDir });
        } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    }

    // Rename or move a file / folder (sidebar rename + drag-to-move).
    if (pathname === "/api/rename" && req.method === "POST") {
        const b = (await readBody(req)) as { from?: unknown; to?: unknown };
        if (!b || typeof b.from !== "string" || typeof b.to !== "string") {
            return json({ error: "from and to required" }, 400);
        }
        const from = safeJoin(root, b.from);
        const to = safeJoin(root, b.to);
        if (!from || !to || from === root || to === root) return json({ error: "invalid path" }, 400);
        if (!existsSync(from)) return json({ error: "source not found" }, 404);
        if (existsSync(to)) return json({ error: "target already exists" }, 409);
        let fromDir: boolean;
        try {
            fromDir = statSync(from).isDirectory();
        } catch {
            return json({ error: "source not found" }, 404);
        }
        if (!fromDir && !isViewablePath(to)) {
            return json({ error: "target must keep a markdown/tex extension" }, 400);
        }
        try {
            mkdirSync(dirname(to), { recursive: true });
            renameSync(from, to);
            return json({ ok: true, from: relPath(root, from), to: relPath(root, to), dir: fromDir });
        } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    }

    // Delete a file or folder (folders go recursively).
    if (pathname === "/api/delete" && req.method === "POST") {
        const b = (await readBody(req)) as { path?: unknown };
        if (!b || typeof b.path !== "string") return json({ error: "path required" }, 400);
        const target = safeJoin(root, b.path);
        if (!target || target === root) return json({ error: "invalid path" }, 400);
        if (!existsSync(target)) return json({ error: "not found" }, 404);
        try {
            const dir = statSync(target).isDirectory();
            rmSync(target, { recursive: dir, force: false });
            return json({ ok: true, path: relPath(root, target), dir });
        } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 500);
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
        return html(pageHtml(boot, basename(root) || root, root));
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

async function readBody(req: Request): Promise<unknown> {
    try {
        return await req.json();
    } catch {
        return null;
    }
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

function pageHtml(bootPath: string, rootName: string, rootKey: string): string {
    // State is inlined rather than fetched so the first paint already carries
    // the stored theme/font — a round trip here would flash the wrong one.
    let state: UiState = { prefs: {}, root: {}, recent: [] };
    try {
        state = readState(rootKey);
    } catch (e) {
        process.stderr.write(`md: state db unavailable (${e instanceof Error ? e.message : String(e)})\n`);
    }
    const data = JSON.stringify({ boot: bootPath, root: rootName, key: rootKey, state });
    const theme = state.prefs.theme === "light" || state.prefs.theme === "dark" ? state.prefs.theme : "dark";
    const font = state.prefs.font === "serif" ? "serif" : "sans";
    return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}" data-font="${font}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>md serve</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400..600&display=swap" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css" />
<style>
/* oboe.chat-matched zinc palette (shadcn zinc base) + jade accent */
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
  --accent: oklch(0.78 0.13 168);
  --accent-strong: oklch(0.85 0.12 168);
  --accent-soft: oklch(0.78 0.13 168 / 15%);
  --heading: oklch(0.985 0 0);
  --code-bg: oklch(0.163 0.004 285.9);
  --code-head-bg: oklch(0.2 0.005 285.9);
  --code-border: oklch(1 0 0 / 8%);
  --quote-border: oklch(0.78 0.13 168);
  --link: oklch(0.80 0.12 168);
  --mark: oklch(0.78 0.13 168 / 24%);
  --shadow-lg: 0 24px 60px -12px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.05);
  --glow: radial-gradient(1200px 520px at 80% -10%, oklch(0.78 0.13 168 / 8%), transparent 60%);
  --sel: oklch(0.78 0.13 168 / 24%);
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
  --accent: oklch(0.52 0.11 168);
  --accent-strong: oklch(0.45 0.10 168);
  --accent-soft: oklch(0.52 0.11 168 / 9%);
  --heading: oklch(0.145 0.005 285.8);
  --code-bg: oklch(0.985 0.001 286.4);
  --code-head-bg: oklch(0.967 0.001 286.4);
  --code-border: oklch(0.92 0.004 286.3);
  --quote-border: oklch(0.52 0.11 168);
  --link: oklch(0.52 0.11 168);
  --mark: oklch(0.52 0.11 168 / 15%);
  --shadow-lg: 0 24px 60px -12px rgba(15,23,42,.18), 0 0 0 1px rgba(15,23,42,.05);
  --glow: radial-gradient(1200px 520px at 80% -10%, oklch(0.52 0.11 168 / 6%), transparent 60%);
  --sel: oklch(0.52 0.11 168 / 14%);
  color-scheme: light;
}
* { box-sizing: border-box; }
::selection { background: var(--sel); }
:root {
  --side-w: 288px;
  --toc-w: 240px;
  --bar-h: 52px;
  --tabs-h: 0px; /* becomes non-zero when buffers are open (html.has-tabs) */
}
:root.has-tabs { --tabs-h: 42px; }
html { scroll-padding-top: calc(var(--bar-h) + var(--tabs-h) + 16px); }
html, body { margin: 0; }
body {
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
  border-radius: 0;
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
  border-radius: 0;
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
  border-radius: 0;
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
  border-radius: 0;
  cursor: pointer;
  font-size: .82rem;
  font-weight: 600;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--fg); }
.icon-btn.active { color: var(--accent); background: var(--accent-soft); }

/* ── tab strip (multi-buffer) — lives inside the content column ──── */
.tabs {
  position: sticky;
  top: var(--bar-h);
  z-index: 20;
  display: none;
  align-items: stretch;
  gap: 2px;
  height: var(--tabs-h);
  padding: 0 .4rem;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: saturate(140%) blur(14px);
  border-bottom: 1px solid var(--border-soft);
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }
:root.has-tabs .tabs { display: flex; }
.tab {
  display: flex;
  align-items: center;
  gap: .45rem;
  padding: 0 .35rem 0 .7rem;
  margin: 5px 0;
  max-width: 220px;
  border: 1px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--fg-muted);
  font-size: .8rem;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  flex-shrink: 0;
}
.tab:hover { background: var(--bg-hover); color: var(--fg); }
.tab.active { background: var(--bg-elev); color: var(--fg); border-color: var(--border); box-shadow: var(--shadow-lg); }
.tab.dragging { opacity: .45; }
.tab.drop-before { box-shadow: inset 3px 0 0 var(--accent); }
.tab.drop-after { box-shadow: inset -3px 0 0 var(--accent); }
.tab .t-dot { width: 6px; height: 6px; border-radius: 0; background: var(--fg-faint); flex-shrink: 0; opacity: .5; }
.tab.tex .t-dot { background: #d9a441; opacity: .9; }
.tab.dirty .t-dot { background: var(--accent); opacity: 1; }
.tab .t-name { overflow: hidden; text-overflow: ellipsis; }
.tab .t-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px;
  border: none; background: transparent; color: var(--fg-faint);
  border-radius: 0; cursor: pointer; font-size: 1rem; line-height: 1;
  flex-shrink: 0;
}
.tab .t-close:hover { background: var(--bg-hover); color: var(--fg); }
.tab.dirty .t-close .x { display: none; }
.tab .t-close .d { display: none; }
.tab.dirty .t-close .d { display: inline; }
.tab .t-close:hover .x { display: inline; }
.tab .t-close:hover .d { display: none; }
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
/* sticky header: title + actions + filter, pinned above the scrolling tree */
.side-top {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-soft);
}
.side-head {
  display: flex;
  align-items: center;
  gap: .5rem;
  padding: .6rem .45rem .1rem .85rem;
}
.side-title {
  flex: 1;
  font-size: .68rem;
  text-transform: uppercase;
  letter-spacing: .09em;
  color: var(--fg-faint);
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-acts { display: flex; gap: .05rem; flex-shrink: 0; }
.mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-muted);
  border-radius: 0;
  cursor: pointer;
}
.mini-btn:hover { background: var(--bg-hover); color: var(--fg); }
.side-search {
  padding: .5rem .75rem .6rem;
}
.side-search input {
  width: 100%;
  height: 32px;
  padding: 0 .6rem;
  border: 1px solid var(--border);
  border-radius: 0;
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
  border-radius: 0;
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
  border-radius: 0;
  cursor: pointer;
  font-size: .84rem;
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-item .dot { width: 5px; height: 5px; border-radius: 0; background: var(--fg-faint); flex-shrink: 0; opacity: .6; }
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
  position: relative;
  max-width: 760px;
  margin: 0 auto;
  padding: 3rem 2.5rem 6rem;
}
[data-font="serif"] .article {
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, ui-serif, serif;
  font-size: 1.06rem;
}
.doc-head { position: relative; margin-bottom: 1.6rem; min-height: 1.2rem; }
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
  border-radius: 0;
  background: var(--bg-elev);
  cursor: pointer;
  transition: border-color .15s, transform .12s, box-shadow .15s;
}
.card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: var(--shadow-lg); }
.card .c-name { font-weight: 600; color: var(--fg); font-size: .92rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .c-path { font-size: .74rem; color: var(--fg-faint); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--fg-muted); text-align: center; padding: 5rem 1rem; font-size: .95rem; }

/* ── document toolbar (edit toggle) ──────────────────────── */
.doc-actions { position: absolute; top: 0; right: 0; display: flex; gap: .4rem; }
.doc-btn {
  display: inline-flex; align-items: center; gap: .35rem;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--fg-muted);
  border-radius: 0;
  padding: .3rem .65rem;
  font-size: .76rem;
  cursor: pointer;
  transition: color .12s, border-color .12s, background .12s;
}
.doc-btn:hover { color: var(--accent); border-color: var(--accent); }
.doc-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.doc-btn.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); color: #fff; }
.doc-btn.primary:disabled { opacity: .45; cursor: default; }
.doc-btn svg { flex-shrink: 0; }

/* ── split editor ────────────────────────────────────────── */
.editor {
  display: grid;
  grid-template-columns: 1fr 1fr;
  height: calc(100vh - var(--bar-h) - var(--tabs-h));
  min-height: 0;
}
.editor.solo { grid-template-columns: 1fr; }
.ed-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ed-pane.preview-pane { border-left: 1px solid var(--border); }
.editor.solo .preview-pane { display: none; }
.ed-head {
  display: flex; align-items: center; gap: .5rem;
  padding: .4rem .5rem .4rem .9rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  font-size: .72rem;
  color: var(--fg-faint);
  text-transform: uppercase;
  letter-spacing: .08em;
  font-family: var(--font-mono);
  min-height: 38px;
}
.ed-head .spacer { flex: 1; }
.ed-status { text-transform: none; letter-spacing: 0; color: var(--fg-faint); font-size: .72rem; }
.ed-status.ok { color: #22c55e; }
.ed-status.err { color: var(--destructive, #f87171); }
textarea.ed-input {
  flex: 1;
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: .84rem;
  line-height: 1.65;
  padding: 1.1rem 1.25rem 3rem;
  tab-size: 2;
  overflow: auto;
}
.ed-pane.preview-pane .preview-scroll { flex: 1; overflow: auto; min-height: 0; }
.ed-pane.preview-pane .article { padding: 1.6rem 1.75rem 4rem; }
@media (max-width: 900px) {
  .editor { grid-template-columns: 1fr; }
  .editor .preview-pane { display: none; }
}

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
  scroll-margin-top: calc(var(--bar-h) + var(--tabs-h) + 24px);
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
.article mark { background: var(--mark); color: inherit; border-radius: 0; padding: 0 .15em; }
.article code {
  font-family: var(--font-mono);
  font-size: .85em;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 0;
  padding: .12em .4em;
}
/* code blocks — oboe.chat style: flat card, header row, shiki body */
.code-wrap {
  margin: 1.4em 0;
  border: 1px solid var(--code-border);
  border-radius: 0;
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
  border-radius: 0;
  padding: .22rem .55rem;
  font-size: .72rem;
  cursor: pointer;
  font-family: var(--font-mono);
  transition: background .12s, color .12s;
}
.copy-btn:hover { color: var(--fg); background: var(--bg-hover); }
.copy-btn.done { color: #22c55e; }
.code-tools { display: flex; align-items: center; gap: .12rem; }
.code-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-muted);
  border-radius: 0;
  cursor: pointer;
  transition: background .12s, color .12s;
}
.code-btn:hover { color: var(--fg); background: var(--bg-hover); }
.table-wrap {
  margin: 1.4em 0;
  border: 1px solid var(--code-border);
  border-radius: 0;
  overflow: hidden;
  background: var(--code-bg);
}
.table-scroll { overflow: auto; max-height: 70vh; }
/* ── json tree viewer ────────────────────────────────────── */
.json-tree {
  padding: 1rem 1.15rem;
  font-family: var(--font-mono);
  font-size: .84rem;
  line-height: 1.65;
  overflow: auto;
  max-height: 70vh;
}
.json-node > summary {
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.json-node > summary::-webkit-details-marker { display: none; }
.json-node > summary::before {
  content: "";
  display: inline-block;
  width: 0; height: 0;
  margin-right: .35rem;
  border-left: 5px solid var(--fg-faint);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform .12s;
}
.json-node[open] > summary::before { transform: rotate(90deg); }
.json-node:not([open]) > summary .json-kids { display: none; }
.json-count {
  margin: 0 .3rem;
  padding: 0 .35rem;
  font-size: .68rem;
  color: var(--fg-faint);
  background: var(--bg-hover);
}
.json-node[open] > summary .json-count { display: none; }
.json-brk { color: var(--fg-faint); }
.json-kids { margin-left: .55rem; padding-left: .85rem; border-left: 1px solid var(--border-soft); }
.json-key { color: var(--accent); margin-right: .45rem; }
.json-key::after { content: ":"; color: var(--fg-faint); }
.json-string { color: #16a34a; }
.json-number { color: #2563eb; }
.json-boolean { color: #d97706; }
.json-null { color: #dc2626; font-style: italic; }
.json-empty { color: var(--fg-faint); }
html[data-theme="dark"] .json-string { color: #4ade80; }
html[data-theme="dark"] .json-number { color: #60a5fa; }
html[data-theme="dark"] .json-boolean { color: #fbbf24; }
html[data-theme="dark"] .json-null { color: #f87171; }
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
.article .shiki, .full-overlay .shiki { background: transparent !important; }
html[data-theme="dark"] .article .shiki,
html[data-theme="dark"] .article .shiki span,
html[data-theme="dark"] .full-overlay .shiki,
html[data-theme="dark"] .full-overlay .shiki span { color: var(--shiki-dark) !important; }
.article blockquote {
  margin: 1.3em 0;
  padding: .3em 0 .3em 1.15em;
  border-left: 3px solid var(--quote-border);
  color: var(--fg-muted);
  font-style: italic;
}
.article blockquote p:last-child { margin-bottom: 0; }
/* keep code/math upright inside an italic quote */
.article blockquote code, .article blockquote .katex { font-style: normal; }
.article ul, .article ol { padding-left: 1.4em; }
.article li { margin: .3em 0; }
.table-wrap table {
  border-collapse: collapse;
  width: 100%;
  font-size: .92rem;
}
.table-wrap th, .table-wrap td {
  border: 1px solid var(--border);
  padding: .5em .75em;
  text-align: left;
}
.table-wrap th { background: var(--bg-elev); font-weight: 650; color: var(--fg); }
.table-wrap tr:nth-child(2n) td { background: var(--bg-hover); }
.article hr { border: none; border-top: 1px solid var(--border); margin: 2.5em 0; }
.article img { max-width: 100%; height: auto; border-radius: 0; border: 1px solid var(--border-soft); }
.article .katex-display { overflow-x: auto; overflow-y: hidden; padding: .5em 0; }
/* ── mermaid: a pannable / zoomable diagram card ─────────── */
.mmd-card {
  margin: 1.4em 0;
  border: 1px solid var(--code-border);
  border-radius: 0;
  background: var(--code-bg);
  overflow: hidden;
}
.mmd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .5rem;
  padding: .35rem .5rem .35rem .95rem;
  background: var(--code-head-bg);
  border-bottom: 1px solid var(--code-border);
}
.mmd-lang {
  font-family: var(--font-mono);
  font-size: .68rem;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--fg-faint);
  font-weight: 600;
}
.mmd-tools { display: flex; align-items: center; gap: .12rem; }
.mmd-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-muted);
  border-radius: 0;
  cursor: pointer;
  transition: background .12s, color .12s;
}
.mmd-btn:hover { color: var(--fg); background: var(--bg-hover); }
.mmd-btn:active { color: var(--accent); }
.mmd-btn.done { color: #22c55e; }
.mmd-zoom {
  min-width: 3.6em;
  padding: .2rem .2rem;
  border: 1px solid transparent;
  background: transparent;
  font-family: var(--font-mono);
  font-size: .68rem;
  color: var(--fg-faint);
  text-align: center;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.mmd-zoom:hover { color: var(--fg); background: var(--bg-hover); }
.mmd-view {
  position: relative;
  overflow: hidden;
  height: 320px;
  touch-action: none;
  cursor: grab;
  background-image: radial-gradient(circle at 1px 1px, var(--border) 1px, transparent 0);
  background-size: 20px 20px;
}
.mmd-view.dragging { cursor: grabbing; }
.mmd-view:focus { outline: none; }
.mmd-view:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.mmd-stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  /* ponytail: no will-change — it snapshots the SVG as a bitmap and zoom goes blurry */
}
.mmd-stage svg { display: block; max-width: none !important; shape-rendering: geometricPrecision; }
.mmd-hint {
  position: absolute;
  left: .55rem;
  bottom: .5rem;
  padding: .18rem .45rem;
  font-family: var(--font-mono);
  font-size: .66rem;
  color: var(--fg-faint);
  background: color-mix(in srgb, var(--bg-elev) 85%, transparent);
  border: 1px solid var(--border-soft);
  pointer-events: none;
  opacity: 0;
  transition: opacity .16s;
}
.mmd-card:hover .mmd-hint, .mmd-view:focus-visible ~ .mmd-hint { opacity: 1; }
/* mermaid failed to parse → fall back to the source */
.mmd-card.failed .mmd-view { height: auto; cursor: default; background-image: none; }
.mmd-card.failed .mmd-stage { position: static; }
.mmd-card.failed .mmd-hint { display: none; }
.mmd-card.failed pre { margin: 0; padding: 1rem; font-family: var(--font-mono); font-size: .8rem; color: var(--fg-muted); white-space: pre-wrap; }

.mmd-full-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: none;
  padding: clamp(.75rem, 3vh, 2.2rem);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(4px);
}
.mmd-full-overlay.open { display: flex; }
.mmd-full-overlay .mmd-card {
  margin: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg-elev);
  box-shadow: var(--shadow-lg);
}
.mmd-full-overlay .mmd-view { flex: 1; }

/* code blocks & tables can also fill the screen */
.full-overlay .code-wrap, .full-overlay .table-wrap {
  margin: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg-elev);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.full-overlay .code-wrap pre, .full-overlay .table-wrap .table-scroll, .full-overlay .code-wrap .json-tree {
  flex: 1;
  overflow: auto;
  max-height: none;
}
.full-overlay .code-wrap pre { margin: 0; padding: 1rem 1.15rem; }

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
  border-radius: 0;
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
.palette-in .hint { font-size: .68rem; color: var(--fg-faint); font-family: var(--font-mono); border: 1px solid var(--border); border-radius: 0; padding: .1rem .35rem; }
.palette-list { overflow: auto; padding: .4rem; }
.p-sec { font-size: .66rem; text-transform: uppercase; letter-spacing: .09em; color: var(--fg-faint); font-weight: 700; padding: .6rem .7rem .3rem; }
.p-item {
  display: flex;
  align-items: center;
  gap: .6rem;
  padding: .5rem .7rem;
  border-radius: 0;
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
.p-item .p-snip mark { background: var(--mark); color: var(--fg); border-radius: 0; }
.p-item.sel { background: var(--accent-soft); }
.p-item.sel .p-sub { color: var(--accent); }
.p-empty { color: var(--fg-faint); padding: 1.4rem; text-align: center; font-size: .86rem; }
.palette-foot { display: flex; gap: 1rem; padding: .5rem .9rem; border-top: 1px solid var(--border); font-size: .7rem; color: var(--fg-faint); }
.palette-foot kbd { font-family: var(--font-mono); border: 1px solid var(--border); border-radius: 0; padding: 0 .28rem; }

/* ── sidebar drag-to-move affordances ────────────────────── */
.file-item.dragging { opacity: .45; }
details.dir > summary.drop-into {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
  color: var(--fg);
}
.tree.drop-root { outline: 2px dashed var(--accent); outline-offset: -5px; border-radius: 0; }

/* ── right-click context menu ────────────────────────────── */
.ctx-menu {
  position: fixed;
  z-index: 200;
  min-width: 190px;
  padding: .3rem;
  display: none;
  flex-direction: column;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0;
  box-shadow: var(--shadow-lg);
}
.ctx-menu.open { display: flex; }
.ctx-item {
  display: flex;
  align-items: center;
  gap: .6rem;
  padding: .42rem .55rem;
  border: none;
  background: transparent;
  color: var(--fg);
  border-radius: 0;
  cursor: pointer;
  font-size: .82rem;
  font-family: inherit;
  text-align: left;
}
.ctx-item:hover { background: var(--bg-hover); }
.ctx-item svg { flex-shrink: 0; opacity: .75; }
.ctx-item .ctx-ico { width: 14px; flex-shrink: 0; }
.ctx-item.danger { color: #f0616d; }
.ctx-item.danger:hover { background: color-mix(in srgb, #f0616d 15%, transparent); }
.ctx-item.disabled { opacity: .38; cursor: default; }
.ctx-item.disabled:hover { background: transparent; }
.ctx-item .k { margin-left: auto; font-family: var(--font-mono); font-size: .68rem; color: var(--fg-faint); }

/* reveal-in-sidebar flash */
@keyframes md-flash {
  0%, 100% { background: transparent; }
  25%, 60% { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
}
.file-item.flash { animation: md-flash 1.05s ease; }
.ctx-sep { height: 1px; background: var(--border-soft); margin: .28rem .35rem; }

/* ── input modal (new file / rename) ─────────────────────── */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: none;
  align-items: flex-start;
  justify-content: center;
  padding-top: 17vh;
  background: rgba(3,4,8,.5);
  backdrop-filter: blur(3px);
}
.modal-overlay.open { display: flex; }
.modal {
  width: min(460px, 92vw);
  padding: 1.1rem 1.15rem 1rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0;
  box-shadow: var(--shadow-lg);
}
.modal-title { font-weight: 650; font-size: 1rem; color: var(--fg); }
.modal-label { display: block; font-size: .74rem; color: var(--fg-faint); margin: .55rem 0 .3rem; }
.modal-input {
  width: 100%;
  height: 38px;
  padding: 0 .7rem;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--bg);
  color: var(--fg);
  font-size: .88rem;
  font-family: var(--font-mono);
  outline: none;
}
.modal-input:focus { border-color: var(--accent); }
.modal-err { color: #f0616d; font-size: .75rem; min-height: 1.05rem; margin-top: .4rem; }
.modal-foot { display: flex; justify-content: flex-end; gap: .5rem; margin-top: .2rem; }
.modal-btn {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--fg-muted);
  border-radius: 0;
  padding: .42rem .95rem;
  font-size: .82rem;
  cursor: pointer;
  font-family: inherit;
}
.modal-btn:hover { color: var(--fg); border-color: var(--accent); }
.modal-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.modal-btn.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); color: #fff; }

/* ── toast ───────────────────────────────────────────────── */
.toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%) translateY(12px);
  max-width: 82vw;
  padding: .55rem .95rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--fg);
  border-radius: 0;
  box-shadow: var(--shadow-lg);
  font-size: .82rem;
  z-index: 220;
  opacity: 0;
  pointer-events: none;
  transition: opacity .16s, transform .16s;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.ok { border-color: color-mix(in srgb, #22c55e 55%, var(--border)); }
.toast.err { border-color: color-mix(in srgb, #f0616d 60%, var(--border)); }

/* ── keyboard shortcuts help ─────────────────────────────── */
.help-overlay {
  position: fixed;
  inset: 0;
  z-index: 205;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(3,4,8,.55);
  backdrop-filter: blur(3px);
}
.help-overlay.open { display: flex; }
.help {
  width: min(560px, 94vw);
  max-height: 82vh;
  overflow: auto;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0;
  box-shadow: var(--shadow-lg);
}
.help-head {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.1rem;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  font-weight: 650;
}
.help-body { padding: .4rem 1.1rem 1.2rem; }
.help-sec {
  font-size: .66rem;
  text-transform: uppercase;
  letter-spacing: .09em;
  color: var(--fg-faint);
  font-weight: 700;
  margin: 1.1rem 0 .3rem;
}
.help-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: .4rem 0;
  border-bottom: 1px solid var(--border-soft);
}
.help-row:last-child { border-bottom: none; }
.help-row .desc { color: var(--fg-muted); font-size: .86rem; }
.help-keys { display: flex; gap: .3rem; flex-shrink: 0; }
.help-keys kbd, .keycap {
  font-family: var(--font-mono);
  font-size: .72rem;
  color: var(--fg);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 0;
  padding: .12rem .42rem;
  background: var(--bg);
  min-width: 1.5rem;
  text-align: center;
}

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
    <button class="icon-btn" id="btn-help" title="Keyboard shortcuts (?)">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h.01M17 13h.01M9 13h6"/></svg>
    </button>
    <button class="icon-btn" id="btn-font" title="Toggle serif / sans">Aa</button>
    <button class="icon-btn" id="btn-theme" title="Toggle theme">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    </button>
    <button class="icon-btn active" id="btn-sidebar" title="Toggle files (⌘B)">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
    </button>
  </div>
</div>

<div class="layout" id="layout">
  <aside class="sidebar" id="sidebar">
    <div class="side-top">
      <div class="side-head">
        <span class="side-title" id="side-title">Files</span>
        <div class="side-acts">
          <button class="mini-btn" id="act-newfile" title="New file">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/><path d="M14 3v5h5"/><path d="M18 14v6M15 17h6"/></svg>
          </button>
          <button class="mini-btn" id="act-newfolder" title="New folder">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H16a2 2 0 0 1 2 2v2"/><path d="M3 7v11a2 2 0 0 0 2 2h6"/><path d="M18 14v6M15 17h6"/></svg>
          </button>
          <button class="mini-btn" id="act-collapse" title="Collapse folders">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 14l-6-6-6 6"/><path d="M18 20l-6-6-6 6"/></svg>
          </button>
          <button class="mini-btn" id="act-refresh" title="Refresh">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
          </button>
        </div>
      </div>
      <div class="side-search">
        <input id="tree-filter" type="text" placeholder="Filter files…" spellcheck="false" autocomplete="off" />
      </div>
    </div>
    <div class="tree" id="tree"></div>
  </aside>
  <main class="main" id="main">
    <div class="tabs" id="tabs"></div>
    <div id="main-content"><div class="empty">loading…</div></div>
  </main>
  <aside class="toc" id="toc"></aside>
</div>

<div class="mmd-full-overlay full-overlay" id="full-overlay"></div>
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

<div class="ctx-menu" id="ctx-menu" role="menu"></div>

<div class="modal-overlay" id="modal-overlay"></div>

<div class="mmd-full-overlay" id="mmd-full"></div>

<div class="toast" id="toast"></div>

<div class="help-overlay" id="help-overlay">
  <div class="help" role="dialog" aria-modal="true">
    <div class="help-head"><span>Keyboard shortcuts</span><button class="icon-btn" id="help-close" title="Close (esc)">esc</button></div>
    <div class="help-body" id="help-body"></div>
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
const content = $("main-content"); // rendered doc/editor lives here; tabs are a sibling
const layout = $("layout");
const tocEl = $("toc");
const crumbsEl = $("crumbs");
const ROOT_KEY = DATA.key || DATA.root || ".";
// Absolute path of the served root (DATA.key is the resolved root on disk).
const ROOT_ABS = DATA.key || "";
// NB: this script ships inside a TS template literal — no backslash literals here.
const BSLASH = String.fromCharCode(92);
const PATH_SEP = ROOT_ABS.includes(BSLASH) && !ROOT_ABS.includes("/") ? BSLASH : "/";
// Relative (URL-ish) path → absolute on-disk path, for "Copy path".
function absPath(rel) {
  if (!ROOT_ABS) return rel;
  if (!rel) return ROOT_ABS;
  let base = ROOT_ABS;
  while (base.length > 1 && (base.endsWith("/") || base.endsWith(BSLASH))) base = base.slice(0, -1);
  const r = PATH_SEP === BSLASH ? String(rel).split("/").join(BSLASH) : String(rel);
  return base + PATH_SEP + r;
}

// ── persisted state (server-side, ~/.markdown/state.db) ────
// Inlined by the server at render time, so boot needs no round trip. Writes
// are merged and flushed on a short debounce; a failed flush only costs
// persistence, never the interaction.
const STATE = DATA.state || { prefs: {}, root: {}, recent: [] };
STATE.prefs = STATE.prefs || {};
STATE.root = STATE.root || {};
STATE.recent = STATE.recent || [];
let statePatch = null;
let stateTimer = 0;
function flushState(beacon) {
  stateTimer = 0;
  const body = statePatch;
  statePatch = null;
  if (!body) return;
  const payload = JSON.stringify(body);
  // On unload a fetch gets cancelled with the page; sendBeacon survives it.
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/state", new Blob([payload], { type: "application/json" }));
    return;
  }
  fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload })
    .catch(() => {});
}
function queueState(patch) {
  statePatch = statePatch || {};
  if (patch.prefs) statePatch.prefs = Object.assign(statePatch.prefs || {}, patch.prefs);
  if (patch.root) statePatch.root = Object.assign(statePatch.root || {}, patch.root);
  if (patch.recent) statePatch.recent = (statePatch.recent || []).concat(patch.recent);
  if (!stateTimer) stateTimer = setTimeout(flushState, 150);
}
function savePref(key, value) {
  STATE.prefs[key] = String(value);
  queueState({ prefs: { [key]: String(value) } });
}
function saveRootState(key, value) {
  STATE.root[key] = value;
  queueState({ root: { [key]: value } });
}
// A tab closed mid-debounce would otherwise drop the last write.
addEventListener("pagehide", () => { if (stateTimer) { clearTimeout(stateTimer); flushState(true); } });

// One-time lift of the pre-db localStorage state, so an existing browser keeps
// its theme, open tabs and expanded folders. Runs before anything reads STATE.
// Self-limiting: the legacy keys are dropped once read, and only values the db
// doesn't have yet are taken, so the db always wins on a second visit.
function migrateLegacyState() {
  const prefs = {};
  const rootPatch = {};
  let recents = [];
  try {
    const parse = (k) => { try { const raw = localStorage.getItem(k); return raw == null ? undefined : JSON.parse(raw); } catch { return undefined; } };
    for (const [from, to] of [["md-theme", "theme"], ["md-font", "font"], ["md-sidebar", "sidebar"]]) {
      const v = localStorage.getItem(from);
      if (v != null && STATE.prefs[to] === undefined) { prefs[to] = v; STATE.prefs[to] = v; }
    }
    const expanded = parse("md-expanded:" + ROOT_KEY);
    if (Array.isArray(expanded) && STATE.root.expanded === undefined) { rootPatch.expanded = expanded; STATE.root.expanded = expanded; }
    const empties = parse("md-emptydirs:" + ROOT_KEY);
    if (Array.isArray(empties) && STATE.root.emptyDirs === undefined) { rootPatch.emptyDirs = empties; STATE.root.emptyDirs = empties; }
    const bufs = parse("md-buffers:" + ROOT_KEY);
    if (bufs && Array.isArray(bufs.open) && STATE.root.buffers === undefined) { rootPatch.buffers = bufs; STATE.root.buffers = bufs; }
    const recent = parse("md-recent");
    if (Array.isArray(recent) && !STATE.recent.length) {
      STATE.recent = recent.filter((p) => typeof p === "string").slice(0, 20);
      // Oldest first, so replaying the pushes lands newest-first in the db.
      recents = STATE.recent.slice().reverse();
    }
    for (const k of ["md-theme", "md-font", "md-sidebar", "md-recent", "md-expanded:" + ROOT_KEY, "md-emptydirs:" + ROOT_KEY, "md-buffers:" + ROOT_KEY]) localStorage.removeItem(k);
  } catch {
    // No localStorage (private mode, storage blocked) — nothing to migrate.
  }
  const patch = {};
  if (Object.keys(prefs).length) patch.prefs = prefs;
  if (Object.keys(rootPatch).length) patch.root = rootPatch;
  if (recents.length) patch.recent = recents;
  if (patch.prefs || patch.root || patch.recent) queueState(patch);
}
migrateLegacyState();

let currentFile = null;
let allFiles = [];
let mermaidId = 0;
let headings = [];
let spyRAF = 0;

// ── multi-buffer state ─────────────────────────────────────
// each buffer: { path, name, kind, doc, mode:"preview"|"edit", draft, dirty }
let buffers = [];
let activePath = null;
let previewTimer = 0;
const tabsEl = $("tabs");
function getBuffer(p) { return buffers.find((b) => b.path === p); }
function activeBuffer() { return getBuffer(activePath); }

// ── platform key hint ──────────────────────────────────────
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$("kbd-hint").textContent = isMac ? "⌘K" : "Ctrl K";

// ── theme + font ───────────────────────────────────────────
function systemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  savePref("theme", t);
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, theme: t === "dark" ? "dark" : "default", securityLevel: "loose" });
  }
}
function applyFont(f) {
  document.documentElement.setAttribute("data-font", f);
  savePref("font", f);
  $("btn-font").classList.toggle("active", f === "serif");
}
const savedTheme = STATE.prefs.theme;
applyTheme(savedTheme === "light" || savedTheme === "dark" ? savedTheme : systemTheme());
applyFont(STATE.prefs.font === "serif" ? "serif" : "sans");

$("btn-theme").onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  // Code re-colors instantly via shiki dual-theme CSS vars; re-render the
  // active buffer only to re-theme mermaid, preserving scroll position.
  if (activeBuffer()) { const y = window.scrollY; renderActive(); window.scrollTo(0, y); }
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
  savePref("sidebar", hidden ? "0" : "1");
}
if (STATE.prefs.sidebar === "0") {
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
      // first word of the source names the diagram type (flowchart, sequenceDiagram, …)
      const first = (text.trim().split(/\\n/)[0] || "").trim().split(/[\\s:]/)[0];
      const kind = /^[A-Za-z-]+$/.test(first) ? first : "mermaid";
      return '<div class="mmd-card" data-src="'+esc(text)+'">'+
        '<div class="mmd-head"><span class="mmd-lang">'+esc(kind)+'</span>'+
        '<div class="mmd-tools">'+
          '<button class="mmd-btn" data-mmd="out" type="button" title="Zoom out (−)">'+zoomOutIcon()+'</button>'+
          '<button class="mmd-zoom" data-mmd="reset" type="button" title="Fit to view (0)">100%</button>'+
          '<button class="mmd-btn" data-mmd="in" type="button" title="Zoom in (+)">'+zoomInIcon()+'</button>'+
          '<button class="mmd-btn" data-mmd="fit" type="button" title="Fit to view (0)">'+fitIcon()+'</button>'+
          '<button class="mmd-btn" data-mmd="full" type="button" title="Fullscreen (f)">'+expandIcon()+'</button>'+
          '<button class="mmd-btn" data-mmd="copy" type="button" title="Copy diagram source">'+copyIcon()+'</button>'+
        '</div></div>'+
        '<div class="mmd-view" tabindex="0" role="img" aria-label="'+esc(kind)+' diagram">'+
          '<div class="mmd-stage"><div class="mermaid" id="'+id+'">'+safe+'</div></div>'+
          '<div class="mmd-hint">drag to pan · '+(isMac ? "⌘" : "ctrl")+'+scroll to zoom · double-click to fit</div>'+
        '</div></div>';
    }
    // Emit a plain, escaped placeholder immediately; shiki upgrades it after
    // the DOM is inserted (see highlightCode). textContent recovers the raw
    // source for the highlighter and the copy button.
    const label = language || "text";
    const safe = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    return '<div class="code-wrap" data-lang="'+esc(language)+'">'+
      '<div class="code-head"><span class="code-lang">'+esc(label)+'</span>'+
      '<div class="code-tools">'+
        '<button class="code-btn" data-code="full" type="button" title="Fullscreen (f)">'+expandIcon()+'</button>'+
        '<button class="copy-btn" type="button">'+copyIcon()+'Copy</button>'+
      '</div></div>'+
      '<pre class="raw-code"><code>'+safe+'</code></pre></div>';
  },
  table({ header, rows }) {
    // Wrap in scrollable container with fullscreen option
    const head = header.map(h => '<th>'+h.text+'</th>').join('');
    const body = rows.map(r => '<tr>'+r.map(c => '<td>'+c.text+'</td>').join('')+'</tr>').join('');
    return '<div class="table-wrap">'+
      '<div class="code-head"><span class="code-lang">table</span>'+
      '<div class="code-tools">'+
        '<button class="code-btn" data-code="full" type="button" title="Fullscreen (f)">'+expandIcon()+'</button>'+
      '</div></div>'+
      '<div class="table-scroll"><table><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table></div></div>';
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
  return STATE.recent;
}
function pushRecent(path) {
  STATE.recent = [path].concat(STATE.recent.filter((p) => p !== path)).slice(0, 20);
  queueState({ recent: path });
}

// ── file tree ──────────────────────────────────────────────
function fileKind(path) {
  return /\\.(tex|latex|ltx)$/i.test(path) ? "tex" : "markdown";
}
function buildTree(files) {
  const root = { dirs: {}, files: [] };
  const ensureDir = (path) => {
    let node = root;
    for (const part of path.split("/")) {
      if (!part) continue;
      node.dirs[part] = node.dirs[part] || { dirs: {}, files: [] };
      node = node.dirs[part];
    }
    return node;
  };
  if (typeof emptyDirs !== "undefined" && emptyDirs) for (const d of emptyDirs) ensureDir(d);
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
// Expanded-folder state, persisted per root in the state db. null = not yet
// initialized (first visit) → seed with top-level dirs open. Collapsing a
// folder removes it.
let expandedDirs = Array.isArray(STATE.root.expanded) ? new Set(STATE.root.expanded) : null;
function saveExpanded() {
  if (expandedDirs) saveRootState("expanded", [...expandedDirs]);
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
    if (!expandedDirs) { // first visit: top-level folders open by default
      expandedDirs = new Set(Object.keys(tree.dirs));
      saveExpanded();
    }
    treeEl.innerHTML = renderNode(tree, "", 0);
  }
  bindTreeEvents(treeEl);
}
function renderNode(node, prefix, depth) {
  let html = "";
  const dirNames = Object.keys(node.dirs).sort((a, b) => a.localeCompare(b));
  for (const name of dirNames) {
    const path = prefix ? prefix + "/" + name : name;
    const open = expandedDirs && expandedDirs.has(path) ? " open" : "";
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
  const active = f.path === activePath ? " active" : "";
  const kind = f.kind || fileKind(f.path);
  return '<div class="file-item '+kind+active+'" draggable="true" data-path="'+esc(f.path)+'" title="'+esc(f.path)+'">'+
    '<span class="dot"></span><span class="nm">'+esc(f.name)+'</span></div>';
}
function bindTreeEvents(treeEl) {
  treeEl.querySelectorAll(".file-item").forEach((el) => {
    const p = el.getAttribute("data-path");
    el.addEventListener("click", () => openFile(p));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, fileMenu(p));
    });
    // drag a file onto a folder (or the root) to move it
    el.addEventListener("dragstart", (e) => {
      sideDrag = { path: p, dir: false };
      el.classList.add("dragging");
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", p); } catch {} }
    });
    el.addEventListener("dragend", () => { sideDrag = null; el.classList.remove("dragging"); });
  });
  // persist open/closed folder state: expanding adds, collapsing removes
  treeEl.querySelectorAll("details.dir").forEach((d) => {
    const dir = d.getAttribute("data-dir");
    d.addEventListener("toggle", () => {
      if (!expandedDirs) expandedDirs = new Set();
      if (d.open) expandedDirs.add(dir); else expandedDirs.delete(dir);
      saveExpanded();
    });
    const summary = d.querySelector(":scope > summary");
    if (!summary) return;
    summary.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, folderMenu(dir));
    });
    summary.addEventListener("dragover", (e) => {
      if (!sideDrag || sideDrag.path === dir || dir.indexOf(sideDrag.path + "/") === 0) return;
      e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      summary.classList.add("drop-into");
    });
    summary.addEventListener("dragleave", () => summary.classList.remove("drop-into"));
    summary.addEventListener("drop", (e) => {
      if (!sideDrag) return;
      e.preventDefault(); e.stopPropagation();
      summary.classList.remove("drop-into");
      const src = sideDrag.path; sideDrag = null;
      if (src && src !== dir && dir.indexOf(src + "/") !== 0) moveEntry(src, dir);
    });
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
  const nodes = content.querySelectorAll(".article h2, .article h3");
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
// Height of the sticky chrome (top bar + tab strip) plus breathing room, so a
// scrolled-to heading lands in the visible body instead of under the header.
function chromeOffset() {
  const cs = getComputedStyle(document.documentElement);
  const bar = parseFloat(cs.getPropertyValue("--bar-h")) || 52;
  const tabs = parseFloat(cs.getPropertyValue("--tabs-h")) || 0;
  return bar + tabs + 16;
}
function scrollToEl(el) {
  const top = el.getBoundingClientRect().top + window.scrollY - chromeOffset();
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}
function updateSpy() {
  spyRAF = 0;
  const denom = document.documentElement.scrollHeight - window.innerHeight;
  $("progress").style.width = (denom > 0 ? Math.min(100, (window.scrollY / denom) * 100) : 0) + "%";
  if (!headings.length) return;
  let active = headings[0].id;
  for (const h of headings) {
    if (h.el.getBoundingClientRect().top < chromeOffset() + 24) active = h.id;
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
function bindCopyButtons(root) {
  (root || content).querySelectorAll(".code-wrap").forEach((wrap) => {
    const btn = wrap.querySelector(".copy-btn");
    if (btn) {
      btn.onclick = () => {
        const pre = wrap.querySelector("pre");
        const text = pre ? pre.innerText : "";
        navigator.clipboard.writeText(text).then(() => {
          btn.innerHTML = copyIcon() + "Copied";
          btn.classList.add("done");
          setTimeout(() => { btn.innerHTML = copyIcon() + "Copy"; btn.classList.remove("done"); }, 1400);
        });
      };
    }
    bindFullscreen(wrap);
  });
  (root || content).querySelectorAll(".table-wrap").forEach(bindFullscreen);
}

// ── generic fullscreen for code blocks & tables ───────────
let fullEl = null;
const fullOverlay = $("full-overlay");
fullOverlay.addEventListener("click", (e) => { if (e.target === fullOverlay && fullEl) exitFull(); });

function bindFullscreen(wrap) {
  const btn = wrap.querySelector('[data-code="full"]');
  if (!btn) return;
  btn.onclick = () => {
    if (fullEl === wrap) exitFull();
    else enterFull(wrap);
  };
}

function enterFull(el) {
  if (fullEl) exitFull();
  const holder = document.createElement("div");
  el.parentNode.insertBefore(holder, el);
  fullOverlay.appendChild(el);
  fullOverlay.classList.add("open");
  document.body.style.overflow = "hidden";
  fullEl = el;
  el.__fullHolder = holder;
  const btn = el.querySelector('[data-code="full"]');
  if (btn) { btn.innerHTML = collapseIcon(); btn.title = "Exit fullscreen (esc)"; }
}

function exitFull() {
  if (!fullEl) return;
  fullOverlay.classList.remove("open");
  document.body.style.overflow = "";
  const holder = fullEl.__fullHolder;
  if (holder && holder.parentNode) holder.parentNode.replaceChild(fullEl, holder);
  else fullEl.remove();
  const btn = fullEl.querySelector('[data-code="full"]');
  if (btn) { btn.innerHTML = expandIcon(); btn.title = "Fullscreen (f)"; }
  fullEl = null;
}

// keyboard: f to toggle, esc to exit
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && fullEl) { e.preventDefault(); exitFull(); return; }
  if ((e.key === "f" || e.key === "F") && fullEl) { e.preventDefault(); exitFull(); return; }
});
function pencilIcon() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
}
function eyeIcon() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
}
function saveIcon() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>';
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
async function highlightCode(root) {
  const scope = root || main;
  const run = ++highlightRun;
  const wraps = Array.from(scope.querySelectorAll(".code-wrap"));
  for (const wrap of wraps) {
    if (run !== highlightRun) return; // a newer render superseded us
    if (wrap.__jsonTree) continue; // json blocks show the interactive tree instead
    const pre = wrap.querySelector("pre.raw-code");
    if (!pre) continue;
    const codeEl = pre.querySelector("code");
    const raw = codeEl ? codeEl.textContent : pre.textContent;
    const html = await shikiHtml(raw, wrap.getAttribute("data-lang"));
    if (run !== highlightRun) return;
    if (html) pre.outerHTML = html;
  }
}
function renderMathIn(el) {
  if (!window.renderMathInElement) return;
  renderMathInElement(el, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\\\[", right: "\\\\]", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\\\(", right: "\\\\)", display: false },
    ],
    throwOnError: false,
  });
}
// ── mermaid diagrams: pan, zoom, fullscreen ────────────────
// Each fenced mermaid block renders into a card whose <svg> sits on a stage we
// translate/scale. The SVG keeps its natural size, so every zoom level stays
// vector-crisp; only the stage transform changes.
const MMD_MIN = 0.1, MMD_MAX = 16;
function svgIcon(body) {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'+body+'</svg>';
}
function zoomInIcon() { return svgIcon('<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16M8 11h6M11 8v6"/>'); }
function zoomOutIcon() { return svgIcon('<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16M8 11h6"/>'); }
function fitIcon() { return svgIcon('<path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/>'); }
function expandIcon() { return svgIcon('<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>'); }
function collapseIcon() { return svgIcon('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'); }

let mmdFull = null; // the card currently in fullscreen, if any
const mmdFullOverlay = $("mmd-full");
mmdFullOverlay.addEventListener("click", (e) => { if (e.target === mmdFullOverlay && mmdFull) mmdFull.exitFull(); });

function runMermaid(el) {
  const nodes = el.querySelectorAll(".mermaid");
  if (!nodes.length || !window.mermaid) return;
  const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default";
  mermaid.initialize({ startOnLoad: false, theme, securityLevel: "loose" });
  // Set diagrams up whether or not every node parsed — a failed one falls back
  // to its source, and the rest still become interactive.
  mermaid.run({ nodes }).catch(() => {}).finally(() => {
    el.querySelectorAll(".mmd-card").forEach(setupDiagram);
  });
}

function setupDiagram(card) {
  if (card.__mmd) { card.__mmd.refit(); return; }
  const view = card.querySelector(".mmd-view");
  const stage = card.querySelector(".mmd-stage");
  const svg = stage && stage.querySelector("svg");
  if (!view || !stage || !svg) {
    // mermaid could not draw it: show the source instead of a broken box.
    card.classList.add("failed");
    if (stage) {
      const pre = document.createElement("pre");
      pre.textContent = card.getAttribute("data-src") || "";
      stage.replaceChildren(pre);
    }
    if (view) view.style.height = "auto";
    bindDiagramTools(card, null);
    return;
  }

  // Natural size, from the viewBox where possible (mermaid always sets one).
  let nw = 0, nh = 0;
  const vb = (svg.getAttribute("viewBox") || "").split(/[\\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { nw = vb[2]; nh = vb[3]; }
  if (!nw || !nh) { const r = svg.getBoundingClientRect(); nw = r.width || 400; nh = r.height || 300; }
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.maxWidth = "none";
  svg.style.width = nw + "px";
  svg.style.height = nh + "px";

  let s = 1, tx = 0, ty = 0, fitScale = 1, touched = false, lastWidth = 0;
  const badge = card.querySelector('[data-mmd="reset"]');
  const isFull = () => card.classList.contains("full");

  function clampPan() {
    const W = view.clientWidth, H = view.clientHeight;
    const cw = nw * s, ch = nh * s;
    tx = cw <= W ? (W - cw) / 2 : Math.min(0, Math.max(W - cw, tx));
    ty = ch <= H ? (H - ch) / 2 : Math.min(0, Math.max(H - ch, ty));
  }
  function apply() {
    clampPan();
    stage.style.transform = "translate("+tx.toFixed(2)+"px,"+ty.toFixed(2)+"px) scale("+s.toFixed(4)+")";
    if (badge) badge.textContent = Math.round(s * 100) + "%";
  }
  function fit() {
    const W = view.clientWidth || 1, H = view.clientHeight || 1;
    const pad = 24;
    fitScale = Math.min((W - pad) / nw, (H - pad) / nh, isFull() ? 2 : 1);
    if (!(fitScale > 0)) fitScale = 1;
    s = fitScale;
    touched = false;
    apply();
  }
  function refit() {
    // Inline height follows the diagram's aspect, within sane bounds; in
    // fullscreen the flex layout owns it.
    if (isFull()) view.style.height = "";
    else {
      const W = view.clientWidth || 1;
      const base = Math.min(1, W / nw);
      view.style.height = Math.max(200, Math.min(560, Math.round(nh * base) + 28)) + "px";
    }
    fit();
  }
  function zoomAt(factor, px, py) {
    const ns = Math.max(MMD_MIN, Math.min(MMD_MAX, s * factor));
    if (ns === s) return;
    tx = px - (px - tx) * (ns / s);
    ty = py - (py - ty) * (ns / s);
    s = ns;
    touched = true;
    apply();
  }
  function zoomCenter(factor) { zoomAt(factor, view.clientWidth / 2, view.clientHeight / 2); }
  function panBy(dx, dy) { tx += dx; ty += dy; touched = true; apply(); }

  // — pointer: drag to pan, two-finger pinch to zoom —
  const pts = new Map();
  let last = null, pinch = null;
  const mid = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  view.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { view.setPointerCapture(e.pointerId); } catch {}
    if (pts.size === 1) { last = { x: e.clientX, y: e.clientY }; view.classList.add("dragging"); }
    else if (pts.size === 2) { pinch = mid(); last = null; }
    e.preventDefault();
  });
  view.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2) {
      const now = mid();
      if (pinch && pinch.d > 0 && now.d > 0) {
        const r = view.getBoundingClientRect();
        zoomAt(now.d / pinch.d, now.x - r.left, now.y - r.top);
        panBy(now.x - pinch.x, now.y - pinch.y);
      }
      pinch = now;
      return;
    }
    if (!last) return;
    panBy(e.clientX - last.x, e.clientY - last.y);
    last = { x: e.clientX, y: e.clientY };
  });
  const release = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) { last = null; view.classList.remove("dragging"); }
    else last = [...pts.values()][0];
  };
  view.addEventListener("pointerup", release);
  view.addEventListener("pointercancel", release);

  // — wheel: ⌘/ctrl+scroll (and trackpad pinch) zooms; plain scroll still
  //   scrolls the page, so the diagram never traps you mid-document —
  view.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey && !isFull()) return;
    e.preventDefault();
    const r = view.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  view.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (touched || s > fitScale * 1.01) { fit(); return; }
    const r = view.getBoundingClientRect();
    zoomAt(2.2, e.clientX - r.left, e.clientY - r.top);
  });

  view.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 120 : 40;
    const k = e.key;
    if (k === "+" || k === "=") { e.preventDefault(); zoomCenter(1.25); }
    else if (k === "-" || k === "_") { e.preventDefault(); zoomCenter(0.8); }
    else if (k === "0") { e.preventDefault(); fit(); }
    else if (k === "f" || k === "F") { e.preventDefault(); toggleFull(); }
    else if (k === "ArrowLeft") { e.preventDefault(); panBy(step, 0); }
    else if (k === "ArrowRight") { e.preventDefault(); panBy(-step, 0); }
    else if (k === "ArrowUp") { e.preventDefault(); panBy(0, step); }
    else if (k === "ArrowDown") { e.preventDefault(); panBy(0, -step); }
  });

  // — fullscreen: the card itself moves into the overlay, so one set of
  //   handlers serves both modes —
  let holder = null;
  function enterFull() {
    if (mmdFull && mmdFull !== card.__mmd) mmdFull.exitFull();
    holder = document.createElement("div");
    card.parentNode.insertBefore(holder, card);
    mmdFullOverlay.appendChild(card);
    card.classList.add("full");
    mmdFullOverlay.classList.add("open");
    document.body.style.overflow = "hidden";
    const btn = card.querySelector('[data-mmd="full"]');
    if (btn) { btn.innerHTML = collapseIcon(); btn.title = "Exit fullscreen (esc)"; }
    mmdFull = card.__mmd;
    requestAnimationFrame(() => { refit(); view.focus(); });
  }
  function exitFull() {
    card.classList.remove("full");
    mmdFullOverlay.classList.remove("open");
    document.body.style.overflow = "";
    if (holder && holder.parentNode) holder.parentNode.replaceChild(card, holder);
    else card.remove(); // the document re-rendered underneath us
    holder = null;
    const btn = card.querySelector('[data-mmd="full"]');
    if (btn) { btn.innerHTML = expandIcon(); btn.title = "Fullscreen (f)"; }
    if (mmdFull === card.__mmd) mmdFull = null;
    if (card.isConnected) requestAnimationFrame(refit);
  }
  function toggleFull() { isFull() ? exitFull() : enterFull(); }

  card.__mmd = { refit, fit, zoomCenter, toggleFull, exitFull };
  bindDiagramTools(card, card.__mmd);

  // Re-fit on width changes (sidebar toggle, window resize, split preview),
  // but never fight a zoom the reader chose.
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const w = view.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      if (touched) apply();
      else refit();
    }).observe(card);
  }
  lastWidth = view.clientWidth;
  refit();
}

function bindDiagramTools(card, ctl) {
  card.querySelectorAll("[data-mmd]").forEach((btn) => {
    const act = btn.getAttribute("data-mmd");
    if (act === "copy") {
      btn.onclick = () => {
        copyText(card.getAttribute("data-src") || "");
        btn.innerHTML = fitCheckIcon();
        btn.classList.add("done");
        toast("Diagram source copied");
        setTimeout(() => { btn.innerHTML = copyIcon(); btn.classList.remove("done"); }, 1400);
      };
      return;
    }
    if (!ctl) { btn.disabled = true; btn.style.opacity = ".4"; return; }
    if (act === "in") btn.onclick = () => ctl.zoomCenter(1.25);
    else if (act === "out") btn.onclick = () => ctl.zoomCenter(0.8);
    else if (act === "fit" || act === "reset") btn.onclick = () => ctl.fit();
    else if (act === "full") btn.onclick = () => ctl.toggleFull();
  });
}
function fitCheckIcon() { return svgIcon('<path d="M20 6L9 17l-5-5"/>'); }

// ── json: interactive tree, expanded by default ───────────
// JSON code blocks render as a collapsible <details> tree. The raw <pre> stays
// in the DOM (hidden) so the copy button and shiki keep working.
function renderJsonViews(root) {
  (root || content).querySelectorAll('.code-wrap[data-lang="json"]').forEach((wrap) => {
    if (wrap.__jsonTree) return;
    const code = wrap.querySelector("pre code");
    const raw = code ? code.textContent : "";
    let data;
    try { data = JSON.parse(raw); } catch { return; } // not valid json — leave as code
    wrap.__jsonTree = true;
    const pre = wrap.querySelector("pre");
    if (pre) pre.style.display = "none";
    const tree = document.createElement("div");
    tree.className = "json-tree";
    tree.appendChild(jsonNode(data));
    if (pre) pre.after(tree); else wrap.appendChild(tree);
  });
}
function jsonLeaf(text, type) {
  const s = document.createElement("span");
  s.className = "json-val json-" + type;
  s.textContent = text;
  return s;
}
function jsonRow(key, v) {
  const row = document.createElement("div");
  row.className = "json-row";
  const k = document.createElement("span");
  k.className = "json-key";
  k.textContent = key;
  row.appendChild(k);
  row.appendChild(jsonNode(v));
  return row;
}
function jsonNode(v) {
  if (v === null) return jsonLeaf("null", "null");
  const t = Array.isArray(v) ? "array" : typeof v;
  if (t !== "object" && t !== "array") {
    return jsonLeaf(t === "string" ? JSON.stringify(v) : String(v), t);
  }
  const keys = t === "array" ? v.map((_, i) => String(i)) : Object.keys(v);
  if (!keys.length) return jsonLeaf(t === "array" ? "[]" : "{}", "empty");
  const d = document.createElement("details");
  d.className = "json-node";
  d.open = true;
  const s = document.createElement("summary");
  const open = t === "array" ? "[" : "{", close = t === "array" ? "]" : "}";
  s.innerHTML = '<span class="json-brk">'+open+'</span><span class="json-count">'+keys.length+'</span><span class="json-brk json-close">'+close+'</span>';
  d.appendChild(s);
  const kids = document.createElement("div");
  kids.className = "json-kids";
  keys.forEach((k) => kids.appendChild(jsonRow(k, v[k])));
  d.appendChild(kids);
  return d;
}

function enrich(el) { renderMathIn(el); runMermaid(el); bindCopyButtons(el); renderJsonViews(el); highlightCode(el); }

// ── file-op UI: refs, icons, toast, modal, context menu ─────
const ctxMenu = $("ctx-menu");
const modalOverlay = $("modal-overlay");
const helpOverlay = $("help-overlay");
let sideDrag = null;

function trashIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>'; }
function filePlusIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/><path d="M14 3v5h5"/><path d="M18 14v6M15 17h6"/></svg>'; }
function folderPlusIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H16a2 2 0 0 1 2 2v2"/><path d="M3 7v11a2 2 0 0 0 2 2h6"/><path d="M18 14v6M15 17h6"/></svg>'; }
function linkIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>'; }
function closeAllIcon() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h11M4 12h9M4 17h7"/><path d="M15 15l5 5M20 15l-5 5"/></svg>'; }

let toastTimer = 0;
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast" + (kind ? " " + kind : ""); }, 2600);
}
function copyText(t) { try { navigator.clipboard.writeText(t); } catch {} }

// Reusable input dialog → resolves to a trimmed string, or null on cancel.
function promptModal(opts) {
  return new Promise((resolve) => {
    modalOverlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">'+
        '<div class="modal-title">'+esc(opts.title || "")+'</div>'+
        (opts.label ? '<label class="modal-label" for="modal-input">'+esc(opts.label)+'</label>' : '')+
        '<input class="modal-input" id="modal-input" spellcheck="false" autocomplete="off" autocapitalize="off" />'+
        '<div class="modal-foot">'+
          '<button class="modal-btn" id="modal-cancel" type="button">Cancel</button>'+
          '<button class="modal-btn primary" id="modal-ok" type="button">'+esc(opts.okText || "OK")+'</button>'+
        '</div>'+
      '</div>';
    modalOverlay.classList.add("open");
    const inp = $("modal-input");
    inp.value = opts.value || "";
    inp.placeholder = opts.placeholder || "";
    inp.focus();
    if (opts.selectRange) { try { inp.setSelectionRange(opts.selectRange[0], opts.selectRange[1]); } catch { inp.select(); } }
    else inp.select();
    function done(val) { modalOverlay.classList.remove("open"); modalOverlay.innerHTML = ""; resolve(val); }
    function submit() { done(inp.value.trim() || null); }
    $("modal-cancel").onclick = () => done(null);
    $("modal-ok").onclick = submit;
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    });
    modalOverlay.onclick = (e) => { if (e.target === modalOverlay) done(null); };
  });
}

function closeContextMenu() { ctxMenu.classList.remove("open"); ctxMenu.innerHTML = ""; }
function openContextMenu(x, y, items) {
  ctxMenu.innerHTML = items.map((it, i) => it.sep
    ? '<div class="ctx-sep"></div>'
    : '<button class="ctx-item'+(it.danger ? " danger" : "")+(it.disabled ? " disabled" : "")+'" data-i="'+i+'" type="button"'+(it.disabled ? " disabled" : "")+'>'+
        (it.icon || '<span class="ctx-ico"></span>')+'<span class="ctx-label">'+esc(it.label)+'</span>'+(it.hint ? '<span class="k">'+esc(it.hint)+'</span>' : '')+'</button>'
  ).join("");
  ctxMenu.classList.add("open");
  ctxMenu.style.left = "0px"; ctxMenu.style.top = "0px";
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  ctxMenu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  ctxMenu.querySelectorAll(".ctx-item").forEach((el) => {
    el.onclick = () => { const it = items[parseInt(el.getAttribute("data-i"), 10)]; if (it && it.disabled) return; closeContextMenu(); if (it && it.onClick) it.onClick(); };
  });
}
document.addEventListener("click", (e) => { if (!e.target.closest("#ctx-menu")) closeContextMenu(); });
document.addEventListener("contextmenu", (e) => { if (!e.target.closest(".file-item") && !e.target.closest("details.dir > summary") && !e.target.closest(".tab")) closeContextMenu(); }, true);
window.addEventListener("resize", closeContextMenu);
window.addEventListener("scroll", closeContextMenu, true);

// ── empty-folder tracking ──────────────────────────────────
// The tree is built from the flat file list, so a freshly-created empty folder
// has no file to hang on. Remember such dirs (per root) until a file lands.
let emptyDirs = loadEmptyDirs();
function loadEmptyDirs() { return new Set(Array.isArray(STATE.root.emptyDirs) ? STATE.root.emptyDirs : []); }
function saveEmptyDirs() { saveRootState("emptyDirs", [...emptyDirs]); }
function pruneEmptyDirs() {
  let changed = false;
  for (const d of [...emptyDirs]) {
    if (allFiles.some((f) => f.path.indexOf(d + "/") === 0)) { emptyDirs.delete(d); changed = true; }
  }
  if (changed) saveEmptyDirs();
}
function remapEmptyDirs(from, to, isDir) {
  if (!isDir) return;
  let changed = false;
  for (const d of [...emptyDirs]) {
    if (d === from) { emptyDirs.delete(d); emptyDirs.add(to); changed = true; }
    else if (d.indexOf(from + "/") === 0) { emptyDirs.delete(d); emptyDirs.add(to + d.slice(from.length)); changed = true; }
  }
  if (changed) saveEmptyDirs();
}

// ── file operations (create / rename / move / delete) ──────
async function apiPost(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data && data.error ? data.error : ("HTTP " + res.status));
  return data;
}
function joinRel(dir, name) {
  const clean = String(name).replace(/^\\/+/, "").replace(/\\/+$/, "").replace(/\\/+/g, "/");
  return dir ? dir + "/" + clean : clean;
}
function parentOf(rel) { const i = rel.lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); }
function baseOf(rel) { return rel.split("/").pop(); }
function expandAncestors(rel) {
  if (!expandedDirs) expandedDirs = new Set();
  const parts = rel.split("/"); let acc = "";
  for (let i = 0; i < parts.length - 1; i++) { acc = acc ? acc + "/" + parts[i] : parts[i]; expandedDirs.add(acc); }
  saveExpanded();
}
async function refreshFiles() {
  try { const data = await api("/api/all"); allFiles = data.files || []; } catch {}
  pruneEmptyDirs();
  renderTree();
  markActive();
}
function rerenderHomeIfShown() { if (activePath == null) showHome("none"); }

async function newFile(dirPrefix) {
  const name = await promptModal({ title: "New file", label: dirPrefix ? "New file inside " + dirPrefix + "/" : "File name or path", placeholder: "notes.md", okText: "Create" });
  if (!name) return;
  let rel = joinRel(dirPrefix, name);
  if (!/\\.(md|markdown|mdx)$/i.test(rel)) rel += ".md";
  try {
    await apiPost("/api/create", { path: rel });
    emptyDirs.delete(parentOf(rel)); saveEmptyDirs();
    expandAncestors(rel);
    await refreshFiles();
    toast("Created " + rel, "ok");
    await openFile(rel);
    const b = getBuffer(rel); if (b) setMode(b, "edit");
  } catch (e) { toast(e.message || "Could not create file", "err"); }
}
async function newFolder(dirPrefix) {
  const name = await promptModal({ title: "New folder", label: dirPrefix ? "New folder inside " + dirPrefix + "/" : "Folder name or path", placeholder: "chapters", okText: "Create" });
  if (!name) return;
  const rel = joinRel(dirPrefix, name);
  try {
    await apiPost("/api/create", { path: rel, dir: true });
    emptyDirs.add(rel); saveEmptyDirs();
    expandAncestors(rel + "/_"); // open rel and its ancestors
    await refreshFiles();
    rerenderHomeIfShown();
    toast("Created " + rel + "/", "ok");
  } catch (e) { toast(e.message || "Could not create folder", "err"); }
}
async function renameEntry(path, isDir) {
  const base = baseOf(path);
  const dot = base.lastIndexOf(".");
  const startSel = path.length - base.length;
  const endSel = (!isDir && dot > 0) ? path.length - (base.length - dot) : path.length;
  const to = await promptModal({ title: isDir ? "Rename folder" : "Rename file", label: "New name or path (use / to move)", value: path, okText: "Rename", selectRange: [startSel, endSel] });
  if (!to || to === path) return;
  try {
    const r = await apiPost("/api/rename", { from: path, to: joinRel("", to) });
    remapEmptyDirs(path, r.to, r.dir);
    if (r.dir) expandAncestors(r.to + "/_");
    await refreshFiles();
    reconcileRename(path, r.to, r.dir);
    rerenderHomeIfShown();
    toast("Renamed to " + r.to, "ok");
  } catch (e) { toast(e.message || "Rename failed", "err"); }
}
async function moveEntry(from, toDir) {
  if (parentOf(from) === toDir) return;
  if (toDir === from || toDir.indexOf(from + "/") === 0) { toast("Can't move a folder into itself", "err"); return; }
  const to = joinRel(toDir, baseOf(from));
  try {
    const r = await apiPost("/api/rename", { from, to });
    remapEmptyDirs(from, r.to, r.dir);
    if (toDir) expandAncestors(r.to + (r.dir ? "/_" : ""));
    await refreshFiles();
    reconcileRename(from, r.to, r.dir);
    rerenderHomeIfShown();
    toast("Moved to " + (toDir ? toDir + "/" : "root"), "ok");
  } catch (e) { toast(e.message || "Move failed", "err"); }
}
async function deleteEntry(path, isDir) {
  if (!confirm("Delete " + (isDir ? "folder " : "") + path + (isDir ? " and everything inside it?" : "?"))) return;
  try {
    await apiPost("/api/delete", { path });
    const gone = buffers.filter((b) => b.path === path || (isDir && b.path.indexOf(path + "/") === 0));
    const hadActive = gone.some((b) => b.path === activePath);
    buffers = buffers.filter((b) => gone.indexOf(b) < 0);
    for (const d of [...emptyDirs]) { if (d === path || d.indexOf(path + "/") === 0) emptyDirs.delete(d); }
    saveEmptyDirs();
    if (hadActive) activePath = null;
    await refreshFiles();
    if (hadActive) {
      if (buffers.length) openFile(buffers[buffers.length - 1].path, "replace");
      else showHome("replace");
    } else {
      renderTabs(); saveBuffers();
      rerenderHomeIfShown();
    }
    toast("Deleted " + path, "ok");
  } catch (e) { toast(e.message || "Delete failed", "err"); }
}
// After a rename/move, keep any open buffers (and the URL) pointing at the new path.
function reconcileRename(from, to, isDir) {
  let activeChanged = false;
  for (const b of buffers) {
    let np = null;
    if (isDir) { if (b.path === from || b.path.indexOf(from + "/") === 0) np = to + b.path.slice(from.length); }
    else if (b.path === from) np = to;
    if (np != null) {
      if (b.path === activePath) { activePath = np; currentFile = np; activeChanged = true; }
      b.path = np; b.name = baseOf(np); b.kind = fileKind(np);
    }
  }
  renderTabs(); saveBuffers(); markActive();
  if (activeChanged) {
    renderCrumbs(activePath);
    history.replaceState({ rel: activePath }, "", relToUrl(activePath));
    document.title = baseOf(activePath) + " · md";
  }
}

// ── sidebar context menus + drag-to-move ───────────────────
function fileMenu(p) {
  return [
    { label: "Open", icon: eyeIcon(), onClick: () => openFile(p) },
    { sep: true },
    { label: "Rename…", icon: pencilIcon(), onClick: () => renameEntry(p, false) },
    { label: "Copy path", icon: linkIcon(), onClick: () => { copyText(absPath(p)); toast("Path copied"); } },
    { sep: true },
    { label: "Delete", icon: trashIcon(), danger: true, onClick: () => deleteEntry(p, false) },
  ];
}
function folderMenu(dir) {
  return [
    { label: "New file…", icon: filePlusIcon(), onClick: () => newFile(dir) },
    { label: "New folder…", icon: folderPlusIcon(), onClick: () => newFolder(dir) },
    { sep: true },
    { label: "Rename…", icon: pencilIcon(), onClick: () => renameEntry(dir, true) },
    { label: "Delete", icon: trashIcon(), danger: true, onClick: () => deleteEntry(dir, true) },
  ];
}
// Root-level drop target (move into the served root). Attached once — #tree persists.
(function setupTreeRootDnD() {
  const treeEl = $("tree");
  const isEntry = (t) => t.closest("details.dir > summary") || t.closest(".file-item");
  treeEl.addEventListener("dragover", (e) => {
    if (!sideDrag || isEntry(e.target)) return;
    e.preventDefault(); treeEl.classList.add("drop-root");
  });
  treeEl.addEventListener("dragleave", (e) => { if (e.target === treeEl) treeEl.classList.remove("drop-root"); });
  treeEl.addEventListener("drop", (e) => {
    treeEl.classList.remove("drop-root");
    if (!sideDrag || isEntry(e.target)) return;
    e.preventDefault(); const src = sideDrag.path; sideDrag = null;
    if (src && parentOf(src) !== "") moveEntry(src, "");
  });
})();

// ── sidebar header actions ─────────────────────────────────
function collapseAll() { expandedDirs = new Set(); saveExpanded(); renderTree(); }
$("act-newfile").onclick = () => newFile("");
$("act-newfolder").onclick = () => newFolder("");
$("act-collapse").onclick = collapseAll;
$("act-refresh").onclick = async () => { await refreshFiles(); rerenderHomeIfShown(); toast("Refreshed"); };

// ── close all / others / to-the-right (VS Code tab menu) ───
function xIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'; }
function revealIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M14 4h7v7M21 4l-9 9"/></svg>'; }

function closeAllBuffers() { bulkClose(buffers.slice(), null); }
function closeOtherBuffers(keep) { bulkClose(buffers.filter((b) => b.path !== keep), keep); }
function closeBuffersToRight(path) {
  const idx = buffers.findIndex((b) => b.path === path);
  if (idx < 0) return;
  bulkClose(buffers.slice(idx + 1), path);
}
// Close a set of buffers with a single dirty confirm, then re-activate sensibly.
function bulkClose(targets, keep) {
  if (!targets.length) return;
  const dirty = targets.filter((b) => b.dirty);
  if (dirty.length && !confirm(dirty.length + " tab" + (dirty.length === 1 ? "" : "s") + " with unsaved changes. Close anyway?")) return;
  const set = new Set(targets.map((b) => b.path));
  const activeClosed = activePath != null && set.has(activePath);
  buffers = buffers.filter((b) => !set.has(b.path));
  if (activeClosed) {
    if (keep && getBuffer(keep)) openFile(keep, "replace");
    else if (buffers.length) openFile(buffers[buffers.length - 1].path, "replace");
    else { activePath = null; saveBuffers(); showHome("replace"); }
  } else {
    renderTabs(); saveBuffers();
  }
}

// Right-click menu for an open buffer tab.
function tabMenu(path) {
  const idx = buffers.findIndex((b) => b.path === path);
  const hasOthers = buffers.length > 1;
  const hasRight = idx >= 0 && idx < buffers.length - 1;
  return [
    { label: "Close", icon: xIcon(), hint: "mid-click", onClick: () => closeBuffer(path) },
    { label: "Close others", disabled: !hasOthers, onClick: () => closeOtherBuffers(path) },
    { label: "Close to the right", disabled: !hasRight, onClick: () => closeBuffersToRight(path) },
    { label: "Close all", icon: closeAllIcon(), onClick: closeAllBuffers },
    { sep: true },
    { label: "Reveal in sidebar", icon: revealIcon(), onClick: () => revealInSidebar(path) },
    { label: "Copy path", icon: linkIcon(), onClick: () => { copyText(absPath(path)); toast("Path copied"); } },
    { sep: true },
    { label: "Rename…", icon: pencilIcon(), onClick: () => renameEntry(path, false) },
    { label: "Delete", icon: trashIcon(), danger: true, onClick: () => deleteEntry(path, false) },
  ];
}

// Show the sidebar, expand to the file, scroll it into view and flash it.
function revealInSidebar(path) {
  if (layout.classList.contains("no-sidebar")) toggleSidebar();
  $("tree-filter").value = "";
  expandAncestors(path);
  renderTree();
  let el = null;
  $("tree").querySelectorAll(".file-item").forEach((x) => { if (x.getAttribute("data-path") === path) el = x; });
  if (el) {
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash");
    setTimeout(() => el && el.classList.remove("flash"), 1100);
  }
}

// ── palette commands (VS Code-style) ───────────────────────
function paletteCommands() {
  return [
    { title: "New file", icon: filePlusIcon(), run: () => newFile("") },
    { title: "New folder", icon: folderPlusIcon(), run: () => newFolder("") },
    { title: "Close current tab", icon: null, run: () => { if (activePath) closeBuffer(activePath); } },
    { title: "Close all tabs", icon: closeAllIcon(), run: closeAllBuffers },
    { title: "Toggle theme", icon: null, run: () => $("btn-theme").click() },
    { title: "Toggle sidebar", icon: null, run: toggleSidebar },
    { title: "Toggle serif / sans", icon: null, run: () => $("btn-font").click() },
    { title: "Keyboard shortcuts", icon: null, run: openHelp },
  ];
}
function commandResults(q) {
  const cmds = paletteCommands();
  const wrap = (c, nameHtml) => ({ section: "Commands", run: c.run, icon: c.icon, nameHtml, sub: "Command" });
  if (!q) return cmds.map((c) => wrap(c, esc(c.title)));
  const scored = [];
  for (const c of cmds) { const s = fuzzy(q, c.title); if (s > 0) scored.push({ c, s }); }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 5).map(({ c }) => wrap(c, highlightMatch(c.title, q)));
}
function paletteResults(q) {
  let items = [];
  if (paletteMode !== "files") items = items.concat(commandResults(q));
  return items.concat(localFileResults(q));
}

// ── keyboard shortcuts help overlay ────────────────────────
const SHORTCUTS = [
  { sec: "General", rows: [
    { keys: ["Cmd", "K"], desc: "Command palette — files, content & commands" },
    { keys: ["Cmd", "P"], desc: "Go to file" },
    { keys: ["/"], desc: "Search" },
    { keys: ["?"], desc: "This shortcuts help" },
    { keys: ["Esc"], desc: "Close dialog / menu" },
  ] },
  { sec: "View & edit", rows: [
    { keys: ["Cmd", "B"], desc: "Toggle file sidebar" },
    { keys: ["Cmd", "E"], desc: "Toggle edit / preview" },
    { keys: ["Cmd", "S"], desc: "Save (in edit mode)" },
  ] },
  { sec: "Tabs", rows: [
    { keys: ["Alt", "1–9"], desc: "Jump to tab 1–9" },
    { keys: ["Middle-click"], desc: "Close a tab" },
    { keys: ["Drag"], desc: "Reorder tabs" },
  ] },
  { sec: "Files (sidebar)", rows: [
    { keys: ["Right-click"], desc: "New · rename · delete" },
    { keys: ["Drag → folder"], desc: "Move a file into a folder" },
  ] },
  { sec: "Diagrams (mermaid)", rows: [
    { keys: ["Drag"], desc: "Pan the diagram" },
    { keys: ["Cmd", "Scroll"], desc: "Zoom at the pointer (or pinch)" },
    { keys: ["Double-click"], desc: "Zoom in · back to fit" },
    { keys: ["+", "−"], desc: "Zoom in / out (diagram focused)" },
    { keys: ["0"], desc: "Fit to view" },
    { keys: ["F"], desc: "Fullscreen · Esc to leave" },
  ] },
];
function openHelp() {
  const ctrl = isMac ? "⌘" : "Ctrl";
  const alt = isMac ? "⌥" : "Alt";
  let html = "";
  for (const g of SHORTCUTS) {
    html += '<div class="help-sec">'+esc(g.sec)+'</div>';
    for (const r of g.rows) {
      const keys = r.keys.map((k) => '<kbd>'+esc(k === "Cmd" ? ctrl : k === "Alt" ? alt : k)+'</kbd>').join("");
      html += '<div class="help-row"><span class="desc">'+esc(r.desc)+'</span><span class="help-keys">'+keys+'</span></div>';
    }
  }
  $("help-body").innerHTML = html;
  helpOverlay.classList.add("open");
}
function closeHelp() { helpOverlay.classList.remove("open"); }
$("btn-help").onclick = openHelp;
$("help-close").onclick = closeHelp;
helpOverlay.addEventListener("click", (e) => { if (e.target === helpOverlay) closeHelp(); });

// ── tabs (multi-buffer) ────────────────────────────────────
let dragPath = null;
function reorderBuffers(fromPath, toPath, before) {
  if (fromPath === toPath) return;
  const from = buffers.findIndex((b) => b.path === fromPath);
  if (from < 0) return;
  const [moved] = buffers.splice(from, 1);
  let to = buffers.findIndex((b) => b.path === toPath);
  if (to < 0) buffers.push(moved);
  else buffers.splice(before ? to : to + 1, 0, moved);
  renderTabs();
  saveBuffers();
}
function renderTabs() {
  document.documentElement.classList.toggle("has-tabs", buffers.length > 0);
  if (!buffers.length) { tabsEl.innerHTML = ""; return; }
  tabsEl.innerHTML = buffers.map((b) => {
    const cls = "tab" + (b.path === activePath ? " active" : "") + (b.kind === "tex" ? " tex" : "") + (b.dirty ? " dirty" : "");
    return '<div class="'+cls+'" draggable="true" data-path="'+esc(b.path)+'" title="'+esc(b.path)+'">'+
      '<span class="t-dot"></span><span class="t-name">'+esc(b.name)+'</span>'+
      '<button class="t-close" title="Close · middle-click"><span class="x">×</span><span class="d">●</span></button></div>';
  }).join("");
  tabsEl.querySelectorAll(".tab").forEach((el) => {
    const p = el.getAttribute("data-path");
    el.onclick = (e) => { if (e.target.closest(".t-close")) return; if (p !== activePath) openFile(p); };
    el.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeBuffer(p); } };
    el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openContextMenu(e.clientX, e.clientY, tabMenu(p)); };
    const close = el.querySelector(".t-close");
    if (close) close.onclick = (e) => { e.stopPropagation(); closeBuffer(p); };
    // drag-to-reorder (VS Code style)
    el.ondragstart = (e) => {
      dragPath = p;
      el.classList.add("dragging");
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", p); } catch {} }
    };
    el.ondragend = () => {
      dragPath = null;
      tabsEl.querySelectorAll(".tab").forEach((t) => t.classList.remove("dragging", "drop-before", "drop-after"));
    };
    el.ondragover = (e) => {
      if (!dragPath || dragPath === p) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      el.classList.toggle("drop-before", before);
      el.classList.toggle("drop-after", !before);
    };
    el.ondragleave = () => el.classList.remove("drop-before", "drop-after");
    el.ondrop = (e) => {
      e.preventDefault();
      const before = el.classList.contains("drop-before");
      el.classList.remove("drop-before", "drop-after");
      const from = dragPath;
      dragPath = null;
      if (from && from !== p) reorderBuffers(from, p, before);
    };
  });
  const active = tabsEl.querySelector(".tab.active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function closeBuffer(path) {
  const idx = buffers.findIndex((b) => b.path === path);
  if (idx < 0) return;
  const b = buffers[idx];
  if (b.dirty && !confirm(b.name + " has unsaved changes. Close anyway?")) return;
  buffers.splice(idx, 1);
  if (activePath === path) {
    const next = buffers[idx] || buffers[idx - 1] || null;
    if (next) openFile(next.path);
    else showHome();
  } else {
    renderTabs();
    saveBuffers();
  }
}

// ── render the active buffer ───────────────────────────────
function currentText(b) {
  if (b.kind === "markdown" && b.draft != null) return b.draft;
  return b.doc.markdown;
}
function savedText(b) { return b.doc.raw != null ? b.doc.raw : b.doc.markdown; }

function renderActive() {
  const b = activeBuffer();
  if (!b) return;
  document.title = b.name + " · md";
  if (b.mode === "edit" && b.kind === "markdown") renderEditor(b);
  else renderPreview(b);
}
function setMode(b, mode) {
  if (mode === "edit" && b.kind !== "markdown") return;
  b.mode = mode;
  if (mode === "edit" && b.draft == null) b.draft = savedText(b);
  renderActive();
}

function renderPreview(b) {
  layout.classList.remove("no-toc");
  const kicker = b.kind === "tex" ? "LaTeX · " + b.path : b.path;
  const editBtn = b.kind === "markdown"
    ? '<button class="doc-btn" id="edit-btn" title="Edit (e)">'+pencilIcon()+'Edit</button>'
    : "";
  content.innerHTML = '<article class="article">'+
    '<div class="doc-head"><div class="doc-actions">'+editBtn+'</div>'+
    '<div class="doc-kicker">'+esc(kicker)+'</div></div>'+
    marked.parse(currentText(b))+'</article>';
  enrich(content);
  buildToc();
  updateSpy();
  const eb = $("edit-btn");
  if (eb) eb.onclick = () => setMode(b, "edit");
}

function insertAtCursor(ta, text) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
}
function renderEditor(b) {
  layout.classList.add("no-toc");
  content.innerHTML =
    '<div class="editor" id="editor">'+
      '<div class="ed-pane">'+
        '<div class="ed-head">'+esc(b.path)+
          '<span class="spacer"></span>'+
          '<span class="ed-status" id="ed-status"></span>'+
          '<button class="doc-btn" id="preview-btn" title="Back to preview (e)">'+eyeIcon()+'Preview</button>'+
          '<button class="doc-btn primary" id="save-btn" title="Save (⌘S)">'+saveIcon()+'Save</button>'+
        '</div>'+
        '<textarea class="ed-input" id="ed-input" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>'+
      '</div>'+
      '<div class="ed-pane preview-pane">'+
        '<div class="ed-head">Preview</div>'+
        '<div class="preview-scroll" id="preview-scroll"></div>'+
      '</div>'+
    '</div>';
  const ta = $("ed-input");
  const status = $("ed-status");
  ta.value = b.draft != null ? b.draft : savedText(b);
  function refreshDirty() {
    b.dirty = ta.value !== savedText(b);
    renderTabs();
    status.textContent = b.dirty ? "unsaved" : "";
    status.className = "ed-status";
  }
  function scheduledPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => updatePreviewPane(b), 180);
  }
  ta.addEventListener("input", () => { b.draft = ta.value; refreshDirty(); scheduledPreview(); });
  ta.addEventListener("keydown", (e) => {
    // ⌘S is handled by the global keydown listener (works focused or not).
    if (e.key === "Tab") { e.preventDefault(); insertAtCursor(ta, "  "); b.draft = ta.value; refreshDirty(); scheduledPreview(); }
  });
  $("preview-btn").onclick = () => setMode(b, "preview");
  $("save-btn").onclick = () => saveBuffer(b);
  updatePreviewPane(b);
  refreshDirty();
  ta.focus();
}
function updatePreviewPane(b) {
  const el = $("preview-scroll");
  if (!el) return;
  el.innerHTML = '<article class="article">'+marked.parse(b.draft != null ? b.draft : b.doc.markdown)+'</article>';
  enrich(el);
}
async function saveBuffer(b) {
  if (b.kind !== "markdown") return;
  const ta = $("ed-input");
  const content = ta ? ta.value : (b.draft != null ? b.draft : b.doc.markdown);
  const status = $("ed-status");
  const btn = $("save-btn");
  if (btn) btn.disabled = true;
  if (status) { status.textContent = "saving…"; status.className = "ed-status"; }
  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: b.path, content }),
    });
    if (!res.ok) throw new Error(await res.text());
    b.doc.raw = content;
    b.doc.markdown = content;
    b.draft = content;
    b.dirty = false;
    renderTabs();
    if (status) {
      status.textContent = "saved";
      status.className = "ed-status ok";
      setTimeout(() => { if (status.textContent === "saved") { status.textContent = ""; status.className = "ed-status"; } }, 1500);
    }
  } catch (err) {
    if (status) { status.textContent = "save failed"; status.className = "ed-status err"; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── open / activate a file (buffer-aware) ──────────────────
// nav: "push" (new history entry, default), "replace" (in place), "none" (from popstate)
function updateHistory(rel, nav) {
  const url = relToUrl(rel);
  if (nav === "replace") history.replaceState({ rel }, "", url);
  else if (nav !== "none") history.pushState({ rel }, "", url);
}
function baseName(rel) { return rel.split("/").pop(); }
async function openFile(rel, nav) {
  if (!rel) return;
  if (window.innerWidth <= 760) layout.classList.add("no-sidebar");
  if (!getBuffer(rel)) {
    // create a buffer (doc fetched lazily on activation) and remember the tab
    buffers.push({ path: rel, name: baseName(rel), kind: fileKind(rel), doc: null, mode: "preview", draft: null, dirty: false });
    saveBuffers(); // persist immediately so a reload during fetch keeps the tab
  }
  await activateBuffer(rel, nav);
}
async function activateBuffer(rel, nav) {
  const b = getBuffer(rel);
  if (!b) return;
  activePath = rel; currentFile = rel;
  renderCrumbs(rel); markActive(); pushRecent(rel);
  updateHistory(rel, nav);
  renderTabs();
  if (!b.doc) {
    content.innerHTML = '<div class="empty">loading…</div>';
    try {
      const doc = await api("/api/file?path=" + encodeURIComponent(rel));
      if (activePath !== rel) return; // superseded while fetching
      b.doc = doc; b.name = doc.name; b.kind = doc.kind;
    } catch (err) {
      content.innerHTML = '<div class="empty">Failed to load <code>'+esc(rel)+'</code><br><br>'+esc(String(err.message || err))+'</div>';
      layout.classList.add("no-toc");
      saveBuffers();
      return;
    }
  }
  renderActive();
  if (b.mode !== "edit") window.scrollTo(0, 0);
  saveBuffers();
}
// persist open buffers per served root so they reopen on restart
function saveBuffers() {
  saveRootState("buffers", { open: buffers.map((b) => b.path), active: activePath });
}
function restoreBuffers() {
  const saved = STATE.root.buffers;
  if (!saved || !Array.isArray(saved.open)) return null;
  const open = saved.open.filter((p) => allFiles.some((f) => f.path === p));
  for (const p of open) {
    buffers.push({ path: p, name: baseName(p), kind: fileKind(p), doc: null, mode: "preview", draft: null, dirty: false });
  }
  if (buffers.length) renderTabs();
  if (open.includes(saved.active)) return saved.active;
  return open.length ? open[open.length - 1] : null;
}
function markActive() {
  $("tree").querySelectorAll(".file-item").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-path") === activePath);
  });
}

// ── home / landing ─────────────────────────────────────────
function showHome(nav) {
  currentFile = null;
  activePath = null;
  document.title = (DATA.root || "md") + " · md";
  if (nav === "replace") history.replaceState({ rel: "" }, "", "/");
  else if (nav !== "none") history.pushState({ rel: "" }, "", "/");
  renderTabs();
  saveBuffers();
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
  content.innerHTML = html;
  content.querySelectorAll(".card").forEach((el) => {
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
let paletteMode = "all"; // "all" = files + content + commands, "files" = quick-open only

function openPalette(mode) {
  paletteMode = mode === "files" ? "files" : "all";
  overlay.classList.add("open");
  pInput.value = "";
  pInput.placeholder = paletteMode === "files" ? "Go to file…" : "Search files, content, and commands…";
  pInput.focus();
  renderPalette(paletteResults(""));
}
function closePalette() { overlay.classList.remove("open"); }
$("search-btn").onclick = () => openPalette("all");
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
    const ico = it.icon ? '<span class="p-ico">'+it.icon+'</span>' : fileIco();
    const sub = it.sub != null ? it.sub : (it.path || "");
    html += '<div class="p-item '+(it.kind === "tex" ? "tex " : "")+(i === 0 ? "sel" : "")+'" data-i="'+i+'">'+ico+
      '<div class="p-main"><div class="p-name">'+it.nameHtml+'</div>'+
      (it.snippet ? '<div class="p-snip">'+it.snippet+'</div>' : '<div class="p-sub">'+esc(sub)+'</div>')+
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
  if (it.run) it.run();
  else if (it.path) openFile(it.path);
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
  renderPalette(paletteResults(q));
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
        renderPalette(paletteResults(q).concat(content));
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
// Actions that change state live on modifier keys (⌘/Ctrl) so a stray letter
// press can never, say, drop you into edit mode. Only a couple of harmless,
// deliberate bare keys ("/" and "?") act on their own, and never while typing.
document.addEventListener("keydown", (e) => {
  // 1. Dismiss any transient UI first.
  if (e.key === "Escape") {
    if (ctxMenu.classList.contains("open")) { e.preventDefault(); closeContextMenu(); return; }
    if (mmdFull) { e.preventDefault(); mmdFull.exitFull(); return; }
    if (helpOverlay.classList.contains("open")) { e.preventDefault(); closeHelp(); return; }
  }
  if (modalOverlay.classList.contains("open")) return; // the modal owns its keys

  const b = activeBuffer();
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  // 2. Modifier shortcuts — intentional, and allowed even while typing.
  if (mod && !e.altKey) {
    if (k === "k") { e.preventDefault(); openPalette("all"); return; }
    if (k === "p") { e.preventDefault(); openPalette("files"); return; }
    if (k === "b") { e.preventDefault(); toggleSidebar(); return; }
    if (k === "s") { if (b && b.mode === "edit") { e.preventDefault(); saveBuffer(b); } return; }
    if (k === "e") { if (b && b.kind === "markdown") { e.preventDefault(); setMode(b, b.mode === "edit" ? "preview" : "edit"); } return; }
    return; // leave every other ⌘/Ctrl combo to the browser
  }

  // 3. Alt/Option + 1–9 → jump to tab N (layout-independent via e.code).
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    const m = /^Digit([1-9])$/.exec(e.code);
    if (m && buffers[+m[1] - 1]) { e.preventDefault(); openFile(buffers[+m[1] - 1].path); }
    return;
  }

  if (overlay.classList.contains("open")) return;    // palette handles its own keys
  if (helpOverlay.classList.contains("open")) return;

  // 4. Bare keys: harmless only, and never while a field/editor is focused.
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); openPalette("all"); }
  else if (e.key === "?") { e.preventDefault(); openHelp(); }
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
  // Restore previously-open tabs for this root, then pick what to show.
  const restoredActive = restoreBuffers();
  const start = pathToRel() || DATA.boot || restoredActive || null;
  if (start) await openFile(start, "replace");
  else showHome("replace");
})();
</script>
</body>
</html>`;
}
