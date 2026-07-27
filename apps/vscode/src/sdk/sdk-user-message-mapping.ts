import { isGenuineUserPromptMessage } from "@cline/core"
import type * as LlmsProviders from "@cline/llms"
import { isSyntheticContinuationPromptText } from "@cline/shared"

export type SdkUserMessage = {
	role?: unknown
	content?: unknown
	metadata?: unknown
}

export function extractSdkUserText(message: SdkUserMessage): string {
	const { content } = message
	if (typeof content === "string") {
		return content.trim()
	}
	if (!Array.isArray(content)) {
		return ""
	}
	return content
		.map((block) => {
			if (!block || typeof block !== "object") {
				return ""
			}
			const typed = block as { type?: unknown; text?: unknown; content?: unknown }
			if (typed.type === "text" && typeof typed.text === "string") {
				return typed.text.trim()
			}
			if (typed.type === "file" && typeof typed.content === "string") {
				return typed.content.trim()
			}
			return ""
		})
		.filter(Boolean)
		.join("\n")
		.trim()
}

/**
 * Prompts sent to the SDK without a visible user_feedback echo (task
 * resumption, plan -> act auto-continue). They exist in SDK history but not
 * in the visible transcript, so ordinal mapping between the two must skip
 * them or every later user message maps one slot too early. The canonical
 * definition lives in @cline/shared and is shared with the SDK's checkpoint
 * run counting.
 */
export function isSyntheticUserPrompt(text: string): boolean {
	return isSyntheticContinuationPromptText(text)
}

/**
 * True when the SDK message counts as a genuine user turn: it has a visible
 * user bubble in the transcript and a checkpoint run of its own. Delegates to
 * @cline/core's shared filter so transcript mapping, checkpoint creation, and
 * checkpoint restore can never drift from each other. False for tool results
 * (folded into `role: "user"` messages in this wire format), synthetic
 * kind-tagged notices (recovery/loop/compaction/completion reminders), and
 * host continuation prompts without user attachments.
 */
export function isGenuineSdkUserMessage(message: SdkUserMessage): boolean {
	return isGenuineUserPromptMessage(message as LlmsProviders.MessageWithMetadata)
}

/**
 * True when the SDK message has no visible user_feedback counterpart. An
 * attachment-only continuation carries the synthetic text alongside the
 * user's image/file blocks AND a visible bubble, so it must still be counted.
 */
export function isSyntheticSdkUserMessage(message: SdkUserMessage): boolean {
	return message.role === "user" && !isGenuineSdkUserMessage(message)
}

/**
 * Maps the Nth genuine user message (1-based ordinal over checkpoint-run
 * task/user_feedback rows) to its index in the persisted SDK message history,
 * skipping synthetic prompts and tool results that have no visible
 * counterpart.
 */
export function findSdkUserMessageIndexByOrdinal(sdkMessages: SdkUserMessage[], userOrdinal: number): number {
	let seenUsers = 0
	return sdkMessages.findIndex((message) => {
		if (!isGenuineSdkUserMessage(message)) {
			return false
		}
		seenUsers += 1
		return seenUsers === userOrdinal
	})
}

/**
 * Counts the genuine user messages in the persisted SDK history — the number
 * of checkpoint runs the persisted conversation contains.
 */
export function countGenuineSdkUserMessages(sdkMessages: SdkUserMessage[]): number {
	let count = 0
	for (const message of sdkMessages) {
		if (isGenuineSdkUserMessage(message)) {
			count += 1
		}
	}
	return count
}
