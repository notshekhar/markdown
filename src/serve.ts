/**
 * `markdown serve` — local HTTP preview with light/dark themes.
 *
 * Bun.serve + one embedded SPA. Client renders markdown (marked + hljs +
 * KaTeX + mermaid). .tex converted server-side via existing texToMarkdown.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { docKind, isViewablePath, listDirectory } from "./file-list.ts";
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
    const preferred = opts.port ?? 4321;
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

    if (pathname === "/" || pathname === "/index.html") {
        const boot = initialFile
            ? relative(root, initialFile).split(sep).join("/")
            : "";
        return html(pageHtml(boot));
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

function pageHtml(bootPath: string): string {
    const boot = JSON.stringify(bootPath);
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>md serve</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github-dark.min.css" id="hljs-dark" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github.min.css" id="hljs-light" disabled />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css" />
<style>
:root, [data-theme="dark"] {
  --bg: #0d1117;
  --bg-elev: #161b22;
  --bg-sidebar: #010409;
  --fg: #e6edf3;
  --fg-muted: #8b949e;
  --border: #30363d;
  --accent: #58a6ff;
  --accent-soft: rgba(88,166,255,.12);
  --heading: #79c0ff;
  --code-bg: #161b22;
  --quote-border: #a371f7;
  --link: #58a6ff;
  --shadow: 0 1px 2px rgba(0,0,0,.4);
  --sel: #1f6feb33;
  color-scheme: dark;
}
[data-theme="light"] {
  --bg: #ffffff;
  --bg-elev: #f6f8fa;
  --bg-sidebar: #f6f8fa;
  --fg: #1f2328;
  --fg-muted: #656d76;
  --border: #d0d7de;
  --accent: #0969da;
  --accent-soft: rgba(9,105,218,.1);
  --heading: #0550ae;
  --code-bg: #f6f8fa;
  --quote-border: #8250df;
  --link: #0969da;
  --shadow: 0 1px 2px rgba(0,0,0,.06);
  --sel: #0969da22;
  color-scheme: light;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--fg);
  display: grid;
  grid-template-rows: auto 1fr;
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: .75rem;
  padding: .55rem .9rem;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow);
  min-height: 48px;
}
header .brand {
  font-weight: 700;
  color: var(--accent);
  letter-spacing: .02em;
  font-size: .95rem;
}
header .path {
  flex: 1;
  color: var(--fg-muted);
  font-size: .85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
header button, .icon-btn {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  border-radius: 6px;
  padding: .35rem .65rem;
  font-size: .8rem;
  cursor: pointer;
  line-height: 1.2;
}
header button:hover, .icon-btn:hover { border-color: var(--accent); color: var(--accent); }
header button.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  min-height: 0;
  height: 100%;
}
.layout.no-sidebar { grid-template-columns: 1fr; }
.sidebar {
  border-right: 1px solid var(--border);
  background: var(--bg-sidebar);
  overflow: auto;
  padding: .5rem 0;
  min-height: 0;
}
.sidebar.hidden { display: none; }
.side-item {
  display: flex;
  align-items: center;
  gap: .45rem;
  padding: .35rem .85rem;
  cursor: pointer;
  font-size: .875rem;
  color: var(--fg);
  border-left: 2px solid transparent;
  user-select: none;
}
.side-item:hover { background: var(--accent-soft); }
.side-item.active { background: var(--sel); border-left-color: var(--accent); color: var(--accent); }
.side-item .ico { width: 1.1em; opacity: .7; flex-shrink: 0; }
.side-item.dir { color: var(--fg); font-weight: 500; }
.side-crumb {
  padding: .4rem .85rem .55rem;
  font-size: .75rem;
  color: var(--fg-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  border-bottom: 1px solid var(--border);
  margin-bottom: .25rem;
}
.main {
  overflow: auto;
  min-height: 0;
  scroll-behavior: smooth;
}
.article {
  max-width: 860px;
  margin: 0 auto;
  padding: 2rem 2.25rem 4rem;
}
.empty {
  color: var(--fg-muted);
  text-align: center;
  padding: 4rem 1rem;
  font-size: .95rem;
}
/* markdown body */
.article h1, .article h2, .article h3, .article h4, .article h5, .article h6 {
  color: var(--heading);
  line-height: 1.25;
  margin: 1.4em 0 .6em;
  font-weight: 650;
}
.article h1 { font-size: 1.9rem; border-bottom: 1px solid var(--border); padding-bottom: .3em; margin-top: 0; }
.article h2 { font-size: 1.45rem; border-bottom: 1px solid var(--border); padding-bottom: .25em; }
.article h3 { font-size: 1.2rem; }
.article p, .article li { line-height: 1.7; }
.article a { color: var(--link); text-decoration: none; }
.article a:hover { text-decoration: underline; }
.article code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .88em;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: .1em .35em;
}
.article pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: .9rem 1rem;
  overflow: auto;
  box-shadow: var(--shadow);
}
.article pre code {
  background: none;
  border: none;
  padding: 0;
  font-size: .85rem;
  line-height: 1.55;
}
.article blockquote {
  margin: 1em 0;
  padding: .15em 0 .15em 1em;
  border-left: 3px solid var(--quote-border);
  color: var(--fg-muted);
}
.article table {
  border-collapse: collapse;
  width: 100%;
  margin: 1.2em 0;
  font-size: .92rem;
}
.article th, .article td {
  border: 1px solid var(--border);
  padding: .45em .7em;
  text-align: left;
}
.article th { background: var(--bg-elev); }
.article hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
.article img { max-width: 100%; height: auto; border-radius: 6px; }
.article .katex-display { overflow-x: auto; overflow-y: hidden; padding: .4em 0; }
.mermaid {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  margin: 1.2em 0;
  text-align: center;
  overflow-x: auto;
}
.mermaid svg { max-width: 100%; height: auto; }
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { display: none; }
  .sidebar.open { display: block; position: absolute; inset: 48px 0 0 0; z-index: 5; }
  .article { padding: 1.25rem 1rem 3rem; }
}
</style>
</head>
<body>
<header>
  <span class="brand">md</span>
  <button type="button" id="btn-sidebar" title="Toggle file list">files</button>
  <span class="path" id="crumb">.</span>
  <button type="button" id="btn-theme" title="Toggle light/dark theme">theme</button>
