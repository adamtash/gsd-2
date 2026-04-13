import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { GSD_COMMAND_DESCRIPTION, getGsdArgumentCompletions } from "./catalog.js";

export function registerGSDCommand(pi: ExtensionAPI): void {
  pi.registerCommand("gsd", {
    description: GSD_COMMAND_DESCRIPTION,
    getArgumentCompletions: getGsdArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { handleGSDCommand } = await import("./dispatcher.js");
      const { setStderrLoggingEnabled } = await import("../workflow-logger.js");
      const previousStderrSetting = setStderrLoggingEnabled(false);
      try {
        await handleGSDCommand(args, ctx, pi);
      } catch (err) {
        // Directory validation errors (e.g. running from $HOME) should surface as
        // a user-visible notification rather than an unhandled extension crash.
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(msg, "error");
      } finally {
        setStderrLoggingEnabled(previousStderrSetting);
      }
    },
  });
}
