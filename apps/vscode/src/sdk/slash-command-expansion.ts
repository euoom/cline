import type { AvailableRuntimeCommand } from "@cline/core"

/**
 * Matches a slash-command token that is either at the start of the message or
 * preceded by whitespace, and followed by whitespace or end-of-string. Kept in
 * sync with the webview's `slashCommandRegex` (webview-ui/src/utils/slash-commands.ts)
 * so anything the chat input highlights/autocompletes as a command can be expanded.
 */
const SLASH_COMMAND_TOKEN_REGEX = /(^|\s)(\/[a-zA-Z0-9_.:@-]+)(?=\s|$)/g

/**
 * File extensions the SDK's workflow discovery accepts (`MARKDOWN_EXTENSIONS`
 * in @cline/core's user-instruction-config-loader). The SDK strips the
 * extension when naming the command; the webview autocomplete and legacy
 * toggle state keep it.
 */
const WORKFLOW_FILE_EXTENSION_REGEX = /\.(md|markdown|txt)$/i

/**
 * Canonical form used to compare workflow names across the places they appear:
 * typed slash commands and toggle paths keep the file extension, while SDK
 * command names and remote workflow names do not.
 */
function canonicalWorkflowName(value: string): string {
	const stripped = value.replace(WORKFLOW_FILE_EXTENSION_REGEX, "").toLowerCase()
	return stripped || value.toLowerCase()
}

/**
 * Find the runtime command matching a typed slash-command name.
 *
 * The SDK names workflows by frontmatter `name` or file basename *without* the
 * extension, but the webview autocomplete (and legacy Cline versions) surface
 * workflow files as `/my-workflow.md`. Accept both spellings so workflows
 * created under the legacy extension keep working after an upgrade.
 */
function findRuntimeCommand(
	commands: readonly AvailableRuntimeCommand[],
	typedName: string,
	workflowRecords: ReadonlyArray<WorkflowRecordRef>,
): AvailableRuntimeCommand | undefined {
	const withoutExtension = typedName.replace(WORKFLOW_FILE_EXTENSION_REGEX, "")
	const candidates = withoutExtension && withoutExtension !== typedName ? [typedName, withoutExtension] : [typedName]
	for (const candidate of candidates) {
		const exact = commands.find((command) => command.name === candidate)
		if (exact) {
			return exact
		}
	}
	// The webview highlights/validates slash commands case-insensitively, so
	// fall back to a case-insensitive match rather than silently not expanding.
	for (const candidate of candidates) {
		const lowered = candidate.toLowerCase()
		const insensitive = commands.find((command) => command.name.toLowerCase() === lowered)
		if (insensitive) {
			return insensitive
		}
	}
	// The webview autocomplete inserts workflows by *file basename*
	// (e.g. /release.md), but a frontmatter `name:` renames the SDK command
	// (e.g. ship-it). Map the typed filename back to its command through the
	// discovered record's file path, like the toggle matching below does.
	const typedCanonical = canonicalWorkflowName(typedName)
	const record = workflowRecords.find((record) => canonicalWorkflowName(fileBasename(record.filePath)) === typedCanonical)
	if (record) {
		const renamedCanonical = canonicalWorkflowName(record.name)
		return commands.find((command) => canonicalWorkflowName(command.name) === renamedCanonical)
	}
	return undefined
}

/**
 * Expand the first slash command in `text` that resolves to a known
 * workflow/skill into its instruction body.
 *
 * Unlike the SDK's `resolveRuntimeSlashCommand` (leading `/command` only), this
 * matches commands anywhere in the message — the webview lets users insert a
 * slash command after whitespace mid-message, and the legacy extension expanded
 * those too. Only the first matching command is expanded, mirroring legacy
 * behavior and the webview menu (which only offers suggestions for the first
 * command in a message).
 *
 * @param disabledWorkflowNames canonical (extension-less, lower-cased) workflow
 *   names the user disabled via the Workflows toggles, from
 *   {@link buildDisabledWorkflowNames}. Disabled workflows are left unexpanded,
 *   matching legacy semantics.
 * @param workflowRecords discovered workflow records, used to resolve a typed
 *   filename (e.g. `/release.md`) to a command renamed by frontmatter.
 */
export function expandSlashCommands(
	text: string,
	commands: readonly AvailableRuntimeCommand[],
	disabledWorkflowNames: ReadonlySet<string> = new Set(),
	workflowRecords: ReadonlyArray<WorkflowRecordRef> = [],
): string {
	if (!text.includes("/") || commands.length === 0) {
		return text
	}
	for (const match of text.matchAll(SLASH_COMMAND_TOKEN_REGEX)) {
		const token = match[2]
		const typedName = token.slice(1)
		const command = findRuntimeCommand(commands, typedName, workflowRecords)
		if (!command) {
			continue
		}
		if (command.kind === "workflow" && disabledWorkflowNames.has(canonicalWorkflowName(command.name))) {
			continue
		}
		const start = (match.index ?? 0) + match[1].length
		const end = start + token.length
		return text.slice(0, start) + command.instructions + text.slice(end)
	}
	return text
}

