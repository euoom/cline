import { describe, expect, it, vi } from "vitest";
import {
	COMPILED_BUN_EMBEDDED_PATH_PREFIX,
	resolveHubDaemonEntryPath,
} from "./entry-path";

describe("resolveHubDaemonEntryPath", () => {
	it("uses the sibling entry module when it exists on disk", () => {
		const resolveModuleUrl = vi.fn();
		const result = resolveHubDaemonEntryPath({
			moduleUrl:
				"file:///opt/app/node_modules/@cline/core/dist/hub/daemon/index.js",
			fileExists: (path) =>
				path === "/opt/app/node_modules/@cline/core/dist/hub/daemon/entry.js",
			resolveModuleUrl,
		});

		expect(result).toBe(
			"/opt/app/node_modules/@cline/core/dist/hub/daemon/entry.js",
		);
		expect(resolveModuleUrl).not.toHaveBeenCalled();
	});

	it("uses the sibling TypeScript entry when running from sources", () => {
		const result = resolveHubDaemonEntryPath({
			moduleUrl: "file:///repo/sdk/packages/core/src/hub/daemon/index.ts",
			fileExists: (path) =>
				path === "/repo/sdk/packages/core/src/hub/daemon/entry.ts",
		});

		expect(result).toBe("/repo/sdk/packages/core/src/hub/daemon/entry.ts");
	});

	it("keeps compiled-bun embedded paths without checking the disk", () => {
		const fileExists = vi.fn(() => false);
		const result = resolveHubDaemonEntryPath({
			moduleUrl: `file://${COMPILED_BUN_EMBEDDED_PATH_PREFIX}root/index.js`,
			fileExists,
		});

		expect(result).toBe(`${COMPILED_BUN_EMBEDDED_PATH_PREFIX}root/entry.js`);
		expect(fileExists).not.toHaveBeenCalled();
	});

	it("falls back to the installed package export when the sibling entry is missing", () => {
		const packagedEntryPath =
			"/opt/app/node_modules/@cline/core/dist/hub/daemon/entry.js";
		const resolveModuleUrl = vi.fn(() => `file://${packagedEntryPath}`);
		const result = resolveHubDaemonEntryPath({
			// Simulates @cline/core bundled into a host app's single-file build,
			// e.g. kanban/dist/cli.js, where no sibling entry.js exists.
			moduleUrl: "file:///opt/app/dist/cli.js",
			fileExists: (path) => path === packagedEntryPath,
			resolveModuleUrl,
		});

		expect(result).toBe(packagedEntryPath);
		expect(resolveModuleUrl).toHaveBeenCalledWith(
			"@cline/core/hub/daemon-entry",
		);
	});

	it("throws an actionable error when no daemon entry module can be found", () => {
		expect(() =>
			resolveHubDaemonEntryPath({
				moduleUrl: "file:///opt/app/dist/cli.js",
				fileExists: () => false,
				resolveModuleUrl: () => {
					throw new Error("Cannot find package '@cline/core'");
				},
			}),
		).toThrow(
			/Unable to locate the Cline Hub daemon entry module \(expected \/opt\/app\/dist\/entry\.js\)/,
		);
	});

	it("throws when the package export resolves to a missing file", () => {
		expect(() =>
			resolveHubDaemonEntryPath({
				moduleUrl: "file:///opt/app/dist/cli.js",
				fileExists: () => false,
				resolveModuleUrl: () =>
					"file:///opt/app/node_modules/@cline/core/dist/hub/daemon/entry.js",
			}),
		).toThrow("Unable to locate the Cline Hub daemon entry module");
	});
});
