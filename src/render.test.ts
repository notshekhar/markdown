import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./render.ts";

// chalk is level 0 under `bun test` (no TTY), so these assert on plain text.
const strip = (lines: string[]) => lines.join("\n");

describe("fenced code blocks", () => {
    test("are framed, with the language on the border and no fence markers", () => {
        const out = renderMarkdown("```ts\nconst x = 1;\n```\n", 80);
        const text = strip(out);
        expect(text).not.toContain("```");
        expect(text).toContain("┌─ ts ");
        expect(text).toContain("│ const x = 1;");
        expect(text).toContain("└");
    });

    test("a bare fence still gets a box, without a label", () => {
        const text = strip(renderMarkdown("```\nplain text\n```\n", 80));
        expect(text).not.toContain("```");
        expect(text).toMatch(/┌─+┐/);
        expect(text).toContain("│ plain text");
    });

    test("the box never exceeds the content width; long lines wrap inside it", () => {
        const long = "x".repeat(200);
        const out = renderMarkdown("```\n" + long + "\n```\n", 40);
        for (const line of out) {
            expect(line.length).toBeLessThanOrEqual(40);
        }
        // Every character survives the wrap.
        expect(strip(out).split("x").length - 1).toBe(200);
    });

    test("blank lines separate the block from surrounding prose exactly once", () => {
        const out = renderMarkdown("before\n\n```ts\ncode\n```\n\nafter\n", 80);
        const top = out.findIndex((l) => l.includes("┌"));
        const bottom = out.findIndex((l) => l.includes("└"));
        expect(out[top - 1]?.trim()).toBe("");
        expect(out[top - 2]?.trim()).toBe("before");
        expect(out[bottom + 1]?.trim()).toBe("");
        expect(out[bottom + 2]?.trim()).toBe("after");
    });

    test("a fence indented inside a list stays with the list", () => {
        // Pulling it out would split the list and restart its numbering.
        const src = "1. one\n\n   ```sh\n   ls\n   ```\n\n2. two\n";
        const text = strip(renderMarkdown(src, 80));
        expect(text).toContain("1.");
        expect(text).toContain("2.");
    });

    test("mermaid fences are still diagrams, not code boxes", () => {
        const text = strip(renderMarkdown("```mermaid\ngraph TD;\nA-->B;\n```\n", 80));
        expect(text).not.toContain("┌─ mermaid");
    });
});
