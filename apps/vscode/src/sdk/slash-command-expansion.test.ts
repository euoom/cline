import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { AvailableRuntimeCommand } from "@cline/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildWorkflowToggleState, type ExpandableRuntimeCommand, expandSlashCommands } from "./slash-command-expansion"

function workflow(name: string, instructions: string, filePath?: string): ExpandableRuntimeCommand {
	return { id: name, name, instructions, kind: "workflow", filePath }
}

function skill(name: string, instructions: string): AvailableRuntimeCommand {
	return { id: name, name, instructions, kind: "skill" }
}

describe("expandSlashCommands", () => {
	const commands = [workflow("release", "Run the release workflow."), skill("debug", "Use the debugging skill.")]

	it("expands a leading workflow command", async () => {
		expect(await expandSlashCommands("/release", commands)).toBe("Run the release workflow.")
		expect(await expandSlashCommands("/release now", commands)).toBe("Run the release workflow. now")
	})

	it("expands the legacy filename spelling with the .md extension", async () => {
		expect(await expandSlashCommands("/release.md now", commands)).toBe("Run the release workflow. now")
	})

	it("expands the other workflow file extensions the SDK discovers", async () => {
		expect(await expandSlashCommands("/release.markdown", commands)).toBe("Run the release workflow.")
		expect(await expandSlashCommands("/release.txt", commands)).toBe("Run the release workflow.")
	})

	it("matches case-insensitively as a fallback, like webview validation", async () => {
		expect(await expandSlashCommands("/Release.MD", commands)).toBe("Run the release workflow.")
	})

	it("expands a command that appears mid-message after whitespace", async () => {
		expect(await expandSlashCommands("please run /release.md for v2", commands)).toBe(
			"please run Run the release workflow. for v2",
		)
	})

	it("only expands the first matching command", async () => {
		expect(await expandSlashCommands("/release then /debug", commands)).toBe("Run the release workflow. then /debug")
	})

	it("skips unknown commands but still expands a later known one", async () => {
		expect(await expandSlashCommands("/newtask use /release", commands)).toBe("/newtask use Run the release workflow.")
	})

	it("expands skills by name", async () => {
		expect(await expandSlashCommands("/debug this failure", commands)).toBe("Use the debugging skill. this failure")
	})

	it("does not treat path segments as commands", async () => {
		expect(await expandSlashCommands("look at /release/notes.txt", commands)).toBe("look at /release/notes.txt")
	})

	it("returns unknown commands unchanged", async () => {
		expect(await expandSlashCommands("/missing", commands)).toBe("/missing")
		expect(await expandSlashCommands("no commands here", commands)).toBe("no commands here")
	})

	it("skips workflows the user disabled via toggles", async () => {
		const toggles = buildWorkflowToggleState({ globalToggles: { "/global/dir/release.md": false } })
		expect(await expandSlashCommands("/release", commands, toggles)).toBe("/release")
		expect(await expandSlashCommands("/release.md", commands, toggles)).toBe("/release.md")
		// Skills are governed by frontmatter, not workflow toggles.
		const debugToggles = buildWorkflowToggleState({ globalToggles: { "/global/dir/debug.md": false } })
		expect(await expandSlashCommands("/debug", commands, debugToggles)).toBe("Use the debugging skill.")
	})

	it("skips a workflow whose backing file is toggled off even when its frontmatter name differs", async () => {
		// Toggles are keyed by file path (basename "deploy"), while the runtime
		// command carries the frontmatter name "deploy-checklist".
		const renamed = [workflow("deploy-checklist", "Follow the checklist.", "/global/dir/deploy.md")]
		const toggles = buildWorkflowToggleState({ globalToggles: { "/global/dir/deploy.md": false } })
		expect(await expandSlashCommands("/deploy-checklist", renamed, toggles)).toBe("/deploy-checklist")
		expect(await expandSlashCommands("/deploy-checklist", renamed)).toBe("Follow the checklist.")
	})
})

