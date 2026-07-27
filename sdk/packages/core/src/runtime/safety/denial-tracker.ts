/**
 * Per-session consecutive tool-denial tracker.
 *
 * Counts turns in which the user explicitly rejected a tool approval
 * (`deniedByUser` on the runtime's `tool-finished` event). Unlike the
 * `MistakeTracker`, this counter is NOT reset by successful tool calls —
 * a retry loop that interleaves auto-approved reads between rejected edits
 * must still trip the limit. It resets only at run boundaries (new user
 * input) and conversation boundaries.
 *
 * When the limit is reached the session resolves the host's
 * `onConsecutiveMistakeLimitReached` callback with reason
 * `"tool_approval_denied"` so hosts can render denial-specific UI, then
 * stops the run (unless the host decides to continue with guidance).
 */

import type {
	ConsecutiveMistakeLimitContext,
	ConsecutiveMistakeLimitDecision,
} from "@cline/shared";
import type { LeveledLog } from "./mistake-tracker";

export const DEFAULT_MAX_CONSECUTIVE_TOOL_DENIALS = 3;

export interface RecordDenialInput {
	iteration: number;
	details?: string;
}

export type DenialOutcome =
	| { action: "continue"; guidance?: string }
	| { action: "stop"; message: string; reason?: string };

export interface DenialTrackerOptions {
	readonly maxConsecutiveDenials: number;
	readonly onLimitReached?: (
		ctx: ConsecutiveMistakeLimitContext,
	) =>
		| Promise<ConsecutiveMistakeLimitDecision>
		| ConsecutiveMistakeLimitDecision;
	/**
	 * Observability hook fired exactly once per limit hit, right before the
	 * limit decision is resolved. Used for telemetry.
	 */
	readonly onLimitTelemetry?: (ctx: ConsecutiveMistakeLimitContext) => void;
	readonly log: LeveledLog;
	readonly agentId: string;
	readonly getConversationId: () => string;
	readonly getActiveRunId: () => string;
	readonly appendRecoveryNotice: (message: string) => void;
}

export class DenialTracker {
	private consecutiveDenials = 0;
	private readonly options: DenialTrackerOptions;

	constructor(options: DenialTrackerOptions) {
		this.options = options;
	}

	async record(input: RecordDenialInput): Promise<DenialOutcome> {
		const max = this.options.maxConsecutiveDenials;
		this.consecutiveDenials += 1;
		const next = this.consecutiveDenials;

		this.options.log("info", "Recorded consecutive tool denial", {
			agentId: this.options.agentId,
			conversationId: this.options.getConversationId(),
			runId: this.options.getActiveRunId(),
			iteration: input.iteration,
			details: input.details,
			consecutiveDenials: next,
			maxConsecutiveDenials: max,
		});

		if (!max || next < max) {
			return { action: "continue" };
		}

		const limitContext: ConsecutiveMistakeLimitContext = {
			iteration: input.iteration,
			consecutiveMistakes: next,
			maxConsecutiveMistakes: max,
			reason: "tool_approval_denied",
			details: input.details,
		};
		this.options.onLimitTelemetry?.(limitContext);
		const decision = await resolveDenialLimitDecision(
			limitContext,
			this.options.onLimitReached,
		);

		if (decision.action === "continue") {
			const guidance = decision.guidance?.trim();
			if (guidance) {
				this.options.appendRecoveryNotice(guidance);
			}
			this.consecutiveDenials = 0;
			return { action: "continue", guidance };
		}

		return {
			action: "stop",
			reason: decision.reason?.trim() || undefined,
			message: buildDenialLimitStopMessage(next),
		};
	}

	reset(): void {
		this.consecutiveDenials = 0;
	}

	get value(): number {
		return this.consecutiveDenials;
	}
}

/**
 * The stop notice appended to the conversation so the model, on resume,
 * knows the rejected operations never happened and must wait for guidance.
 */
export function buildDenialLimitStopMessage(denials: number): string {
	return (
		`Stopped after the user rejected ${denials} consecutive tool operations. ` +
		"The rejected operations were NOT performed and their target files are unchanged. " +
		"Do not retry the rejected operations or attempt them through other means. " +
		"Wait for further instructions from the user."
	);
}

async function resolveDenialLimitDecision(
	input: ConsecutiveMistakeLimitContext,
	callback?: (
		context: ConsecutiveMistakeLimitContext,
	) =>
		| Promise<ConsecutiveMistakeLimitDecision>
		| ConsecutiveMistakeLimitDecision,
): Promise<ConsecutiveMistakeLimitDecision> {
	if (!callback) {
		return {
			action: "stop",
			reason: `maximum consecutive tool denials reached (${input.maxConsecutiveMistakes})`,
		};
	}
	try {
		return await callback(input);
	} catch (error) {
		return {
			action: "stop",
			reason:
				error instanceof Error
					? error.message
					: `maximum consecutive tool denials reached (${input.maxConsecutiveMistakes})`,
		};
	}
}
