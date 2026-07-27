import { describe, expect, it } from "vitest";
import {
	countGenuineUserPromptMessages,
	isGenuineUserPromptMessage,
} from "./checkpoint-message-filter";

describe("isGenuineUserPromptMessage", () => {
	it("rejects non-user roles", () => {
		expect(
			isGenuineUserPromptMessage({ role: "assistant", content: "hi" }),
		).toBe(false);
	});

	it("accepts plain text user messages", () => {
		expect(isGenuineUserPromptMessage({ role: "user", content: "hi" })).toBe(
			true,
		);
	});

	it("rejects empty string content", () => {
		expect(isGenuineUserPromptMessage({ role: "user", content: "   " })).toBe(
			false,
		);
	});

	it("rejects messages consisting solely of tool_result blocks", () => {
		expect(
			isGenuineUserPromptMessage({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						name: "read_file",
						content: "contents",
					},
				],
			}),
		).toBe(false);
	});

	it("accepts messages mixing text and tool_result blocks", () => {
		expect(
			isGenuineUserPromptMessage({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						name: "read_file",
						content: "contents",
					},
					{ type: "text", text: "here's the file, also please fix X" },
				],
			}),
		).toBe(true);
	});

	it("rejects known synthetic system-injected kinds", () => {
		for (const kind of [
			"recovery_notice",
			"compaction",
			"compaction_summary",
			"loop_detection_notice",
			"mistake_stop_notice",
			"completion_reminder",
		]) {
			expect(
				isGenuineUserPromptMessage({
					role: "user",
					content: "synthetic",
					metadata: { kind },
				}),
			).toBe(false);
		}
	});

	it("rejects host continuation prompts (task resumption, act auto-continue)", () => {
		expect(
			isGenuineUserPromptMessage({
				role: "user",
				content: "[TASK RESUMPTION] Please continue where you left off.",
			}),
		).toBe(false);
		// Persisted prompts carry the formatModePrompt wrapper.
		expect(
			isGenuineUserPromptMessage({
				role: "user",
				content:
					'<user_input mode="act">[TASK RESUMPTION] Please continue where you left off.</user_input>',
			}),
		).toBe(false);
		expect(
			isGenuineUserPromptMessage({
				role: "user",
				content:
					"The user approved switching to act mode. Continue with the approved plan now.",
			}),
		).toBe(false);
	});

	it("accepts continuation prompts that carry user attachments", () => {
		// An attachment-only plan -> act toggle has a visible bubble for the
		// attachment, so the message still counts as a genuine turn.
		expect(
			isGenuineUserPromptMessage({
				role: "user",
				content: [
					{
						type: "text",
						text: "The user approved switching to act mode. Continue with the approved plan now.",
					},
					{ type: "image", mediaType: "image/png", data: "abc" },
				],
			}),
		).toBe(true);
	});
});

describe("countGenuineUserPromptMessages", () => {
	it("counts only genuine user turns across a mixed conversation", () => {
		const messages = [
			{ role: "user" as const, content: "first" },
			{ role: "assistant" as const, content: "reply" },
			{
				role: "user" as const,
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: "call_1",
						name: "read_file",
						content: "contents",
					},
				],
			},
			{
				role: "user" as const,
				content: "reminder",
				metadata: { kind: "completion_reminder" },
			},
			{ role: "user" as const, content: "second" },
		];

		expect(countGenuineUserPromptMessages(messages)).toBe(2);
	});
});
