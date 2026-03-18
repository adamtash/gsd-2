export type ProviderErrorPauseUI = {
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
};

export function isRetryableProviderErrorDetail(errorDetail: string): boolean {
  const normalized = errorDetail.replace(/^:\s*/, "");
  return /overloaded|rate.?limit|too many requests|429|quota|billing|(?:hit|exceed(?:ed|ing)?).*usage.?limit|usage.?limit|500|502|503|504|service.?unavailable|server error|internal error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay|network.?(?:is\s+)?unavailable|credentials.*expired|temporarily backed off/i.test(
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
 * For rate-limit errors with a known reset delay, schedules an automatic
 * resume after the delay and shows a countdown notification. For all other
 * errors, pauses indefinitely (user must manually resume).
 */
export async function pauseAutoForProviderError(
  ui: ProviderErrorPauseUI,
  errorDetail: string,
  pause: () => Promise<void>,
  options?: {
    isRateLimit?: boolean;
    retryAfterMs?: number;
    resume?: () => void;
  },
): Promise<void> {
  if (options?.isRateLimit && options.retryAfterMs && options.retryAfterMs > 0 && options.resume) {
    const delaySec = Math.ceil(options.retryAfterMs / 1000);
    ui.notify(
      `Rate limited${errorDetail}. Auto-resuming in ${delaySec}s...`,
      "warning",
    );
    await pause();

    // Schedule auto-resume after the rate limit window
    setTimeout(() => {
      ui.notify("Rate limit window elapsed. Resuming auto-mode.", "info");
      options.resume!();
    }, options.retryAfterMs);
  } else {
    ui.notify(`Auto-mode paused due to provider error${errorDetail}`, "warning");
    await pause();
  }
}
