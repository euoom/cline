import type { ClineMessage } from "@shared/ExtensionMessage"

export function isVisibleCheckpointUserMessage(message: ClineMessage): boolean {
	return message.type === "say" && (message.say === "task" || message.say === "user_feedback")
}

/**
 * Ask rows whose user response is delivered INSIDE the running turn (folded
 * into the pending tool's result) instead of as a standalone user message in
 * SDK history: ask_question answers, tool/command/MCP/subagent approval
 * feedback, plus the legacy ask types with the same in-run semantics.
 *
 * `completion_result` and `resume_task`/`resume_completed_task` are absent on
 * purpose: responses to those start a NEW agent turn and are persisted as
 * standalone user messages, so their user_feedback bubbles are genuine runs.
 *
 * Keep in sync with the webview's copy in
 * webview-ui/src/components/chat/chat-view/utils/messageUtils.ts.
 */
const IN_RUN_ANSWER_ASKS = new Set<string>([
	"followup",
	"plan_mode_respond",
	"act_mode_respond",
	"mistake_limit_reached",
	"tool",
	"command",
	"command_output",
	"use_mcp_server",
	"use_subagents",
	"browser_action_launch",
])

/**
 * Rows that prove the run progressed past the pending ask before the bubble
 * was emitted: another model request started, the turn errored, or the task
 * completed. An answer bubble is emitted the moment its ask resolves, BEFORE
 * any of these can appear, so a bubble beyond one of them is a genuine
 * follow-up (e.g. a queued prompt delivered after the ask was resolved) —
 * assistant text/reasoning rows streamed alongside the ask are walked past.
 */
function isRunProgressBarrier(message: ClineMessage): boolean {
	return message.say === "api_req_started" || message.say === "error" || message.say === "completion_result"
}

/**
 * True when the user_feedback bubble at `index` answered an in-run ask (see
 * IN_RUN_ANSWER_ASKS). Such bubbles have no standalone user message in SDK
 * history — their text was folded into the pending tool's result — so run
 * counting and transcript-to-history ordinal mapping must skip them.
 */
export function isCheckpointAnswerMessage(messages: ClineMessage[], index: number): boolean {
	const message = messages[index]
	if (message?.type !== "say" || message.say !== "user_feedback") {
		return false
	}

	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const previous = messages[cursor]
		if (previous.type === "ask") {
			return IN_RUN_ANSWER_ASKS.has(previous.ask ?? "")
		}
		if (isVisibleCheckpointUserMessage(previous) || isRunProgressBarrier(previous)) {
			return false
		}
	}

	return false
}

export function isCheckpointRunUserMessage(messages: ClineMessage[], index: number): boolean {
	return isVisibleCheckpointUserMessage(messages[index]) && !isCheckpointAnswerMessage(messages, index)
}

export function getCheckpointRunCountForMessage(messages: ClineMessage[], targetIndex: number): number | undefined {
	if (!isCheckpointRunUserMessage(messages, targetIndex)) {
		return undefined
	}

	let runCount = 0
	for (let index = 0; index <= targetIndex; index += 1) {
		if (isCheckpointRunUserMessage(messages, index)) {
			runCount += 1
		}
	}
	return runCount
}

export function findVisibleCheckpointUserMessageByRun(
	messages: ClineMessage[],
	runCount: number,
): { message: ClineMessage; index: number } | undefined {
	let seenUsers = 0
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]
		if (!isCheckpointRunUserMessage(messages, index)) {
			continue
		}
		seenUsers += 1
		if (seenUsers === runCount) {
			return { message, index }
		}
	}
	return undefined
}