describe("expandSlashCommands with same-named workflows across scopes", () => {
	let tempDir: string

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "slash-command-expansion-"))
	})

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("prefers the workspace file over the watcher's same-named global file", async () => {
		// Same canonical name "release" for both files.
		const wsPath = path.join(tempDir, "release-ws", "release.md")
		const globalPath = path.join(tempDir, "release-global", "release.md")
		await fs.mkdir(path.dirname(wsPath), { recursive: true })
		await fs.mkdir(path.dirname(globalPath), { recursive: true })
		await fs.writeFile(wsPath, "---\nname: release\n---\nRun the WORKSPACE release workflow.\n")
		await fs.writeFile(globalPath, "Run the GLOBAL release workflow.\n")

		const commands = [workflow("release", "Run the GLOBAL release workflow.", globalPath)]
		const bothEnabled = buildWorkflowToggleState({
			globalToggles: { [globalPath]: true },
			workspaceToggles: { [wsPath]: true },
		})
		expect(await expandSlashCommands("/release.md", commands, bothEnabled)).toBe("Run the WORKSPACE release workflow.")

		// A disabled workspace file must not shadow the enabled global one.
		const workspaceDisabled = buildWorkflowToggleState({
			globalToggles: { [globalPath]: true },
			workspaceToggles: { [wsPath]: false },
		})
		expect(await expandSlashCommands("/release.md", commands, workspaceDisabled)).toBe("Run the GLOBAL release workflow.")
	})

	it("expands an enabled toggle file by file name even when the watcher named it differently", async () => {
		// The file's frontmatter names the command "deploy-checklist", so the
		// watcher has no command named "deploy" — but the menu advertises the
		// file name from the toggles.
		const deployPath = path.join(tempDir, "deploy.md")
		await fs.writeFile(deployPath, "---\nname: deploy-checklist\n---\nFollow the checklist.\n")
		const commands = [workflow("deploy-checklist", "Follow the checklist.", deployPath)]
		const toggles = buildWorkflowToggleState({ workspaceToggles: { [deployPath]: true } })
		expect(await expandSlashCommands("/deploy.md", commands, toggles)).toBe("Follow the checklist.")
	})
})

describe("buildWorkflowToggleState", () => {
	it("indexes disabled workflows by canonical (extension-less, lower-cased) name", () => {
		const { disabledNames } = buildWorkflowToggleState({
			globalToggles: {
				"/home/user/Documents/Cline/Workflows/Release.md": false,
				"/home/user/Documents/Cline/Workflows/notes.txt": false,
			},
		})
		expect(disabledNames).toEqual(new Set(["release", "notes"]))
	})

	it("keeps a name enabled when any scope has it enabled", () => {
		// Legacy expansion searched enabled workflows across scopes, so a
		// disabled workspace file must not shadow an enabled global one.
		expect(
			buildWorkflowToggleState({
				globalToggles: { "/global/dir/release.md": true },
				workspaceToggles: { "/repo/.clinerules/workflows/release.md": false },
			}).disabledNames,
		).toEqual(new Set())
		expect(
			buildWorkflowToggleState({
				globalToggles: { "/global/dir/release.md": false },
				workspaceToggles: { "/repo/.clinerules/workflows/release.md": true },
			}).disabledNames,
		).toEqual(new Set())
	})

	it("collects disabled names from every scope, including remote", () => {
		const { disabledNames } = buildWorkflowToggleState({
			globalToggles: { "/global/dir/deploy.md": false, "/global/dir/keep.md": true },
			workspaceToggles: { "C:\\repo\\.clinerules\\workflows\\hotfix.md": false },
			remoteToggles: { "org-standards": false, "org-review": true },
		})
		expect(disabledNames).toEqual(new Set(["deploy", "hotfix", "org-standards"]))
	})

	it("treats locked (alwaysEnabled) remote workflows as enabled despite stale toggles", () => {
		const { disabledNames } = buildWorkflowToggleState({
			remoteToggles: { "org-standards": false },
			remoteAlwaysEnabledNames: ["org-standards"],
		})
		expect(disabledNames).toEqual(new Set())
	})

	it("records explicitly disabled file paths", () => {
		const { disabledFilePaths } = buildWorkflowToggleState({
			globalToggles: { "/global/dir/deploy.md": false, "/global/dir/keep.md": true },
		})
		expect(disabledFilePaths).toEqual(new Set([path.resolve("/global/dir/deploy.md")]))
	})

	it("maps each name to its highest-precedence enabled file, workspace first", () => {
		const { enabledFilePathsByName } = buildWorkflowToggleState({
			globalToggles: { "/global/dir/release.md": true, "/global/dir/deploy.md": true },
			workspaceToggles: { "/repo/.clinerules/workflows/release.md": true },
		})
		expect(enabledFilePathsByName.get("release")).toBe(path.resolve("/repo/.clinerules/workflows/release.md"))
		expect(enabledFilePathsByName.get("deploy")).toBe(path.resolve("/global/dir/deploy.md"))
	})
})
