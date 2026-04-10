import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	makeStreamExhaustedErrorMessage,
	buildPromptFromContext,
	buildSdkOptions,
	extractToolResultsFromSdkUserMessage,
	getClaudeLookupCommand,
	parseClaudeLookupOutput,
} from "../stream-adapter.ts";
import type { Context, Message } from "@gsd/pi-ai";
import type { SDKUserMessage } from "../sdk-types.ts";

// ---------------------------------------------------------------------------
// Existing tests — exhausted stream fallback (#2575)
// ---------------------------------------------------------------------------

describe("stream-adapter — exhausted stream fallback (#2575)", () => {
	test("generator exhaustion becomes an error message instead of clean completion", () => {
		const message = makeStreamExhaustedErrorMessage("claude-sonnet-4-20250514", "partial answer");

		assert.equal(message.stopReason, "error");
		assert.equal(message.errorMessage, "stream_exhausted_without_result");
		assert.deepEqual(message.content, [{ type: "text", text: "partial answer" }]);
	});

	test("generator exhaustion without prior text still exposes a classifiable error", () => {
		const message = makeStreamExhaustedErrorMessage("claude-sonnet-4-20250514", "");

		assert.equal(message.stopReason, "error");
		assert.equal(message.errorMessage, "stream_exhausted_without_result");
		assert.match(String((message.content[0] as any)?.text ?? ""), /Claude Code error: stream_exhausted_without_result/);
	});
});

// ---------------------------------------------------------------------------
// Bug #2859 — stateless provider regression tests
// ---------------------------------------------------------------------------

describe("stream-adapter — full context prompt (#2859)", () => {
	test("buildPromptFromContext includes all user and assistant messages, not just the last user message", () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "What is 2+2?" } as Message,
				{
					role: "assistant",
					content: [{ type: "text", text: "4" }],
					api: "anthropic-messages",
					provider: "claude-code",
					model: "claude-sonnet-4-20250514",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} as Message,
				{ role: "user", content: "Now multiply that by 3" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);

		// Must contain content from BOTH user messages, not just the last
		assert.ok(prompt.includes("2+2"), "prompt must include first user message");
		assert.ok(prompt.includes("multiply"), "prompt must include second user message");
		// Must contain assistant response for continuity
		assert.ok(prompt.includes("4"), "prompt must include assistant reply for context");
	});

	test("buildPromptFromContext includes system prompt when present", () => {
		const context: Context = {
			systemPrompt: "You are a coding assistant.",
			messages: [
				{ role: "user", content: "Write a function" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);
		assert.ok(prompt.includes("coding assistant"), "prompt must include system prompt");
	});

	test("buildPromptFromContext handles array content parts in user messages", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "First part" },
						{ type: "text", text: "Second part" },
					],
				} as Message,
				{ role: "user", content: "Follow-up" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);
		assert.ok(prompt.includes("First part"), "prompt must include array content parts");
		assert.ok(prompt.includes("Second part"), "prompt must include all text parts");
		assert.ok(prompt.includes("Follow-up"), "prompt must include follow-up message");
	});

	test("buildPromptFromContext returns empty string for empty messages", () => {
		const context: Context = { messages: [] };
		const prompt = buildPromptFromContext(context);
		assert.equal(prompt, "");
	});
});

describe("stream-adapter — Claude Code external tool results", () => {
	test("extractToolResultsFromSdkUserMessage maps tool_result content to tool payloads", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-bash-1",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-bash-1",
						content: "line 1\nline 2",
						is_error: false,
					},
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results, [
			{
				toolUseId: "tool-bash-1",
				result: {
					content: [{ type: "text", text: "line 1\nline 2" }],
					details: {},
					isError: false,
				},
			},
		]);
	});

	test("extractToolResultsFromSdkUserMessage falls back to tool_use_result", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-read-1",
			message: { role: "user", content: [] },
			tool_use_result: {
				tool_use_id: "tool-read-1",
				content: "file contents",
				is_error: true,
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results, [
			{
				toolUseId: "tool-read-1",
				result: {
					content: [{ type: "text", text: "file contents" }],
					details: {},
					isError: true,
				},
			},
		]);
	});
});