</header>
<div class="layout" id="layout">
  <aside class="sidebar" id="sidebar"></aside>
  <main class="main" id="main">
    <div class="empty">pick a file →</div>
  </main>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked@14.1.4/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/lib/common.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/contrib/auto-render.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>
const BOOT = ${boot};
const $ = (id) => document.getElementById(id);
const sidebar = $("sidebar");
const main = $("main");
const crumb = $("crumb");
const layout = $("layout");
const btnTheme = $("btn-theme");
const btnSidebar = $("btn-sidebar");

let currentDir = ".";
let currentFile = null;
let mermaidId = 0;

// ── theme ──────────────────────────────────────────────────────────
function systemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("md-theme", t);
  $("hljs-dark").disabled = t === "light";
  $("hljs-light").disabled = t !== "light";
  btnTheme.textContent = t === "dark" ? "☀ light" : "☾ dark";
  // re-init mermaid colors if already loaded
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      theme: t === "dark" ? "dark" : "default",
      securityLevel: "loose",
    });
  }
}
const saved = localStorage.getItem("md-theme");
applyTheme(saved === "light" || saved === "dark" ? saved : systemTheme());
btnTheme.onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  if (currentFile) openFile(currentFile); // re-render mermaid with new theme
};
btnSidebar.onclick = () => {
  sidebar.classList.toggle("hidden");
  sidebar.classList.toggle("open");
  layout.classList.toggle("no-sidebar", sidebar.classList.contains("hidden"));
  btnSidebar.classList.toggle("active", !sidebar.classList.contains("hidden"));
};

