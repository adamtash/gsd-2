export type ProviderErrorPauseUI = {
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
};

export function isRetryableProviderErrorDetail(errorDetail: string): boolean {
  const normalized = errorDetail.replace(/^:\s*/, "");
  return /overloaded|rate.?limit|too many requests|429|quota|billing|(?:hit|exceed(?:ed|ing)?).*usage.?limit|usage.?limit|500|502|503|504|service.?unavailable|server.?error|internal.?error|api.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay|network.?(?:is\s+)?unavailable|credentials.*expired|temporarily backed off/i.test(
    normalized,
  );
}

export async function maybePauseAutoForProviderError(
  ui: ProviderErrorPauseUI,
  errorDetail: string,
  pause: () => Promise<void>,
): Promise<boolean> {
  if (isRetryableProviderErrorDetail(errorDetail)) {
    return false;
  }

  await pauseAutoForProviderError(ui, errorDetail, pause);
  return true;
}

/**
 * Pause auto-mode due to a provider error.
 *
 * For transient errors (rate limits, server errors, overloaded), schedules
 * an automatic resume after a delay. For permanent errors (auth, billing),
 * pauses indefinitely — user must manually resume.
 */
export async function pauseAutoForProviderError(
  ui: ProviderErrorPauseUI,
  errorDetail: string,
  pause: () => Promise<void>,
  options?: {
    isRateLimit?: boolean;
    isTransient?: boolean;
    retryAfterMs?: number;
    resume?: () => void;
  },
): Promise<void> {
  const shouldAutoResume = (options?.isRateLimit || options?.isTransient)
    && options.retryAfterMs
    && options.retryAfterMs > 0
    && options.resume;

  if (shouldAutoResume) {
    const delaySec = Math.ceil(options!.retryAfterMs! / 1000);
    const reason = options!.isRateLimit ? "Rate limited" : "Server error (transient)";
    ui.notify(
      `${reason}${errorDetail}. Auto-resuming in ${delaySec}s...`,
      "warning",
    );
    await pause();

    // Schedule auto-resume after the delay
    setTimeout(() => {
      const resumeMsg = options!.isRateLimit
        ? "Rate limit window elapsed. Resuming auto-mode."
        : "Server error recovery delay elapsed. Resuming auto-mode.";
      ui.notify(resumeMsg, "info");
      options!.resume!();
    }, options!.retryAfterMs!);
  } else {
    ui.notify(`Auto-mode paused due to provider error${errorDetail}`, "warning");
    await pause();
  }
}
