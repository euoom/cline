import * as fs from "node:fs/promises"
import * as path from "node:path"
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
 * Matches a YAML frontmatter block at the start of a workflow file. Kept in
 * sync with `parseMarkdownFrontmatter` in @cline/core's
 * user-instruction-config-loader so a body read directly from a toggle file
 * matches what the SDK watcher would have produced for the same file.
 */
const WORKFLOW_FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

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
 * A runtime command optionally augmented with the absolute path of the file
 * backing it. Workflow toggles are keyed by file path, so the path is what
 * ties a watcher command back to the user's enable/disable toggles when the
 * file's frontmatter `name` differs from its file name.
 */
export interface ExpandableRuntimeCommand extends AvailableRuntimeCommand {
	filePath?: string
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
	commands: readonly ExpandableRuntimeCommand[],
	typedName: string,
): ExpandableRuntimeCommand | undefined {
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
	return undefined
}

/**
 * The user's workflow enable/disable toggle state, projected into the forms
 * expansion needs. Built by {@link buildWorkflowToggleState}.
 */
export interface WorkflowToggleState {
	/**
	 * Canonical (extension-less, lower-cased) workflow names disabled in every
	 * scope that mentions them: legacy expansion only searched enabled
	 * workflows across scopes, so a disabled workspace file must not shadow a
	 * same-named enabled global one (or vice versa).
	 */
	disabledNames: ReadonlySet<string>
	/** Resolved absolute paths of workflow files explicitly toggled off. */
	disabledFilePaths: ReadonlySet<string>
	/**
	 * Canonical name -> resolved absolute path of the highest-precedence
	 * *enabled* toggle file for that name (workspace before global), mirroring
	 * the legacy local-over-global expansion order and the slash menu.
	 */
	enabledFilePathsByName: ReadonlyMap<string, string>
}

const EMPTY_WORKFLOW_TOGGLE_STATE: WorkflowToggleState = {
	disabledNames: new Set(),
	disabledFilePaths: new Set(),
	enabledFilePathsByName: new Map(),
}

/**
 * Read a workflow body directly from a toggle file, stripping frontmatter the
 * same way the SDK watcher does. Returns undefined when the file is missing or
 * has no body, so the caller can fall back to the watcher's copy.
 */
async function readWorkflowInstructionsFromFile(filePath: string): Promise<string | undefined> {
	try {
		const content = await fs.readFile(filePath, "utf8")
		// Strip a leading UTF-8 BOM so the frontmatter regex can match, as the
		// SDK's parseMarkdownFrontmatter does.
		const instructions = content
			.replace(/^\uFEFF/, "")
			.replace(WORKFLOW_FRONTMATTER_REGEX, "")
			.trim()
		return instructions || undefined
	} catch {
		return undefined
	}
}

/**
 * Resolve the instruction body for a workflow slash-command token, honoring
 * the user's enable/disable toggles.
 *
 * The SDK watcher keeps a single file per workflow name (later search
 * directories win), so on a workspace/global name clash it may hold a
 * different file from the one the slash menu advertises. The toggle paths
 * carry the user's actual files and intent: prefer the highest-precedence
 * *enabled* toggle file for the name, reading its body from disk when it is
 * not the file the watcher kept — matching the legacy local-over-global
 * expansion order.
 */
