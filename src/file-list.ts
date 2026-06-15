import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "vendor"]);

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
