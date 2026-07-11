import type { MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { highlightCode } from "./highlight.ts";
import { uiStyle } from "./ui-mode.ts";

/** Markdown renderer theme — follows the active UI mode. */
export function getMarkdownTheme(): MarkdownTheme {
    const c = uiStyle().colors;
    return {
        heading: c.heading,
        link: c.link,
        linkUrl: c.linkUrl,
        code: c.code,
        codeBlock: c.codeBlock,
        codeBlockBorder: c.codeBlockBorder,
        quote: c.quote,
        quoteBorder: c.quoteBorder,
        hr: c.hr,
        listBullet: c.listBullet,
        bold: c.bold,
        italic: c.italic,
        underline: c.underline,
        strikethrough: c.strikethrough,
        highlightCode: (code, lang) => highlightCode(code, lang),
    };
}

export function getSelectListTheme(): SelectListTheme {
    const c = uiStyle().colors;
    return {
        selectedPrefix: c.selected,
        selectedText: c.selected,
        description: c.muted,
        scrollInfo: c.muted,
        noMatch: c.muted,
    };
}