// ── marked + highlight (marked v14 token-style renderer) ───────────
const renderer = {
  code({ text, lang }) {
    const language = (lang || "").trim().split(/\\s+/)[0];
    if (language === "mermaid") {
      const id = "mmd-" + (++mermaidId);
      const safe = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      return '<div class="mermaid" id="'+id+'">'+safe+'</div>';
    }
    let html = text;
    try {
      if (language && hljs.getLanguage(language)) {
        html = hljs.highlight(text, { language }).value;
      } else {
        html = hljs.highlightAuto(text).value;
      }
    } catch { /* plain */ }
    const cls = language ? ' class="hljs language-'+esc(language)+'"' : ' class="hljs"';
    return '<pre><code'+cls+'>'+html+'</code></pre>\\n';
  },
  image({ href, title, text }) {
    const src = rewriteAsset(href);
    const t = title ? ' title="'+esc(title)+'"' : "";
    return '<img src="'+esc(src)+'" alt="'+esc(text||"")+'"'+t+' />';
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
  return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
}
function rewriteAsset(href) {
  if (!href || /^(https?:|data:|mailto:|#|\\/)/i.test(href)) return href;
  const base = currentFile ? currentFile.replace(/[^/]+$/, "") : "";
  const joined = (base + href).replace(/\\/+/g, "/");
  // resolve .. segments
  const parts = [];
  for (const p of joined.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return "/raw/" + parts.map(encodeURIComponent).join("/");
}

// ── math: protect code, then $...$ / $$...$$ → katex later via auto-render
// We keep $ in source; KaTeX auto-render handles it after HTML insert.

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadDir(rel) {
  currentDir = rel || ".";
  const data = await api("/api/list?path=" + encodeURIComponent(currentDir));
  crumb.textContent = data.path === "." ? "/" : "/" + data.path;
  const bits = [];
  if (data.parent !== null) {
    bits.push(itemRow("..", data.parent, true, false));
  }
  for (const d of data.dirs) bits.push(itemRow(d.name + "/", d.path, true, false));
  for (const f of data.files) bits.push(itemRow(f.name, f.path, false, f.path === currentFile));
  sidebar.innerHTML = '<div class="side-crumb">'+esc(data.path)+'</div>' + bits.join("");
  sidebar.querySelectorAll(".side-item").forEach((el) => {
    el.addEventListener("click", () => {
      const p = el.getAttribute("data-path");
      const isDir = el.getAttribute("data-dir") === "1";
      if (isDir) loadDir(p);
      else openFile(p);
    });
  });
}

function itemRow(label, path, isDir, active) {
  const ico = isDir ? "📁" : "📄";
  return '<div class="side-item'+(isDir?" dir":"")+(active?" active":"")+
    '" data-path="'+esc(path)+'" data-dir="'+(isDir?"1":"0")+'">'+
    '<span class="ico">'+ico+'</span><span>'+esc(label)+'</span></div>';
}

async function openFile(rel) {
  currentFile = rel;
  crumb.textContent = "/" + rel;
  // mark active in sidebar
  sidebar.querySelectorAll(".side-item").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-path") === rel);
  });
  history.replaceState(null, "", "#/" + rel.split("/").map(encodeURIComponent).join("/"));
  try {
    const data = await api("/api/file?path=" + encodeURIComponent(rel));
    document.title = data.name + " · md";
    const html = marked.parse(data.markdown);
    main.innerHTML = '<article class="article">'+html+'</article>';
    // highlight any missed
    main.querySelectorAll("pre code").forEach((block) => {
      if (!block.classList.contains("hljs")) {
        try { hljs.highlightElement(block); } catch {}
      }
    });
    // math
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
    // mermaid
    const nodes = main.querySelectorAll(".mermaid");
    if (nodes.length && window.mermaid) {
      const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default";
      mermaid.initialize({ startOnLoad: false, theme, securityLevel: "loose" });
      await mermaid.run({ nodes });
    }
    main.scrollTop = 0;
  } catch (err) {
    main.innerHTML = '<div class="empty">failed to load: '+esc(String(err.message || err))+'</div>';
  }
}

// hash route: #/path/to/file.md
function routeFromHash() {
  const h = location.hash.replace(/^#\\/?/, "");
  if (!h) return null;
  try { return decodeURIComponent(h); } catch { return h; }
}

window.addEventListener("hashchange", () => {
  const r = routeFromHash();
  if (r && r !== currentFile) openFile(r);
});

(async function boot() {
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      theme: document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default",
      securityLevel: "loose",
    });
  }
  const fromHash = routeFromHash();
  const start = fromHash || BOOT || null;
  if (start) {
    const dir = start.includes("/") ? start.replace(/\\/[^/]+$/, "") || "." : ".";
    await loadDir(dir === "" ? "." : dir);
    await openFile(start);
  } else {
    await loadDir(".");
  }
})();
</script>
</body>
</html>`;
}
