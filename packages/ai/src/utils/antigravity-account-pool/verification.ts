/**
 * Detection of Google account verification requirements from 403 responses.
 * When Google requires identity verification (CAPTCHA), the account should be
 * temporarily disabled and rotated away from.
 */

export interface VerificationResult {
	isVerification: boolean;
	reason?: string;
	verifyUrl?: string;
}

/**
 * Parse a 403 response body to detect verification requirements.
 */
export function extractVerificationError(responseBody: string): VerificationResult {
	try {
		const parsed = JSON.parse(responseBody) as {
			error?: {
				message?: string;
				details?: Array<{ reason?: string; verifyUrl?: string; metadata?: Record<string, string> }>;
			};
		};

		const error = parsed?.error;
		if (!error) return { isVerification: false };

		// Check details array for explicit validation_required reason
		if (Array.isArray(error.details)) {
			for (const detail of error.details) {
				if (detail.reason === "validation_required" || detail.reason === "VALIDATION_REQUIRED") {
					return {
						isVerification: true,
						reason: error.message ?? "Account requires verification",
						verifyUrl: detail.verifyUrl ?? detail.metadata?.verifyUrl,
					};
				}
			}
		}

		// Check message patterns
		const message = error.message?.toLowerCase() ?? "";
		if (
			message.includes("verify your account") ||
			message.includes("verification required") ||
			message.includes("validation required") ||
			message.includes("captcha")
		) {
			return {
				isVerification: true,
				reason: error.message,
			};
		}

		return { isVerification: false };
	} catch {
		return { isVerification: false };
	}
}
