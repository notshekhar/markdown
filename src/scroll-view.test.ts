import { expect, test } from "bun:test";
import chalk from "chalk";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ScrollView } from "./scroll-view.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");

/** Build a viewer over fixed styled lines and prime its width cache. */
function viewer(lines: string[], width = 80): ScrollView {
    const v = new ScrollView("t", () => lines);
    v.render(width); // populate the width-keyed line cache
    return v;
}

function type(v: ScrollView, text: string): void {
    for (const ch of text) v.handleInput(ch);
}

test("clamps every body line to the viewport width (no wrap on wide content)", () => {
    const wide = "x".repeat(500);
    const v = viewer([wide, chalk.red("y".repeat(500))]);
    for (const line of v.render(80)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
});

test("search finds matches and reports a count", () => {
    const v = viewer(["the quick brown fox", "the lazy dog", chalk.green("another fox here")]);
    v.handleInput("F"); // shift+f
    type(v, "fox");
    const footer = strip(v.render(80).at(-1) ?? "");
    expect(footer).toContain("[1/2]"); // two "fox" occurrences
});

test("highlighting preserves the line's text and width", () => {
    const plain = "see the bright fox run";
    const styled = chalk.cyan("see the ") + chalk.bold("bright fox") + chalk.cyan(" run");
    const v = viewer([styled]);
    v.handleInput("F");
    type(v, "fox");
    const body = v.render(80).slice(2, -1); // drop header+rule and footer
    const row = body.find((l) => strip(l).includes("fox"));
    expect(row).toBeDefined();
    // Text is intact (gutter + original content) and nothing overflowed.
    expect(strip(row!).trimEnd()).toBe(`  ${plain}`);
    expect(visibleWidth(row!)).toBeLessThanOrEqual(80);
});

test("esc clears an active search before leaving the viewer", () => {
    let backCalls = 0;
    const v = viewer(["alpha beta", "gamma"]);
    v.onBack = () => backCalls++;
    v.handleInput("F");
    type(v, "beta");
    v.handleInput("\r"); // commit (enter)
    v.handleInput("\x1b"); // esc → clears search, does NOT go back
    expect(backCalls).toBe(0);
    expect(strip(v.render(80).at(-1) ?? "")).not.toContain("[");
    v.handleInput("\x1b"); // esc again → now leaves
    expect(backCalls).toBe(1);
});

test("backspace never exits the file", () => {
    let backCalls = 0;
    const v = viewer(["alpha beta", "gamma"]);
    v.onBack = () => backCalls++;
    // Backspace with nothing typed must not call onBack.
    v.handleInput("\x7f");
    v.handleInput("\x7f");
    expect(backCalls).toBe(0);
    // After committing a search, backspace clears it but still never exits.
    v.handleInput("/");
    type(v, "beta");
    v.handleInput("\r");
    v.handleInput("\x7f"); // clears search
    v.handleInput("\x7f"); // no search, still does not exit
    expect(backCalls).toBe(0);
    expect(strip(v.render(80).at(-1) ?? "")).not.toContain("[");
});

test("slash opens search just like Shift+F", () => {
    const v = viewer(["find the needle", "needle again"]);
    v.handleInput("/");
    type(v, "needle");
    expect(strip(v.render(80).at(-1) ?? "")).toContain("[1/2]");
});

test("horizontal pan reveals content past the right edge", () => {
    const line = "START" + "-".repeat(120) + "END";
    const v = viewer([line], 40);
    const before = strip(v.render(40).slice(2, -1)[0] ?? "");
    expect(before).toContain("START");
    expect(before).not.toContain("END");
    for (let i = 0; i < 12; i++) v.handleInput("\x1b[C"); // pan right toward the tail
    const after = strip(v.render(40).slice(2, -1)[0] ?? "");
    expect(after).toContain("END");
});
