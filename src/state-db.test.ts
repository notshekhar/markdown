import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "md-state-"));
process.env.MARKDOWN_CONFIG_DIR = dir;

const { closeDb, configDir, DB_FILE_NAME, getDb, pushRecent, readState, writePrefs, writeRootState } = await import(
    "./state-db.ts"
);

const ROOT_A = "/tmp/docs-a";
const ROOT_B = "/tmp/docs-b";

beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM recent; DELETE FROM root_state; DELETE FROM roots; DELETE FROM prefs;");
});

afterAll(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
});

describe("state db", () => {
    test("lives in the configured dir", () => {
        getDb();
        expect(configDir()).toBe(dir);
        expect(existsSync(join(dir, DB_FILE_NAME))).toBe(true);
    });

    test("empty state for an unseen root", () => {
        expect(readState(ROOT_A)).toEqual({ prefs: {}, root: {}, recent: [] });
    });

    test("prefs are global across roots", () => {
        writePrefs({ theme: "light", font: "serif" });
        expect(readState(ROOT_A).prefs).toEqual({ theme: "light", font: "serif" });
        expect(readState(ROOT_B).prefs).toEqual({ theme: "light", font: "serif" });
    });

    test("prefs update in place and ignore unknown keys", () => {
        writePrefs({ theme: "light" });
        writePrefs({ theme: "dark", nonsense: "x" });
        expect(readState(ROOT_A).prefs).toEqual({ theme: "dark" });
    });

    test("root state is per root and round-trips JSON", () => {
        writeRootState(ROOT_A, { expanded: ["guides", "guides/deep"], buffers: { open: ["a.md"], active: "a.md" } });
        writeRootState(ROOT_B, { expanded: [] });
        expect(readState(ROOT_A).root).toEqual({
            expanded: ["guides", "guides/deep"],
            buffers: { open: ["a.md"], active: "a.md" },
        });
        expect(readState(ROOT_B).root).toEqual({ expanded: [] });
    });

    test("root state ignores unknown keys", () => {
        writeRootState(ROOT_A, { expanded: ["x"], evil: "no" });
        expect(readState(ROOT_A).root).toEqual({ expanded: ["x"] });
    });

    test("recent is newest first, deduped, per root", () => {
        pushRecent(ROOT_A, "one.md");
        pushRecent(ROOT_A, "two.md");
        pushRecent(ROOT_A, "one.md");
        pushRecent(ROOT_B, "other.md");
        expect(readState(ROOT_A).recent).toEqual(["one.md", "two.md"]);
        expect(readState(ROOT_B).recent).toEqual(["other.md"]);
    });

    test("recent is capped at 20", () => {
        for (let i = 0; i < 25; i++) pushRecent(ROOT_A, `f${i}.md`);
        const recent = readState(ROOT_A).recent;
        expect(recent).toHaveLength(20);
        expect(recent[0]).toBe("f24.md");
        expect(recent).not.toContain("f0.md");
    });

    test("state survives a reopen", () => {
        writePrefs({ theme: "light" });
        writeRootState(ROOT_A, { expanded: ["docs"] });
        pushRecent(ROOT_A, "kept.md");
        closeDb();
        const after = readState(ROOT_A);
        expect(after.prefs.theme).toBe("light");
        expect(after.root.expanded).toEqual(["docs"]);
        expect(after.recent).toEqual(["kept.md"]);
    });
});