/** The discovered workflow files the disabled set is computed for. */
export interface WorkflowRecordRef {
	/** Command name (frontmatter `name`, or file basename without extension). */
	name: string
	/** Absolute path of the workflow file. */
	filePath: string
}

export interface BuildDisabledWorkflowNamesOptions {
	/** Discovered workflow records from `listRecords("workflow")`. */
	records: ReadonlyArray<WorkflowRecordRef>
	/** `globalWorkflowToggles` (global settings) — keyed by absolute file path. */
	globalToggles?: Record<string, boolean>
	/** Workspace `workflowToggles` — keyed by absolute file path. */
	workspaceToggles?: Record<string, boolean>
	/** `remoteWorkflowToggles` (global state) — keyed by remote workflow name. */
	remoteToggles?: Record<string, boolean>
	/** Names of remote workflows the organization locks on (`alwaysEnabled`). */
	remoteAlwaysEnabledNames?: Iterable<string>
}

function fileBasename(filePath: string): string {
	return filePath.replace(/^.*[/\\]/, "")
}

/** Matches files materialized from remote config (`.cline/remote-config/…`). */
const REMOTE_CONFIG_PATH_REGEX = /[/\\]\.cline[/\\]remote-config[/\\]/

/**
 * Mirror of `sanitizeSegment` in @cline/shared's remote-config materializer
 * (not exported by the SDK; keep in sync): the filename segment a remote
 * workflow's config `name` is materialized under.
 */
function sanitizeRemoteSegment(value: string): string {
	let result = ""
	let pendingSeparator = false
	for (const char of value.trim().toLowerCase()) {
		const code = char.charCodeAt(0)
		const isAllowed =
			(code >= 97 && code <= 122) || (code >= 48 && code <= 57) || char === "." || char === "_" || char === "-"
		if (isAllowed) {
			if (pendingSeparator && result && result[result.length - 1] !== "-") {
				result += "-"
			}
			pendingSeparator = false
			result += char
		} else {
			pendingSeparator = true
		}
		if (result.length >= 80) {
			break
		}
	}
	while (result.endsWith("-")) {
		result = result.slice(0, -1)
	}
	while (result.startsWith("-")) {
		result = result.slice(1)
	}
	return result || "item"
}

/**
 * Canonical form for matching remote workflows across their two spellings:
 * remote toggles and `alwaysEnabled` locks are keyed by the raw config name
 * (e.g. `Org Standards`), while the materialized file — and therefore the
 * discovered record — carries the sanitized basename (`org-standards`).
 * Sanitizing is idempotent, so both sides normalize to the same key.
 */
function canonicalRemoteWorkflowName(value: string): string {
	return sanitizeRemoteSegment(value.replace(WORKFLOW_FILE_EXTENSION_REGEX, ""))
}

/**
 * Build the set of canonical command names whose workflows the user disabled
 * via the Workflows toggles (local, global, and enterprise/remote scopes).
 *
 * Toggle state is matched to each discovered record by its file basename, so a
 * frontmatter `name` that differs from the filename is still governed by the
 * file's toggle. A basename that appears in several scopes counts as enabled
 * when *any* scope has it enabled: legacy expansion only searched enabled
 * workflows across scopes, so a disabled workspace file must not shadow a
 * same-named enabled global one (or vice versa). Files materialized from
 * remote config are governed by the name-keyed remote toggles instead, and
 * locked (`alwaysEnabled`) remote workflows always count as enabled.
 */
export function buildDisabledWorkflowNames(options: BuildDisabledWorkflowNamesOptions): Set<string> {
	const enabledByBasename = new Map<string, boolean>()
	for (const toggles of [options.globalToggles ?? {}, options.workspaceToggles ?? {}]) {
		for (const [filePath, enabled] of Object.entries(toggles)) {
			const key = canonicalWorkflowName(fileBasename(filePath))
			if (!key) {
				continue
			}
			enabledByBasename.set(key, (enabledByBasename.get(key) ?? false) || enabled)
		}
	}
	const remoteToggles = new Map(
		Object.entries(options.remoteToggles ?? {}).map(([name, enabled]) => [canonicalRemoteWorkflowName(name), enabled]),
	)
	const remoteAlwaysEnabled = new Set([...(options.remoteAlwaysEnabledNames ?? [])].map(canonicalRemoteWorkflowName))

	const disabled = new Set<string>()
	for (const record of options.records) {
		const name = canonicalWorkflowName(record.name)
		if (!name) {
			continue
		}
		let enabled: boolean
		if (REMOTE_CONFIG_PATH_REGEX.test(record.filePath)) {
			// Match by materialized file basename (like the local branch below)
			// so a frontmatter rename inside the remote contents cannot detach
			// the record from its name-keyed toggle.
			const remoteName = canonicalRemoteWorkflowName(fileBasename(record.filePath))
			enabled = remoteAlwaysEnabled.has(remoteName) || remoteToggles.get(remoteName) !== false
		} else {
			enabled = enabledByBasename.get(canonicalWorkflowName(fileBasename(record.filePath))) ?? true
		}
		if (!enabled) {
			disabled.add(name)
		}
	}
	return disabled
}
