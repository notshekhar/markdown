import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "./theme.ts";
import { renderMathInMarkdown } from "./math.ts";
import { stripInternalAnchorLinks } from "./links.ts";
import { renderMermaid } from "./mermaid.ts";
import { texToMarkdown } from "./tex.ts";
import type { DocKind } from "./file-list.ts";

export interface RenderOptions {
    /** Print mode renders mermaid as inline images when the terminal supports it. */
    images?: boolean;
}

interface Chunk {
    type: "markdown" | "mermaid";
    text: string;
}

const MERMAID_FENCE = /^```mermaid[^\n]*\n([\s\S]*?)\n```$/gm;

/** Render a full markdown document to styled terminal lines. */
export function renderMarkdown(source: string, width: number, options: RenderOptions = {}): string[] {
    const withoutAnchorLinks = stripInternalAnchorLinks(source);
    const withMath = renderMathInMarkdown(withoutAnchorLinks);
    const chunks = splitMermaid(withMath);
    const theme = getMarkdownTheme();
    const lines: string[] = [];

    for (const chunk of chunks) {
        if (chunk.type === "mermaid") {
            lines.push(...renderMermaid(chunk.text, width, { images: options.images }));
            lines.push("");
            continue;
        }
        if (chunk.text.trim() === "") {
            continue;
        }
        const md = new Markdown(chunk.text, 0, 0, theme);
        lines.push(...md.render(width));
    }

    return lines;
}

/**
 * Render a LaTeX source file as a readable terminal preview.
 *
 * Pure JS: converts common LaTeX/resume macros → markdown, then reuses the
 * markdown renderer. No TeX engine, no shell-outs, no extra packages.
 */
export function renderTex(source: string, width: number, options: RenderOptions = {}): string[] {
    return renderMarkdown(texToMarkdown(source), width, options);
}

/** Dispatch to the right renderer by document kind. */
export function renderDocument(
    source: string,
    width: number,
    kind: DocKind,
    options: RenderOptions = {},
): string[] {
    if (kind === "tex") {
        return renderTex(source, width, options);
    }
    return renderMarkdown(source, width, options);
}

/** Split a document into ordered markdown and mermaid chunks. */
function splitMermaid(source: string): Chunk[] {
    const chunks: Chunk[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    MERMAID_FENCE.lastIndex = 0;
    while ((match = MERMAID_FENCE.exec(source)) !== null) {
        if (match.index > last) {
            chunks.push({ type: "markdown", text: source.slice(last, match.index) });
        }
        chunks.push({ type: "mermaid", text: match[1] });
        last = match.index + match[0].length;
    }
    if (last < source.length) {
        chunks.push({ type: "markdown", text: source.slice(last) });
    }
    return chunks;
}
