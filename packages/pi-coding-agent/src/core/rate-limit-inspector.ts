import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

export interface RateLimitWindow {
	utilization: number | null;
	resetsAt: number | null;
	windowMinutes?: number | null;
}

export interface CredentialRateLimitInfo {
	credentialId: string;
	provider: string;
	label: string;
	fetchedAt: number;
	fiveHour: RateLimitWindow | null;
	weekly: RateLimitWindow | null;
	isRateLimited: boolean;
	availableAt: number | null;
	error?: string;
	isActive?: boolean;
	isPreferred?: boolean;
	isBackedOff?: boolean;
	backoffRemainingMs?: number;
}

type AnthropicUsageResponse = {
	five_hour?: { utilization?: number | null; resets_at?: number | string | null } | null;
	seven_day?: { utilization?: number | null; resets_at?: number | string | null } | null;
};

type CodexAuthSnapshot = {
	access: string;
	refresh: string;
	accountId?: string;
	idToken?: string;
};

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";

function normalizeTimestamp(value: unknown): number | null {
	if (value == null) return null;
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string") {
		const parsedNumber = Number(value);
		if (Number.isFinite(parsedNumber)) return parsedNumber;
		const parsedDate = Date.parse(value);
		return Number.isNaN(parsedDate) ? null : parsedDate;
	}
	return null;
}

function normalizeRateLimitWindow(input: {
	utilization?: number | null;
	resets_at?: number | string | null;
	resetsAt?: number | string | null;
	windowDurationMins?: number | null;
} | null | undefined): RateLimitWindow | null {
	if (!input) return null;
	const utilization = typeof input.utilization === "number" && Number.isFinite(input.utilization)
		? Math.max(0, Math.min(100, input.utilization))
		: null;
	const resetsAt = normalizeTimestamp(input.resetsAt ?? input.resets_at);
	const windowMinutes = typeof input.windowDurationMins === "number" && Number.isFinite(input.windowDurationMins)
		? input.windowDurationMins
		: null;
	return { utilization, resetsAt, windowMinutes };
}

function computeAvailableAt(fiveHour: RateLimitWindow | null, weekly: RateLimitWindow | null): {
	isRateLimited: boolean;
	availableAt: number | null;
} {
	const blocking = [fiveHour, weekly].filter(
		(window): window is RateLimitWindow => Boolean(window && (window.utilization ?? -1) >= 100),
	);
	if (blocking.length === 0) {
		return { isRateLimited: false, availableAt: null };
	}
	const resetTimes = blocking
		.map((window) => window.resetsAt)
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	if (resetTimes.length !== blocking.length) {
		return { isRateLimited: true, availableAt: null };
	}
	return {
		isRateLimited: true,
		availableAt: Math.max(...resetTimes),
	};
}

export function formatRelativeTime(targetMs: number, nowMs: number = Date.now()): string {
	const diffMs = Math.max(0, targetMs - nowMs);
	const totalMinutes = Math.ceil(diffMs / 60_000);
	if (totalMinutes < 1) return "now";
	if (totalMinutes < 60) return `in ${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (minutes === 0) return `in ${hours}h`;
	return `in ${hours}h ${minutes}m`;
}

export function formatResetTime(resetAt: number | null | undefined): string {
	if (!resetAt) return "unknown";
	return new Date(resetAt).toLocaleString("en-US", {
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatUtilization(window: RateLimitWindow | null): string | null {
	if (!window || window.utilization == null) return null;
	return `${Math.round(window.utilization)}%`;
}

export function formatActiveRateLimitSummary(info: CredentialRateLimitInfo | undefined): string | undefined {
	if (!info) return undefined;
	const windows: string[] = [];
	if (info.fiveHour) {
		const util = formatUtilization(info.fiveHour);
		windows.push(`5h${util ? ` ${util}` : ""} reset ${formatResetTime(info.fiveHour.resetsAt)}`);
	}
	if (info.weekly) {
		const util = formatUtilization(info.weekly);
		windows.push(`7d${util ? ` ${util}` : ""} reset ${formatResetTime(info.weekly.resetsAt)}`);
	}
	if (info.isRateLimited) {
		const waitText = info.availableAt ? formatRelativeTime(info.availableAt) : "until reset";
		return `${info.label} blocked ${waitText}${windows.length > 0 ? ` · ${windows.join(" · ")}` : ""}`;
	}
	if (windows.length > 0) {
		return `${info.label} ${windows.join(" · ")}`;
	}
	if (info.error) {
		return `${info.label} usage unavailable`;
	}
	return undefined;
}

export function formatProviderRecoverySummary(provider: string, infos: CredentialRateLimitInfo[]): string | undefined {
	if (infos.length === 0) return undefined;
	const parts = infos.map((info) => {
		if (info.availableAt) {
			return `${info.label} ${formatRelativeTime(info.availableAt)} (${formatResetTime(info.availableAt)})`;
		}
		if (info.isRateLimited) {
			return `${info.label} waiting for reset`;
		}
		if (info.error) {
			return `${info.label} unavailable`;
		}
		return `${info.label} ready`;
	});
	return `${provider} accounts: ${parts.join("; ")}`;
}

export async function inspectAnthropicRateLimit(
	provider: string,
	credentialId: string,
	label: string,
	accessToken: string,
): Promise<CredentialRateLimitInfo> {
	const response = await fetch(CLAUDE_USAGE_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": "claude-code/2.1.76",
			"anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Usage fetch failed (${response.status}): ${body || response.statusText}`);
	}

	const usage = (await response.json()) as AnthropicUsageResponse;
	const fiveHour = normalizeRateLimitWindow(usage.five_hour);
	const weekly = normalizeRateLimitWindow(usage.seven_day);
	const availability = computeAvailableAt(fiveHour, weekly);
	return {
		credentialId,
		provider,
		label,
		fetchedAt: Date.now(),
		fiveHour,
		weekly,
		isRateLimited: availability.isRateLimited,
		availableAt: availability.availableAt,
	};
}

