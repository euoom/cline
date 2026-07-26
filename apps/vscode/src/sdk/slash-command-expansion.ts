import type { AvailableRuntimeCommand } from "@cline/core"

/**
 * Matches a slash-command token that is either at the start of the message or
 * preceded by whitespace, and followed by whitespace or end-of-string. Kept in
 * sync with the webview's `slashCommandRegex` (webview-ui/src/utils/slash-commands.ts)
 * so anything the chat input highlights/autocompletes as a command can be expanded.
 */
const SLASH_COMMAND_TOKEN_REGEX = /(^|\s)(\/[a-zA-Z0-9_.:@-]+)(?=\s|$)/g

/** Extensions the SDK accepts as workflow files (see MARKDOWN_EXTENSIONS in @cline/core). */
const WORKFLOW_EXTENSION_REGEX = /\.(md|markdown|txt)$/i

/**
 * Find the runtime command matching a typed slash-command name.
 *
 * The SDK names workflows by frontmatter `name` or file basename *without* the
 * extension, but the webview autocomplete (and legacy Cline versions) surface
 * workflow files as `/my-workflow.md` (or `.markdown`/`.txt`). Accept both
 * spellings so workflows created under the legacy extension keep working after
 * an upgrade.
 */
function findRuntimeCommand(
	commands: readonly AvailableRuntimeCommand[],
	typedName: string,
): AvailableRuntimeCommand | undefined {
	const withoutExtension = typedName.replace(WORKFLOW_EXTENSION_REGEX, "")
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
 * @param disabledWorkflowNames lower-cased workflow names (with and without the
 *   file extension) the user disabled via the Workflows toggles. Disabled
 *   workflows are left unexpanded, matching legacy semantics.
 */
export function expandSlashCommands(
	text: string,
	commands: readonly AvailableRuntimeCommand[],
	disabledWorkflowNames: ReadonlySet<string> = new Set(),
): string {
	if (!text.includes("/") || commands.length === 0) {
		return text
	}
	for (const match of text.matchAll(SLASH_COMMAND_TOKEN_REGEX)) {
		const token = match[2]
		const typedName = token.slice(1)
		const command = findRuntimeCommand(commands, typedName)
		if (!command) {
			continue
		}
		if (
			command.kind === "workflow" &&
			(disabledWorkflowNames.has(typedName.toLowerCase()) || disabledWorkflowNames.has(command.name.toLowerCase()))
		) {
			continue
		}
		const start = (match.index ?? 0) + match[1].length
		const end = start + token.length
		return text.slice(0, start) + command.instructions + text.slice(end)
	}
	return text
}

/**
 * Build the set of workflow names the user disabled via the Rules & Workflows
 * modal. Global/workspace toggle maps are keyed by absolute file path; remote
 * (enterprise) toggles are keyed by workflow name. Expansion matches by command
 * name, so index by basename both with and without the file extension
 * (lower-cased). A name counts as disabled only when no scope enables it,
 * matching the slash menu, which still offers a global workflow when a
 * same-named workspace workflow is disabled.
 */
export function buildDisabledWorkflowNames(
	globalToggles: Record<string, boolean> | undefined,
	workspaceToggles: Record<string, boolean> | undefined,
	remoteToggles?: Record<string, boolean>,
	remoteWorkflows?: readonly { name: string; alwaysEnabled?: boolean }[],
): Set<string> {
	const merged = new Map<string, boolean>()
	const mergeEnabled = (fileName: string, enabled: boolean) => {
		const key = fileName.toLowerCase()
		if (!key) {
			return
		}
		merged.set(key, (merged.get(key) ?? false) || enabled)
		const withoutExtension = key.replace(WORKFLOW_EXTENSION_REGEX, "")
		if (withoutExtension && withoutExtension !== key) {
			merged.set(withoutExtension, (merged.get(withoutExtension) ?? false) || enabled)
		}
	}
	for (const toggles of [globalToggles ?? {}, workspaceToggles ?? {}]) {
		for (const [filePath, enabled] of Object.entries(toggles)) {
			mergeEnabled(filePath.replace(/^.*[/\\]/, ""), enabled)
		}
	}
	// Remote workflows default to enabled when untoggled, and `alwaysEnabled`
	// ones cannot be turned off — same rule the slash menu applies.
	for (const workflow of remoteWorkflows ?? []) {
		mergeEnabled(workflow.name, workflow.alwaysEnabled === true || remoteToggles?.[workflow.name] !== false)
	}
	const disabled = new Set<string>()
	for (const [name, enabled] of merged) {
		if (!enabled) {
			disabled.add(name)
		}
	}
	return disabled
}
