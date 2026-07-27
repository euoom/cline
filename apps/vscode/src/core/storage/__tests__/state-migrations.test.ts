import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type * as vscode from "vscode"
import { migrateWelcomeViewCompleted } from "../state-migrations"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FakeStores {
	globalState?: Record<string, unknown>
	secrets?: Record<string, string>
}

/** Minimal ExtensionContext exposing the stores the migration touches. */
function makeContext(initial: FakeStores = {}) {
	const globalState = new Map<string, unknown>(Object.entries(initial.globalState ?? {}))
	const secrets = new Map<string, string>(Object.entries(initial.secrets ?? {}))
	const context = {
		globalState: {
			get: (key: string) => globalState.get(key),
			update: async (key: string, value: unknown) => {
				if (value === undefined) {
					globalState.delete(key)
				} else {
					globalState.set(key, value)
				}
			},
		},
		secrets: {
			get: async (key: string) => secrets.get(key),
		},
	} as unknown as vscode.ExtensionContext
	return { context, globalState }
}

let dataDir: string

/** Seed the file-backed stores under the temp data dir. */
function writeDataFile(relativePath: string, contents: unknown) {
	const filePath = path.join(dataDir, relativePath)
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.writeFileSync(filePath, JSON.stringify(contents, null, 2), "utf-8")
}

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-state-migrations-"))
})

afterEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// migrateWelcomeViewCompleted
// ---------------------------------------------------------------------------

describe("migrateWelcomeViewCompleted", () => {
	it("leaves an already-set VS Code flag untouched", async () => {
		const { context, globalState } = makeContext({ globalState: { welcomeViewCompleted: true } })
		writeDataFile("globalState.json", { welcomeViewCompleted: false })

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(true)
	})

	it("sets false when no configuration exists anywhere (fresh install)", async () => {
		const { context, globalState } = makeContext()

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(false)
	})

	it("mirrors welcomeViewCompleted=true from the file-backed global state", async () => {
		const { context, globalState } = makeContext()
		writeDataFile("globalState.json", { welcomeViewCompleted: true })

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(true)
	})

	it("mirrors welcomeViewCompleted=false from the file-backed global state without recomputing", async () => {
		const { context, globalState } = makeContext()
		// Even with a key on disk, an explicit false in the runtime source of
		// truth wins — the migration must not disagree with the file store.
		writeDataFile("globalState.json", { welcomeViewCompleted: false })
		writeDataFile("secrets.json", { apiKey: "sk-ant-123" })

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(false)
	})

	it("detects an API key in VS Code SecretStorage (pre-4.x upgrade path)", async () => {
		const { context, globalState } = makeContext({ secrets: { apiKey: "sk-ant-123" } })

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(true)
	})

	it("detects provider secrets the old hardcoded list missed (e.g. moonshotApiKey)", async () => {
		const { context, globalState } = makeContext({ secrets: { moonshotApiKey: "mk-123" } })

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(true)
	})

	it("detects an API key in the file-backed secrets.json (ENG-2346 regression)", async () => {
		const { context, globalState } = makeContext()
		writeDataFile("secrets.json", { openRouterApiKey: "sk-or-123" })

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(true)
	})

	it("ignores non-provider secrets like authNonce and mcpOAuthSecrets", async () => {
		const { context, globalState } = makeContext({ secrets: { authNonce: "nonce" } })
		writeDataFile("secrets.json", { mcpOAuthSecrets: "{}" })

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(false)
	})

	it("detects keyless provider config in VS Code global state (e.g. planModeOllamaModelId)", async () => {
		const { context, globalState } = makeContext({ globalState: { planModeOllamaModelId: "llama3" } })

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(true)
	})

	it("detects keyless provider config in the file-backed globalState.json (e.g. awsRegion)", async () => {
		const { context, globalState } = makeContext()
		writeDataFile("globalState.json", { awsRegion: "us-east-1" })

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(true)
	})

	it("detects providers configured in the SDK's providers.json", async () => {
		const { context, globalState } = makeContext()
		writeDataFile("settings/providers.json", {
			version: 1,
			providers: {
				anthropic: {
					settings: { provider: "anthropic", apiKey: "sk-ant-123", model: "claude-sonnet-4-6" },
					updatedAt: "2026-07-01T00:00:00.000Z",
					tokenSource: "migration",
				},
			},
			lastUsedProvider: "anthropic",
		})

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(true)
	})

	it("treats an empty providers map in providers.json as unconfigured", async () => {
		const { context, globalState } = makeContext()
		writeDataFile("settings/providers.json", { version: 1, providers: {} })

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(false)
	})

	it("treats a corrupt providers.json as unconfigured", async () => {
		const { context, globalState } = makeContext()
		const providersPath = path.join(dataDir, "settings", "providers.json")
		fs.mkdirSync(path.dirname(providersPath), { recursive: true })
		fs.writeFileSync(providersPath, "not json", "utf-8")

		await migrateWelcomeViewCompleted(context, dataDir)

		expect(globalState.get("welcomeViewCompleted")).toBe(false)
	})
})
