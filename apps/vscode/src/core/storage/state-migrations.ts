import fs from "fs/promises"
import path from "path"
import * as vscode from "vscode"
import { readGlobalState, readSecrets, resolveDataDir } from "@/sdk/legacy-state-reader"
import { Logger } from "@/shared/services/Logger"
import { SecretKeys } from "@/shared/storage/state-keys"
import { ensureRulesDirectoryExists } from "./disk"

export async function migrateWorkspaceToGlobalStorage(context: vscode.ExtensionContext) {
	// Keys to migrate from workspace storage back to global storage
	const keysToMigrate = [
		// Core settings
		"apiProvider",
		"apiModelId",
		"thinkingBudgetTokens",
		"reasoningEffort",
		"vsCodeLmModelSelector",

		// Provider-specific model keys
		"awsBedrockCustomSelected",
		"awsBedrockCustomModelBaseId",
		"openRouterModelId",
		"openRouterModelInfo",
		"openAiModelId",
		"openAiModelInfo",
		"ollamaModelId",
		"lmStudioModelId",
		"liteLlmModelId",
		"liteLlmModelInfo",
		"requestyModelId",
		"requestyModelInfo",
		"togetherModelId",
		"fireworksModelId",
		"sapAiCoreModelId",
		"groqModelId",
		"groqModelInfo",
		"huggingFaceModelId",
		"huggingFaceModelInfo",

		// Previous mode settings
		"previousModeApiProvider",
		"previousModeModelId",
		"previousModeModelInfo",
		"previousModeVsCodeLmModelSelector",
		"previousModeThinkingBudgetTokens",
		"previousModeReasoningEffort",
		"previousModeAwsBedrockCustomSelected",
		"previousModeAwsBedrockCustomModelBaseId",
		"previousModeSapAiCoreModelId",
	]

	for (const key of keysToMigrate) {
		// Use raw workspace state since these keys shouldn't be in workspace storage
		const workspaceValue = await context.workspaceState.get(key)
		const globalValue = await context.globalState.get(key)

		if (workspaceValue !== undefined && globalValue === undefined) {
			Logger.log(`[Storage Migration] migrating key: ${key} to global storage. Current value: ${workspaceValue}`)

			// Move to global storage using raw VSCode method to avoid type errors
			await context.globalState.update(key, workspaceValue)
			// Remove from workspace storage
			await context.workspaceState.update(key, undefined)
			const newWorkspaceValue = await context.workspaceState.get(key)

			Logger.log(`[Storage Migration] migrated key: ${key} to global storage. Current value: ${newWorkspaceValue}`)
		}
	}
}

export async function migrateTaskHistoryToFile(_context: vscode.ExtensionContext) {
	// TODO migrate to sdk location
}

export async function migrateCustomInstructionsToGlobalRules(context: vscode.ExtensionContext) {
	try {
		const customInstructions = (await context.globalState.get("customInstructions")) as string | undefined

		if (customInstructions?.trim()) {
			Logger.log("Migrating custom instructions to global Cline rules...")

			// Create global .clinerules directory if it doesn't exist
			const globalRulesDir = await ensureRulesDirectoryExists()

			// Use a fixed filename for custom instructions
			const migrationFileName = "custom_instructions.md"
			const migrationFilePath = path.join(globalRulesDir, migrationFileName)

			try {
				// Check if file already exists to determine if we should append
				let existingContent = ""
				try {
					existingContent = await fs.readFile(migrationFilePath, "utf8")
				} catch (_readError) {
					// File doesn't exist, which is fine
				}

				// Append or create the file with custom instructions
				const contentToWrite = existingContent
					? `${existingContent}\n\n---\n\n${customInstructions.trim()}`
					: customInstructions.trim()

				await fs.writeFile(migrationFilePath, contentToWrite)
				Logger.log(`Successfully ${existingContent ? "appended to" : "created"} migration file: ${migrationFilePath}`)
			} catch (fileError) {
				Logger.error("Failed to write migration file:", fileError)
				return
			}

			// Remove customInstructions from global state only after successful file creation
			await context.globalState.update("customInstructions", undefined)
			Logger.log("Successfully migrated custom instructions to global Cline rules")
		}
	} catch (error) {
		Logger.error("Failed to migrate custom instructions to global rules:", error)
		// Continue execution - migration failure shouldn't break extension startup
	}
}

// Secrets that exist for reasons other than a configured LLM provider. Their
// presence alone doesn't mean the user has completed provider setup.
const NON_PROVIDER_SECRET_KEYS: ReadonlySet<string> = new Set(["authNonce", "mcpOAuthSecrets"])

// Provider configurations that live in global state rather than secrets
// (local providers, cloud configs without an API key, VS Code LM). Same set
// the pre-SDK welcome view used to decide whether setup was complete.
const PROVIDER_CONFIG_GLOBAL_STATE_KEYS = [
	"awsRegion",
	"vertexProjectId",
	"planModeOllamaModelId",
	"planModeLmStudioModelId",
	"actModeOllamaModelId",
	"actModeLmStudioModelId",
	"planModeVsCodeLmModelSelector",
	"actModeVsCodeLmModelSelector",
] as const

