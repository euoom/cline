import type { AgentMessage } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	countGenuineUserPromptMessages,
	isGenuineUserPromptMessage,
} from "./checkpoint-run-counting";

function message(
	role: AgentMessage["role"],
	metadata?: Record<string, unknown>,
): AgentMessage {
	return {
		id: "m",
		role,
		content: [{ type: "text", text: "x" }],
		createdAt: 0,
		...(metadata ? { metadata } : {}),
	};
}

describe("isGenuineUserPromptMessage (AgentMessage)", () => {
	it("accepts a plain user message", () => {
		expect(isGenuineUserPromptMessage(message("user"))).toBe(true);
	});

	it("rejects assistant and tool roles", () => {
		expect(isGenuineUserPromptMessage(message("assistant"))).toBe(false);
		expect(isGenuineUserPromptMessage(message("tool"))).toBe(false);
	});

	it("rejects a completion-tool reminder message", () => {
		expect(
			isGenuineUserPromptMessage(
				message("user", { kind: "completion_reminder" }),
			),
		).toBe(false);
	});

	it("accepts a genuinely queued/steered user message", () => {
		// consumePendingUserMessage() pushes an untagged role:"user" message -
		// it must keep counting as a real turn.
		expect(isGenuineUserPromptMessage(message("user"))).toBe(true);
	});

	it("rejects host continuation prompts (task resumption, act auto-continue)", () => {
		const withText = (text: string): AgentMessage => ({
			id: "m",
			role: "user",
			content: [{ type: "text", text }],
			createdAt: 0,
		});
		expect(
			isGenuineUserPromptMessage(
				withText("[TASK RESUMPTION] Please continue where you left off."),
			),
		).toBe(false);
		expect(
			isGenuineUserPromptMessage(
				withText(
					'<user_input mode="act">The user approved switching to act mode. Continue with the approved plan now.</user_input>',
				),
			),
		).toBe(false);
	});

	it("accepts a continuation prompt that carries user attachments", () => {
		expect(
			isGenuineUserPromptMessage({
				id: "m",
				role: "user",
				content: [
					{
						type: "text",
						text: "The user approved switching to act mode. Continue with the approved plan now.",
					},
					{ type: "image", image: "abc", mediaType: "image/png" },
				],
				createdAt: 0,
			}),
		).toBe(true);
	});

	it("rejects an empty user message", () => {
		expect(
			isGenuineUserPromptMessage({
				id: "m",
				role: "user",
				content: [{ type: "text", text: "   " }],
				createdAt: 0,
			}),
		).toBe(false);
	});
});

describe("countGenuineUserPromptMessages (AgentMessage)", () => {
	it("ignores tool-role messages and tagged synthetic reminders", () => {
		const messages: AgentMessage[] = [
			message("user"),
			message("assistant"),
			message("tool"),
			message("assistant"),
			message("user", { kind: "completion_reminder" }),
			message("user", { kind: "completion_reminder" }),
			message("user"),
		];

		expect(countGenuineUserPromptMessages(messages)).toBe(2);
	});
});
