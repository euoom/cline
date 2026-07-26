import type { AvailableRuntimeCommand } from "@cline/core"
import { describe, expect, it } from "vitest"
import { buildWorkflowToggleState, expandSlashCommands } from "./slash-command-expansion"

function disabledWorkflowNames(options: Parameters<typeof buildWorkflowToggleState>[0]): Set<string> {
	return buildWorkflowToggleState(options).disabledWorkflowNames
}

function workflow(name: string, instructions: string): AvailableRuntimeCommand {
	return { id: name, name, instructions, kind: "workflow" }
}

function skill(name: string, instructions: string): AvailableRuntimeCommand {
	return { id: name, name, instructions, kind: "skill" }
}

describe("expandSlashCommands", () => {
	const commands = [workflow("release", "Run the release workflow."), skill("debug", "Use the debugging skill.")]

	it("expands a leading workflow command", () => {
		expect(expandSlashCommands("/release", commands)).toBe("Run the release workflow.")
		expect(expandSlashCommands("/release now", commands)).toBe("Run the release workflow. now")
	})

	it("expands the legacy filename spelling with the .md extension", () => {
		expect(expandSlashCommands("/release.md now", commands)).toBe("Run the release workflow. now")
	})

	it("expands the other workflow file extensions the SDK discovers", () => {
		expect(expandSlashCommands("/release.markdown", commands)).toBe("Run the release workflow.")
		expect(expandSlashCommands("/release.txt", commands)).toBe("Run the release workflow.")
	})

	it("matches case-insensitively as a fallback, like webview validation", () => {
		expect(expandSlashCommands("/Release.MD", commands)).toBe("Run the release workflow.")
	})

	it("resolves a typed filename to a frontmatter-renamed workflow via records", () => {
		const renamed = [workflow("ship-it", "Ship it carefully.")]
		const records = [{ name: "ship-it", filePath: "/repo/.clinerules/workflows/release.md" }]
		expect(expandSlashCommands("/release.md", renamed, { workflowRecords: records })).toBe("Ship it carefully.")
		// The renamed command stays governed by its file's toggle.
		expect(
			expandSlashCommands("/release.md", renamed, {
				workflowRecords: records,
				disabledWorkflowNames: new Set(["ship-it"]),
			}),
		).toBe("/release.md")
	})

	it("expands a command that appears mid-message after whitespace", () => {
		expect(expandSlashCommands("please run /release.md for v2", commands)).toBe("please run Run the release workflow. for v2")
	})

	it("only expands the first matching command", () => {
		expect(expandSlashCommands("/release then /debug", commands)).toBe("Run the release workflow. then /debug")
	})

	it("skips unknown commands but still expands a later known one", () => {
		expect(expandSlashCommands("/newtask use /release", commands)).toBe("/newtask use Run the release workflow.")
	})

	it("expands skills by name", () => {
		expect(expandSlashCommands("/debug this failure", commands)).toBe("Use the debugging skill. this failure")
	})

	it("does not treat path segments as commands", () => {
		expect(expandSlashCommands("look at /release/notes.txt", commands)).toBe("look at /release/notes.txt")
	})

	it("returns unknown commands unchanged", () => {
		expect(expandSlashCommands("/missing", commands)).toBe("/missing")
		expect(expandSlashCommands("no commands here", commands)).toBe("no commands here")
	})

	it("skips workflows the user disabled via toggles", () => {
		const disabled = new Set(["release"])
		expect(expandSlashCommands("/release", commands, { disabledWorkflowNames: disabled })).toBe("/release")
		expect(expandSlashCommands("/release.md", commands, { disabledWorkflowNames: disabled })).toBe("/release.md")
		// Skills are governed by frontmatter, not workflow toggles.
		expect(expandSlashCommands("/debug", commands, { disabledWorkflowNames: new Set(["debug"]) })).toBe(
			"Use the debugging skill.",
		)
	})

	it("expands a remote workflow typed under its unsanitized config name", () => {
		// Remote config name "Team:Deploy" materializes as team-deploy.md, and
		// the runtime command is named after that sanitized basename.
		const remote = [workflow("team-deploy", "Deploy via the team pipeline.")]
		expect(expandSlashCommands("/Team:Deploy", remote)).toBe("Deploy via the team pipeline.")
		expect(expandSlashCommands("/team-deploy", remote)).toBe("Deploy via the team pipeline.")
	})

	it("prefers the override body for workflows whose record lost legacy scope precedence", () => {
		const overrides = new Map([["release", "Run the workspace release workflow."]])
		expect(expandSlashCommands("/release now", commands, { workflowInstructionOverrides: overrides })).toBe(
			"Run the workspace release workflow. now",
		)
		// Skills are never overridden by workflow toggles.
		expect(
			expandSlashCommands("/debug", commands, {
				workflowInstructionOverrides: new Map([["debug", "nope"]]),
			}),
		).toBe("Use the debugging skill.")
	})
})

