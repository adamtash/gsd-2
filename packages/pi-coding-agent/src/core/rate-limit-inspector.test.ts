import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	formatRelativeTime,
	formatResetTime,
	formatActiveRateLimitSummary,
	formatProviderRecoverySummary,
	type CredentialRateLimitInfo,
} from "./rate-limit-inspector.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeInfo(overrides: Partial<CredentialRateLimitInfo> = {}): CredentialRateLimitInfo {
	return {
		credentialId: "cred_1",
		provider: "anthropic",
		label: "user@example.com",
		fetchedAt: Date.now(),
		fiveHour: null,
		weekly: null,
		isRateLimited: false,
		availableAt: null,
		...overrides,
	};
}

// ─── formatRelativeTime ───────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
	const now = 1_700_000_000_000;

	it("returns 'now' when target is in the past", () => {
		assert.equal(formatRelativeTime(now - 60_000, now), "now");
	});

	it("returns 'now' when target equals now", () => {
		assert.equal(formatRelativeTime(now, now), "now");
	});

	it("returns minutes for < 60 minutes", () => {
		assert.equal(formatRelativeTime(now + 5 * 60_000, now), "in 5m");
		assert.equal(formatRelativeTime(now + 59 * 60_000, now), "in 59m");
	});

	it("returns hours for exact hours", () => {
		assert.equal(formatRelativeTime(now + 2 * 60 * 60_000, now), "in 2h");
	});

	it("returns hours and minutes for mixed", () => {
		assert.equal(formatRelativeTime(now + 90 * 60_000, now), "in 1h 30m");
	});

	it("rounds up to the next minute", () => {
		// 1 ms past 5 minutes → should be "in 6m" because Math.ceil
		assert.equal(formatRelativeTime(now + 5 * 60_000 + 1, now), "in 6m");
	});
});

// ─── formatResetTime ──────────────────────────────────────────────────────────

describe("formatResetTime", () => {
	it("returns 'unknown' for null/undefined", () => {
		assert.equal(formatResetTime(null), "unknown");
		assert.equal(formatResetTime(undefined), "unknown");
	});

	it("returns formatted date for valid timestamp", () => {
		const result = formatResetTime(1_700_000_000_000);
		assert.ok(result.length > 0);
		assert.notEqual(result, "unknown");
	});
});

// ─── formatActiveRateLimitSummary ─────────────────────────────────────────────

describe("formatActiveRateLimitSummary", () => {
	it("returns undefined for undefined info", () => {
		assert.equal(formatActiveRateLimitSummary(undefined), undefined);
	});

	it("returns undefined for info with no windows and no error", () => {
		assert.equal(formatActiveRateLimitSummary(makeInfo()), undefined);
	});

	it("returns label with error suffix when only error is present", () => {
		const result = formatActiveRateLimitSummary(makeInfo({ error: "fetch failed" }));
		assert.equal(result, "user@example.com usage unavailable");
	});

	it("returns label with window utilization when not rate-limited", () => {
		const now = Date.now();
		const result = formatActiveRateLimitSummary(makeInfo({
			fiveHour: { utilization: 42, resetsAt: now + 60 * 60_000 },
		}));
		assert.ok(result);
		assert.ok(result.includes("user@example.com"));
		assert.ok(result.includes("5h 42%"), `expected '5h 42%' in: ${result}`);
		assert.ok(result.includes("resets in"), `expected 'resets in' in: ${result}`);
	});

	it("omits utilization when API returns null (no n/a shown)", () => {
		const now = Date.now();
		const result = formatActiveRateLimitSummary(makeInfo({
			fiveHour: { utilization: null, resetsAt: now + 60 * 60_000 },
			weekly: { utilization: null, resetsAt: now + 120 * 60_000 },
		}));
		assert.ok(result);
		assert.ok(!result.includes("n/a"), "should not show n/a");
		assert.ok(result.includes("5h resets"), "should show 5h resets without utilization");
		assert.ok(result.includes("7d resets"), "should show 7d resets without utilization");
	});

	it("returns blocked message when rate-limited", () => {
		const now = Date.now();
		const result = formatActiveRateLimitSummary(makeInfo({
			isRateLimited: true,
			availableAt: now + 30 * 60_000,
			fiveHour: { utilization: 100, resetsAt: now + 30 * 60_000 },
		}));
		assert.ok(result);
		assert.ok(result.includes("blocked"));
	});

	it("returns blocked 'until reset' when no availableAt", () => {
		const result = formatActiveRateLimitSummary(makeInfo({
			isRateLimited: true,
			availableAt: null,
		}));
		assert.ok(result);
		assert.ok(result.includes("blocked until reset"));
	});

	it("includes both windows when present", () => {
		const now = Date.now();
		const result = formatActiveRateLimitSummary(makeInfo({
			fiveHour: { utilization: 50, resetsAt: now + 60_000 },
			weekly: { utilization: 20, resetsAt: now + 3600_000 },
		}));
		assert.ok(result);
		assert.ok(result.includes("5h 50%"), `expected '5h 50%' in: ${result}`);
		assert.ok(result.includes("7d 20%"), `expected '7d 20%' in: ${result}`);
	});

	it("shows 100% when a window is fully consumed", () => {
		const now = Date.now();
		const result = formatActiveRateLimitSummary(makeInfo({
			fiveHour: { utilization: 100, resetsAt: now + 30 * 60_000 },
		}));
		assert.ok(result);
		assert.ok(result.includes("5h 100%"), `expected '5h 100%' in: ${result}`);
	});
});

// ─── formatProviderRecoverySummary ────────────────────────────────────────────

describe("formatProviderRecoverySummary", () => {
	it("returns undefined for empty infos", () => {
		assert.equal(formatProviderRecoverySummary("anthropic", []), undefined);
	});

	it("lists all credentials with status", () => {
		const now = Date.now();
		const result = formatProviderRecoverySummary("anthropic", [
			makeInfo({ label: "acct-1", availableAt: now + 5 * 60_000 }),
			makeInfo({ label: "acct-2", isRateLimited: false }),
		]);
		assert.ok(result);
		assert.ok(result.includes("anthropic accounts:"));
		assert.ok(result.includes("acct-1"));
		assert.ok(result.includes("acct-2 ready"));
	});

	it("shows 'waiting for reset' when rate-limited without availableAt", () => {
		const result = formatProviderRecoverySummary("anthropic", [
			makeInfo({ label: "acct-1", isRateLimited: true }),
		]);
		assert.ok(result);
		assert.ok(result.includes("waiting for reset"));
	});

	it("shows 'unavailable' when error is present", () => {
		const result = formatProviderRecoverySummary("anthropic", [
			makeInfo({ label: "acct-1", error: "fetch failed" }),
		]);
		assert.ok(result);
		assert.ok(result.includes("unavailable"));
	});
});
