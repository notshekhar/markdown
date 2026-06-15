import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/** Package root: src/commands.ts → src → root. */
export function packageRoot(): string {
    return dirname(dirname(new URL(import.meta.url).pathname));
}

export function getVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
        return typeof pkg.version === "string" ? pkg.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}

/**
 * Update in place. `md` ships from a git checkout (mirrors pi's `upgrade`), so
 * we fast-forward the repo and reinstall dependencies.
 */
export function runUpgrade(opts: { force?: boolean } = {}): void {
    const root = packageRoot();
    if (!existsSync(join(root, ".git"))) {
        process.stderr.write("md: not a git checkout — reinstall manually.\n");
        process.exit(1);
    }

    process.stdout.write(`▶ Updating md (current v${getVersion()})…\n`);

    const pullArgs = ["-C", root, "pull", opts.force ? "--force" : "--ff-only"];
    const pull = spawnSync("git", pullArgs, { stdio: "inherit" });
    if (pull.status !== 0) {
        process.stderr.write("✗ git pull failed\n");
        process.exit(pull.status ?? 1);
    }

    const install = spawnSync("bun", ["install"], { cwd: root, stdio: "inherit" });
    if (install.status !== 0) {
        process.stderr.write("✗ bun install failed\n");
        process.exit(install.status ?? 1);
    }

    process.stdout.write(`✓ Up to date — v${getVersion()}\n`);
}
