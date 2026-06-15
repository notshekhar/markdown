import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Injected at build time by build-bin.ts via `bun build --define`. Undefined
// when running from source, where we read package.json instead.
declare const __MD_VERSION__: string;

const REPO_SLUG = "notshekhar/markdown";
const INSTALL_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh`;

/** Package root: src/commands.ts → src → root. */
export function packageRoot(): string {
    return dirname(dirname(new URL(import.meta.url).pathname));
}

export function getVersion(): string {
    if (typeof __MD_VERSION__ !== "undefined") {
        return __MD_VERSION__;
    }
    try {
        const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
        return typeof pkg.version === "string" ? pkg.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}

/**
 * Update in place (mirrors pi's `upgrade`). A git checkout fast-forwards and
 * reinstalls deps; an installed binary re-runs the release installer.
 */
export function runUpgrade(opts: { force?: boolean } = {}): void {
    const root = packageRoot();
    process.stdout.write(`▶ Updating md (current v${getVersion()})…\n`);

    if (existsSync(join(root, ".git"))) {
        upgradeFromSource(root, opts);
    } else {
        upgradeFromRelease(opts);
    }
}

function upgradeFromSource(root: string, opts: { force?: boolean }): void {
    const pull = spawnSync("git", ["-C", root, "pull", opts.force ? "--force" : "--ff-only"], { stdio: "inherit" });
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

function upgradeFromRelease(opts: { force?: boolean }): void {
    const env = { ...process.env };
    if (opts.force) {
        env.MD_FORCE = "1";
    }
    const result = spawnSync("bash", ["-c", `curl -fsSL ${INSTALL_URL} | bash`], { stdio: "inherit", env });
    process.exit(result.status ?? 1);
}
