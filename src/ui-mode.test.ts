import { describe, expect, test, beforeEach } from "bun:test";
import {
    activeUiMode,
    cycleUiMode,
    listUiModes,
    resolveUiModeFromEnv,
    setActiveUiMode,
    uiStyle,
} from "./ui-mode.ts";

describe("ui modes", () => {
    beforeEach(() => {
        setActiveUiMode("md");
    });

    test("ships md + noir", () => {
        const ids = listUiModes().map((m) => m.id).sort();
        expect(ids).toEqual(["md", "noir"]);
    });

    test("md is the default", () => {
        expect(activeUiMode().id).toBe("md");
        expect(uiStyle().canvas.wash).toBe(false);
        expect(uiStyle().header.style).toBe("pill");
    });

    test("noir enables canvas wash and gutters", () => {
        expect(setActiveUiMode("noir")).toBe(true);
        expect(activeUiMode().id).toBe("noir");
        expect(uiStyle().canvas.wash).toBe(true);
        expect(uiStyle().canvas.bgBase).toBe("#141414");
        expect(uiStyle().body.gutter).toBe("┃");
        expect(uiStyle().header.prefix).toContain("◆");
    });

    test("cycle flips md ↔ noir", () => {
        expect(cycleUiMode().id).toBe("noir");
        expect(cycleUiMode().id).toBe("md");
    });

    test("unknown mode is refused", () => {
        expect(setActiveUiMode("matrix")).toBe(false);
        expect(activeUiMode().id).toBe("md");
    });

    test("resolveUiModeFromEnv aliases", () => {
        expect(resolveUiModeFromEnv("noir")).toBe("noir");
        expect(resolveUiModeFromEnv("grok")).toBe("noir");
        expect(resolveUiModeFromEnv("night")).toBe("noir");
        expect(resolveUiModeFromEnv("md")).toBe("md");
        expect(resolveUiModeFromEnv(null)).toBe("md");
    });
});
