// Syntax highlighting via Shiki (TextMate grammars, the same engine VS Code
// uses) → ANSI truecolor. Shiki bundles ~330 languages, so code blocks in
// anything from dockerfile to elixir to terraform get real highlighting.
//
// Fenced blocks with no language are auto-detected: highlight.js's
// highlightAuto() guesses the language (it's good at this), and we render the
// guess with Shiki. Detection is gated on a relevance threshold so prose in a
// bare ``` block stays plain rather than getting mis-highlighted.
//
// Shiki's highlighter is created asynchronously and loads grammars on demand,
// but pi-tui's Markdown theme calls highlightCode() synchronously while it
// renders. We bridge that gap with prewarmHighlighter(): callers scan a
// document for the languages it uses (detecting bare blocks too) and await them
// before rendering, after which codeToTokens() is fully synchronous.

import chalk from "chalk";
import hljs from "highlight.js";
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

// ── Auto-detection for bare ``` blocks ──────────────────────────────────────
//
// Restrict highlight.js to a common subset: it makes detection faster and
// avoids confident guesses into obscure languages for a stray snippet.
const AUTO_DETECT_SUBSET = [
    "javascript", "typescript", "python", "json", "bash", "shell", "go", "rust",
    "java", "ruby", "c", "cpp", "csharp", "xml", "css", "scss", "sql", "yaml",
    "ini", "diff", "makefile", "dockerfile", "lua", "php", "kotlin", "swift",
];

// highlight.js language name → Shiki id, only where they differ.
const HLJS_TO_SHIKI: Record<string, string> = {
    xml: "html", // hljs reports HTML as "xml"; Shiki's html grammar reads better
    shell: "bash",
};

// Below this relevance, a guess is too weak to trust (prose scores ~1–2, real
// code ~3+), so we leave the block as plain text instead of mis-coloring prose.
const MIN_RELEVANCE = 3;

// Detection is deterministic per code string; cache it so prewarm and the later
// synchronous render agree and we never pay for highlightAuto twice.
const detectCache = new Map<string, BundledLanguage | null>();

/** Guess a code block's Shiki language, or undefined if unknown / too weak. */
function detectLang(code: string): BundledLanguage | undefined {
    if (detectCache.has(code)) return detectCache.get(code) ?? undefined;
    let result: BundledLanguage | null = null;
    try {
        const { language, relevance } = hljs.highlightAuto(code, AUTO_DETECT_SUBSET);
        if (language && relevance >= MIN_RELEVANCE) {
            const name = HLJS_TO_SHIKI[language] ?? language;
            if (isBundled(name)) result = name;
        }
    } catch {
        result = null;
    }
    detectCache.set(code, result);
    return result ?? undefined;
}

/** Create the singleton (once) and ensure the given valid langs are loaded. */
async function ensureLoaded(langs: BundledLanguage[]): Promise<void> {
    if (langs.length === 0 && highlighter) return;
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

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

/** Yield each fenced code block's info string and body, in document order. */
function* codeBlocks(source: string): Generator<{ info: string; body: string }> {
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const open = FENCE_OPEN.exec(lines[i]);
        if (!open) continue;
        const [, fence, info] = open;
        const fenceChar = fence[0];
        const close = new RegExp(`^[ \\t]*\\${fenceChar}{${fence.length},}[ \\t]*$`);
        const body: string[] = [];
        let j = i + 1;
        for (; j < lines.length && !close.test(lines[j]); j++) body.push(lines[j]);
        yield { info: info.trim(), body: body.join("\n") };
        i = j; // resume after the closing fence
    }
}

/**
 * Preload every language used by the fenced code blocks in `source` — including
 * auto-detected languages for bare blocks — so the synchronous highlightCode()
 * below can render them. Best-effort and safe to call repeatedly; failures just
 * leave the affected blocks as plain text.
 */
export async function prewarmHighlighter(source: string): Promise<void> {
    const langs = new Set<BundledLanguage>();
    for (const { info, body } of codeBlocks(source)) {
        const first = info.split(/\s+/)[0]?.toLowerCase() ?? "";
        // mermaid is handled by its own renderer, not as a code block.
        if (first === "mermaid") continue;
        const lang = first === "" ? detectLang(body) : normalize(first);
        if (lang) langs.add(lang);
    }
    try {
        await ensureLoaded([...langs]);
    } catch {
        // Highlighting is a nicety; never let it break rendering.
    }
}

/** Render a code block to styled terminal lines (one string per source line). */
export function highlightCode(code: string, lang?: string): string[] {
    // An explicit (even if unsupported) language is respected as-is; only truly
    // bare blocks are auto-detected, so ```text stays plain on purpose.
    const explicit = lang?.trim();
    const resolved = explicit ? normalize(explicit) : detectLang(code);

    if (!highlighter || !resolved || !loaded.has(resolved)) {
        return code.split("\n").map((line) => chalk.gray(line));
    }
    try {
        const { tokens } = highlighter.codeToTokens(code, { lang: resolved, theme: THEME });
        return tokens.map((line) =>
            line.map((token) => (token.color ? chalk.hex(token.color)(token.content) : token.content)).join(""),
        );
    } catch {
        return code.split("\n").map((line) => chalk.gray(line));
    }
}