async function resolveWorkflowInstructions(
	typedName: string,
	command: ExpandableRuntimeCommand | undefined,
	toggleState: WorkflowToggleState,
): Promise<string | undefined> {
	const names = new Set([canonicalWorkflowName(typedName)])
	if (command) {
		names.add(canonicalWorkflowName(command.name))
	}
	let enabledFilePath: string | undefined
	for (const name of names) {
		enabledFilePath = toggleState.enabledFilePathsByName.get(name)
		if (enabledFilePath) {
			break
		}
	}
	if (!command) {
		// The watcher may know this file only under its frontmatter `name`,
		// while the menu advertises (and the user typed) the file name from
		// the toggles.
		return enabledFilePath ? await readWorkflowInstructionsFromFile(enabledFilePath) : undefined
	}
	const commandFilePath = command.filePath ? path.resolve(command.filePath) : undefined
	if (enabledFilePath) {
		if (commandFilePath === enabledFilePath) {
			return command.instructions
		}
		return (await readWorkflowInstructionsFromFile(enabledFilePath)) ?? command.instructions
	}
	const disabled =
		[...names].some((name) => toggleState.disabledNames.has(name)) ||
		(commandFilePath !== undefined && toggleState.disabledFilePaths.has(commandFilePath))
	return disabled ? undefined : command.instructions
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
 * @param toggleState the user's workflow enable/disable toggles from
 *   {@link buildWorkflowToggleState}. Disabled workflows are left unexpanded
 *   and, when workflows in different scopes share a name, the highest-
 *   precedence enabled toggle file supplies the body, matching legacy
 *   semantics and the webview's slash menu.
 */
export async function expandSlashCommands(
	text: string,
	commands: readonly ExpandableRuntimeCommand[],
	toggleState: WorkflowToggleState = EMPTY_WORKFLOW_TOGGLE_STATE,
): Promise<string> {
	if (!text.includes("/") || (commands.length === 0 && toggleState.enabledFilePathsByName.size === 0)) {
		return text
	}
	for (const match of text.matchAll(SLASH_COMMAND_TOKEN_REGEX)) {
		const token = match[2]
		const typedName = token.slice(1)
		const command = findRuntimeCommand(commands, typedName)
		const instructions =
			command && command.kind !== "workflow"
				? command.instructions
				: await resolveWorkflowInstructions(typedName, command, toggleState)
		if (instructions === undefined) {
			continue
		}
		const start = (match.index ?? 0) + match[1].length
		const end = start + token.length
		return text.slice(0, start) + instructions + text.slice(end)
	}
	return text
}

export interface BuildWorkflowToggleStateOptions {
	/** `globalWorkflowToggles` (global settings) — keyed by absolute file path. */
	globalToggles?: Record<string, boolean>
	/** Workspace `workflowToggles` — keyed by absolute file path. */
	workspaceToggles?: Record<string, boolean>
	/** `remoteWorkflowToggles` (global state) — keyed by remote workflow name. */
	remoteToggles?: Record<string, boolean>
	/** Names of remote workflows the organization locks on (`alwaysEnabled`). */
	remoteAlwaysEnabledNames?: Iterable<string>
}

/**
 * Project the Workflows toggles (local, global, and enterprise/remote scopes)
 * into the state expansion needs: which canonical names are disabled
 * everywhere, which exact files are toggled off, and which enabled file wins
 * each name. Locked (`alwaysEnabled`) remote workflows always count as
 * enabled.
 */
export function buildWorkflowToggleState(options: BuildWorkflowToggleStateOptions): WorkflowToggleState {
	const enabledByName = new Map<string, boolean>()
	const register = (rawName: string, enabled: boolean) => {
		const name = canonicalWorkflowName(rawName)
		if (!name) {
			return
		}
		enabledByName.set(name, (enabledByName.get(name) ?? false) || enabled)
	}

	const disabledFilePaths = new Set<string>()
	const enabledFilePathsByName = new Map<string, string>()
	// Workspace toggles first: legacy expansion searched local workflows before
	// global ones, and the slash menu hides a global file behind a same-named
	// enabled local one, so the workspace file must win a name clash.
	for (const toggles of [options.workspaceToggles ?? {}, options.globalToggles ?? {}]) {
		for (const [filePath, enabled] of Object.entries(toggles)) {
			const name = canonicalWorkflowName(filePath.replace(/^.*[/\\]/, ""))
			if (!name) {
				continue
			}
			enabledByName.set(name, (enabledByName.get(name) ?? false) || enabled)
			if (enabled) {
				if (!enabledFilePathsByName.has(name)) {
					enabledFilePathsByName.set(name, path.resolve(filePath))
				}
			} else {
				disabledFilePaths.add(path.resolve(filePath))
			}
		}
	}
	for (const [name, enabled] of Object.entries(options.remoteToggles ?? {})) {
		register(name, enabled)
	}
	for (const name of options.remoteAlwaysEnabledNames ?? []) {
		register(name, true)
	}

	const disabledNames = new Set<string>()
	for (const [name, enabled] of enabledByName) {
		if (!enabled) {
			disabledNames.add(name)
		}
	}
	return { disabledNames, disabledFilePaths, enabledFilePathsByName }
}
