/**
 * Pure TypeScript LaTeX → markdown preview.
 *
 * No TeX engine, no shell-outs, no new packages — just string transforms that
 * turn common document/resume markup into markdown, then the existing
 * markdown renderer paints it in the terminal.
 *
 * Scope is intentionally pragmatic (resumes, notes, simple articles), not a
 * full TeX interpreter.
 */

/** Private-use placeholders so escaped specials survive table `&` rewrites. */
const PH = {
    amp: "\uE000",
    pct: "\uE001",
    dol: "\uE002",
    hash: "\uE003",
    us: "\uE004",
} as const;

/** Convert LaTeX source to markdown suitable for `renderMarkdown`. */
export function texToMarkdown(source: string): string {
    let body = extractDocumentBody(source);
    body = stripComments(body);
    // Protect \& \% etc. *before* table `&` rewriting or brace unwrapping.
    body = protectEscaped(body);
    body = dropPreambleNoise(body);
    // Drop tabular/list wrappers *before* brace unwrapping, so colspecs like
    // {l@{\extracolsep{\fill}}r} never leak into the visible text.
    body = stripEnvironments(body);
    body = expandKnownMacros(body);
    body = stripLeftoverCommands(body);
    body = decodeLatexChars(body);
    body = tidyWhitespace(body);
    return body.trim() + "\n";
}

/** Prefer content between \begin{document} … \end{document}. */
function extractDocumentBody(source: string): string {
    const begin = /\\begin\s*\{\s*document\s*\}/i.exec(source);
    const end = /\\end\s*\{\s*document\s*\}/i.exec(source);
    if (begin && end && end.index > begin.index) {
        return source.slice(begin.index + begin[0].length, end.index);
    }
    return source;
}

/** Drop % comments (not escaped as \%). */
function stripComments(src: string): string {
    return src.replace(/(?<!\\)%[^\n]*/g, "");
}

/**
 * Remove common preamble / layout commands that produce no readable content
 * when they leak into the document body (or when there's no document env).
 */
function dropPreambleNoise(src: string): string {
    let s = src;
    const dropCmd = [
        "documentclass",
        "usepackage",
        "pagestyle",
        "fancyhf",
        "fancyfoot",
        "fancyhead",
        "hypersetup",
        "titleformat",
        "newcommand",
        "renewcommand",
        "providecommand",
        "setlength",
        "addtolength",
        "setcounter",
        "urlstyle",
        "raggedbottom",
        "raggedright",
        "thispagestyle",
        "noindent",
        "newpage",
        "clearpage",
        "pagebreak",
    ];
    for (const name of dropCmd) {
        s = dropCommandOccurrences(s, name);
    }
    s = s.replace(/\\resumeSubHeadingListStart\b/g, "");
    s = s.replace(/\\resumeSubHeadingListEnd\b/g, "");
    s = s.replace(/\\resumeItemListStart\b/g, "");
    s = s.replace(/\\resumeItemListEnd\b/g, "");
    return s;
}

/** Drop every occurrence of `\name…` including optional [...] and brace groups. */
function dropCommandOccurrences(src: string, name: string): string {
    let s = src;
    const re = new RegExp(`\\\\${name}\\b`);
    for (;;) {
        const m = re.exec(s);
        if (!m) break;
        const start = m.index;
        let i = start + m[0].length;
        for (;;) {
            while (i < s.length && /\s/.test(s[i])) i++;
            if (s[i] === "[") {
                const end = matchBracket(s, i, "[", "]");
                if (end < 0) break;
                i = end + 1;
                continue;
            }
            if (s[i] === "{") {
                const end = matchBracket(s, i, "{", "}");
                if (end < 0) break;
                i = end + 1;
                continue;
            }
            break;
        }
        s = s.slice(0, start) + s.slice(i);
        re.lastIndex = 0;
    }
    return s;
}

