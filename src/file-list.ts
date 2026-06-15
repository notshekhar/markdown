import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "vendor"]);

export interface DirListing {
    /** Absolute paths of subdirectories that contain markdown somewhere below. */
    dirs: string[];
    /** Absolute paths of markdown files directly in this directory. */
    files: string[];
}

/** List one directory: markdown-bearing subfolders and markdown files. */
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
            if (!SKIP_DIRS.has(entry.name) && hasMarkdown(full, 0)) {
                dirs.push(full);
            }
        } else if (MARKDOWN_EXT.test(entry.name)) {
            files.push(full);
        }
    }
    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));
    return { dirs, files };
}

/** True if a directory contains any markdown file within the depth limit. */
function hasMarkdown(dir: string, depth: number): boolean {
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
            if (!SKIP_DIRS.has(entry.name) && hasMarkdown(join(dir, entry.name), depth + 1)) {
                return true;
            }
        } else if (MARKDOWN_EXT.test(entry.name)) {
            return true;
        }
    }
    return false;
}

/** Recursively collect markdown files under root, returned as relative paths. */
export function findMarkdownFiles(root: string): string[] {
    const found: string[] = [];
    walk(root, root, found, 0);
    found.sort((a, b) => a.localeCompare(b));
    return found;
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
        } else if (MARKDOWN_EXT.test(entry.name)) {
            found.push(relative(root, full) || entry.name);
        }
    }
}
