import chalk from "chalk";
import type { MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { highlightCode } from "./highlight.ts";

export function getMarkdownTheme(): MarkdownTheme {
    return {
        heading: (text) => chalk.cyan.bold(text),
        link: (text) => chalk.blue(text),
        linkUrl: (text) => chalk.gray(text),
        code: (text) => chalk.yellow(text),
        codeBlock: (text) => chalk.gray(text),
        codeBlockBorder: (text) => chalk.dim.gray(text),
        quote: (text) => chalk.italic.gray(text),
        quoteBorder: (text) => chalk.magenta(text),
        hr: (text) => chalk.dim.gray(text),
        listBullet: (text) => chalk.magenta(text),
        bold: (text) => chalk.bold(text),
        italic: (text) => chalk.italic(text),
        underline: (text) => chalk.underline(text),
        strikethrough: (text) => chalk.strikethrough(text),
        highlightCode: (code, lang) => highlightCode(code, lang),
    };
}

export function getSelectListTheme(): SelectListTheme {
    return {
        selectedPrefix: (text) => chalk.cyan(text),
        selectedText: (text) => chalk.cyan(text),
        description: (text) => chalk.gray(text),
        scrollInfo: (text) => chalk.gray(text),
        noMatch: (text) => chalk.gray(text),
    };
}
