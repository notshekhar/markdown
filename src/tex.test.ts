import { describe, expect, test } from "bun:test";
import { texToMarkdown } from "./tex.ts";

describe("texToMarkdown", () => {
    test("extracts document body and renders sections", () => {
        const md = texToMarkdown(String.raw`
\documentclass{article}
\usepackage{hyperref}
\begin{document}
\section{Hello}
World \& friends.
\end{document}
`);
        expect(md).toContain("## Hello");
        expect(md).toContain("World & friends.");
        expect(md).not.toContain("usepackage");
        expect(md).not.toContain("documentclass");
    });

    test("expands resume macros", () => {
        const md = texToMarkdown(String.raw`
\begin{document}
\resumeSubheading{Pronto}{Bangalore}{SDE 2}{2025 -- Present}
\resumeItem{Matching}{Built PostGIS matching.}
\end{document}
`);
        expect(md).toContain("### Pronto · Bangalore");
        expect(md).toContain("SDE 2 · 2025 – Present");
        expect(md).toContain("**Matching**: Built PostGIS matching.");
    });

    test("href and textbf", () => {
        const md = texToMarkdown(String.raw`
\begin{document}
\href{https://example.com}{Example} and \textbf{bold}.
\end{document}
`);
        expect(md).toContain("[Example](https://example.com)");
        expect(md).toContain("**bold**");
    });

    test("strips percent comments", () => {
        const md = texToMarkdown(String.raw`
\begin{document}
Keep me
% hide me
\end{document}
`);
        expect(md).toContain("Keep me");
        expect(md).not.toContain("hide me");
    });
});
