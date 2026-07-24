/**
 * UI modes for the markdown viewer — same idea as loop's pluggable modes, scaled
 * to a document surface (not a chat transcript).
 *
 * Builtin modes:
 *   - `md`   — today's look (default): cyan header pill, no canvas wash
 *   - `noir` — dark cockpit: OSC 11 wash, raised header, accent gutters
 *
 * Mode is toggled with `u` and persisted in ~/.markdown/state.db by the app
 * layer (this module stays pure); `--ui <id>` / `MD_UI_MODE` override it.
 */

export type UiModeId = "md" | "noir";

export interface UiStyleSpec {
    canvas: {
        /** Paint the terminal background via OSC 11 (theme bgBase). */
        wash: boolean;
        /** Hex background for OSC 11 when wash is on. */
        bgBase: string;
    };
    header: {
        /** "pill" = cyan inverse bar (classic). "bar" = raised dark strip (noir). */
        style: "pill" | "bar";
        /** Accent glyph before the title ("" = none). */
        prefix: string;
    };
    body: {
        /** Left accent gutter on content lines ("" = plain margin). */
        gutter: string;
        /** Extra left margin columns beyond the gutter glyph. */
        margin: number;
    };
    chrome: {
        /** Rule under the header. */
        rule: boolean;
        /** Show active mode id in the footer. */
        modeBadge: boolean;
    };
    colors: {
        heading: (s: string) => string;
        link: (s: string) => string;
        linkUrl: (s: string) => string;
        code: (s: string) => string;
        codeBlock: (s: string) => string;
        codeBlockBorder: (s: string) => string;
        quote: (s: string) => string;
        quoteBorder: (s: string) => string;
        hr: (s: string) => string;
        listBullet: (s: string) => string;
        bold: (s: string) => string;
        italic: (s: string) => string;
        underline: (s: string) => string;
        strikethrough: (s: string) => string;
        headerBg: (s: string) => string;
        headerText: (s: string) => string;
        rule: (s: string) => string;
        muted: (s: string) => string;
        accent: (s: string) => string;
        gutter: (s: string) => string;
        selected: (s: string) => string;
        browserHeading: (s: string) => string;
        searchHit: (s: string) => string;
        searchCurrent: (s: string) => string;
    };
}

export interface UiModePlugin {
    id: UiModeId;
    name: string;
    style: UiStyleSpec;
}

// Lazy chalk import via function so themes stay sync and tree-shake friendly
// in tests that don't paint.
import chalk from "chalk";

// The accent, shared with the web UI (its --accent is oklch(0.78 0.13 168)).
// One jade, two weights: JADE for text on the canvas, JADE_DEEP for text on a
// jade background (the header pill, search hits).
const JADE = "#3ddca4";
const JADE_DEEP = "#0c3b2c";
// noir runs its accents a shade cooler and darker than the md mode's.
const JADE_DIM = "#57c99a";

const MD_STYLE: UiStyleSpec = {
    canvas: { wash: false, bgBase: "#0d1117" },
    header: { style: "pill", prefix: "" },
    body: { gutter: "", margin: 2 },
    chrome: { rule: true, modeBadge: false },
    colors: {
        heading: (s) => chalk.hex(JADE).bold(s),
        link: (s) => chalk.blue(s),
        linkUrl: (s) => chalk.gray(s),
        code: (s) => chalk.yellow(s),
        codeBlock: (s) => chalk.gray(s),
        codeBlockBorder: (s) => chalk.dim.gray(s),
        quote: (s) => chalk.italic.gray(s),
        quoteBorder: (s) => chalk.hex(JADE)(s),
        hr: (s) => chalk.dim.gray(s),
        listBullet: (s) => chalk.hex(JADE)(s),
        bold: (s) => chalk.bold(s),
        italic: (s) => chalk.italic(s),
        underline: (s) => chalk.underline(s),
        strikethrough: (s) => chalk.strikethrough(s),
        headerBg: (s) => chalk.bgHex(JADE).hex(JADE_DEEP).bold(s),
        headerText: (s) => chalk.hex(JADE_DEEP).bold(s),
        rule: (s) => chalk.dim.gray(s),
        muted: (s) => chalk.gray(s),
        accent: (s) => chalk.hex(JADE)(s),
        gutter: (s) => chalk.dim.gray(s),
        selected: (s) => chalk.hex(JADE)(s),
        browserHeading: (s) => chalk.hex(JADE).bold(s),
        searchHit: (s) => chalk.hex(JADE_DEEP).bgHex(JADE)(s),
        searchCurrent: (s) => chalk.black.bgYellow(s),
    },
};

