import { readGlobalSettings, setTelemetryOptOutGlobally } from "@cline/core"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import { Logger } from "@/shared/services/Logger"

interface TelemetryStateManager {
	getGlobalSettingsKey(key: "telemetrySetting"): TelemetrySetting | boolean | undefined
	getGlobalStateKey(key: "lastSyncedTelemetrySetting"): TelemetrySetting | undefined
	getRemoteConfigSettings(): { telemetrySetting?: TelemetrySetting }
	setGlobalState(key: "telemetrySetting" | "lastSyncedTelemetrySetting", value: TelemetrySetting): void
}

export function telemetrySettingFromSharedGlobalSettings(): TelemetrySetting {
	return readGlobalSettings().telemetryOptOut ? "disabled" : "enabled"
}

function normalizeLegacyTelemetrySetting(value: TelemetrySetting | boolean | undefined): TelemetrySetting | undefined {
	if (value === false) {
		return "disabled"
	}
	if (value === true) {
		return "enabled"
	}
	if (value === "disabled" || value === "enabled" || value === "unset") {
		return value
	}
	return undefined
}

export function syncTelemetrySettingFromSharedGlobalSettings(stateManager: TelemetryStateManager): void {
	try {
		if (stateManager.getRemoteConfigSettings().telemetrySetting !== undefined) {
			// Remote config governs telemetry for this user; don't reconcile the
			// local stores against the remotely-enforced value.
			return
		}

		const legacyTelemetrySetting = normalizeLegacyTelemetrySetting(stateManager.getGlobalSettingsKey("telemetrySetting"))
		const lastSyncedTelemetrySetting = stateManager.getGlobalStateKey("lastSyncedTelemetrySetting")
		if (
			legacyTelemetrySetting === "disabled" &&
			legacyTelemetrySetting !== lastSyncedTelemetrySetting &&
			!readGlobalSettings().telemetryOptOut
		) {
			// The legacy VS Code globalState value changed outside this build's own
			// mirroring — either this is the first activation after upgrading from a
			// legacy (pre-SDK) build, or the user rolled back and opted out there.
			// The legacy store is the only place that choice lives, so import it
			// into the shared global settings file even when the file already
			// exists: other Cline surfaces (e.g. the CLI or hub daemon) create it
			// with telemetryOptOut defaulted to false without the user ever making
			// a telemetry choice (ENG-2334). Only opt-outs are imported — an
			// existing shared opt-out is never silently flipped back to enabled.
			// Do not emit opt-out telemetry for the import; this is not a new
			// explicit user action.
			setTelemetryOptOutGlobally(true)
		}

		const telemetrySetting = telemetrySettingFromSharedGlobalSettings()
		if (stateManager.getGlobalSettingsKey("telemetrySetting") !== telemetrySetting) {
			// Keep the legacy in-memory state mirrored so existing VS Code telemetry
			// providers that still read StateManager observe the shared setting.
			stateManager.setGlobalState("telemetrySetting", telemetrySetting)
		}
		if (lastSyncedTelemetrySetting !== telemetrySetting) {
			stateManager.setGlobalState("lastSyncedTelemetrySetting", telemetrySetting)
		}
	} catch (error) {
		Logger.warn(`[SdkController] Failed to sync shared telemetry setting: ${error}`)
	}
}
