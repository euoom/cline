import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCliConnectCommand } from "./connector-reconnect";

describe("resolveCliConnectCommand", () => {
	const originalArgv = [...process.argv];
	const originalExecPath = process.execPath;
	const originalCliPath = process.env.CLINE_CLI_PATH;

	afterEach(() => {
		process.argv = [...originalArgv];
		Object.defineProperty(process, "execPath", {
			value: originalExecPath,
			configurable: true,
		});
		if (originalCliPath === undefined) {
			delete process.env.CLINE_CLI_PATH;
		} else {
			process.env.CLINE_CLI_PATH = originalCliPath;
		}
		vi.restoreAllMocks();
	});

	it("uses the compiled cline binary when execPath is cline", () => {
		Object.defineProperty(process, "execPath", {
			value: "/usr/local/bin/cline",
			configurable: true,
		});
		expect(resolveCliConnectCommand("telegram", ["-k", "token"])).toEqual({
			launcher: "/usr/local/bin/cline",
			childArgs: ["connect", "telegram", "-k", "token"],
		});
	});

	it("prefers an explicit CLINE_CLI_PATH over non-CLI host entries", () => {
		Object.defineProperty(process, "execPath", {
			value: "/usr/bin/bun",
			configurable: true,
		});
		process.argv = ["bun", "/tmp/not-the-cli.js"];
		process.env.CLINE_CLI_PATH = "/workspace/apps/cli/src/index.ts";

		expect(resolveCliConnectCommand("slack", ["--bot-token", "x"])).toEqual({
			launcher: "/usr/bin/bun",
			childArgs: [
				"--conditions=development",
				"/workspace/apps/cli/src/index.ts",
				"connect",
				"slack",
				"--bot-token",
				"x",
			],
		});
	});
});
