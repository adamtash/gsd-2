import test from "node:test";
import assert from "node:assert/strict";

import { isRetryableProviderErrorDetail, maybePauseAutoForProviderError, pauseAutoForProviderError } from "../provider-error-pause.ts";

test("isRetryableProviderErrorDetail detects rate-limit/provider retry errors", () => {
  assert.equal(
    isRetryableProviderErrorDetail(': 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}'),
    true,
  );
  assert.equal(isRetryableProviderErrorDetail(": terminated"), true);
  assert.equal(isRetryableProviderErrorDetail(": invalid_api_key"), false);

  // Server errors
  assert.equal(isRetryableProviderErrorDetail(": 500 Internal Server Error"), true);
  assert.equal(isRetryableProviderErrorDetail(": 502 Bad Gateway"), true);
  assert.equal(isRetryableProviderErrorDetail(": 503 Service Unavailable"), true);
  assert.equal(isRetryableProviderErrorDetail(": 504 Gateway Timeout"), true);

  // Connection errors
  assert.equal(isRetryableProviderErrorDetail(": connection refused"), true);
  assert.equal(isRetryableProviderErrorDetail(": fetch failed"), true);
  assert.equal(isRetryableProviderErrorDetail(": network unavailable"), true);
  assert.equal(isRetryableProviderErrorDetail(": network is unavailable"), true);

  // Overload
  assert.equal(isRetryableProviderErrorDetail(": overloaded"), true);
  assert.equal(isRetryableProviderErrorDetail(": too many requests"), true);

  // Quota / usage exhaustion should still flow through retry-or-fallback
  assert.equal(isRetryableProviderErrorDetail(": You have hit your ChatGPT usage limit (team plan). Try again later."), true);
  assert.equal(isRetryableProviderErrorDetail(": usage limit exceeded"), true);
  assert.equal(isRetryableProviderErrorDetail(": billing quota exhausted"), true);

  // Backoff
  assert.equal(isRetryableProviderErrorDetail(": credentials temporarily backed off"), true);

  // Non-retryable
  assert.equal(isRetryableProviderErrorDetail(": invalid_api_key"), false);
  assert.equal(isRetryableProviderErrorDetail(": permission denied"), false);
  assert.equal(isRetryableProviderErrorDetail(""), false);
});

test("maybePauseAutoForProviderError does not pause on retryable 429 errors", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;

  const paused = await maybePauseAutoForProviderError(
    {
      notify(message, level?) {
        notifications.push({ message, level: level ?? "info" });
      },
    },
    ': 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    async () => {
      pauseCalls += 1;
    },
  );

  assert.equal(paused, false);
  assert.equal(pauseCalls, 0);
  assert.deepEqual(notifications, []);
});

test("maybePauseAutoForProviderError does not pause on usage-limit errors", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;

  const paused = await maybePauseAutoForProviderError(
    {
      notify(message, level?) {
        notifications.push({ message, level: level ?? "info" });
      },
    },
    ": Error: You have hit your ChatGPT usage limit (team plan). Try again in ~2206 min.",
    async () => {
      pauseCalls += 1;
    },
  );

  assert.equal(paused, false);
  assert.equal(pauseCalls, 0);
  assert.deepEqual(notifications, []);
});

test("pauseAutoForProviderError warns and pauses without requiring ctx.log", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;

  await pauseAutoForProviderError(
    {
      notify(message, level?) {
        notifications.push({ message, level: level ?? "info" });
      },
    },
    ": terminated",
    async () => {
      pauseCalls += 1;
    },
  );

  assert.equal(pauseCalls, 1, "should pause auto-mode exactly once");
  assert.deepEqual(notifications, [
    {
      message: "Auto-mode paused due to provider error: terminated",
      level: "warning",
    },
  ]);
});

test("pauseAutoForProviderError schedules auto-resume for rate limit errors", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;
  let resumeCalled = false;

  // Use fake timer
  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    timers.push({ fn, delay });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    await pauseAutoForProviderError(
      {
        notify(message, level?) {
          notifications.push({ message, level: level ?? "info" });
        },
      },
      ": rate limit exceeded",
      async () => {
        pauseCalls += 1;
      },
      {
        isRateLimit: true,
        retryAfterMs: 90000,
        resume: () => {
          resumeCalled = true;
        },
      },
    );

    assert.equal(pauseCalls, 1, "should pause auto-mode");
    assert.equal(timers.length, 1, "should schedule one timer");
    assert.equal(timers[0].delay, 90000, "timer should match retryAfterMs");
    assert.deepEqual(notifications[0], {
      message: "Rate limited: rate limit exceeded. Auto-resuming in 90s...",
      level: "warning",
    });

    // Fire the timer
    timers[0].fn();
    assert.equal(resumeCalled, true, "should call resume after timer fires");
    assert.deepEqual(notifications[1], {
      message: "Rate limit window elapsed. Resuming auto-mode.",
      level: "info",
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pauseAutoForProviderError falls back to indefinite pause when not rate limit", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;

  await pauseAutoForProviderError(
    {
      notify(message, level?) {
        notifications.push({ message, level: level ?? "info" });
      },
    },
    ": connection refused",
    async () => {
      pauseCalls += 1;
    },
    {
      isRateLimit: false,
    },
  );

  assert.equal(pauseCalls, 1);
  assert.deepEqual(notifications, [
    {
      message: "Auto-mode paused due to provider error: connection refused",
      level: "warning",
    },
  ]);
});
