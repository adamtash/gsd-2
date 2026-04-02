/**
 * Anthropic OAuth flow (Claude Pro/Max)
 */

import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";
const INFERENCE_ONLY_SCOPE = "user:inference";

/** 1 year in seconds – used by setup-token to request a long-lived token */
const SETUP_TOKEN_EXPIRES_IN = 31_536_000;

export interface AnthropicLoginOptions {
	/** When true, request only user:inference scope (used by setup-token) */
	inferenceOnly?: boolean;
	/** Requested token lifetime in seconds (e.g. 31536000 for 1 year) */
	expiresIn?: number;
}

/**
 * Login with Anthropic OAuth (device code flow)
 *
 * @param onAuthUrl - Callback to handle the authorization URL (e.g., open browser)
 * @param onPromptCode - Callback to prompt user for the authorization code
 * @param options - Optional overrides for scope and token lifetime
 */
export async function loginAnthropic(
	onAuthUrl: (url: string) => void,
	onPromptCode: () => Promise<string>,
	options?: AnthropicLoginOptions,
): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	const scope = options?.inferenceOnly ? INFERENCE_ONLY_SCOPE : SCOPES;

	// Build authorization URL
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});

	const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;

	// Notify caller with URL to open
	onAuthUrl(authUrl);

	// Wait for user to paste authorization code (format: code#state)
	const authCode = await onPromptCode();
	const splits = authCode.split("#");
	const code = splits[0];
	const state = splits[1];

	// Exchange code for tokens
	const tokenBody: Record<string, string> = {
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		code: code ?? "",
		state: state ?? "",
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier,
	};
	if (options?.expiresIn != null) {
		tokenBody.expires_in = String(options.expiresIn);
	}

	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(tokenBody),
		signal: AbortSignal.timeout(30_000),
	});

	if (!tokenResponse.ok) {
		const error = await tokenResponse.text();
		throw new Error(`Token exchange failed: ${error}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	// Calculate expiry time (current time + expires_in seconds - 5 min buffer)
	const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

	// Save credentials
	return {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: expiresAt,
	};
}

/**
 * Setup a long-lived authentication token (like Claude Code's `setup-token`).
 *
 * Performs an Anthropic OAuth flow with inference-only scope and requests a
 * 1-year token. Returns the raw access token for the user to store.
 */
export async function setupAnthropicToken(
	onAuthUrl: (url: string) => void,
	onPromptCode: () => Promise<string>,
): Promise<{ credentials: OAuthCredentials; expiresInSeconds: number }> {
	const credentials = await loginAnthropic(onAuthUrl, onPromptCode, {
		inferenceOnly: true,
		expiresIn: SETUP_TOKEN_EXPIRES_IN,
	});
	return {
		credentials,
		expiresInSeconds: SETUP_TOKEN_EXPIRES_IN,
	};
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		}),
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Anthropic token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAnthropic(
			(url) => callbacks.onAuth({ url }),
			() => callbacks.onPrompt({ message: "Paste the authorization code:" }),
		);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshAnthropicToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
