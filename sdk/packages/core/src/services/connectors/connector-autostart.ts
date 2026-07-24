import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withConnectorStore } from "@cline/shared/db";
import { resolveConnectorDataDir } from "@cline/shared/storage";

const INTERACTIVE_FLAGS = new Set(["-i", "--interactive"]);
const RECONNECT_LOCK_RETRY_MS = 100;
const RECONNECT_LOCK_TIMEOUT_MS = 30_000;
const RECONNECT_ACTIVE_WAIT_MS = 5_000;
const RECONNECT_ACTIVE_POLL_MS = 100;

function stripInteractiveFlags(args: string[]): string[] {
	return args.filter((arg) => !INTERACTIVE_FLAGS.has(arg));
}

/**
 * Record a successful connector start so the connector can be reconnected
 * automatically after a hub or host restart.
 */
export function persistConnectorConnection(
	channel: string,
	rawArgs: string[],
): void {
	try {
		withConnectorStore((store) =>
			store.recordConnected(channel, stripInteractiveFlags(rawArgs)),
		);
	} catch {
		// Persistence is best-effort; never fail the connector start over it.
	}
}

/** Stop auto-reconnecting a channel after the user stopped it explicitly. */
export function disableConnectorAutostart(channel?: string): void {
	try {
		withConnectorStore((store) => {
			if (channel) {
				store.setEnabled(channel, false);
			} else {
				store.disableAll();
			}
		});
	} catch {
		// Persistence is best-effort; never fail the connector stop over it.
	}
}

export interface ReconnectAttempt {
	channel: string;
	ok: boolean;
	error?: string;
}

export interface ReconnectPersistedConnectorsOptions {
	/** Starts a connector channel with the stored, non-interactive arguments. */
	start: (channel: string, args: string[]) => Promise<boolean>;
	/** Reports whether a host already has an active connector for the channel. */
	isActive?: (channel: string) => boolean;
	log?: (message: string) => void;
}

function isPidAlive(pid: number): boolean {
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

function readReconnectLockPid(lockPath: string): number | undefined {
	try {
		const raw = readFileSync(lockPath, "utf8").trim().split("\n")[0];
		const pid = Number.parseInt(raw ?? "", 10);
		return Number.isInteger(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Serialize reconnect across hosts (CLI daemon + hub dashboard) so both do not
 * spawn the same channel while its state file is still being written.
 */
async function acquireReconnectLock(): Promise<() => void> {
	const lockPath = join(resolveConnectorDataDir(), "reconnect.lock");
	mkdirSync(resolveConnectorDataDir(), { recursive: true });
	const deadline = Date.now() + RECONNECT_LOCK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const fd = openSync(lockPath, "wx");
			try {
				writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
			} finally {
				closeSync(fd);
			}
			return () => {
				try {
					unlinkSync(lockPath);
				} catch {
					// Best-effort unlock.
				}
			};
		} catch {
			if (existsSync(lockPath)) {
				const ownerPid = readReconnectLockPid(lockPath);
				if (ownerPid !== undefined && !isPidAlive(ownerPid)) {
					try {
						unlinkSync(lockPath);
						continue;
					} catch {
						// Another process may have claimed the lock.
					}
				}
			}
			await new Promise((resolve) =>
				setTimeout(resolve, RECONNECT_LOCK_RETRY_MS),
			);
		}
	}
	// Prefer attempting reconnect over silently skipping after a lock timeout.
	return () => {};
}

async function waitForActiveConnector(
	isActive: ((channel: string) => boolean) | undefined,
	channel: string,
): Promise<void> {
	if (!isActive) {
		return;
	}
	const deadline = Date.now() + RECONNECT_ACTIVE_WAIT_MS;
	while (Date.now() < deadline) {
		if (isActive(channel)) {
			return;
		}
		await new Promise((resolve) =>
			setTimeout(resolve, RECONNECT_ACTIVE_POLL_MS),
		);
	}
}

/**
 * Reconnect every connector that has stored connection arguments, is enabled,
 * and is not already active in the calling host.
 */
export async function reconnectPersistedConnectors(
	options: ReconnectPersistedConnectorsOptions,
): Promise<ReconnectAttempt[]> {
	const log = options.log ?? (() => {});
	let candidates: { channel: string; args: string[] }[];
	try {
		candidates = withConnectorStore((store) => store.list())
			.filter((entry) => entry.enabled && entry.connectArgs?.length)
			.map((entry) => ({
				channel: entry.channel,
				args: stripInteractiveFlags(entry.connectArgs ?? []),
			}));
	} catch (error) {
		log(
			`[connect] failed to read persisted connectors: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return [];
	}

	const releaseLock = await acquireReconnectLock();
	const attempts: ReconnectAttempt[] = [];
	try {
		for (const { channel, args } of candidates) {
			if (options.isActive?.(channel)) {
				continue;
			}
			log(`[connect] reconnecting ${channel} connector`);
			try {
				const ok = await options.start(channel, args);
				attempts.push({ channel, ok });
				if (!ok) {
					log(`[connect] failed to reconnect ${channel} connector`);
					continue;
				}
				await waitForActiveConnector(options.isActive, channel);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				attempts.push({ channel, ok: false, error: message });
				log(`[connect] failed to reconnect ${channel} connector: ${message}`);
			}
		}
	} finally {
		releaseLock();
	}
	return attempts;
}