const NOIR_STYLE: UiStyleSpec = {
    canvas: { wash: true, bgBase: "#141414" },
    header: { style: "bar", prefix: "◆ " },
    body: { gutter: "┃", margin: 1 },
    chrome: { rule: true, modeBadge: true },
    colors: {
        heading: (s) => chalk.hex("#e5c07b").bold(s),
        link: (s) => chalk.hex("#61afef")(s),
        linkUrl: (s) => chalk.hex("#5f5f5f")(s),
        code: (s) => chalk.hex("#c678dd")(s),
        codeBlock: (s) => chalk.hex("#98c379")(s),
        codeBlockBorder: (s) => chalk.hex("#5f5f5f")(s),
        quote: (s) => chalk.italic.hex("#8a8a8a")(s),
        quoteBorder: (s) => chalk.hex(JADE_DIM)(s),
        hr: (s) => chalk.hex("#3a3a3a")(s),
        listBullet: (s) => chalk.hex(JADE_DIM)(s),
        bold: (s) => chalk.bold.hex("#e0e0e0")(s),
        italic: (s) => chalk.italic.hex("#e0e0e0")(s),
        underline: (s) => chalk.underline(s),
        strikethrough: (s) => chalk.strikethrough(s),
        // Raised bar: dark strip + jade accent, not a cyan pill.
        headerBg: (s) => chalk.bgHex("#242424").hex(JADE_DIM).bold(s),
        headerText: (s) => chalk.hex("#e0e0e0").bold(s),
        rule: (s) => chalk.hex("#3a3a3a")(s),
        muted: (s) => chalk.hex("#8a8a8a")(s),
        accent: (s) => chalk.hex(JADE_DIM)(s),
        gutter: (s) => chalk.hex("#5f5f5f")(s),
        selected: (s) => chalk.hex(JADE_DIM)(s),
        browserHeading: (s) => chalk.hex(JADE_DIM).bold(s),
        searchHit: (s) => chalk.hex(JADE_DEEP).bgHex(JADE_DIM)(s),
        searchCurrent: (s) => chalk.black.bgHex("#e5c07b")(s),
    },
};

const MD_MODE: UiModePlugin = { id: "md", name: "Markdown", style: MD_STYLE };
const NOIR_MODE: UiModePlugin = { id: "noir", name: "Noir", style: NOIR_STYLE };

const modes = new Map<string, UiModePlugin>([
    [MD_MODE.id, MD_MODE],
    [NOIR_MODE.id, NOIR_MODE],
]);

let activeId: string = MD_MODE.id;

export function listUiModes(): UiModePlugin[] {
    return [...modes.values()];
}

export function getUiMode(id: string): UiModePlugin | undefined {
    return modes.get(id);
}

export function activeUiMode(): UiModePlugin {
    return modes.get(activeId) ?? MD_MODE;
}

export function uiStyle(): UiStyleSpec {
    return activeUiMode().style;
}

/** Activate a registered mode. Unknown ids return false. */
export function setActiveUiMode(id: string): boolean {
    if (!modes.has(id)) return false;
    activeId = id;
    return true;
}

/** Cycle md → noir → md … Returns the newly active mode. */
export function cycleUiMode(): UiModePlugin {
    const ids = [...modes.keys()];
    const i = ids.indexOf(activeId);
    const next = ids[(i + 1) % ids.length] ?? MD_MODE.id;
    setActiveUiMode(next);
    return activeUiMode();
}

/**
 * Resolve the startup mode: CLI flag → env → the stored pref (`u` toggles are
 * remembered in ~/.markdown/state.db) → `md`.
 */
export function resolveUiModeFromEnv(flag?: string | null, stored?: string | null): UiModeId {
    const raw = (flag ?? process.env.MD_UI_MODE ?? stored ?? "md").trim().toLowerCase();
    if (raw === "noir" || raw === "grok" || raw === "night") return "noir";
    return "md";
}
