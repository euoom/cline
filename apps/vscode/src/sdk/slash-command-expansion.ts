import type { AvailableRuntimeCommand } from "@cline/core"
import { remoteWorkflowCommandName } from "@/shared/slashCommands"

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

function fileBasename(filePath: string): string {
	return filePath.replace(/^.*[/\\]/, "")
}

/** Matches files materialized from remote config (`.cline/remote-config/…`). */
const REMOTE_CONFIG_PATH_REGEX = /[/\\]\.cline[/\\]remote-config[/\\]/

/** The discovered workflow files toggle filtering and matching operate on. */
export interface WorkflowRecordRef {
	/** Command name (frontmatter `name`, or file basename without extension). */
	name: string
	/** Absolute path of the workflow file. */
	filePath: string
}

export interface ExpandSlashCommandsOptions {
	/**
	 * Exact command names of workflows the user disabled via the Workflows
	 * toggles, from {@link buildWorkflowToggleState}. Disabled workflows are
	 * left unexpanded, matching legacy semantics.
	 */
	disabledWorkflowNames?: ReadonlySet<string>
	/**
	 * Discovered workflow records, used to also match a typed file name (e.g.
	 * `/my-workflow.md`, what the autocomplete inserts) against a workflow
	 * whose frontmatter `name` differs from its filename.
	 */
	workflowRecords?: ReadonlyArray<WorkflowRecordRef>
	/**
	 * Replacement instruction bodies, keyed by exact command name, for workflow
	 * commands whose winning SDK record is not the file legacy scope precedence
	 * selects — from {@link buildWorkflowToggleState}'s `overrideFilePaths`.
	 */
	workflowInstructionOverrides?: ReadonlyMap<string, string>
}

/**
 * Find the runtime command matching a typed slash-command name.
 *
 * The SDK names workflows by frontmatter `name` or file basename *without* the
 * extension, but the webview autocomplete (and legacy Cline versions) surface
 * workflow files as `/my-workflow.md`. Accept both spellings — and resolve a
 * typed file name to its frontmatter-renamed command — so workflows created
 * under the legacy extension keep working after an upgrade.
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
	// Typed file name (autocomplete inserts `/my-workflow.md`) whose workflow
	// was renamed via frontmatter: resolve through the record's file basename.
	const typedCanonical = canonicalWorkflowName(typedName)
	const record = workflowRecords.find((r) => canonicalWorkflowName(fileBasename(r.filePath)) === typedCanonical)
	if (record) {
		const recordCanonical = canonicalWorkflowName(record.name)
		const resolved = commands.find((command) => canonicalWorkflowName(command.name) === recordCanonical)
		if (resolved) {
			return resolved
		}
	}
	// Remote (enterprise) workflows are surfaced under their remote config
	// name, but the runtime command is named after the sanitized materialized
	// basename (e.g. config name "Team:Deploy" → command "team-deploy").
	// Bridge the two forms so the inserted/typed name still expands.
	const typedRemoteKey = remoteWorkflowCommandName(typedName)
	return commands.find((command) => remoteWorkflowCommandName(command.name) === typedRemoteKey)
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
 */
export function expandSlashCommands(
	text: string,
	commands: readonly AvailableRuntimeCommand[],
	options: ExpandSlashCommandsOptions = {},
): string {
	if (!text.includes("/") || commands.length === 0) {
		return text
	}
	const disabledWorkflowNames = options.disabledWorkflowNames ?? new Set()
	const workflowRecords = options.workflowRecords ?? []
	for (const match of text.matchAll(SLASH_COMMAND_TOKEN_REGEX)) {
		const token = match[2]
		const typedName = token.slice(1)
		const command = findRuntimeCommand(commands, typedName, workflowRecords)
		if (!command) {
			continue
		}
		if (command.kind === "workflow" && disabledWorkflowNames.has(command.name)) {
			continue
		}
		const override = command.kind === "workflow" ? options.workflowInstructionOverrides?.get(command.name) : undefined
		const start = (match.index ?? 0) + match[1].length
		const end = start + token.length
		return text.slice(0, start) + (override ?? command.instructions) + text.slice(end)
	}
	return text
}

