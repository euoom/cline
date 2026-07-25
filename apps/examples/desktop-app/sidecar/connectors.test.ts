import {
	CLINE_CONNECTOR_CLI_LAUNCH_ENV,
	readConnectorCliLaunchSpec,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { __test__, configureDesktopConnectorCliLaunch } from "./connectors";

describe("desktop connector lifecycle", () => {
	it("uses the atomic restart command for an active channel", () => {
		expect(
			__test__.buildConnectorLaunchArgs(["telegram", "-k", "token"], true),
		).toEqual(["--restart", "telegram", "-k", "token"]);
	});

	it("starts an inactive channel directly", () => {
		expect(
			__test__.buildConnectorLaunchArgs(["telegram", "-k", "token"], false),
		).toEqual(["telegram", "-k", "token"]);
	});

	it("registers the connector CLI launch specification for hub reconnect", () => {
		const env: NodeJS.ProcessEnv = {};
		configureDesktopConnectorCliLaunch(
			"/repo",
			{
				execPath: "/usr/local/bin/bun",
				exists: (path) => path === "/repo/apps/cli/src/index.ts",
			},
			env,
		);

		expect(env[CLINE_CONNECTOR_CLI_LAUNCH_ENV]).toBeDefined();
		expect(readConnectorCliLaunchSpec(env)).toEqual({
			launcher: "/usr/local/bin/bun",
			connectArgsPrefix: [
				"--conditions=development",
				"/repo/apps/cli/src/index.ts",
				"connect",
			],
			cwd: "/repo",
		});
	});
});
