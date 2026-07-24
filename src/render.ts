import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { sliceByColumn } from "@earendil-works/pi-tui/dist/utils.js";
import { getMarkdownTheme } from "./theme.ts";
import { highlightCode } from "./highlight.ts";
import { uiStyle } from "./ui-mode.ts";
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
    type: "markdown" | "mermaid" | "code";
    text: string;
    /** Fence info string for `code` chunks ("" when the fence was bare). */
    lang?: string;
}

// Top-level fenced blocks (column 0), which covers mermaid diagrams and the
// code blocks we frame ourselves. A fence indented inside a list item is left
// to the markdown renderer, which keeps it attached to its list.
const FENCE = /^```([^\n]*)\n([\s\S]*?)\n?^```[ \t]*$/gm;

/** Render a full markdown document to styled terminal lines. */
export function renderMarkdown(source: string, width: number, options: RenderOptions = {}): string[] {
    const withoutAnchorLinks = stripInternalAnchorLinks(source);
    const withMath = renderMathInMarkdown(withoutAnchorLinks);
    const chunks = splitFences(withMath);
    const theme = getMarkdownTheme();
    const lines: string[] = [];

    const isBlank = (line: string | undefined) => (line ?? "").trim() === "";
    const endsBlank = () => lines.length === 0 || isBlank(lines[lines.length - 1]);
    /** Append a chunk with exactly one blank line at the seam. */
    const append = (rendered: string[]) => {
        let start = 0;
        while (start < rendered.length && isBlank(rendered[start])) start++;
        if (start >= rendered.length) return;
        if (!endsBlank() && lines.length > 0) lines.push("");
        lines.push(...rendered.slice(start));
    };

    for (const chunk of chunks) {
        if (chunk.type === "mermaid") {
            append(renderMermaid(chunk.text, width, { images: options.images }));
            continue;
        }
        if (chunk.type === "code") {
            append(renderCodeBlock(chunk.text, chunk.lang ?? "", width));
            continue;
        }
        if (chunk.text.trim() === "") {
            continue;
        }
        const md = new Markdown(chunk.text, 0, 0, theme);
        append(md.render(width));
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

/** Split a document into ordered markdown, mermaid and code chunks. */
function splitFences(source: string): Chunk[] {
    const chunks: Chunk[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    FENCE.lastIndex = 0;
    while ((match = FENCE.exec(source)) !== null) {
        if (match.index > last) {
            chunks.push({ type: "markdown", text: source.slice(last, match.index) });
        }
        const lang = (match[1] ?? "").trim().split(/\s+/)[0] ?? "";
        const body = match[2] ?? "";
        if (lang.toLowerCase() === "mermaid") {
            chunks.push({ type: "mermaid", text: body });
        } else {
            chunks.push({ type: "code", text: body, lang });
        }
        last = match.index + match[0].length;
    }
    if (last < source.length) {
        chunks.push({ type: "markdown", text: source.slice(last) });
    }
    return chunks;
}

/** Slice an ANSI-styled line into `width`-column pieces, styling intact. */
function wrapStyled(line: string, width: number): string[] {
    const total = visibleWidth(line);
    if (total <= width) return [line];
    const out: string[] = [];
    for (let col = 0; col < total; col += width) {
        out.push(sliceByColumn(line, col, width));
    }
    return out;
}

/**
 * Draw a fenced block as a framed card with its language on the top border —
 * the terminal counterpart of the web UI's code card. The frame never exceeds
 * the content width, so long lines wrap inside the box instead of blowing it
 * open (or being lost off-screen).
 */
function renderCodeBlock(code: string, lang: string, width: number): string[] {
    const c = uiStyle().colors;
    const highlighted = highlightCode(code, lang || undefined);
    while (highlighted.length > 0 && (highlighted[highlighted.length - 1] ?? "").trim() === "") {
        highlighted.pop();
    }
    if (highlighted.length === 0) return [];

    const label = lang.trim().toLowerCase();
    const FRAME = 4; // "│ " + " │"
    const widest = highlighted.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const inner = Math.max(
        // Keep room for the label so the top border can always show it.
        Math.min(Math.max(widest, label.length + 2), Math.max(8, width - FRAME)),
        8,
    );
    const body = highlighted.flatMap((line) => wrapStyled(line, inner));

    const dashes = (n: number) => "─".repeat(Math.max(0, n));
    const top = label
        ? c.codeBlockBorder("┌─ ") + c.muted(label) + c.codeBlockBorder(" " + dashes(inner - label.length - 1) + "┐")
        : c.codeBlockBorder("┌" + dashes(inner + 2) + "┐");
    const bottom = c.codeBlockBorder("└" + dashes(inner + 2) + "┘");
    const bar = c.codeBlockBorder("│");

    return [
        top,
        ...body.map((line) => `${bar} ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} ${bar}`),
        bottom,
    ];
}
