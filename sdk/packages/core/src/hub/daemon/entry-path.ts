import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Module paths inside a compiled Bun executable live in Bun's virtual
 * filesystem and never exist on disk, so they must bypass file existence
 * checks. Callers detect this prefix and re-execute the compiled binary with
 * `--cline-hub-daemon` instead of launching a standalone entry module.
 */
export const COMPILED_BUN_EMBEDDED_PATH_PREFIX = "/$bunfs/";

const PACKAGED_DAEMON_ENTRY_SPECIFIER = "@cline/core/hub/daemon-entry";

export interface ResolveHubDaemonEntryPathOptions {
	/** Overrides `import.meta.url` of this module. Intended for tests. */
	moduleUrl?: string;
	/** Overrides the on-disk existence check. Intended for tests. */
	fileExists?: (path: string) => boolean;
	/** Overrides `import.meta.resolve`. Intended for tests. */
	resolveModuleUrl?: (specifier: string) => string;
}

function defaultResolveModuleUrl(specifier: string): string {
	return import.meta.resolve(specifier);
}

function resolvePackagedDaemonEntryPath(
	resolveModuleUrl: (specifier: string) => string,
	fileExists: (path: string) => boolean,
): string | undefined {
	try {
		const resolvedPath = fileURLToPath(
			resolveModuleUrl(PACKAGED_DAEMON_ENTRY_SPECIFIER),
		);
		return fileExists(resolvedPath) ? resolvedPath : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolves the module that a detached hub daemon process should execute.
 *
 * The sibling `entry.js`/`entry.ts` module works when @cline/core runs from
 * its published `dist/` layout or from monorepo sources. But when a host app
 * bundles @cline/core into a single output file, `import.meta.url` points at
 * that bundle and no sibling entry module exists on disk. Spawning that
 * nonexistent path used to fail silently: the detached child died immediately
 * with MODULE_NOT_FOUND (only visible in hub-daemon.log) and callers hung
 * until generic hub startup/command timeouts
 * (https://github.com/cline/cline/issues/12153). Fall back to the installed
 * `@cline/core/hub/daemon-entry` package export in that case, and otherwise
 * fail fast with an actionable error.
 */
export function resolveHubDaemonEntryPath(
	options: ResolveHubDaemonEntryPathOptions = {},
): string {
	const moduleUrl = options.moduleUrl ?? import.meta.url;
	const fileExists = options.fileExists ?? existsSync;
	const resolveModuleUrl = options.resolveModuleUrl ?? defaultResolveModuleUrl;
	const extension = moduleUrl.endsWith(".ts") ? "ts" : "js";
	const siblingEntryPath = fileURLToPath(
		new URL(`./entry.${extension}`, moduleUrl),
	);
	if (
		siblingEntryPath.startsWith(COMPILED_BUN_EMBEDDED_PATH_PREFIX) ||
		fileExists(siblingEntryPath)
	) {
		return siblingEntryPath;
	}
	const packagedEntryPath = resolvePackagedDaemonEntryPath(
		resolveModuleUrl,
		fileExists,
	);
	if (packagedEntryPath) {
		return packagedEntryPath;
	}
	throw new Error(
		`Unable to locate the Cline Hub daemon entry module (expected ${siblingEntryPath}). ` +
			"@cline/core appears to be bundled into a single file without a resolvable " +
			`${PACKAGED_DAEMON_ENTRY_SPECIFIER} export next to it. Keep @cline/core installed as a ` +
			"runtime dependency of the bundling application so the hub daemon can be started.",
	);
}
