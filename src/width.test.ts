import { afterAll, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { graphemeWidth, installWidthModel, setWidthCalibration } from "./width.ts";
import { renderMarkdown } from "./render.ts";

const DEFAULTS = { spacingMarkWidth: 1, shapedClusters: false, clampClusters: false } as const;

installWidthModel();
afterAll(() => setWidthCalibration({ ...DEFAULTS }));

describe("grapheme width", () => {
    test("ASCII and CJK are unchanged", () => {
        expect(graphemeWidth("a")).toBe(1);
        expect(graphemeWidth("漢")).toBe(2);
        expect(graphemeWidth("🙂")).toBe(2);
    });

    test("Devanagari spacing marks take a cell, nonspacing marks do not", () => {
        setWidthCalibration({ ...DEFAULTS });
        expect(graphemeWidth("क")).toBe(1); // bare consonant
        expect(graphemeWidth("की")).toBe(2); // + spacing matra ी (Mc)
        expect(graphemeWidth("कि")).toBe(2); // + ि, also Mc despite rendering left
        expect(graphemeWidth("कं")).toBe(1); // + anusvara ं (Mn) — no cell
        expect(graphemeWidth("प्रे")).toBe(2); // प + ् (Mn) + र + े (Mn)
    });

    test("Thai and Hangul jamo compose instead of adding cells", () => {
        expect(graphemeWidth("กิ")).toBe(1); // Thai vowel above is nonspacing
        expect(graphemeWidth("한")).toBe(2); // precomposed Hangul syllable
        expect(graphemeWidth("가")).toBe(2); // jamo compose into one cell pair
    });

    test("a shaping terminal fits the whole cluster in the base cell", () => {
        setWidthCalibration({ spacingMarkWidth: 1, shapedClusters: true, clampClusters: false });
        expect(graphemeWidth("की")).toBe(1);
        expect(graphemeWidth("स्त्र")).toBe(1);
        setWidthCalibration({ ...DEFAULTS });
    });

    test("a clamping terminal caps a cluster at one cell pair", () => {
        // र् + मा sums to 3 under the default model; Ghostty draws 2.
        expect(graphemeWidth("र्मा")).toBe(3);
        setWidthCalibration({ spacingMarkWidth: 1, shapedClusters: false, clampClusters: true });
        expect(graphemeWidth("र्मा")).toBe(2);
        setWidthCalibration({ ...DEFAULTS });
    });
});

describe("layout holds for stacked scripts", () => {
    const DEVANAGARI = [
        "| भाषा | वर्ष |",
        "| --- | --- |",
        "| हिंदी | 1936 |",
        "| मराठी | 1960 |",
        "",
        "```python",
        "# हिंदी टिप्पणी — Devanagari inside code",
        'नाम = "प्रेमचंद"',
        "```",
        "",
    ].join("\n");

    /** Widths of every row of every ┌…└ block, per block. */
    function framedBlocks(src: string, width: number): number[][] {
        const lines = renderMarkdown(src, width).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
        const blocks: number[][] = [];
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i]!.trimStart().startsWith("┌")) continue;
            const widths: number[] = [];
            for (; i < lines.length; i++) {
                widths.push(visibleWidth(lines[i]!));
                if (lines[i]!.trimStart().startsWith("└")) break;
            }
            blocks.push(widths);
        }
        return blocks;
    }

    // Whatever the terminal does with clusters, the frame it draws has to be a
    // rectangle: every row of a table or code box measures the same.
    for (const [name, cal] of [
        ["per-codepoint terminals", { spacingMarkWidth: 1, shapedClusters: false, clampClusters: false }],
        ["shaping terminals", { spacingMarkWidth: 1, shapedClusters: true, clampClusters: false }],
        ["clamping terminals (Ghostty)", { spacingMarkWidth: 1, shapedClusters: false, clampClusters: true }],
    ] as const) {
        test(`frames stay rectangular on ${name}`, () => {
            setWidthCalibration({ ...cal });
            const blocks = framedBlocks(DEVANAGARI, 80);
            expect(blocks.length).toBe(2); // the table and the code box
            for (const widths of blocks) {
                expect(new Set(widths).size).toBe(1);
            }
            setWidthCalibration({ ...DEFAULTS });
        });
    }

    test("no rendered line overflows the requested width", () => {
        setWidthCalibration({ ...DEFAULTS });
        for (const line of renderMarkdown(DEVANAGARI, 40)) {
            expect(visibleWidth(line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())).toBeLessThanOrEqual(40);
        }
    });
});

describe("pi-tui measures through the installed model", () => {
    test("a Devanagari word is measured by cells, not clusters", () => {
        setWidthCalibration({ ...DEFAULTS });
        // भ + ा + ष + ा — upstream counts the two clusters as 2 columns.
        expect(visibleWidth("भाषा")).toBe(4);
        expect(visibleWidth("हिंदी")).toBe(4); // ह + ि(Mc) + ं(Mn) + द + ी(Mc)
    });

    test("recalibration re-measures previously cached strings", () => {
        setWidthCalibration({ ...DEFAULTS });
        expect(visibleWidth("भाषा")).toBe(4);
        setWidthCalibration({ spacingMarkWidth: 1, shapedClusters: true, clampClusters: false });
        expect(visibleWidth("भाषा")).toBe(2);
        setWidthCalibration({ ...DEFAULTS });
        expect(visibleWidth("भाषा")).toBe(4);
    });

    test("ASCII stays on the fast path", () => {
        expect(visibleWidth("hello world")).toBe(11);
    });
});
