// Mermaid rendering for the terminal.
//
//   1. Image mode (opt-in, MD_MERMAID_IMAGES=1): render via the mermaid CLI to
//      a PNG and emit it inline on iTerm2/kitty. Heavy (pulls a headless
//      browser), so it is never the default.
//   2. Flow mode: parse `graph`/`flowchart` diagrams and draw the nodes and
//      labeled edges as a readable flow.
//   3. Box mode: for diagram types we don't lay out (sequence, class, ...),
//      show the source in a titled panel.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import chalk from "chalk";
import {
    getCapabilities,
    getPngDimensions,
    renderImage,
    visibleWidth,
} from "@earendil-works/pi-tui";

export interface MermaidOptions {
    images?: boolean;
}

export function renderMermaid(code: string, width: number, options: MermaidOptions = {}): string[] {
    if (options.images) {
        const image = renderMermaidImage(code, width);
        if (image) {
            return image;
        }
    }
    const flow = renderFlowchart(code, width);
    if (flow) {
        return flow;
    }
    return renderMermaidBox("mermaid", code, width);
}

// ---------------------------------------------------------------------------
// Flowchart parsing + drawing
// ---------------------------------------------------------------------------

type Shape = "rect" | "round" | "stadium" | "diamond" | "circle";

interface Node {
    id: string;
    label: string;
    shape: Shape;
}

interface Edge {
    from: string;
    to: string;
    label?: string;
}

const SHAPE_WRAP: Record<Shape, [string, string]> = {
    rect: ["[", "]"],
    round: ["(", ")"],
    stadium: ["([", "])"],
    diamond: ["{", "}"],
    circle: ["((", "))"],
};

// Matches `Id`, optionally followed by a shaped label: A[x] A(x) A([x]) A{x} A((x))
const NODE_RE = /([A-Za-z0-9_]+)(\(\(([^)]*)\)\)|\(\[([^\]]*)\]\)|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?/;
// Arrow operators, with an optional `|label|`.
const ARROW_RE = /\s*(?:-{2,}>|-\.->|={2,}>|-{3,}|-\.-)\s*(?:\|([^|]*)\|)?\s*/;

function renderFlowchart(code: string, width: number): string[] | null {
    const lines = code
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) {
        return null;
    }

    const headerMatch = /^(graph|flowchart)\s+([A-Za-z]{2})?/.exec(lines[0]);
    if (!headerMatch) {
        return null;
    }
    const direction = headerMatch[2] ?? "TD";

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    const remember = (raw: string): string | undefined => {
        const match = NODE_RE.exec(raw.trim());
        if (!match || !match[1]) {
            return undefined;
        }
        const id = match[1];
        const labelText = match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7];
        if (labelText !== undefined && !nodes.has(id)) {
            nodes.set(id, { id, label: cleanLabel(labelText), shape: shapeFor(match[2] ?? "") });
        } else if (!nodes.has(id)) {
            nodes.set(id, { id, label: id, shape: "rect" });
        }
        return id;
    };

    for (const line of lines.slice(1)) {
        if (!ARROW_RE.test(line)) {
            // Standalone node declaration (e.g. `A[Label]`).
            remember(line);
            continue;
        }
        parseEdgeChain(line, remember, edges);
    }

    if (edges.length === 0) {
        return null;
    }

    const body: string[] = [];
    for (const edge of edges) {
        const from = renderNode(nodes.get(edge.from));
        const to = renderNode(nodes.get(edge.to));
        const arrow = edge.label ? `──${chalk.yellow(edge.label)}──▶` : "──▶";
        body.push(`${from} ${chalk.gray(arrow)} ${to}`);
    }

    return boxed(`flowchart ${direction}`, body, width);
}

/** Split a chained edge line (`A --> B --> C`) into individual edges. */
function parseEdgeChain(line: string, remember: (raw: string) => string | undefined, edges: Edge[]): void {
    let rest = line;
    let previous: string | undefined;

    while (rest.length > 0) {
        const arrow = ARROW_RE.exec(rest);
        if (!arrow || arrow.index === undefined) {
            const id = remember(rest);
            if (previous && id) {
                edges.push({ from: previous, to: id });
            }
            break;
        }
        const left = rest.slice(0, arrow.index);
        const leftId = remember(left);
        const fromId = previous ?? leftId;
        rest = rest.slice(arrow.index + arrow[0].length);

        // Peek the next node so we can record the edge now.
        const nextArrow = ARROW_RE.exec(rest);
        const rightChunk = nextArrow && nextArrow.index !== undefined ? rest.slice(0, nextArrow.index) : rest;
        const toId = remember(rightChunk);
        if (fromId && toId) {
            edges.push({ from: fromId, to: toId, label: arrow[1]?.trim() || undefined });
        }
        previous = toId;
        if (!nextArrow) {
            break;
        }
    }
}