function protectEscaped(src: string): string {
    return src
        .replace(/\\&/g, PH.amp)
        .replace(/\\%/g, PH.pct)
        .replace(/\\\$/g, PH.dol)
        .replace(/\\#/g, PH.hash)
        .replace(/\\_/g, PH.us);
}

function expandKnownMacros(src: string): string {
    // Caller already ran protectEscaped on the full document.
    let s = src;

    // Symbols before generic command stripping.
    const symbols: [RegExp, string][] = [
        [/\\rightarrow\b/g, "→"],
        [/\\leftarrow\b/g, "←"],
        [/\\Rightarrow\b/g, "⇒"],
        [/\\Leftarrow\b/g, "⇐"],
        [/\\leftrightarrow\b/g, "↔"],
        [/\\times\b/g, "×"],
        [/\\cdot\b/g, "·"],
        [/\\circ\b/g, "∘"],
        [/\\bullet\b/g, "•"],
        [/\\ldots\b|\\dots\b/g, "…"],
        [/\\textasciitilde\{\}?|\\~/g, "~"],
        [/\\textasciicircum\{\}?/g, "^"],
        [/\\textbackslash\{\}?/g, "\\"],
        [/\\LaTeX\b/g, "LaTeX"],
        [/\\TeX\b/g, "TeX"],
        [/\\sim\b/g, "~"],
        [/\\approx\b/g, "≈"],
        [/\\leq\b|\\le\b/g, "≤"],
        [/\\geq\b|\\ge\b/g, "≥"],
        [/\\neq\b|\\ne\b/g, "≠"],
    ];
    for (const [re, rep] of symbols) s = s.replace(re, rep);

    // $…$ math: keep body (symbols already expanded).
    s = s.replace(/\$([^$]*)\$/g, "$1");

    s = replaceCommand(s, "resumeSubheading", 4, (a) => {
        const [org, loc, role, dates] = a.map(inlineTex);
        return `\n### ${org}${loc ? ` · ${loc}` : ""}\n*${role}${dates ? ` · ${dates}` : ""}*\n\n`;
    });
    s = replaceCommand(s, "resumeItem", 2, (a) => {
        const [title, desc] = a.map(inlineTex);
        return `\n- **${title}**: ${desc}\n`;
    });
    s = replaceCommand(s, "resumeSubItem", 2, (a) => {
        const [title, desc] = a.map(inlineTex);
        return `\n- **${title}**: ${desc}\n`;
    });

    s = replaceCommand(s, "section", 1, ([t]) => `\n\n## ${inlineTex(t)}\n\n`);
    s = replaceCommand(s, "subsection", 1, ([t]) => `\n\n### ${inlineTex(t)}\n\n`);
    s = replaceCommand(s, "subsubsection", 1, ([t]) => `\n\n#### ${inlineTex(t)}\n\n`);
    s = replaceCommand(s, "paragraph", 1, ([t]) => `\n\n**${inlineTex(t)}**\n\n`);

    s = replaceCommand(s, "href", 2, ([url, text]) => `[${inlineTex(text)}](${url.trim()})`);
    s = replaceCommand(s, "url", 1, ([u]) => `<${u.trim()}>`);

    for (const name of ["textbf", "bf", "mathbf"]) {
        s = replaceCommand(s, name, 1, ([t]) => `**${inlineTex(t)}**`);
    }
    for (const name of ["textit", "emph", "it", "mathit"]) {
        s = replaceCommand(s, name, 1, ([t]) => `*${inlineTex(t)}*`);
    }
    s = replaceCommand(s, "texttt", 1, ([t]) => `\`${inlineTex(t)}\``);
    s = replaceCommand(s, "underline", 1, ([t]) => inlineTex(t));
    s = replaceCommand(s, "textsc", 1, ([t]) => inlineTex(t));

    for (const name of [
        "Huge",
        "huge",
        "LARGE",
        "Large",
        "large",
        "normalsize",
        "small",
        "footnotesize",
        "scriptsize",
        "tiny",
        "bfseries",
        "itshape",
        "ttfamily",
        "scshape",
        "rmfamily",
        "sffamily",
        "mdseries",
        "upshape",
    ]) {
        s = s.replace(new RegExp(`\\\\${name}\\b`, "g"), "");
    }

    s = s.replace(/\\\\(?:\[[^\]]*\])?/g, "\n");
    s = s.replace(/\\quad\b|\\qquad\b|\\,/g, " ");
    s = s.replace(/\\vspace\s*\{[^}]*\}/g, "");
    s = s.replace(/\\hspace\s*\{[^}]*\}/g, " ");
    s = s.replace(/\\hfill\b|\\vfill\b/g, " ");
    s = s.replace(/\\newline\b|\\linebreak\b/g, "\n");
    s = s.replace(/\\item\b(?:\[[^\]]*\])?/g, "\n- ");

    s = unwrapBareGroups(s);
    return s;
}

/** Convert inline-ish latex fragment to plain-ish markdown. */
function inlineTex(fragment: string): string {
    let s = protectEscaped(fragment);
    s = s.replace(/\\rightarrow\b/g, "→").replace(/\\leftarrow\b/g, "←");
    s = s.replace(/\$([^$]*)\$/g, "$1");
    s = replaceCommand(s, "href", 2, ([url, text]) => `[${inlineTex(text)}](${url.trim()})`);
    s = replaceCommand(s, "textbf", 1, ([t]) => `**${inlineTex(t)}**`);
    s = replaceCommand(s, "textit", 1, ([t]) => `*${inlineTex(t)}*`);
    s = replaceCommand(s, "emph", 1, ([t]) => `*${inlineTex(t)}*`);
    s = replaceCommand(s, "texttt", 1, ([t]) => `\`${inlineTex(t)}\``);
    s = replaceCommand(s, "underline", 1, ([t]) => inlineTex(t));
    for (const name of ["Huge", "huge", "Large", "large", "small", "bfseries", "itshape", "scshape"]) {
        s = s.replace(new RegExp(`\\\\${name}\\b`, "g"), "");
    }
    s = s.replace(/\\[a-zA-Z@]+\*?/g, "");
    s = s.replace(/[{}]/g, "");
    s = decodeLatexChars(s);
    return s.replace(/\s+/g, " ").trim();
}

