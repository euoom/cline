import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { syncTelemetrySettingFromSharedGlobalSettings } from "./telemetry-settings-sync"

const state = vi.hoisted(() => ({
	telemetrySetting: undefined as TelemetrySetting | boolean | undefined,
	lastSyncedTelemetrySetting: undefined as TelemetrySetting | undefined,
	remoteTelemetrySetting: undefined as TelemetrySetting | undefined,
	setGlobalState: vi.fn(),
}))

vi.mock("@cline/core", () => ({
	readGlobalSettings: () => {
		const filePath = process.env.CLINE_GLOBAL_SETTINGS_PATH
		if (!filePath || !existsSync(filePath)) {
			return { autoUpdateEnabled: true, telemetryOptOut: false }
		}
		return { autoUpdateEnabled: true, telemetryOptOut: false, ...JSON.parse(readFileSync(filePath, "utf8")) }
	},
	setTelemetryOptOutGlobally: (telemetryOptOut: boolean) => {
		const filePath = process.env.CLINE_GLOBAL_SETTINGS_PATH
		if (!filePath) {
			throw new Error("CLINE_GLOBAL_SETTINGS_PATH is not set")
		}
		mkdirSync(dirname(filePath), { recursive: true })
		writeFileSync(filePath, `${JSON.stringify({ autoUpdateEnabled: true, telemetryOptOut }, null, 2)}\n`)
	},
}))

function makeStateManager() {
	return {
		getGlobalSettingsKey: vi.fn(() => state.telemetrySetting),
		getGlobalStateKey: vi.fn(() => state.lastSyncedTelemetrySetting),
		getRemoteConfigSettings: vi.fn(() => ({ telemetrySetting: state.remoteTelemetrySetting })),
		setGlobalState: state.setGlobalState,
	}
}

describe("syncTelemetrySettingFromSharedGlobalSettings", () => {
	let previousSettingsPath: string | undefined
	let tempDir: string
	let settingsPath: string

	beforeEach(() => {
		previousSettingsPath = process.env.CLINE_GLOBAL_SETTINGS_PATH
		tempDir = mkdtempSync(join(tmpdir(), "cline-vscode-telemetry-sync-"))
		settingsPath = join(tempDir, "global-settings.json")
		process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath
		state.telemetrySetting = undefined
		state.lastSyncedTelemetrySetting = undefined
		state.remoteTelemetrySetting = undefined
		state.setGlobalState.mockReset()
		state.setGlobalState.mockImplementation((key: string, value: TelemetrySetting) => {
			if (key === "telemetrySetting") {
				state.telemetrySetting = value
			} else if (key === "lastSyncedTelemetrySetting") {
				state.lastSyncedTelemetrySetting = value
			}
		})
	})

	afterEach(() => {
		if (previousSettingsPath === undefined) {
			delete process.env.CLINE_GLOBAL_SETTINGS_PATH
		} else {
			process.env.CLINE_GLOBAL_SETTINGS_PATH = previousSettingsPath
		}
		rmSync(tempDir, { force: true, recursive: true })
	})

	it("migrates legacy boolean false to shared telemetry opt-out", () => {
		state.telemetrySetting = false

		syncTelemetrySettingFromSharedGlobalSettings(makeStateManager())

		expect(state.setGlobalState).toHaveBeenCalledWith("telemetrySetting", "disabled")
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ telemetryOptOut: true })
	})

	it("migrates legacy string disabled to shared telemetry opt-out", () => {
		state.telemetrySetting = "disabled"

		syncTelemetrySettingFromSharedGlobalSettings(makeStateManager())

		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ telemetryOptOut: true })
	})

	// ENG-2334 regression: legacy 4.0.x users can already have the shared settings
	// file on disk (created by the CLI or hub daemon with telemetryOptOut defaulted
	// to false). The upgrade import must still preserve their opt-out.
	it("preserves legacy opt-out when the shared settings file already exists without an explicit choice", () => {
		writeFileSync(settingsPath, `${JSON.stringify({ autoUpdateEnabled: true, telemetryOptOut: false }, null, 2)}\n`)
		state.telemetrySetting = "disabled"

		syncTelemetrySettingFromSharedGlobalSettings(makeStateManager())

		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ telemetryOptOut: true })
		expect(state.telemetrySetting).toBe("disabled")
		expect(state.setGlobalState).toHaveBeenCalledWith("lastSyncedTelemetrySetting", "disabled")
	})

	it("imports an opt-out made on the legacy build after a rollback", () => {
		writeFileSync(settingsPath, `${JSON.stringify({ autoUpdateEnabled: true, telemetryOptOut: false }, null, 2)}\n`)
		state.telemetrySetting = "disabled"
		state.lastSyncedTelemetrySetting = "enabled"

		syncTelemetrySettingFromSharedGlobalSettings(makeStateManager())

		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ telemetryOptOut: true })
		expect(state.telemetrySetting).toBe("disabled")
	})

	it("does not re-import a stale mirrored opt-out after telemetry is re-enabled through the shared file", () => {
		// e.g. the user re-enabled telemetry via the CLI while VS Code was closed.
		writeFileSync(settingsPath, `${JSON.stringify({ autoUpdateEnabled: true, telemetryOptOut: false }, null, 2)}\n`)
		state.telemetrySetting = "disabled"
		state.lastSyncedTelemetrySetting = "disabled"

		syncTelemetrySettingFromSharedGlobalSettings(makeStateManager())

		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ telemetryOptOut: false })
		expect(state.telemetrySetting).toBe("enabled")
		expect(state.setGlobalState).toHaveBeenCalledWith("lastSyncedTelemetrySetting", "enabled")
	})

	it("never flips an existing shared opt-out back to enabled from a legacy enabled value", () => {
		writeFileSync(settingsPath, `${JSON.stringify({ autoUpdateEnabled: true, telemetryOptOut: true }, null, 2)}\n`)
		state.telemetrySetting = "enabled"

		syncTelemetrySettingFromSharedGlobalSettings(makeStateManager())

		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ telemetryOptOut: true })
		expect(state.telemetrySetting).toBe("disabled")
	})

	it("does not create the shared settings file for a legacy user without a telemetry choice", () => {
		state.telemetrySetting = "unset"

		syncTelemetrySettingFromSharedGlobalSettings(makeStateManager())

		expect(existsSync(settingsPath)).toBe(false)
		expect(state.telemetrySetting).toBe("enabled")
	})

	it("does nothing when remote config governs the telemetry setting", () => {
		state.telemetrySetting = "disabled"
		state.remoteTelemetrySetting = "enabled"

		syncTelemetrySettingFromSharedGlobalSettings(makeStateManager())

		expect(existsSync(settingsPath)).toBe(false)
		expect(state.setGlobalState).not.toHaveBeenCalled()
	})
})
