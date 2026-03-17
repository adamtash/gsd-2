import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractOpenAICodexIdentity } from "./openai-codex.js";

function createJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.signature`;
}

describe("extractOpenAICodexIdentity", () => {
	it("prefers email and display name from id token while keeping account id from the access token", () => {
		const accessToken = createJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct_123456789" },
		});
		const idToken = createJwt({
			email: "user@example.com",
			name: "Example User",
		});

		assert.deepEqual(extractOpenAICodexIdentity(accessToken, idToken), {
			accountId: "acct_123456789",
			email: "user@example.com",
			displayName: "Example User",
		});
	});

	it("falls back to access-token claims when an id token is unavailable", () => {
		const accessToken = createJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct_abcdef" },
			email: "fallback@example.com",
			name: "Fallback Name",
		});

		assert.deepEqual(extractOpenAICodexIdentity(accessToken), {
			accountId: "acct_abcdef",
			email: "fallback@example.com",
			displayName: "Fallback Name",
		});
	});
});