function shapeFor(wrapper: string): Shape {
    if (wrapper.startsWith("((")) return "circle";
    if (wrapper.startsWith("([")) return "stadium";
    if (wrapper.startsWith("(")) return "round";
    if (wrapper.startsWith("{")) return "diamond";
    return "rect";
}

function cleanLabel(text: string): string {
    return text.replace(/^["']|["']$/g, "").replace(/<br\s*\/?>/gi, " ").trim();
}

function renderNode(node: Node | undefined): string {
    if (!node) {
        return chalk.cyan("?");
    }
    const [open, close] = SHAPE_WRAP[node.shape];
    return chalk.cyan(`${open}${node.label}${close}`);
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

function renderMermaidBox(title: string, code: string, width: number): string[] {
    return boxed(title, code.split("\n").map((line) => chalk.gray(line)), width);
}

/** Draw a titled panel around pre-styled body lines. */
function boxed(title: string, body: string[], width: number): string[] {
    const inner = Math.max(visibleWidth(title) + 4, Math.min(width - 2, contentWidth(body) + 2));
    const titleBar = `─ ${title} `;
    const top = chalk.magenta(`┌${titleBar}${"─".repeat(Math.max(0, inner - visibleWidth(titleBar)))}┐`);
    const bottom = chalk.magenta(`└${"─".repeat(inner)}┘`);
    const out = [top];
    for (const line of body) {
        for (const chunk of wrapVisible(line, inner - 2)) {
            const pad = " ".repeat(Math.max(0, inner - 2 - visibleWidth(chunk)));
            out.push(`${chalk.magenta("│")} ${chunk}${pad} ${chalk.magenta("│")}`);
        }
    }
    out.push(bottom);
    return out;
}

function contentWidth(lines: string[]): number {
    return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

/** Wrap on visible width, keeping ANSI codes inline (they have zero width). */
function wrapVisible(text: string, width: number): string[] {
    if (visibleWidth(text) <= width) {
        return [text];
    }
    const out: string[] = [];
    let current = "";
    let currentWidth = 0;
    let i = 0;
    while (i < text.length) {
        if (text[i] === "\x1b") {
            const end = text.indexOf("m", i);
            if (end !== -1) {
                current += text.slice(i, end + 1);
                i = end + 1;
                continue;
            }
        }
        current += text[i];
        currentWidth += 1;
        if (currentWidth >= width) {
            out.push(current);
            current = "";
            currentWidth = 0;
        }
        i++;
    }
    if (current) {
        out.push(current);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Image mode
// ---------------------------------------------------------------------------

function renderMermaidImage(code: string, width: number): string[] | null {
    if (!getCapabilities().images) {
        return null;
    }
    const png = renderMermaidPng(code);
    if (!png) {
        return null;
    }
    const base64 = png.toString("base64");
    const dims = getPngDimensions(base64);
    if (!dims) {
        return null;
    }
    const result = renderImage(base64, dims, { maxWidthCells: Math.min(width, 80) });
    if (!result) {
        return null;
    }
    const lines = [result.sequence];
    for (let i = 1; i < result.rows; i++) {
        lines.push("");
    }
    return lines;
}

function renderMermaidPng(code: string): Buffer | null {
    let dir: string | undefined;
    try {
        dir = mkdtempSync(join(tmpdir(), "md-mermaid-"));
        const input = join(dir, "diagram.mmd");
        const output = join(dir, "diagram.png");
        writeFileSync(input, code, "utf8");
        const proc = Bun.spawnSync(
            ["bunx", "-y", "@mermaid-js/mermaid-cli", "-i", input, "-o", output, "-b", "transparent", "-s", "2"],
            { stdout: "ignore", stderr: "ignore" },
        );
        if (!proc.success) {
            return null;
        }
        return readFileSync(output);
    } catch {
        return null;
    } finally {
        if (dir) {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort cleanup
            }
        }
    }
}
