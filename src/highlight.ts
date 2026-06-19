// Syntax highlighting via Shiki (TextMate grammars, the same engine VS Code
// uses) → ANSI truecolor. Shiki bundles ~330 languages, so code blocks in
// anything from dockerfile to elixir to terraform get real highlighting rather
// than the flat fallback highlight.js/lib/common left them with.
//
// Shiki's highlighter is created asynchronously and loads grammars on demand,
// but pi-tui's Markdown theme calls highlightCode() synchronously while it
// renders. We bridge that gap with prewarmHighlighter(): callers scan a
// document for the languages it uses and await them before rendering, after
// which codeToTokens() is fully synchronous.

import chalk from "chalk";
import { createHighlighter, bundledLanguages, type BundledLanguage, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Any theme works — we read each token's hex color and let chalk downsample it
// to the terminal's color depth. github-dark reads well on dark terminals and
// degrades gracefully elsewhere.
const THEME = "github-dark";

// The JS regex engine avoids shipping the Oniguruma WASM blob, which keeps the
// `bun build --compile` binary self-contained and starts in a few ms.
const engine = createJavaScriptRegexEngine();

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;
// Languages (canonical ids and aliases) the highlighter has grammars for.
const loaded = new Set<string>();

function isBundled(lang: string): lang is BundledLanguage {
    return lang in bundledLanguages;
}

/** Lowercase + validate a fence language; undefined if Shiki can't highlight it. */
function normalize(lang: string | undefined): BundledLanguage | undefined {
    const l = lang?.trim().toLowerCase();
    return l && isBundled(l) ? l : undefined;
}

/** Create the singleton (once) and ensure the given valid langs are loaded. */
async function ensureLoaded(langs: BundledLanguage[]): Promise<void> {
    if (!highlighter) {
        if (!initPromise) {
            initPromise = createHighlighter({ themes: [THEME], langs, engine });
        }
        highlighter = await initPromise;
        for (const l of highlighter.getLoadedLanguages()) loaded.add(l);
        return;
    }
    const missing = langs.filter((l) => !loaded.has(l));
    if (missing.length === 0) return;
    await highlighter.loadLanguage(...missing);
    for (const l of highlighter.getLoadedLanguages()) loaded.add(l);
}

const FENCE = /^[ \t]*(?:```+|~~~+)[ \t]*([\w#+.-]+)/gm;

/**
 * Preload every language used by the fenced code blocks in `source`, so the
 * synchronous highlightCode() below can render them. Best-effort and safe to
 * call repeatedly — failures just leave the affected blocks as plain text.
 */
export async function prewarmHighlighter(source: string): Promise<void> {
    const langs = new Set<BundledLanguage>();
    FENCE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FENCE.exec(source)) !== null) {
        // mermaid is handled by its own renderer, not as a code block.
        if (match[1].toLowerCase() === "mermaid") continue;
        const lang = normalize(match[1]);
        if (lang) langs.add(lang);
    }
    if (langs.size === 0) return;
    try {
        await ensureLoaded([...langs]);
    } catch {
        // Highlighting is a nicety; never let it break rendering.
    }
}

/** Render a code block to styled terminal lines (one string per source line). */
export function highlightCode(code: string, lang?: string): string[] {
    const l = normalize(lang);
    // No highlighter yet, or an unknown/not-yet-loaded language → dim plain
    // text. We never guess a language (auto-detection is unreliable).
    if (!highlighter || !l || !loaded.has(l)) {
        return code.split("\n").map((line) => chalk.gray(line));
    }
    try {
        const { tokens } = highlighter.codeToTokens(code, { lang: l, theme: THEME });
        return tokens.map((line) =>
            line.map((token) => (token.color ? chalk.hex(token.color)(token.content) : token.content)).join(""),
        );
    } catch {
        return code.split("\n").map((line) => chalk.gray(line));
    }
}
