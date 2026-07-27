import type { ClineMessage } from "@shared/ExtensionMessage"
import { memo, useMemo, useState } from "react"
import { ClineAuthStatus } from "@/components/account/ClineAuthStatus"
import ClinePassLimitError from "@/components/chat/ClinePassLimitError"
import CreditLimitError from "@/components/chat/CreditLimitError"
import EntitlementError from "@/components/chat/EntitlementError"
import OrgClinePassRestrictionError from "@/components/chat/OrgClinePassRestrictionError"
import SpendLimitError from "@/components/chat/SpendLimitError"
import { Button } from "@/components/ui/button"
import { useClineAuth, useClineSignIn } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ClineError, ClineErrorType } from "../../../../src/services/error/ClineError"

const _errorColor = "var(--vscode-errorForeground)"

interface ErrorRowProps {
	message: ClineMessage
	errorType: "error" | "mistake_limit_reached" | "diff_error" | "clineignore_error"
	apiRequestFailedMessage?: string
	apiReqStreamingFailedMessage?: string
}

const CONNECTION_ERROR_PATTERNS = [
	/\bENOTFOUND\b/,
	/\bECONNREFUSED\b/,
	/\bECONNRESET\b/,
	/\bETIMEDOUT\b/,
	/\bEAI_AGAIN\b/,
	/\bUND_ERR/,
	/fetch failed/i,
	/cannot connect to (?:the )?api/i,
	/socket ?error/i,
	/other side closed/i,
	/network error/i,
]

const CONTEXT_WINDOW_PATTERNS = [
	/context (?:length|window)/i,
	/maximum context/i,
	/prompt is too long/i,
	/too many tokens/i,
	/input is too long/i,
]

const MODEL_NOT_FOUND_PATTERNS = [/\bmodel\b[^.,;:]*\b(?:not[ _]?found|does not exist|no such model|unknown model)\b/i]

interface ErrorPresentation {
	/** Short human classification shown as the card title, e.g. "Authentication error" */
	title: string
	/** Actionable next step shown under the message, when we have one */
	guidance?: string
	/** Offer a button that opens the API configuration settings */
	showSettingsButton?: boolean
}

/**
 * Classify a provider error into a short title and an actionable hint so error
 * rows say what went wrong and what to do — instead of dumping raw payloads.
 */
function describeErrorPresentation({
	clineError,
	message,
	providerId,
}: {
	clineError?: ClineError
	message: string
	providerId?: string
}): ErrorPresentation {
	const code = clineError?._error?.code
	const status = clineError?._error?.status
	const providerLabel = providerId ? `your ${providerId} API key` : "your API key"

	if (clineError?.isErrorType(ClineErrorType.Auth)) {
		return {
			title: "Authentication error",
			guidance: `Check that ${providerLabel} is valid in the API configuration settings.`,
			showSettingsButton: true,
		}
	}

	if (clineError?.isErrorType(ClineErrorType.Balance)) {
		return {
			title: "Insufficient credits",
			guidance: providerId
				? `Your ${providerId} account is out of credits. Add credits with your provider, then retry.`
				: "Your account is out of credits. Add credits with your provider, then retry.",
		}
	}

	if (clineError?.isErrorType(ClineErrorType.RateLimit)) {
		return {
			title: "Rate limited",
			guidance: "The provider is throttling requests. Wait a moment and retry, or check your plan's rate limits.",
		}
	}

	if (code === "model_not_found" || MODEL_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(message))) {
		return {
			title: "Model not found",
			showSettingsButton: true,
		}
	}

	if (code === "connection_error" || CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
		return {
			title: "Connection error",
			guidance: providerId
				? `Cline couldn't reach the ${providerId} API, or the connection was interrupted. Check your internet connection and the provider's base URL, then retry.`
				: "Cline couldn't reach the provider's API, or the connection was interrupted. Check your internet connection and the provider settings, then retry.",
		}
	}

	if (code === "provider_server_error" || (typeof status === "number" && status >= 500) || /HTML error page/i.test(message)) {
		return {
			title: "Provider server error",
			guidance: "The provider had an internal problem serving this request. This is usually temporary — retry in a moment.",
		}
	}

	if (CONTEXT_WINDOW_PATTERNS.some((pattern) => pattern.test(message))) {
		return {
			title: "Context window exceeded",
			guidance: "Start a new task, or switch to a model with a larger context window in the API configuration settings.",
		}
	}

	return { title: "API request failed" }
}

