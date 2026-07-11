import { readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

/** Markdown sources. */
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
/** LaTeX sources (resumes, papers, etc.). */
const TEX_EXT = /\.(tex|latex|ltx)$/i;
/** Any file the browser / viewer can open. */
const VIEWABLE_EXT = /\.(md|markdown|mdx|tex|latex|ltx)$/i;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "vendor"]);

export type DocKind = "markdown" | "tex";

export function isMarkdownPath(path: string): boolean {
    return MARKDOWN_EXT.test(path);
}

export function isTexPath(path: string): boolean {
    return TEX_EXT.test(path);
}

export function isViewablePath(path: string): boolean {
    return VIEWABLE_EXT.test(path);
}

/** Classify a path for the renderer. Unknown extensions fall back to markdown. */
export function docKind(path: string): DocKind {
    return isTexPath(path) ? "tex" : "markdown";
}

export interface DirListing {
    /** Absolute paths of subdirectories that contain a viewable file somewhere below. */
    dirs: string[];
    /** Absolute paths of viewable files directly in this directory. */
    files: string[];
}

/** List one directory: viewable-bearing subfolders and viewable files. */
export function listDirectory(dir: string): DirListing {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return { dirs: [], files: [] };
    }
    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".")) {
            continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name) && hasViewable(full, 0)) {
                dirs.push(full);
            }
        } else if (VIEWABLE_EXT.test(entry.name)) {
            files.push(full);
        }
    }
    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));
    return { dirs, files };
}

/** True if a directory contains any viewable file within the depth limit. */
function hasViewable(dir: string, depth: number): boolean {
    if (depth > 12) {
        return false;
    }
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return false;
    }
    for (const entry of entries) {
        if (entry.name.startsWith(".")) {
            continue;
        }
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name) && hasViewable(join(dir, entry.name), depth + 1)) {
                return true;
            }
        } else if (VIEWABLE_EXT.test(entry.name)) {
            return true;
        }
    }
    return false;
}

/** Recursively collect viewable files under root, returned as relative paths. */
export function findViewableFiles(root: string): string[] {
    const found: string[] = [];
    walk(root, root, found, 0);
    found.sort((a, b) => a.localeCompare(b));
    return found;
}

/** @deprecated Prefer findViewableFiles — kept as a thin alias for older call sites. */
export function findMarkdownFiles(root: string): string[] {
    return findViewableFiles(root);
}

function walk(dir: string, root: string, found: string[], depth: number): void {
    if (depth > 12) {
        return;
    }
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".") {
            if (entry.isDirectory()) {
                continue;
            }
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) {
                continue;
            }
            walk(full, root, found, depth + 1);
        } else if (VIEWABLE_EXT.test(entry.name)) {
            found.push(relative(root, full) || entry.name);
        }
    }
}

/** Unused but handy for labels (e.g. footer). */
export function extensionLabel(path: string): string {
    const ext = extname(path).replace(/^\./, "").toLowerCase();
    return ext || "file";
}