/**
 * Check whether the SDK's providers.json contains any configured provider.
 * Read directly (rather than through ProviderSettingsManager) so this early
 * migration step has no side effects — constructing the manager triggers the
 * SDK's own legacy migration and populates a process-wide singleton cache.
 */
async function hasConfiguredSdkProviders(dataDir?: string): Promise<boolean> {
	try {
		const providersPath = path.join(resolveDataDir(dataDir), "settings", "providers.json")
		const parsed = JSON.parse(await fs.readFile(providersPath, "utf8")) as { providers?: Record<string, unknown> }
		return Object.keys(parsed?.providers ?? {}).length > 0
	} catch {
		// Missing or unreadable file — no providers configured there.
		return false
	}
}

/**
 * One-time backfill of the `welcomeViewCompleted` flag for users upgrading
 * from builds that didn't persist it.
 *
 * Provider configuration may live in any of three places, all of which must
 * be considered:
 * - VS Code's per-profile stores (`context.secrets` / `context.globalState`) — pre-4.x builds
 * - the shared file-backed stores (`~/.cline/data/globalState.json` + `secrets.json`) — 4.x builds
 * - the SDK's `~/.cline/data/settings/providers.json` — SDK-based clients (e.g. the CLI)
 *
 * Checking only the VS Code stores (the pre-SDK behavior) marked fully
 * migrated users with file-backed config as `welcomeViewCompleted: false`,
 * pushing them back through onboarding on upgrade.
 *
 * @param dataDir Override for the Cline data directory (tests only).
 */
export async function migrateWelcomeViewCompleted(context: vscode.ExtensionContext, dataDir?: string) {
	try {
		// Check if welcomeViewCompleted is already set
		const welcomeViewCompleted = context.globalState.get("welcomeViewCompleted")
		if (welcomeViewCompleted !== undefined) {
			return
		}

		Logger.log("Migrating welcomeViewCompleted setting...")

		// The file-backed global state is the runtime source of truth and may
		// already carry the flag (written by the legacy 4.x extension). Mirror
		// it instead of recomputing so an onboarded user is never sent back
		// through the welcome view.
		const fileGlobalState = readGlobalState(dataDir)
		if (fileGlobalState.welcomeViewCompleted !== undefined) {
			await context.globalState.update("welcomeViewCompleted", fileGlobalState.welcomeViewCompleted)
			Logger.log(
				`Migration: Mirrored welcomeViewCompleted=${fileGlobalState.welcomeViewCompleted} from file-backed global state`,
			)
			return
		}

		// Any provider secret in either store means setup was completed.
		const fileSecrets: Record<string, string | undefined> = readSecrets(dataDir)
		let hasKey = Object.entries(fileSecrets).some(([key, value]) => !NON_PROVIDER_SECRET_KEYS.has(key) && !!value)

		if (!hasKey) {
			for (const key of SecretKeys) {
				if (NON_PROVIDER_SECRET_KEYS.has(key)) {
					continue
				}
				const value = await context.secrets.get(key)
				if (value) {
					hasKey = true
					break
				}
			}
		}

		// Keyless provider configurations stored in global state (either store).
		if (!hasKey) {
			hasKey = PROVIDER_CONFIG_GLOBAL_STATE_KEYS.some(
				(key) => context.globalState.get(key) !== undefined || fileGlobalState[key] !== undefined,
			)
		}

		// Providers configured through the SDK (e.g. via the CLI, or an
		// already-completed migration to providers.json).
		if (!hasKey) {
			hasKey = await hasConfiguredSdkProviders(dataDir)
		}

		// Set welcomeViewCompleted based on whether user has keys
		await context.globalState.update("welcomeViewCompleted", hasKey)

		Logger.log(`Migration: Set welcomeViewCompleted to ${hasKey} based on existing provider configuration`)
	} catch (error) {
		Logger.error("Failed to migrate welcomeViewCompleted:", error)
		// Continue execution - migration failure shouldn't break extension startup
	}
}

export async function cleanupMcpMarketplaceCatalogFromGlobalState(context: vscode.ExtensionContext) {
	try {
		// Check if mcpMarketplaceCatalog exists in global state
		const mcpMarketplaceCatalog = await context.globalState.get("mcpMarketplaceCatalog")

		if (mcpMarketplaceCatalog !== undefined) {
			Logger.log("Cleaning up mcpMarketplaceCatalog from global state...")

			// Delete it from global state
			await context.globalState.update("mcpMarketplaceCatalog", undefined)

			Logger.log("Successfully removed mcpMarketplaceCatalog from global state")
		}
	} catch (error) {
		Logger.error("Failed to cleanup mcpMarketplaceCatalog from global state:", error)
		// Continue execution - cleanup failure shouldn't break extension startup
	}
}

export async function cleanupOldApiKey(context: vscode.ExtensionContext) {
	try {
		// Old API Keys were introduced in March 2025 and later replaced with tokens
		// Now that we have new API keys that are prefixed with `sk_`,
		// we need to clean up the old ones to free the secret storage
		await context.secrets.delete("clineApiKey")
	} catch (error) {
		Logger.error("Failed to cleanup old clineApiKey", error)
	}
}
