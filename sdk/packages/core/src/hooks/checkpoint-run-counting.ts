// This file is the live-runtime counterpart of
// ../session/checkpoint-message-filter.ts: it defines "a genuine user turn"
// for the `AgentMessage` shape used by the agent runtime's snapshot
// (`sdk/packages/agents/src/agent-runtime.ts`), as opposed to the persisted
// `LlmsProviders.Message` shape used for stored conversation history. The two
// shapes model tool results differently (a distinct `role: "tool"` here, vs.
// `tool_result` content blocks folded into `role: "user"` there), so they
// need separate filters - do not try to unify them.
import type { AgentMessage } from "@cline/shared";
import { isSyntheticContinuationPromptText } from "@cline/shared";
import { isSyntheticUserMessageKind } from "../session/checkpoint-message-filter";

function extractUserText(message: AgentMessage): string {
	return message.content
		.map((part) => {
			if (part.type === "text") {
				return part.text.trim();
			}
			if (part.type === "file") {
				return part.content.trim();
			}
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function hasAttachmentParts(message: AgentMessage): boolean {
	return message.content.some(
		(part) => part.type === "image" || part.type === "file",
	);
}

/**
 * A live AgentMessage counts as a genuine user-initiated turn only if:
 *  - its role is "user" (tool results have their own "tool" role here, so
 *    unlike the persisted message shape, no content-block filtering is
 *    needed to exclude them),
 *  - it isn't tagged as one of the synthetic system-injected kinds (see
 *    checkpoint-message-filter.ts for the canonical list), and
 *  - it isn't a host-generated continuation prompt (task resumption /
 *    plan -> act auto-continue) without user attachments - those run an
 *    agent turn but have no visible user-authored counterpart.
 */
export function isGenuineUserPromptMessage(message: AgentMessage): boolean {
	if (message.role !== "user") {
		return false;
	}
	if (isSyntheticUserMessageKind(message.metadata?.kind)) {
		return false;
	}
	const text = extractUserText(message);
	const hasAttachments = hasAttachmentParts(message);
	if (!text && !hasAttachments) {
		return false;
	}
	if (!hasAttachments && isSyntheticContinuationPromptText(text)) {
		return false;
	}
	return true;
}

export function countGenuineUserPromptMessages(
	messages: readonly AgentMessage[],
): number {
	let count = 0;
	for (const message of messages) {
		if (isGenuineUserPromptMessage(message)) {
			count += 1;
		}
	}
	return count;
}
