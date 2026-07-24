import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CLINE_RUN_AS_HUB_DAEMON_ENV,
	withResolvedClineBuildEnv,
} from "@cline/shared";
import { resolveConnectorDataDir } from "@cline/shared/storage";
import { reconnectPersistedConnectors } from "../../services/connectors/connector-autostart";

type CliConnectCommand = {
	launcher: string;
	childArgs: string[];
};

function isProcessRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isCliEntryPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/").toLowerCase();
	return (
		/\/(?:apps\/)?cli\/(?:src\/|dist\/)?index\.(?:ts|js|mjs)$/.test(
			normalized,
		) ||
		/\/@cline\/cli\/(?:src\/|dist\/)?index\.(?:ts|js|mjs)$/.test(normalized)
	);
}

function resolveCliIndexFromPackage(): string | undefined {
	try {
		const require = createRequire(import.meta.url);
		const packagePath = require.resolve("@cline/cli/package.json");
		const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
			bin?: string | Record<string, string>;
		};
		const bin =
			typeof packageJson.bin === "string"
				? packageJson.bin
				: packageJson.bin?.cline;
		if (!bin) {
			return undefined;
		}
		const candidate = resolve(dirname(packagePath), bin);
		return existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function resolveCliIndexFromMonorepo(): string | undefined {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const relative of [
		"../../../../../../apps/cli/src/index.ts",
		"../../../../../../apps/cli/dist/index.js",
	]) {
		const candidate = resolve(here, relative);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function resolveCliIndexPath(): string | undefined {
	const fromEnv = process.env.CLINE_CLI_PATH?.trim();
	if (fromEnv && existsSync(fromEnv)) {
		return resolve(fromEnv);
	}

	const hostEntry = process.argv[1]?.trim();
	if (hostEntry && !hostEntry.startsWith("/$bunfs/") && existsSync(hostEntry)) {
		const resolvedHostEntry = resolve(hostEntry);
		if (isCliEntryPath(resolvedHostEntry)) {
			return resolvedHostEntry;
		}
	}

	return resolveCliIndexFromPackage() ?? resolveCliIndexFromMonorepo();
}

export function resolveCliConnectCommand(
	channel: string,
	args: string[],
): CliConnectCommand | undefined {
	const execPath = process.execPath?.trim();
	if (!execPath) {
		return undefined;
	}
	const execName = basename(execPath).toLowerCase();
	const connectArgs = ["connect", channel, ...args];

	if (execName === "cline" || execName === "cline.exe") {
		return { launcher: execPath, childArgs: connectArgs };
	}

	const cliIndex = resolveCliIndexPath();
	if (!cliIndex) {
		return undefined;
	}

	const isBunRuntime = execName.includes("bun");
	const isTypeScriptEntry = cliIndex.toLowerCase().endsWith(".ts");
	const launcher = isBunRuntime || !isTypeScriptEntry ? execPath : "bun";
	return {
		launcher,
		childArgs: [
			...(isTypeScriptEntry ? ["--conditions=development"] : []),
			cliIndex,
			...connectArgs,
		],
	};
}

function buildReconnectChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...withResolvedClineBuildEnv(process.env),
		CLINE_NO_INTERACTIVE: "1",
	};
	delete env[CLINE_RUN_AS_HUB_DAEMON_ENV];
	return env;
}

async function runCliConnectCommand(
	channel: string,
	args: string[],
	log: (message: string) => void,
): Promise<boolean> {
	const command = resolveCliConnectCommand(channel, args);
	if (!command) {
		log(`[connect] unable to resolve CLI launcher for ${channel} reconnect`);
		return false;
	}
	const child = spawn(command.launcher, command.childArgs, {
		cwd: process.cwd(),
		env: buildReconnectChildEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const code = await new Promise<number>((resolvePromise, reject) => {
		child.on("error", reject);
		child.on("close", (exitCode) => resolvePromise(exitCode ?? 0));
	});
	if (code !== 0 && stderr.trim()) {
		log(`[connect] ${channel} reconnect stderr: ${stderr.trim()}`);
	}
	return code === 0;
}

function isConnectorChannelActive(channel: string): boolean {
	const dir = join(resolveConnectorDataDir(), channel);
	if (!existsSync(dir)) {
		return false;
	}
	// Active connectors write a non-thread state JSON containing a live pid.
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json") || name.endsWith(".threads.json")) {
			continue;
		}
		try {
			const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
				pid?: unknown;
			};
			if (typeof parsed.pid === "number" && isProcessRunning(parsed.pid)) {
				return true;
			}
		} catch {
			// Ignore malformed state files.
		}
	}
	return false;
}

/**
 * Restore persisted connector sessions after the hub daemon is listening.
 * Uses a CLI subprocess so reconnect works for direct daemon entry launches
 * as well as host wrappers that import this module.
 */
export async function reconnectPersistedConnectorsFromDaemon(
	log: (message: string) => void = (message) => {
		process.stderr.write(`[hub-daemon] ${message}\n`);
	},
): Promise<void> {
	await reconnectPersistedConnectors({
		start: (channel, args) => runCliConnectCommand(channel, args, log),
		isActive: isConnectorChannelActive,
		log,
	});
}
