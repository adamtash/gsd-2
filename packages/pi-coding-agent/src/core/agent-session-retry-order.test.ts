import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectCredentialExhaustionRecoveryMode } from "./agent-session.js";

describe("selectCredentialExhaustionRecoveryMode", () => {
	it("prefers provider fallback over waiting for the same provider to recover", () => {
		assert.equal(
			selectCredentialExhaustionRecoveryMode({
				errorType: "rate_limit",
				hasFallback: true,
				hasRecoveryWindow: true,
			}),
			"fallback",
		);
	});

	it("gives up when quota is exhausted and no fallback exists", () => {
		assert.equal(
			selectCredentialExhaustionRecoveryMode({
				errorType: "quota_exhausted",
				hasFallback: false,
				hasRecoveryWindow: true,
			}),
			"give_up",
		);
	});

	it("waits only when no fallback exists and recovery is possible", () => {
		assert.equal(
			selectCredentialExhaustionRecoveryMode({
				errorType: "rate_limit",
				hasFallback: false,
				hasRecoveryWindow: true,
			}),
			"wait",
		);
	});
});