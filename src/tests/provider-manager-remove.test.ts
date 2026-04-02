import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ModelsJsonWriter } = await import("../../packages/pi-coding-agent/src/core/models-json-writer.ts");
const { ProviderManagerComponent } = await import(
  "../../packages/pi-coding-agent/src/modes/interactive/components/provider-manager.ts"
);
const { initTheme } = await import(
  "../../packages/pi-coding-agent/src/modes/interactive/theme/theme.ts"
);

initTheme();

function createTempModelsJsonPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "provider-manager-test-"));
  return join(dir, "models.json");
}

function createComponent(options: {
  modelsJsonPath: string;
  authProviders?: string[];
  providers: Array<{ name: string; modelIds: string[] }>;
}) {
  const writer = new ModelsJsonWriter(options.modelsJsonPath);
  for (const provider of options.providers) {
    writer.setProvider(provider.name, {
      models: provider.modelIds.map((id: string) => ({ id })),
    });
  }

  const authProviders = new Set(options.authProviders ?? []);
  const removedProviders: string[] = [];
  let refreshCalls = 0;
  let renderCalls = 0;

  const authStorage = {
    hasAuth(provider: string) {
      return authProviders.has(provider);
    },
    remove(provider: string) {
      removedProviders.push(provider);
      authProviders.delete(provider);
    },
    getCredentialPool(provider: string) {
      if (authProviders.has(provider)) {
        return [{ id: "cred-1", label: provider, type: "api_key", isActive: true, isPreferred: false, isBackedOff: false, backoffRemainingMs: 0 }];
      }
      return [];
    },
  } as any;

  const modelRegistry = {
    modelsJsonPath: options.modelsJsonPath,
    getAll() {
      const config = JSON.parse(readFileSync(options.modelsJsonPath, "utf-8")) as {
        providers?: Record<string, { models?: Array<{ id: string }> }>;
      };
      return Object.entries(config.providers ?? {}).flatMap(([provider, providerConfig]) =>
        (providerConfig.models ?? []).map((model) => ({
          id: model.id,
          provider,
        })),
      );
    },
    refresh() {
      refreshCalls += 1;
    },
  } as any;

  const tui = {
    requestRender() {
      renderCalls += 1;
    },
    terminal: { rows: 40 },
  } as any;

  const removedCredentials: Array<{ provider: string; credentialId: string }> = [];

  const component = new ProviderManagerComponent(tui, authStorage, modelRegistry, {
    onDone: () => {},
    onDiscover: () => {},
    onSetActive: () => {},
    onRemoveAccount: (provider: string, credentialId: string) => {
      removedCredentials.push({ provider, credentialId });
      removedProviders.push(provider);
    },
    onAddAccount: () => {},
    onAddApiKey: () => {},
    onSetupToken: () => {},
  });
  return {
    component,
    removedProviders,
    getRefreshCalls: () => refreshCalls,
    getRenderCalls: () => renderCalls,
  };
}

test("provider manager does not fire onRemoveAccount when no credentials exist", (t) => {
  const modelsJsonPath = createTempModelsJsonPath();
  const rootDir = join(modelsJsonPath, "..");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { component, removedProviders } = createComponent({
    modelsJsonPath,
    providers: [{ name: "custom", modelIds: ["local-model"] }],
  });

  component.handleInput("r");

  // No credentials, so onRemoveAccount should not be called
  assert.deepEqual(removedProviders, []);
});

test("provider manager fires onRemoveAccount for provider with auth", (t) => {
  const modelsJsonPath = createTempModelsJsonPath();
  const rootDir = join(modelsJsonPath, "..");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { component, removedProviders } = createComponent({
    modelsJsonPath,
    authProviders: ["custom"],
    providers: [{ name: "custom", modelIds: ["local-model"] }],
  });

  component.handleInput("r");

  assert.deepEqual(removedProviders, ["custom"]);
});

test("provider manager navigation wraps around provider list", (t) => {
  const modelsJsonPath = createTempModelsJsonPath();
  const rootDir = join(modelsJsonPath, "..");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { component } = createComponent({
    modelsJsonPath,
    authProviders: ["zeta"],
    providers: [
      { name: "alpha", modelIds: ["a-1"] },
      { name: "zeta", modelIds: ["z-1"] },
    ],
  });

  const providers = (component as any).providers as Array<{ name: string }>;
  const lastIndex = providers.length - 1;

  (component as any).selectedIndex = lastIndex;

  // Down from the last item should wrap to the first.
  component.handleInput("\x1b[B"); // down arrow
  assert.equal((component as any).selectedIndex, 0);

  // Up from the first item should wrap to the last.
  component.handleInput("\x1b[A"); // up arrow
  assert.equal((component as any).selectedIndex, lastIndex);
});
