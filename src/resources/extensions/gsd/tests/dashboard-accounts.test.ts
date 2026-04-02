import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const overlaySource = readFileSync(join(__dirname, "..", "dashboard-overlay.ts"), "utf-8");
const statusCommandSource = readFileSync(join(__dirname, "..", "commands", "handlers", "core.ts"), "utf-8");
const shortcutsSource = readFileSync(join(__dirname, "..", "bootstrap", "register-shortcuts.ts"), "utf-8");

describe("dashboard accounts contract", () => {
  it("renders an Accounts section in the dashboard overlay", () => {
    assert.match(
      overlaySource,
      /th\.bold\("Accounts"\)/,
      "dashboard overlay should render an Accounts section title",
    );
    assert.match(
      overlaySource,
      /current \$\{currentRow\.provider\}\/\$\{currentRow\.label\}/,
      "dashboard overlay should summarize the current account near the top of the section",
    );
  });

  it("loads credential pools and usage data with the active session id", () => {
    assert.match(
      overlaySource,
      /refreshProviderRateLimitInfo\(provider, this\.sessionId\)/,
      "dashboard overlay should refresh rate-limit data with the current session id",
    );
    assert.match(
      overlaySource,
      /getCredentialPool\(provider, this\.sessionId\)/,
      "dashboard overlay should resolve active accounts using the current session id",
    );
  });

  it("passes auth storage and session context into the dashboard overlay entry points", () => {
    assert.match(
      statusCommandSource,
      /ctx\.modelRegistry\.authStorage,\s*ctx\.sessionManager\.getSessionId\(\),\s*ctx\.model\?\.provider/,
      "status command should pass auth storage, session id, and current provider into the overlay",
    );
    assert.match(
      shortcutsSource,
      /ctx\.modelRegistry\.authStorage,\s*ctx\.sessionManager\.getSessionId\(\),\s*ctx\.model\?\.provider/,
      "keyboard shortcut should pass auth storage, session id, and current provider into the overlay",
    );
  });
});
