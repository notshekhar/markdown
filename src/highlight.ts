// Syntax highlighting: highlight.js HTML output → ANSI, ported from pi's
// theme.ts. We highlight against the common language set (~35 languages),
// which covers every extension we map in getLanguageFromPath.

import hljs from "highlight.js/lib/common";
import chalk from "chalk";

type Formatter = (s: string) => string;
type HighlightTheme = Record<string, Formatter>;

const highlightTheme: HighlightTheme = {
    keyword: (s) => chalk.magenta(s),
    built_in: (s) => chalk.cyan(s),
    literal: (s) => chalk.yellow(s),
    number: (s) => chalk.yellow(s),
    string: (s) => chalk.green(s),
    comment: (s) => chalk.gray(s),
    function: (s) => chalk.blue(s),
    title: (s) => chalk.blue(s),
    class: (s) => chalk.cyan(s),
    type: (s) => chalk.cyan(s),
    attr: (s) => chalk.cyan(s),
    variable: (s) => chalk.red(s),
    params: (s) => chalk.red(s),
    operator: (s) => chalk.white(s),
    punctuation: (s) => chalk.white(s),
    meta: (s) => chalk.gray(s),
    "selector-tag": (s) => chalk.magenta(s),
    "selector-class": (s) => chalk.cyan(s),
    "selector-id": (s) => chalk.yellow(s),
    section: (s) => chalk.blue.bold(s),
    bullet: (s) => chalk.yellow(s),
    symbol: (s) => chalk.yellow(s),
    name: (s) => chalk.blue(s),
};

const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#x27;": "'",
};

function formatterFor(scope: string): Formatter | undefined {
    if (highlightTheme[scope]) {
        return highlightTheme[scope];
    }
    const dot = scope.indexOf(".");
    if (dot !== -1 && highlightTheme[scope.slice(0, dot)]) {
        return highlightTheme[scope.slice(0, dot)];
    }
    const dash = scope.indexOf("-");
    if (dash !== -1 && highlightTheme[scope.slice(0, dash)]) {
        return highlightTheme[scope.slice(0, dash)];
    }
    return undefined;
}

/** Convert hljs HTML span markup to ANSI. */
function renderHighlightedHtml(html: string): string {
    let output = "";
    let textBuffer = "";
    const scopes: Array<string | undefined> = [];

    const flush = () => {
        if (!textBuffer) {
            return;
        }
        let formatter: Formatter | undefined;
        for (let i = scopes.length - 1; i >= 0; i--) {
            const scope = scopes[i];
            if (scope) {
                formatter = formatterFor(scope);
                if (formatter) {
                    break;
                }
            }
        }
        output += formatter ? formatter(textBuffer) : textBuffer;
        textBuffer = "";
    };

    let i = 0;
    while (i < html.length) {
        if (html.startsWith("<span", i)) {
            const end = html.indexOf(">", i + 5);
            if (end !== -1) {
                flush();
                const tag = html.slice(i, end + 1);
                const m = /class\s*=\s*"([^"]*)"/.exec(tag);
                const cls = m?.[1]?.split(/\s+/).find((c) => c.startsWith("hljs-"));
                scopes.push(cls ? cls.slice(5) : undefined);
                i = end + 1;
                continue;
            }
        }
        if (html.startsWith("</span>", i)) {
            flush();
            scopes.pop();
            i += 7;
            continue;
        }
        if (html[i] === "&") {
            const entity = Object.keys(ENTITIES).find((e) => html.startsWith(e, i));
            if (entity) {
                textBuffer += ENTITIES[entity];
                i += entity.length;
                continue;
            }
        }
        textBuffer += html[i];
        i++;
    }
    flush();
    return output;
}

export function highlightCode(code: string, lang?: string): string[] {
    // No valid language → dim plain text. Auto-detection is unreliable, so we
    // never guess (mirrors pi).
    const validLang = lang && hljs.getLanguage(lang) ? lang : undefined;
    if (!validLang) {
        return code.split("\n").map((line) => chalk.gray(line));
    }
    try {
        const html = hljs.highlight(code, { language: validLang, ignoreIllegals: true }).value;
        return renderHighlightedHtml(html).split("\n");
    } catch {
        return code.split("\n").map((line) => chalk.gray(line));
    }
}