describe("buildWorkflowToggleState", () => {
	it("disables records whose file toggle is off, by exact command name", () => {
		const disabled = disabledWorkflowNames({
			records: [
				{ name: "Release", filePath: "/home/user/Documents/Cline/Workflows/Release.md" },
				{ name: "notes", filePath: "/home/user/Documents/Cline/Workflows/notes.txt" },
				{ name: "keep", filePath: "/home/user/Documents/Cline/Workflows/keep.md" },
			],
			globalToggles: {
				"/home/user/Documents/Cline/Workflows/Release.md": false,
				"/home/user/Documents/Cline/Workflows/notes.txt": false,
				"/home/user/Documents/Cline/Workflows/keep.md": true,
			},
		})
		expect(disabled).toEqual(new Set(["Release", "notes"]))
	})

	it("matches the toggle by file basename even when frontmatter renames the command", () => {
		const disabled = disabledWorkflowNames({
			records: [{ name: "ship-it", filePath: "/repo/.clinerules/workflows/release.md" }],
			workspaceToggles: { "/repo/.clinerules/workflows/release.md": false },
		})
		expect(disabled).toEqual(new Set(["ship-it"]))
	})

	it("keeps a name enabled when any scope has it enabled", () => {
		// Legacy expansion searched enabled workflows across scopes, so a
		// disabled workspace file must not shadow an enabled global one.
		const records = [{ name: "release", filePath: "/repo/.clinerules/workflows/release.md" }]
		expect(
			disabledWorkflowNames({
				records,
				globalToggles: { "/global/dir/release.md": true },
				workspaceToggles: { "/repo/.clinerules/workflows/release.md": false },
			}),
		).toEqual(new Set())
		expect(
			disabledWorkflowNames({
				records,
				globalToggles: { "/global/dir/release.md": false },
				workspaceToggles: { "/repo/.clinerules/workflows/release.md": true },
			}),
		).toEqual(new Set())
	})

	it("overrides the record body with the enabled file another scope shadowed", () => {
		// Same-named files collapse into one SDK record (later-scanned
		// directories win), but legacy expanded the *enabled* file, preferring
		// workspace over global — like the slash menu.
		const records = [{ name: "release", filePath: "/global/dir/release.md" }]
		// Disabled global record, enabled workspace file: expand the workspace body.
		expect(
			buildWorkflowToggleState({
				records,
				globalToggles: { "/global/dir/release.md": false },
				workspaceToggles: { "/repo/.clinerules/workflows/release.md": true },
			}).overrideFilePaths,
		).toEqual(new Map([["release", "/repo/.clinerules/workflows/release.md"]]))
		// Both enabled: the workspace file still wins, matching the menu.
		expect(
			buildWorkflowToggleState({
				records,
				globalToggles: { "/global/dir/release.md": true },
				workspaceToggles: { "/repo/.clinerules/workflows/release.md": true },
			}).overrideFilePaths,
		).toEqual(new Map([["release", "/repo/.clinerules/workflows/release.md"]]))
		// The record's own file is the preferred enabled one: no override.
		expect(
			buildWorkflowToggleState({
				records,
				globalToggles: { "/global/dir/release.md": true },
				workspaceToggles: { "/repo/.clinerules/workflows/release.md": false },
			}).overrideFilePaths,
		).toEqual(new Map())
	})

	it("does not let a same-named file with its own record govern or override another record", () => {
		// The workspace file was renamed via frontmatter, so it kept its own
		// record: it must not override (or disable) the global "release" record.
		const records = [
			{ name: "ship-it", filePath: "/repo/.clinerules/workflows/release.md" },
			{ name: "release", filePath: "/global/dir/release.md" },
		]
		const state = buildWorkflowToggleState({
			records,
			globalToggles: { "/global/dir/release.md": false },
			workspaceToggles: { "/repo/.clinerules/workflows/release.md": true },
		})
		expect(state.disabledWorkflowNames).toEqual(new Set(["release"]))
		expect(state.overrideFilePaths).toEqual(new Map())
	})

	it("governs each command by its own record when similar names span scopes", () => {
		// Distinct commands whose names only differ by case/extension must not
		// influence each other: the disabled remote command stays disabled even
		// though the similarly-named local one is enabled, and vice versa.
		const records = [
			{ name: "Release", filePath: "/repo/.clinerules/workflows/Release.md" },
			{ name: "release", filePath: "/repo/.cline/remote-config/workflows/release.md" },
		]
		expect(
			disabledWorkflowNames({
				records,
				workspaceToggles: { "/repo/.clinerules/workflows/Release.md": true },
				remoteToggles: { release: false },
			}),
		).toEqual(new Set(["release"]))
		expect(
			disabledWorkflowNames({
				records,
				workspaceToggles: { "/repo/.clinerules/workflows/Release.md": false },
				remoteAlwaysEnabledNames: ["release"],
			}),
		).toEqual(new Set(["Release"]))
	})

	it("treats records without any toggle entry as enabled", () => {
		const disabled = disabledWorkflowNames({
			records: [{ name: "fresh", filePath: "/home/user/.cline/workflows/fresh.md" }],
			globalToggles: { "/global/dir/other.md": false },
		})
		expect(disabled).toEqual(new Set())
	})

	it("governs remote-config records by name-keyed remote toggles", () => {
		const disabled = disabledWorkflowNames({
			records: [
				{ name: "org-standards", filePath: "/repo/.cline/remote-config/workflows/org-standards.md" },
				{ name: "org-review", filePath: "/repo/.cline/remote-config/workflows/org-review.md" },
				{ name: "org-default", filePath: "C:\\repo\\.cline\\remote-config\\workflows\\org-default.md" },
			],
			remoteToggles: { "org-standards": false, "org-review": true },
		})
		expect(disabled).toEqual(new Set(["org-standards"]))
	})

	it("matches remote toggles whose config names get sanitized during materialization", () => {
		// "Org Standards" materializes as org-standards.md, and the record is
		// named after the sanitized basename.
		const disabled = disabledWorkflowNames({
			records: [{ name: "org-standards", filePath: "/repo/.cline/remote-config/workflows/org-standards.md" }],
			remoteToggles: { "Org Standards": false },
		})
		expect(disabled).toEqual(new Set(["org-standards"]))
	})

	it("treats locked (alwaysEnabled) remote workflows as enabled despite stale toggles", () => {
		const disabled = disabledWorkflowNames({
			records: [{ name: "org-standards", filePath: "/repo/.cline/remote-config/workflows/org-standards.md" }],
			remoteToggles: { "Org Standards": false },
			remoteAlwaysEnabledNames: ["Org Standards"],
		})
		expect(disabled).toEqual(new Set())
	})

	it("collects disabled names across local and remote scopes", () => {
		const disabled = disabledWorkflowNames({
			records: [
				{ name: "deploy", filePath: "/global/dir/deploy.md" },
				{ name: "keep", filePath: "/global/dir/keep.md" },
				{ name: "hotfix", filePath: "C:\\repo\\.clinerules\\workflows\\hotfix.md" },
				{ name: "org-standards", filePath: "/repo/.cline/remote-config/workflows/org-standards.md" },
			],
			globalToggles: { "/global/dir/deploy.md": false, "/global/dir/keep.md": true },
			workspaceToggles: { "C:\\repo\\.clinerules\\workflows\\hotfix.md": false },
			remoteToggles: { "org-standards": false },
		})
		expect(disabled).toEqual(new Set(["deploy", "hotfix", "org-standards"]))
	})
})
