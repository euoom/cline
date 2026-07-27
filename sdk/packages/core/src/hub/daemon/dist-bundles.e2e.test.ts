import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
const distDir = join(packageRoot, "dist");

/**
 * Regression coverage for https://github.com/cline/cline/issues/12153: Bun's
 * bundler can emit a dangling `__reExport(...)` reference when a module that
 * re-exports an external subpath (e.g. `export * from "@cline/shared/storage"`
 * in src/index.ts) is pulled into a non-entry position of another bundle. The
 * broken bundle only crashes at import time under plain Node (Bun masks the
 * problem in-repo by resolving tsconfig paths to sources), which is exactly
 * how npm consumers load @cline/core — so evaluate the shipped bundles with
 * `node` instead of importing them into the test runner.
 */
describe.skipIf(!existsSync(distDir))(
	"dist bundles load under plain Node",
	() => {
		const importableBundles = [
			"dist/index.js",
			"dist/hub/index.js",
			"dist/services/telemetry/index.js",
		];

		for (const bundle of importableBundles) {
			it(`imports ${bundle} without evaluation errors`, async () => {
				const bundlePath = join(packageRoot, bundle);
				expect(existsSync(bundlePath)).toBe(true);
				const { stdout } = await execFileAsync(
					"node",
					[
						"--input-type=module",
						"-e",
						`await import(${JSON.stringify(bundlePath)}); console.log("bundle-ok");`,
					],
					{ cwd: packageRoot, timeout: 20_000 },
				);
				expect(stdout).toContain("bundle-ok");
			});
		}

		it("starts the hub daemon entry bundle as a detached-style child", async () => {
			const entryPath = join(packageRoot, "dist/hub/daemon/entry.js");
			expect(existsSync(entryPath)).toBe(true);
			const dataDir = mkdtempSync(join(tmpdir(), "cline-dist-entry-e2e-"));
			const workspaceDir = mkdtempSync(join(tmpdir(), "cline-dist-entry-ws-"));
			// Port 0 binds an ephemeral port so parallel test runs never collide.
			const child = spawn(
				"node",
				[entryPath, "--cwd", workspaceDir, "--port", "0"],
				{
					cwd: packageRoot,
					env: {
						...process.env,
						CLINE_DATA_DIR: dataDir,
						CLINE_RUN_AS_HUB_DAEMON: "1",
						CLINE_NO_INTERACTIVE: "1",
					},
				},
			);
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			try {
				const exited = await new Promise<number | null | "alive">(
					(resolvePromise) => {
						const timer = setTimeout(() => resolvePromise("alive"), 8_000);
						child.once("exit", (code) => {
							clearTimeout(timer);
							resolvePromise(code);
						});
					},
				);
				// The daemon keeps its process alive forever once the server is
				// up; any early exit means the bundle failed to start.
				expect(exited, `daemon exited early. stderr:\n${stderr}`).toBe("alive");
				expect(stderr).not.toMatch(/is not defined/);
			} finally {
				child.kill("SIGTERM");
				rmSync(dataDir, { recursive: true, force: true });
				rmSync(workspaceDir, { recursive: true, force: true });
			}
		}, 30_000);
	},
);
