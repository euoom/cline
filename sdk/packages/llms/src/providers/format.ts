/**
 * Detects response bodies that are HTML documents (e.g. a gateway's 500/502
 * error page) so they can be summarized instead of dumped verbatim into chat.
 */
function looksLikeHtmlDocument(text: string): boolean {
	const head = text.trimStart().slice(0, 256).toLowerCase();
	return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/**
 * Collapse an HTML error page into a one-line description, preferring the
 * document title or first heading (e.g. "Internal Server Error").
 */
function summarizeHtmlErrorPage(html: string): string {
	const stripTags = (fragment: string): string =>
		fragment
			.replace(/<[^>]*>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
	const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
	const label = stripTags(title ?? heading ?? "");
	return label
		? `The provider returned an HTML error page: ${label}`
		: "The provider returned an HTML error page instead of an API response.";
}

export function extractErrorMessage(error: unknown): string {
	// Generic SDK wrappers carry no signal of their own — when present we prefer
	// the underlying cause/detail (e.g. AI SDK's AI_NoOutputGeneratedError).
	const GENERIC_WRAPPER_MESSAGES = new Set([
		"no output generated. check the stream for errors.",
	]);
	const isGenericWrapperMessage = (message: string): boolean =>
		GENERIC_WRAPPER_MESSAGES.has(message.trim().toLowerCase());

	// Pulls a human-readable message out of structured provider fields
	// (error/detail/errors/responseBody) without falling back to a top-level
	// `message`. Shared by the Error and plain-object branches.
	const extractStructuredDetail = (value: object): string | undefined => {
		const payload = value as {
			error?: { message?: string } | string;
			errors?: unknown;
			detail?: string;
			responseBody?: unknown;
		};
		if (typeof payload.error === "string" && payload.error.trim()) {
			return payload.error;
		}
		if (
			payload.error &&
			typeof payload.error === "object" &&
			typeof payload.error.message === "string" &&
			payload.error.message.trim()
		) {
			return payload.error.message;
		}
		if (typeof payload.detail === "string" && payload.detail.trim()) {
			return payload.detail;
		}
		if (Array.isArray(payload.errors)) {
			for (const nestedError of payload.errors) {
				const nested = extractStructuredMessage(nestedError);
				if (nested) {
					return nested;
				}
			}
		}
		if ("responseBody" in payload && payload.responseBody !== value) {
			const nested = extractStructuredMessage(payload.responseBody);
			if (nested) {
				return nested;
			}
		}
		return undefined;
	};

	const extractStructuredMessage = (value: unknown): string | undefined => {
		if (!value) {
			return undefined;
		}
		if (typeof value === "string") {
			try {
				return extractStructuredMessage(JSON.parse(value));
			} catch {
				const trimmed = value.trim();
				if (!trimmed) {
					return undefined;
				}
				// Never surface a whole HTML document (gateway/proxy error pages)
				// as the error message — summarize it instead.
				if (looksLikeHtmlDocument(trimmed)) {
					return summarizeHtmlErrorPage(trimmed);
				}
				return trimmed;
			}
		}
		if (typeof value !== "object") {
			return undefined;
		}
		if (value instanceof Error) {
			const message = value.message.trim();
			const detailMessage = extractStructuredDetail(value);
			const cause = (value as { cause?: unknown }).cause;
			const causeMessage = extractStructuredMessage(cause);

			// Generic wrappers (e.g. "No output generated...") only matter as a
			// fallback — surface the underlying detail/cause instead.
			if (message && isGenericWrapperMessage(message)) {
				return detailMessage ?? causeMessage ?? undefined;
			}

			// Structured provider detail attached directly to the error
			// (responseBody/detail/error fields) is more useful than the bland
			// top-level Error message.
			if (detailMessage && detailMessage !== message) {
				return detailMessage;
			}

			// Otherwise preserve the wrapper message alongside its cause, e.g.
			// "fetch failed: SocketError: other side closed (UND_ERR_SOCKET)".
			if (causeMessage && message && causeMessage !== message) {
				const causeCode =
					cause && typeof cause === "object" && "code" in cause
						? (cause as { code?: unknown }).code
						: undefined;
				const codeSuffix =
					typeof causeCode === "string" && causeCode.trim()
						? ` (${causeCode})`
						: "";
				// Some wrappers already embed the cause in their own message
				// (e.g. undici's "Cannot connect to API: getaddrinfo ENOTFOUND
				// host") — appending the cause again would just repeat it.
				if (message.includes(causeMessage)) {
					return codeSuffix && !message.includes(codeSuffix)
						? `${message}${codeSuffix}`
						: message;
				}
				const causeName =
					cause instanceof Error && cause.name && cause.name !== "Error"
						? `${cause.name}: `
						: "";
				return `${message}: ${causeName}${causeMessage}${codeSuffix}`;
			}
			return causeMessage ?? (message || undefined);
		}

		const detail = extractStructuredDetail(value);
		if (detail) {
			return detail;
		}
		const payload = value as { cause?: unknown; message?: string };
		if ("cause" in payload && payload.cause !== value) {
			const nested = extractStructuredMessage(payload.cause);
			if (nested) {
				return nested;
			}
		}
		if (typeof payload.message === "string" && payload.message.trim()) {
			return payload.message;
		}
		return undefined;
	};

	const structuredMessage = extractStructuredMessage(error);
	const result = structuredMessage ?? String(error);
	return looksLikeHtmlDocument(result) ? summarizeHtmlErrorPage(result) : result;
}
