// This file provides a single, shared definition of "a genuine user turn"
// for the persisted conversation format (`LlmsProviders.Message`), reused by
// checkpoint creation (via checkpoint-run-counting.ts), checkpoint restore,
// and the VS Code extension's transcript-to-history ordinal mapping so none
// of them can drift from each other.
import type * as LlmsProviders from "@cline/llms";
import { isSyntheticContinuationPromptText } from "@cline/shared";

/**
 * Metadata `kind` tags that mark a `role: "user"` message as a synthetic,
 * system-injected notice rather than something the user actually typed.
 * Keep this in sync with every `metadata: { kind: "..." }` tag applied to a
 * `role: "user"` message across the codebase.
 */
const SYNTHETIC_USER_MESSAGE_KINDS = new Set([
	"recovery_notice",
	"compaction",
	"compaction_summary",
	"loop_detection_notice",
	"mistake_stop_notice",
	// Tagged at the live-runtime layer (agent-runtime.ts's
	// addUserReminderMessage) - included here too since metadata survives the
	// AgentMessage <-> LlmsProviders.Message conversion (agent-message-codec.ts),
	// so a reminder can end up persisted into the stored conversation.
	"completion_reminder",
]);

export function isSyntheticUserMessageKind(kind: unknown): boolean {
	return typeof kind === "string" && SYNTHETIC_USER_MESSAGE_KINDS.has(kind);
}

type GenericMessage = LlmsProviders.Message | LlmsProviders.MessageWithMetadata;

function readMessageMetadata(
	message: GenericMessage,
): Record<string, unknown> | undefined {
	return "metadata" in message &&
		message.metadata &&
		typeof message.metadata === "object" &&
		!Array.isArray(message.metadata)
		? (message.metadata as Record<string, unknown>)
		: undefined;
}

function extractUserText(content: GenericMessage["content"]): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block) => {
			// Persisted JSON can carry malformed entries; guard before reading.
			if (!block || typeof block !== "object") {
				return "";
			}
			if (block.type === "text" && typeof block.text === "string") {
				return block.text.trim();
			}
			if (block.type === "file" && typeof block.content === "string") {
				return block.content.trim();
			}
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function hasAttachmentBlocks(content: GenericMessage["content"]): boolean {
	if (!Array.isArray(content)) {
		return false;
	}
	let hasAttachment = false;
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}
		// Tool results are role "user" in this wire format but are not user
		// input; any media they carry must not make the message count as one.
		if (block.type === "tool_result") {
			return false;
		}
		if (block.type === "image" || block.type === "file") {
			hasAttachment = true;
		}
	}
	return hasAttachment;
}

/**
 * A stored/persisted message counts as a genuine user-initiated turn only if:
 *  - its role is "user",
 *  - it isn't tagged as one of the synthetic system-injected kinds above,
 *  - it isn't a host-generated continuation prompt (task resumption /
 *    plan -> act auto-continue) without user attachments - those exist in
 *    history but have no visible user-authored counterpart, and
 *  - its content carries visible user input: non-empty text or an image/file
 *    attachment. Tool results are modeled as `role: "user"` messages in this
 *    wire format (see ToolResultContent in @cline/shared), so a message
 *    consisting solely of tool_result blocks is an internal continuation,
 *    not a user turn.
 */
export function isGenuineUserPromptMessage(message: GenericMessage): boolean {
	if (message.role !== "user") {
		return false;
	}
	if (isSyntheticUserMessageKind(readMessageMetadata(message)?.kind)) {
		return false;
	}
	const text = extractUserText(message.content);
	const hasAttachments = hasAttachmentBlocks(message.content);
	if (!text && !hasAttachments) {
		return false;
	}
	// An attachment-carrying continuation holds the synthetic text alongside
	// the user's image/file blocks AND a visible transcript bubble, so it
	// still counts as a genuine turn.
	if (!hasAttachments && isSyntheticContinuationPromptText(text)) {
		return false;
	}
	return true;
}

export function countGenuineUserPromptMessages(
	messages: readonly GenericMessage[],
): number {
	let count = 0;
	for (const message of messages) {
		if (isGenuineUserPromptMessage(message)) {
			count += 1;
		}
	}
	return count;
}
