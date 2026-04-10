# @gsd-build/mcp-server

MCP server exposing GSD orchestration tools for Claude Code, Cursor, and other MCP-compatible clients.

Start GSD auto-mode sessions, poll progress, resolve blockers, and retrieve results — all through the [Model Context Protocol](https://modelcontextprotocol.io/).

This package now exposes two tool surfaces:

- session/read tools for starting and inspecting GSD sessions
- workflow mutation tools for planning, completion, validation, reassessment, and gate persistence

## Installation

```bash
npm install @gsd-build/mcp-server
```

Or with the monorepo workspace:

```bash
# Already available as a workspace package
npx gsd-mcp-server
```

## Configuration

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "npx",
      "args": ["gsd-mcp-server"],
      "env": {
        "GSD_CLI_PATH": "/path/to/gsd"
      }
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "gsd-mcp-server"
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "npx",
      "args": ["gsd-mcp-server"],
      "env": {
        "GSD_CLI_PATH": "/path/to/gsd"
      }
    }
  }
}
```

## Tools

### Workflow mutation tools

The workflow MCP surface includes:

- `gsd_plan_milestone`
- `gsd_plan_slice`
- `gsd_replan_slice`
- `gsd_slice_replan`
- `gsd_task_complete`
- `gsd_complete_task`
- `gsd_slice_complete`
- `gsd_complete_slice`
- `gsd_validate_milestone`
- `gsd_milestone_validate`
- `gsd_complete_milestone`
- `gsd_milestone_complete`
- `gsd_reassess_roadmap`
- `gsd_roadmap_reassess`
- `gsd_save_gate_result`
- `gsd_summary_save`
- `gsd_milestone_status`

These mutation tools use the same GSD workflow handlers as the native in-process tool path.

Current support boundary:

- when running inside the GSD monorepo checkout, the MCP server auto-discovers the shared workflow executor module
- outside the monorepo, set `GSD_WORKFLOW_EXECUTORS_MODULE` to an importable `workflow-tool-executors` module path if you want the mutation tools enabled
- session/read tools do not depend on this bridge

If the executor bridge cannot be loaded, workflow mutation calls will fail with a precise configuration error instead of silently degrading.

### `gsd_execute`

Start a GSD auto-mode session for a project directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectDir` | `string` | ✅ | Absolute path to the project directory |
| `command` | `string` | | Command to send (default: `"/gsd auto"`) |
| `model` | `string` | | Model ID override |
| `bare` | `boolean` | | Run in bare mode (skip user config) |

**Returns:** `{ sessionId, status: "started" }`

### `gsd_status`

Poll the current status of a running GSD session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |

**Returns:**

```json
{
  "status": "running",
  "progress": { "eventCount": 42, "toolCalls": 15 },
  "recentEvents": [ ... ],
  "pendingBlocker": null,
  "cost": { "totalCost": 0.12, "tokens": { "input": 5000, "output": 2000, "cacheRead": 1000, "cacheWrite": 500 } },
  "durationMs": 45000
}
```

### `gsd_result`

Get the accumulated result of a session. Works for both running (partial) and completed sessions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |

**Returns:**

```json
{
  "sessionId": "abc-123",
  "projectDir": "/path/to/project",
  "status": "completed",
  "durationMs": 120000,
  "cost": { ... },
  "recentEvents": [ ... ],
  "pendingBlocker": null,
  "error": null
}
```

### `gsd_cancel`

Cancel a running session. Aborts the current operation and stops the agent process.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |

**Returns:** `{ cancelled: true }`

### `gsd_query`

Query GSD project state from the filesystem without an active session. Returns STATE.md, PROJECT.md, requirements, and milestone listing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectDir` | `string` | ✅ | Absolute path to the project directory |
| `query` | `string` | ✅ | What to query (e.g. `"status"`, `"milestones"`) |

**Returns:**

```json
{
  "projectDir": "/path/to/project",
  "state": "...",
  "project": "...",
  "requirements": "...",
  "milestones": [
    { "id": "M001", "hasRoadmap": true, "hasSummary": false }
  ]
}
```

### `gsd_resolve_blocker`

Resolve a pending blocker in a session by sending a response to the blocked UI request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |
| `response` | `string` | ✅ | Response to send for the pending blocker |

**Returns:** `{ resolved: true }`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GSD_CLI_PATH` | Absolute path to the GSD CLI binary. If not set, the server resolves `gsd` via `which`. |
| `GSD_WORKFLOW_EXECUTORS_MODULE` | Optional absolute path or `file:` URL for the shared GSD workflow executor module used by workflow mutation tools. |

## Architecture

```
┌─────────────────┐     stdio      ┌──────────────────┐
│  MCP Client     │ ◄────────────► │  @gsd-build/mcp-server │
│  (Claude Code,  │    JSON-RPC    │                  │
│   Cursor, etc.) │                │  SessionManager  │
└─────────────────┘                │       │          │
                                   │       ▼          │
                                   │  @gsd-build/rpc-client │
                                   │       │          │
                                   │       ▼          │
                                   │  GSD CLI (child  │
                                   │  process via RPC)│
                                   └──────────────────┘
```

- **@gsd-build/mcp-server** — MCP protocol adapter. Translates MCP tool calls into SessionManager operations.
- **SessionManager** — Manages RpcClient lifecycle. One session per project directory. Tracks events in a ring buffer (last 50), detects blockers, accumulates cost.
- **@gsd-build/rpc-client** — Low-level RPC client that spawns and communicates with the GSD CLI process via JSON-RPC over stdio.

## License

MIT
