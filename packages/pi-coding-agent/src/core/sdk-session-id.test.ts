import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

describe("sdk auth session id", () => {
	it("uses the live agent/session id for provider auth resolution", () => {
		const dir = dirname(fileURLToPath(import.meta.url));
		const compiledSdk = readFileSync(join(dir, "sdk.js"), "utf8");

		assert.ok(
			compiledSdk.includes("const currentSessionId = agent.sessionId ?? sessionManager.getSessionId();"),
			"sdk.js must derive auth state from the live session id",
		);
		assert.ok(
			compiledSdk.includes("getApiKeyForProvider(resolvedProvider, currentSessionId)"),
			"provider key lookup must use the live session id",
		);
		assert.ok(
			compiledSdk.includes("getCredentialPool(resolvedProvider, currentSessionId)"),
			"credential pool inspection must use the live session id",
		);
		assert.ok(
			/isUsingOAuth\([^,]+,\s*currentSessionId\)/.test(compiledSdk),
			"OAuth detection must use the live session id",
		);
	});
});
