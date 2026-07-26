export interface SlashCommand {
	name: string
	description?: string
	section?: "default" | "custom" | "mcp"
	cliCompatible?: boolean
}

/**
 * The slash-command name a remote (enterprise) workflow is invoked by.
 *
 * Remote workflows materialize to files named via @cline/shared's
 * `sanitizeSegment` (lower-cased, disallowed character runs collapsed to `-`),
 * and the discovered runtime command is named after that sanitized basename.
 * The remote config name itself (e.g. "Org Standards") may contain characters
 * a slash-command token can't carry, so menus insert — and send-time expansion
 * matches — this sanitized form (e.g. `/org-standards`).
 */
export function remoteWorkflowCommandName(value: string): string {
	const stripped = value
		.trim()
		.toLowerCase()
		.replace(/\.(md|markdown|txt)$/i, "")
	const sanitized = stripped.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
	return sanitized || stripped
}

export const BASE_SLASH_COMMANDS: SlashCommand[] = [
	{
		name: "newtask",
		description: "Create a new task with context from the current task",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "deep-planning",
		description: "Create a comprehensive implementation plan before coding",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "smol",
		description: "Condenses your current context window",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "newrule",
		description: "Create a new Cline rule based on your conversation",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "reportbug",
		description: "Create a Github issue with Cline",
		section: "default",
		cliCompatible: true,
	},
]

// VS Code-only slash commands
export const VSCODE_ONLY_COMMANDS: SlashCommand[] = []