function resolveCodexCommand(): string {
	return process.env.CODEX_AS_CODEX_BIN || "codex";
}

async function requestCodexRateLimits(codexHome: string): Promise<{
	primary: RateLimitWindow | null;
	secondary: RateLimitWindow | null;
}> {
	const child = spawn(resolveCodexCommand(), ["app-server"], {
		env: {
			...process.env,
			CODEX_HOME: codexHome,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	return await new Promise((resolve, reject) => {
		let stdoutBuffer = "";
		let stderr = "";
		const responses = new Map<number, unknown>();
		const expectedIds = new Set([1, 2]);
		let settled = false;

		const cleanup = () => {
			clearTimeout(timer);
			child.stdout.removeAllListeners();
			child.stderr.removeAllListeners();
			child.removeAllListeners();
		};

		const finish = (handler: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			try {
				child.kill("SIGTERM");
			} catch {
				// ignore shutdown races
			}
			handler();
		};

		const timer = setTimeout(() => {
			finish(() => reject(new Error("Timed out waiting for Codex app-server responses.")));
		}, 15_000);

		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let message: { id?: number; result?: unknown; error?: { message?: string } };
				try {
					message = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { message?: string } };
				} catch {
					continue;
				}
				if (message.id != null) {
					responses.set(message.id, message);
				}
				const allPresent = [...expectedIds].every((id) => responses.has(id));
				if (!allPresent) continue;
				finish(() => {
					const payload = responses.get(2) as { result?: { rateLimits?: { primary?: unknown; secondary?: unknown } }; error?: { message?: string } } | undefined;
					if (payload?.error) {
						reject(new Error(payload.error.message || "Codex rate limit request failed"));
						return;
					}
					resolve({
						primary: normalizeRateLimitWindow(payload?.result?.rateLimits?.primary as {
							utilization?: number | null;
							resetsAt?: number | string | null;
							windowDurationMins?: number | null;
						}),
						secondary: normalizeRateLimitWindow(payload?.result?.rateLimits?.secondary as {
							utilization?: number | null;
							resetsAt?: number | string | null;
							windowDurationMins?: number | null;
						}),
					});
				});
				return;
			}
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			finish(() => reject(error));
		});

		child.on("exit", (code, signal) => {
			if (settled) return;
			finish(() => {
				reject(new Error(stderr.trim() || `Codex app-server exited early (code ${code ?? "-"}, signal ${signal ?? "-"})`));
			});
		});

		child.stdin.write(`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: 1,
				clientInfo: { name: "gsd", version: process.env.GSD_VERSION || "0.0.0" },
			},
		})}\n`);
		child.stdin.write(`${JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "account/rateLimits/read",
			params: {},
		})}\n`);
	});
}

export async function inspectOpenAICodexRateLimit(
	provider: string,
	credentialId: string,
	label: string,
	auth: CodexAuthSnapshot,
): Promise<CredentialRateLimitInfo> {
	const tempDir = mkdtempSync(join(tmpdir(), "gsd-codex-rate-"));
	try {
		writeFileSync(
			join(tempDir, "auth.json"),
			`${JSON.stringify({
				auth_mode: "chatgpt",
				OPENAI_API_KEY: null,
				tokens: {
					id_token: auth.idToken ?? auth.access,
					access_token: auth.access,
					refresh_token: auth.refresh,
					account_id: auth.accountId ?? null,
				},
				last_refresh: new Date().toISOString(),
			}, null, 2)}\n`,
			{ mode: 0o600 },
		);
		const limits = await requestCodexRateLimits(tempDir);
		const availability = computeAvailableAt(limits.primary, limits.secondary);
		return {
			credentialId,
			provider,
			label,
			fetchedAt: Date.now(),
			fiveHour: limits.primary,
			weekly: limits.secondary,
			isRateLimited: availability.isRateLimited,
			availableAt: availability.availableAt,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