/**
 * Replace `\name{a}{b}…` (n brace groups) with `fn(args)`.
 * Optional `[...]` after the name is skipped (and ignored).
 */
function replaceCommand(
    src: string,
    name: string,
    arity: number,
    fn: (args: string[]) => string,
): string {
    let s = src;
    const re = new RegExp(`\\\\${name}\\b`);
    for (;;) {
        const m = re.exec(s);
        if (!m) break;
        const start = m.index;
        let i = start + m[0].length;
        while (i < s.length && /\s/.test(s[i])) i++;
        if (s[i] === "[") {
            const end = matchBracket(s, i, "[", "]");
            if (end < 0) break;
            i = end + 1;
            while (i < s.length && /\s/.test(s[i])) i++;
        }
        const args: string[] = [];
        let ok = true;
        for (let a = 0; a < arity; a++) {
            while (i < s.length && /\s/.test(s[i])) i++;
            if (s[i] !== "{") {
                ok = false;
                break;
            }
            const end = matchBracket(s, i, "{", "}");
            if (end < 0) {
                ok = false;
                break;
            }
            args.push(s.slice(i + 1, end));
            i = end + 1;
        }
        if (!ok) {
            s = s.slice(0, start) + s.slice(start + m[0].length);
            re.lastIndex = 0;
            continue;
        }
        const replacement = fn(args);
        s = s.slice(0, start) + replacement + s.slice(i);
        re.lastIndex = 0;
    }
    return s;
}

function stripEnvironments(src: string): string {
    let s = src;
    s = dropBeginEnv(s, "tabular*");
    s = dropBeginEnv(s, "tabular");
    s = s.replace(/\\end\s*\{\s*tabular\*?\s*\}/gi, "\n");
    for (const env of [
        "itemize",
        "enumerate",
        "description",
        "center",
        "flushleft",
        "flushright",
        "minipage",
        "document",
    ]) {
        s = s.replace(new RegExp(`\\\\begin\\s*\\{\\s*${env}\\s*\\}(?:\\[[^\\]]*\\])?`, "gi"), "\n");
        s = s.replace(new RegExp(`\\\\end\\s*\\{\\s*${env}\\s*\\}`, "gi"), "\n");
    }
    // Table column separators (escaped \& is PH.amp already).
    s = s.replace(/\s*&\s*/g, " · ");
    return s;
}

/** Remove `\begin{name}` plus following brace-groups (width/colspec). */
function dropBeginEnv(src: string, name: string): string {
    let s = src;
    const re = new RegExp(`\\\\begin\\s*\\{\\s*${name.replace("*", "\\*")}\\s*\\}`, "i");
    for (;;) {
        const m = re.exec(s);
        if (!m) break;
        let i = m.index + m[0].length;
        for (let n = 0; n < 3; n++) {
            while (i < s.length && /\s/.test(s[i])) i++;
            if (s[i] !== "{") break;
            const end = matchBracket(s, i, "{", "}");
            if (end < 0) break;
            i = end + 1;
        }
        s = s.slice(0, m.index) + "\n" + s.slice(i);
        re.lastIndex = 0;
    }
    return s;
}

/** Remove residual \unknown{...} keeping the innermost text args joined. */
function stripLeftoverCommands(src: string): string {
    let s = src;
    for (let pass = 0; pass < 12; pass++) {
        const next = s.replace(/\\[a-zA-Z@]+\*?(?:\s*\[[^\]]*\])?\s*\{([^{}]*)\}/g, "$1");
        if (next === s) break;
        s = next;
    }
    s = s.replace(/\\[a-zA-Z@]+\*?/g, "");
    s = s.replace(/[{}]/g, "");
    return s;
}

function unwrapBareGroups(src: string): string {
    return src.replace(/\{([^{}]*)\}/g, "$1");
}

function decodeLatexChars(src: string): string {
    return src
        .replaceAll(PH.amp, "&")
        .replaceAll(PH.pct, "%")
        .replaceAll(PH.dol, "$")
        .replaceAll(PH.hash, "#")
        .replaceAll(PH.us, "_")
        .replace(/\\\{/g, "{")
        .replace(/\\\}/g, "}")
        .replace(/---/g, "—")
        .replace(/--/g, "–")
        .replace(/``/g, "“")
        .replace(/''/g, "”");
}

function tidyWhitespace(src: string): string {
    return src
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ");
}

/** Find matching closing bracket; `openIdx` points at the opener. Returns -1 if unmatched. */
function matchBracket(s: string, openIdx: number, open: string, close: string): number {
    if (s[openIdx] !== open) return -1;
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
        const c = s[i];
        if (c === "\\" && i + 1 < s.length) {
            i++;
            continue;
        }
        if (c === open) depth++;
        else if (c === close) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}
