/**
 * Anthropic OAuth flow (Claude Pro/Max)
 */

import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

type AnthropicProfileResponse = {
	account?: {
		uuid?: string;
		email?: string;
		display_name?: string;
	};
	organization?: {
		uuid?: string;
		name?: string;
	};
	subscriptionType?: string | null;
	rateLimitTier?: string | null;
};

async function fetchAnthropicProfile(accessToken: string): Promise<AnthropicProfileResponse | null> {
	const response = await fetch(PROFILE_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
	});

	if (!response.ok) {
		return null;
	}

	return (await response.json()) as AnthropicProfileResponse;
}

function attachProfileMetadata(
	credentials: OAuthCredentials,
	profile: AnthropicProfileResponse | null,
): OAuthCredentials {
	return {
		...credentials,
		email: profile?.account?.email ?? getString(credentials, "email"),
		displayName: profile?.account?.display_name ?? getString(credentials, "displayName"),
		accountId: profile?.account?.uuid ?? getString(credentials, "accountId"),
		organizationUuid: profile?.organization?.uuid ?? getString(credentials, "organizationUuid"),
		organizationName: profile?.organization?.name ?? getString(credentials, "organizationName"),
		subscriptionType: profile?.subscriptionType ?? credentials.subscriptionType,
		rateLimitTier: profile?.rateLimitTier ?? credentials.rateLimitTier,
	};
}

function getString(credentials: OAuthCredentials, key: string): string | undefined {
	const value = credentials[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Login with Anthropic OAuth (device code flow)
 *
 * @param onAuthUrl - Callback to handle the authorization URL (e.g., open browser)
 * @param onPromptCode - Callback to prompt user for the authorization code
 */
export async function loginAnthropic(
	onAuthUrl: (url: string) => void,
	onPromptCode: () => Promise<string>,
): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	// Build authorization URL
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
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
	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: code,
			state: state,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
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
	const credentials = {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: expiresAt,
	};

	const profile = await fetchAnthropicProfile(credentials.access).catch(() => null);
	return attachProfileMetadata(credentials, profile);
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

	const credentials = {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};

	const profile = await fetchAnthropicProfile(credentials.access).catch(() => null);
	return attachProfileMetadata(credentials, profile);
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