describe("stream-adapter — session persistence (#2859)", () => {
	test("buildSdkOptions enables persistSession by default", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "test prompt");
		assert.equal(options.persistSession, true, "persistSession must default to true");
	});

	test("buildSdkOptions sets model and prompt correctly", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "hello world");
		assert.equal(options.model, "claude-sonnet-4-20250514");
	});

	test("buildSdkOptions enables betas for sonnet models", () => {
		const sonnetOpts = buildSdkOptions("claude-sonnet-4-20250514", "test");
		assert.ok(
			Array.isArray(sonnetOpts.betas) && sonnetOpts.betas.length > 0,
			"sonnet models should have betas enabled",
		);

		const opusOpts = buildSdkOptions("claude-opus-4-20250514", "test");
		assert.ok(
			Array.isArray(opusOpts.betas) && opusOpts.betas.length === 0,
			"non-sonnet models should have empty betas",
		);
	});

	test("buildSdkOptions includes workflow MCP server config when env is set", () => {
		const prev = {
			GSD_WORKFLOW_MCP_COMMAND: process.env.GSD_WORKFLOW_MCP_COMMAND,
			GSD_WORKFLOW_MCP_NAME: process.env.GSD_WORKFLOW_MCP_NAME,
			GSD_WORKFLOW_MCP_ARGS: process.env.GSD_WORKFLOW_MCP_ARGS,
			GSD_WORKFLOW_MCP_ENV: process.env.GSD_WORKFLOW_MCP_ENV,
			GSD_WORKFLOW_MCP_CWD: process.env.GSD_WORKFLOW_MCP_CWD,
		};
		try {
			process.env.GSD_WORKFLOW_MCP_COMMAND = "node";
			process.env.GSD_WORKFLOW_MCP_NAME = "gsd-workflow";
			process.env.GSD_WORKFLOW_MCP_ARGS = JSON.stringify(["packages/mcp-server/dist/cli.js"]);
			process.env.GSD_WORKFLOW_MCP_ENV = JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" });
			process.env.GSD_WORKFLOW_MCP_CWD = "/tmp/project";

			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.ok(mcpServers?.["gsd-workflow"], "expected gsd-workflow server config");
			const srv = mcpServers["gsd-workflow"];
			assert.equal(srv.command, "node");
			assert.deepEqual(srv.args, ["packages/mcp-server/dist/cli.js"]);
			assert.equal(srv.cwd, "/tmp/project");
			assert.equal(srv.env.GSD_CLI_PATH, "/tmp/gsd");
			assert.equal(srv.env.GSD_PERSIST_WRITE_GATE_STATE, "1");
			assert.equal(srv.env.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
		} finally {
			process.env.GSD_WORKFLOW_MCP_COMMAND = prev.GSD_WORKFLOW_MCP_COMMAND;
			process.env.GSD_WORKFLOW_MCP_NAME = prev.GSD_WORKFLOW_MCP_NAME;
			process.env.GSD_WORKFLOW_MCP_ARGS = prev.GSD_WORKFLOW_MCP_ARGS;
			process.env.GSD_WORKFLOW_MCP_ENV = prev.GSD_WORKFLOW_MCP_ENV;
			process.env.GSD_WORKFLOW_MCP_CWD = prev.GSD_WORKFLOW_MCP_CWD;
		}
	});

	test("buildSdkOptions auto-discovers bundled MCP server even without env hints", () => {
		const prev = {
			GSD_WORKFLOW_MCP_COMMAND: process.env.GSD_WORKFLOW_MCP_COMMAND,
			GSD_WORKFLOW_MCP_NAME: process.env.GSD_WORKFLOW_MCP_NAME,
			GSD_WORKFLOW_MCP_ARGS: process.env.GSD_WORKFLOW_MCP_ARGS,
			GSD_WORKFLOW_MCP_ENV: process.env.GSD_WORKFLOW_MCP_ENV,
			GSD_WORKFLOW_MCP_CWD: process.env.GSD_WORKFLOW_MCP_CWD,
		};
		try {
			delete process.env.GSD_WORKFLOW_MCP_COMMAND;
			delete process.env.GSD_WORKFLOW_MCP_NAME;
			delete process.env.GSD_WORKFLOW_MCP_ARGS;
			delete process.env.GSD_WORKFLOW_MCP_ENV;
			delete process.env.GSD_WORKFLOW_MCP_CWD;

			const originalCwd = process.cwd();
			const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-none-"));
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			process.chdir(originalCwd);
			// The bundled CLI may or may not be discoverable depending on
			// whether the build output exists relative to import.meta.url.
			// Either outcome is valid — the key invariant is no crash.
			const mcpServers = (options as any).mcpServers;
			if (mcpServers) {
				assert.ok(mcpServers["gsd-workflow"], "if present, must be gsd-workflow");
			}
			rmSync(emptyDir, { recursive: true, force: true });
		} finally {
			process.env.GSD_WORKFLOW_MCP_COMMAND = prev.GSD_WORKFLOW_MCP_COMMAND;
			process.env.GSD_WORKFLOW_MCP_NAME = prev.GSD_WORKFLOW_MCP_NAME;
			process.env.GSD_WORKFLOW_MCP_ARGS = prev.GSD_WORKFLOW_MCP_ARGS;
			process.env.GSD_WORKFLOW_MCP_ENV = prev.GSD_WORKFLOW_MCP_ENV;
			process.env.GSD_WORKFLOW_MCP_CWD = prev.GSD_WORKFLOW_MCP_CWD;
		}
	});

	test("buildSdkOptions auto-detects local workflow MCP dist CLI when present", () => {
		const prev = {
			GSD_WORKFLOW_MCP_COMMAND: process.env.GSD_WORKFLOW_MCP_COMMAND,
			GSD_WORKFLOW_MCP_NAME: process.env.GSD_WORKFLOW_MCP_NAME,
			GSD_WORKFLOW_MCP_ARGS: process.env.GSD_WORKFLOW_MCP_ARGS,
			GSD_WORKFLOW_MCP_ENV: process.env.GSD_WORKFLOW_MCP_ENV,
			GSD_WORKFLOW_MCP_CWD: process.env.GSD_WORKFLOW_MCP_CWD,
			GSD_CLI_PATH: process.env.GSD_CLI_PATH,
		};
		const originalCwd = process.cwd();
		const repoDir = mkdtempSync(join(tmpdir(), "claude-mcp-detect-"));
		try {
			delete process.env.GSD_WORKFLOW_MCP_COMMAND;
			delete process.env.GSD_WORKFLOW_MCP_NAME;
			delete process.env.GSD_WORKFLOW_MCP_ARGS;
			delete process.env.GSD_WORKFLOW_MCP_ENV;
			delete process.env.GSD_WORKFLOW_MCP_CWD;
			process.env.GSD_CLI_PATH = "/tmp/gsd";

			const distDir = join(repoDir, "packages", "mcp-server", "dist");
			mkdirSync(distDir, { recursive: true });
			writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\n");
			process.chdir(repoDir);
			const resolvedRepoDir = realpathSync(repoDir);

			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.ok(mcpServers?.["gsd-workflow"], "expected gsd-workflow server config");
			const srv = mcpServers["gsd-workflow"];
			assert.equal(srv.command, process.execPath);
			assert.deepEqual(srv.args, [realpathSync(resolve(repoDir, "packages", "mcp-server", "dist", "cli.js"))]);
			assert.equal(srv.cwd, resolvedRepoDir);
			assert.equal(srv.env.GSD_CLI_PATH, "/tmp/gsd");
			assert.equal(srv.env.GSD_PERSIST_WRITE_GATE_STATE, "1");
			assert.equal(srv.env.GSD_WORKFLOW_PROJECT_ROOT, resolvedRepoDir);
		} finally {
			process.chdir(originalCwd);
			rmSync(repoDir, { recursive: true, force: true });
			process.env.GSD_WORKFLOW_MCP_COMMAND = prev.GSD_WORKFLOW_MCP_COMMAND;
			process.env.GSD_WORKFLOW_MCP_NAME = prev.GSD_WORKFLOW_MCP_NAME;
			process.env.GSD_WORKFLOW_MCP_ARGS = prev.GSD_WORKFLOW_MCP_ARGS;
			process.env.GSD_WORKFLOW_MCP_ENV = prev.GSD_WORKFLOW_MCP_ENV;
			process.env.GSD_WORKFLOW_MCP_CWD = prev.GSD_WORKFLOW_MCP_CWD;
			process.env.GSD_CLI_PATH = prev.GSD_CLI_PATH;
		}
	});
});

describe("stream-adapter — Windows Claude path lookup (#3770)", () => {
	test("getClaudeLookupCommand uses where on Windows", () => {
		assert.equal(getClaudeLookupCommand("win32"), "where claude");
	});

	test("getClaudeLookupCommand uses which on non-Windows platforms", () => {
		assert.equal(getClaudeLookupCommand("darwin"), "which claude");
		assert.equal(getClaudeLookupCommand("linux"), "which claude");
	});

	test("parseClaudeLookupOutput keeps the first native path from multi-line lookup output", () => {
		const output = "C:\\Users\\Binoy\\.local\\bin\\claude.exe\r\nC:\\Program Files\\Claude\\claude.exe\r\n";
		assert.equal(parseClaudeLookupOutput(output), "C:\\Users\\Binoy\\.local\\bin\\claude.exe");
	});
});
