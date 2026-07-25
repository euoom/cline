import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLINE_CONNECTOR_CLI_LAUNCH_ENV,
	CLINE_RUN_AS_HUB_DAEMON_ENV,
	type ConnectorCliLaunchSpec,
	setConnectorCliLaunchSpec,
} from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistConnectorConnection } from "./connector-autostart";
import {
	__test__,
	reconnectDaemonConnectors,
} from "./daemon-connector-reconnect";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

class FakeConnectorCliChild extends EventEmitter {
	stderr = new EventEmitter() as EventEmitter & {
		setEncoding: (encoding: string) => void;
	};

	constructor() {
		super();
		this.stderr.setEncoding = vi.fn();
	}
}

describe("daemon connector CLI launcher", () => {
	const originalDaemonFlag = process.env[CLINE_RUN_AS_HUB_DAEMON_ENV];
	const originalLaunchSpec = process.env[CLINE_CONNECTOR_CLI_LAUNCH_ENV];
	const spec: ConnectorCliLaunchSpec = {
		launcher: "/usr/local/bin/bun",
		connectArgsPrefix: ["/repo/apps/cli/src/index.ts", "connect"],
		cwd: "/workspace",
	};

	afterEach(() => {
		if (originalDaemonFlag === undefined) {
			delete process.env[CLINE_RUN_AS_HUB_DAEMON_ENV];
		} else {
			process.env[CLINE_RUN_AS_HUB_DAEMON_ENV] = originalDaemonFlag;
		}
		if (originalLaunchSpec === undefined) {
			delete process.env[CLINE_CONNECTOR_CLI_LAUNCH_ENV];
		} else {
			process.env[CLINE_CONNECTOR_CLI_LAUNCH_ENV] = originalLaunchSpec;
		}
		spawnMock.mockReset();
	});

	it("launches reconnect through the CLI without the daemon sentinel", async () => {
		process.env[CLINE_RUN_AS_HUB_DAEMON_ENV] = "1";
		const child = new FakeConnectorCliChild();
		const spawnProcess = vi.fn(() => child);
		const log = vi.fn();

		const pending = __test__.runConnectorCli(
			spec,
			"telegram",
			["-k", "token"],
			log,
			spawnProcess,
		);
		child.emit("close", 0);

		await expect(pending).resolves.toBe(true);
		expect(spawnProcess).toHaveBeenCalledWith(
			"/usr/local/bin/bun",
			[
				"/repo/apps/cli/src/index.ts",
				"connect",
				"--restart",
				"telegram",
				"-k",
				"token",
			],
			expect.objectContaining({
				cwd: "/workspace",
				env: expect.not.objectContaining({
					[CLINE_RUN_AS_HUB_DAEMON_ENV]: "1",
				}),
			}),
		);
		expect(log).not.toHaveBeenCalled();
	});

	it("reports non-zero CLI reconnect exits", async () => {
		const child = new FakeConnectorCliChild();
		const spawnProcess = vi.fn(() => child);
		const log = vi.fn();

		const pending = __test__.runConnectorCli(
			spec,
			"telegram",
			["-k", "token"],
			log,
			spawnProcess,
		);
		child.stderr.emit("data", "invalid token");
		child.emit("close", 1);

		await expect(pending).resolves.toBe(false);
		expect(log).toHaveBeenCalledWith(
			"[connect] telegram reconnect exited with code 1: invalid token",
		);
	});

	it("force-restarts persisted connectors even when a surviving PID looks active", async () => {
		const previousDataDir = process.env.CLINE_DATA_DIR;
		const root = mkdtempSync(join(tmpdir(), "daemon-connector-reconnect-"));
		process.env.CLINE_DATA_DIR = root;
		try {
			persistConnectorConnection(
				"telegram",
				["-k", "123:token"],
				"/telegram-workspace",
			);
			const telegramDir = join(root, "connectors", "telegram");
			mkdirSync(telegramDir, { recursive: true });
			writeFileSync(
				join(telegramDir, "live.json"),
				JSON.stringify({
					pid: process.pid,
					hubUrl: "ws://127.0.0.1:25463/hub",
					botUsername: "orphan_bot",
				}),
			);

			setConnectorCliLaunchSpec(spec);
			const child = new FakeConnectorCliChild();
			spawnMock.mockReturnValue(child);
			const log = vi.fn();
			const pending = reconnectDaemonConnectors(log);
			queueMicrotask(() => child.emit("close", 0));

			await expect(pending).resolves.toEqual([
				{ channel: "telegram", ok: true },
			]);
			expect(spawnMock).toHaveBeenCalledWith(
				"/usr/local/bin/bun",
				[
					"/repo/apps/cli/src/index.ts",
					"connect",
					"--restart",
					"telegram",
					"-k",
					"123:token",
					"--cwd",
					"/telegram-workspace",
				],
				expect.objectContaining({ cwd: "/workspace" }),
			);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.CLINE_DATA_DIR;
			} else {
				process.env.CLINE_DATA_DIR = previousDataDir;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
});