/** Extra diagnostic fields rendered inside the collapsible details section. */
function buildDiagnosticDetails(clineError: ClineError | undefined, rawApiError: string, errorMessage: string): string {
	const lines: string[] = []
	const status = clineError?._error?.status
	const code = clineError?._error?.code
	const modelId = clineError?.modelId || clineError?._error?.modelId
	const rawDetail = clineError?._error?.details?.raw

	if (typeof status === "number") {
		lines.push(`Status: ${status}`)
	}
	if (code) {
		lines.push(`Code: ${code}`)
	}
	if (modelId) {
		lines.push(`Model: ${modelId}`)
	}
	if (typeof rawDetail === "string" && rawDetail.trim() && rawDetail !== errorMessage) {
		lines.push("", rawDetail)
	} else if (rawApiError && rawApiError !== errorMessage) {
		lines.push("", rawApiError)
	}
	return lines.join("\n").trim()
}

const ErrorRow = memo(({ message, errorType, apiRequestFailedMessage, apiReqStreamingFailedMessage }: ErrorRowProps) => {
	const { clineUser } = useClineAuth()
	const { navigateToSettings } = useExtensionState()
	const rawApiError = apiRequestFailedMessage || apiReqStreamingFailedMessage

	const { isLoginLoading, authStatusMessage, handleSignIn } = useClineSignIn()
	const [showDetails, setShowDetails] = useState(false)

	const parsedError = useMemo(() => {
		if (!rawApiError) {
			return undefined
		}
		const clineError = ClineError.parse(rawApiError)
		const errorMessage = clineError?._error?.message || clineError?.message || rawApiError
		return { clineError, errorMessage }
	}, [rawApiError])

	const renderErrorContent = () => {
		switch (errorType) {
			case "error":
			case "mistake_limit_reached":
				// Handle API request errors with special error parsing
				if (rawApiError && parsedError) {
					const { clineError, errorMessage } = parsedError
					const requestId = clineError?._error?.request_id
					const providerId = clineError?.providerId || clineError?._error?.providerId
					// Deliberately narrower than the shared isClineManagedProvider (which
					// also matches cline-pass): only usage-billing errors get the credit
					// and login prompts below.
					const isClineUsageBillingProvider = providerId === "cline"

					if (clineError?.isErrorType(ClineErrorType.Balance)) {
						const errorDetails = clineError._error?.details
						if (isClineUsageBillingProvider || errorDetails?.buy_credits_url) {
							return (
								<CreditLimitError
									buyCreditsUrl={errorDetails?.buy_credits_url}
									currentBalance={errorDetails?.current_balance}
									message={errorDetails?.message}
									totalPromotions={errorDetails?.total_promotions}
									totalSpent={errorDetails?.total_spent}
								/>
							)
						}
					}

					if (clineError?.isErrorType(ClineErrorType.SpendLimit)) {
						const d = clineError._error?.details
						return (
							<SpendLimitError
								budgetPeriod={d?.budget_period}
								limitUsd={d?.limit_usd}
								message={d?.message || errorMessage}
								resetsAt={d?.resets_at}
								spentUsd={d?.spent_usd}
							/>
						)
					}

					if (clineError?.isErrorType(ClineErrorType.Entitlement)) {
						const detailMessage = clineError?._error?.details?.message || errorMessage
						return <EntitlementError message={detailMessage} />
					}

					if (clineError?.isErrorType(ClineErrorType.OrgClinePassRestriction)) {
						return <OrgClinePassRestrictionError />
					}

					if (clineError?.isErrorType(ClineErrorType.ClinePassLimit)) {
						const detailMessage = clineError?._error?.details?.message || errorMessage
						return <ClinePassLimitError message={detailMessage} />
					}

					if (clineError?.isErrorType(ClineErrorType.QuotaExceeded)) {
						const detailMessage = clineError?._error?.details?.message || errorMessage
						return <p className="m-0 whitespace-pre-wrap text-error wrap-anywhere">{detailMessage}</p>
					}

					if (clineError?.isErrorType(ClineErrorType.Auth) && isClineUsageBillingProvider) {
						return !clineUser ? (
							// User is using Cline provider and is not logged in
							<div className="flex flex-col gap-3">
								<div className="flex items-center justify-center rounded border border-neutral-500/30 bg-vscode-editor-background p-6 text-center text-vscode-foreground">
									Whoops looks like you're logged out – click below to sign in
								</div>
								<Button className="w-full" disabled={isLoginLoading} onClick={handleSignIn}>
									Sign in to Cline
									{isLoginLoading && (
										<span className="ml-1 animate-spin">
											<span className="codicon codicon-refresh" />
										</span>
									)}
								</Button>
								<ClineAuthStatus message={authStatusMessage} />
							</div>
						) : (
							// Don't show sign in button after the user has logged in, just ask them to retry
							<div className="mt-4">
								<span className="text-description">(Click "Retry" below)</span>
							</div>
						)
					}

					// Generic structured error card: classification title, readable
					// message, actionable guidance, and the raw payload behind a
					// "Show details" toggle — never dumped inline.
					const presentation = describeErrorPresentation({
						clineError,
						message: errorMessage,
						providerId,
					})
					const diagnosticDetails = clineError ? buildDiagnosticDetails(clineError, rawApiError, errorMessage) : ""

					return (
						<div className="flex flex-col gap-2">
							<p className="m-0 whitespace-pre-wrap text-error wrap-anywhere flex flex-col gap-1">
								<span className="flex items-baseline gap-1">
									<span className="font-bold" data-testid="error-title">
										{presentation.title}
									</span>
									{providerId && <span className="opacity-80">({providerId})</span>}
								</span>
								<span>{errorMessage}</span>
								{requestId && <span className="opacity-80">Request ID: {requestId}</span>}
							</p>

							{presentation.guidance && <p className="m-0 text-description text-xs">{presentation.guidance}</p>}

							{/* Windows Powershell Issue */}
							{errorMessage?.toLowerCase()?.includes("powershell") && (
								<div className="text-error">
									It seems like you're having Windows PowerShell issues, please see this{" "}
									<a
										className="underline text-inherit"
										href="https://github.com/cline/cline/wiki/TroubleShooting-%E2%80%90-%22PowerShell-is-not-recognized-as-an-internal-or-external-command%22">
										troubleshooting guide
									</a>
									.
								</div>
							)}

							{presentation.showSettingsButton && (
								<Button
									className="w-fit"
									onClick={() => navigateToSettings?.("api-config")}
									size="sm"
									variant="secondary">
									Open API settings
								</Button>
							)}

							{diagnosticDetails && (
								<div className="flex flex-col gap-1">
									<button
										aria-expanded={showDetails}
										className="flex items-center gap-1 self-start border-none bg-transparent p-0 text-description text-xs cursor-pointer hover:text-foreground"
										onClick={() => setShowDetails((value) => !value)}
										type="button">
										<span className={`codicon codicon-chevron-${showDetails ? "down" : "right"} text-xs`} />
										{showDetails ? "Hide details" : "Show details"}
									</button>
									{showDetails && (
										<pre className="m-0 max-h-60 overflow-y-auto whitespace-pre-wrap rounded bg-vscode-editor-background p-2 font-mono text-description text-xs wrap-anywhere">
											{diagnosticDetails}
										</pre>
									)}
								</div>
							)}
						</div>
					)
				}

				// Regular error message
				return <p className="m-0 mt-0 whitespace-pre-wrap text-error wrap-anywhere">{message.text}</p>

			case "diff_error":
				return (
					<div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
						<div>The model used search patterns that don't match anything in the file. Retrying...</div>
					</div>
				)

			case "clineignore_error":
				return (
					<div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
						<div>
							Cline tried to access <code>{message.text}</code> which is blocked by the <code>.clineignore</code>
							file.
						</div>
					</div>
				)

			default:
				return null
		}
	}

	// For diff_error and clineignore_error, we don't show the header separately
	if (errorType === "diff_error" || errorType === "clineignore_error") {
		return renderErrorContent()
	}

	// For other error types, show header + content
	return renderErrorContent()
})

export default ErrorRow