export interface BuildWorkflowToggleStateOptions {
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

export interface WorkflowToggleState {
	/** Exact command names whose workflows every governing toggle disables. */
	disabledWorkflowNames: Set<string>
	/**
	 * Exact command name → absolute path of the enabled file whose body should
	 * expand instead of the discovered record's file (legacy scope precedence:
	 * workspace over global).
	 */
	overrideFilePaths: Map<string, string>
}

/**
 * Resolve the Workflows toggles (local, global, and enterprise/remote scopes)
 * against the discovered workflow records.
 *
 * Toggle state is matched to a record by its file basename, so a frontmatter
 * `name` that differs from the filename is still governed by the file's
 * toggle. Same-named files across scopes collapse into a single SDK record
 * (the SDK keeps one record per command name, preferring later-scanned
 * directories), while legacy expansion searched *enabled* workflows with
 * workspace files preferred over same-named global ones — the same preference
 * the slash menu shows. To preserve those semantics, every same-basename
 * toggle governs the collapsed record: the command is disabled only when all
 * of them are off, and when the preferred enabled file is not the record's
 * own, its path is returned in `overrideFilePaths` so the file the user
 * actually enabled (and the menu offered) is what expands. A same-named file
 * that produced its own record — e.g. renamed via frontmatter — governs that
 * record instead. Files materialized from remote config are governed by the
 * name-keyed remote toggles, and locked (`alwaysEnabled`) remote workflows
 * always count as enabled.
 */
export function buildWorkflowToggleState(options: BuildWorkflowToggleStateOptions): WorkflowToggleState {
	// Workspace entries first: legacy expansion preferred local workflows over
	// same-named global ones.
	const togglesByBasename = new Map<string, Array<{ filePath: string; enabled: boolean }>>()
	for (const toggles of [options.workspaceToggles ?? {}, options.globalToggles ?? {}]) {
		for (const [filePath, enabled] of Object.entries(toggles)) {
			const key = canonicalWorkflowName(fileBasename(filePath))
			if (!key) {
				continue
			}
			const entries = togglesByBasename.get(key)
			if (entries) {
				entries.push({ filePath, enabled })
			} else {
				togglesByBasename.set(key, [{ filePath, enabled }])
			}
		}
	}
	const remoteToggles = new Map(
		Object.entries(options.remoteToggles ?? {}).map(([name, enabled]) => [remoteWorkflowCommandName(name), enabled]),
	)
	const remoteAlwaysEnabled = new Set([...(options.remoteAlwaysEnabledNames ?? [])].map(remoteWorkflowCommandName))
	const recordFilePaths = new Set(options.records.map((record) => record.filePath))

	const disabledWorkflowNames = new Set<string>()
	const overrideFilePaths = new Map<string, string>()
	for (const record of options.records) {
		if (!record.name) {
			continue
		}
		if (REMOTE_CONFIG_PATH_REGEX.test(record.filePath)) {
			const remoteKey = remoteWorkflowCommandName(record.name)
			if (!remoteAlwaysEnabled.has(remoteKey) && remoteToggles.get(remoteKey) === false) {
				disabledWorkflowNames.add(record.name)
			}
			continue
		}
		// Toggles for this record's own file plus same-basename files that
		// collapsed into it. A same-named file with a record of its own governs
		// that record, not this one.
		const entries = (togglesByBasename.get(canonicalWorkflowName(fileBasename(record.filePath))) ?? []).filter(
			(entry) => entry.filePath === record.filePath || !recordFilePaths.has(entry.filePath),
		)
		if (entries.length === 0) {
			// No toggle tracks this file: enabled by default.
			continue
		}
		const preferred = entries.find((entry) => entry.enabled)
		if (!preferred) {
			disabledWorkflowNames.add(record.name)
		} else if (preferred.filePath !== record.filePath) {
			overrideFilePaths.set(record.name, preferred.filePath)
		}
	}
	return { disabledWorkflowNames, overrideFilePaths }
}
