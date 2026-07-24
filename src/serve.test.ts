import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./commands.ts";

// Spawned CLIs persist UI state; point them at a throwaway config dir so the
// suite never writes to the developer's real ~/.markdown.
const configDir = mkdtempSync(join(tmpdir(), "md-serve-test-"));
const childEnv = { ...process.env, MARKDOWN_CONFIG_DIR: configDir };
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

// Lightweight integration: spin serve via Bun.serve path by importing handle
// surface through a real subprocess would hang the suite, so we hit the same
// endpoints the CLI uses by starting runServe is hard to stop — instead smoke
// the HTML/API contract with a one-shot inline server mirroring serve.ts routes
// is overkill. Just verify the module loads and CLI help mentions serve.

describe("serve command", () => {
    test("cli help lists serve", async () => {
        const proc = Bun.spawn(["bun", join(packageRoot(), "src/cli.ts"), "help"], {
            stdout: "pipe",
            stderr: "pipe",
            env: childEnv,
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        expect(out).toContain("markdown serve");
        expect(out).toContain("--no-open");
        expect(out).toContain("light/dark");
    });

    test("serve boots and serves sample.md", async () => {
        const root = packageRoot();
        const port = 18765;
        const proc = Bun.spawn(
            ["bun", join(root, "src/cli.ts"), "serve", "sample.md", "--port", String(port), "--no-open"],
            { cwd: root, stdout: "pipe", stderr: "pipe", env: childEnv },
        );
        // Wait until listening.
        let ready = false;
        for (let i = 0; i < 40; i++) {
            await Bun.sleep(50);
            try {
                const r = await fetch(`http://127.0.0.1:${port}/api/file?path=sample.md`);
                if (r.ok) {
                    ready = true;
                    break;
                }
            } catch {
                /* retry */
            }
        }
        expect(ready).toBe(true);

        const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
        expect(html).toContain('data-theme="dark"');
        expect(html).toContain("[data-theme=\"light\"]");
        expect(html).toContain("mermaid");
        expect(html).toContain("katex");
        expect(html).toContain("sample.md"); // boot path
        // UI state is inlined from the state db, not read from localStorage.
        expect(html).toContain('"state"');
        expect(html).toContain('"prefs"');

        // Prefs round-trip through the server, and come back inlined.
        const saved = await fetch(`http://127.0.0.1:${port}/api/state`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefs: { theme: "light" }, recent: "sample.md" }),
        });
        expect(saved.ok).toBe(true);
        const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
        expect(state.prefs.theme).toBe("light");
        expect(state.recent).toEqual(["sample.md"]);
        const reloaded = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
        expect(reloaded).toContain('data-theme="light"');

        const file = await fetch(`http://127.0.0.1:${port}/api/file?path=sample.md`).then((r) => r.json());
        expect(file.kind).toBe("markdown");
        expect(file.markdown).toContain("# Markdown Demo");
        expect(file.markdown).toContain("$");

        const list = await fetch(`http://127.0.0.1:${port}/api/list?path=.`).then((r) => r.json());
        expect(list.files.some((f: { name: string }) => f.name === "sample.md")).toBe(true);

        // Path traversal blocked.
        const bad = await fetch(`http://127.0.0.1:${port}/api/file?path=../package.json`);
        expect(bad.status).toBe(400);

        proc.kill();
        await proc.exited;
    });
});

afterAll(() => {
    // best-effort cleanup if a prior run leaked
});
