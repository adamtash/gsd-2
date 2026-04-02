import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const footerSource = readFileSync(
  join(process.cwd(), "packages", "pi-coding-agent", "src", "modes", "interactive", "components", "footer.ts"),
  "utf-8",
);

test("FooterComponent dims extension status lines to match the rest of the footer", () => {
  assert.match(
    footerSource,
    /theme\.fg\("dim", statusLine\)/,
    "extension status line should be wrapped in the dim footer color",
  );
});

test("FooterComponent shows the active account and usage summary in the footer", () => {
  assert.match(
    footerSource,
    /current \$\{activeAccount\.label\}/,
    "footer should render the currently active account label",
  );
  assert.match(
    footerSource,
    /formatActiveCredentialRateLimitSummary\(\s*activeProvider,\s*this\.session\.sessionId,\s*\)/,
    "footer should include active-account usage summary when rate-limit data exists",
  );
});
