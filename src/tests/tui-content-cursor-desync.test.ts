/**
 * Regression test for #3764: TUI input clears and jumps up after PR #3744.
 *
 * PR #3744 introduced contentCursorRow which diverged from the actual terminal
 * cursor position, causing computeLineDiff to compute wrong movement deltas.
 * The fix reverts to using hardwareCursorRow (actual cursor position) as the
 * baseline for all cursor movement calculations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, TUI, type Component, type Terminal } from "@gsd/pi-tui";

class MockTTYTerminal implements Terminal {
  public writtenData: string[] = [];

  readonly isTTY = true;

  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

  write(data: string): void {
    this.writtenData.push(data);
  }

  get columns(): number {
    return 80;
  }

  get rows(): number {
    return 24;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
}

class DynamicLinesComponent implements Component {
  public lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  render(_width: number): string[] {
    return this.lines;
  }

  invalidate(): void {}
}

describe("TUI cursor tracking regression (#3764)", () => {
  it("does not produce spurious cursor jumps when content changes after IME positioning", () => {
    const terminal = new MockTTYTerminal();
    const tui = new TUI(terminal, false);
    const component = new DynamicLinesComponent([
      "header",
      `input: hello${CURSOR_MARKER}`,
      "status line",
    ]);

    tui.addChild(component);
    (tui as any).doRender();

    // After first render, hardwareCursorRow is at IME position (row 1)
    assert.strictEqual(
      (tui as any).hardwareCursorRow,
      1,
      "hardwareCursorRow should be at IME cursor position (row 1)",
    );

    // Simulate typing — content changes on the same line
    terminal.writtenData = [];
    component.lines = [
      "header",
      `input: hello world${CURSOR_MARKER}`,
      "status line",
    ];

    (tui as any).doRender();

    assert.ok(terminal.writtenData.length >= 1, "typing should trigger a render");

    const buffer = terminal.writtenData[0];
    // Should not contain large upward jumps (3+ rows)
    const largeUpJump = buffer.match(/\x1b\[([3-9]|\d{2,})A/);
    assert.strictEqual(
      largeUpJump,
      null,
      `should not produce large upward cursor jumps, got: ${JSON.stringify(buffer)}`,
    );
  });

  it("hardwareCursorRow tracks actual terminal position through IME and shrink", () => {
    const terminal = new MockTTYTerminal();
    const tui = new TUI(terminal, false);
    const component = new DynamicLinesComponent([
      "line 1",
      `line 2${CURSOR_MARKER}`,
      "line 3",
      "line 4",
      "line 5",
    ]);

    tui.addChild(component);
    (tui as any).doRender();

    // After IME positioning, hardwareCursorRow is at CURSOR_MARKER line (row 1)
    assert.strictEqual(
      (tui as any).hardwareCursorRow,
      1,
      "hardwareCursorRow should be at IME position (row 1) after first render",
    );

    // Shrink content
    terminal.writtenData = [];
    component.lines = [
      "line 1",
      `line 2${CURSOR_MARKER}`,
      "line 3",
    ];

    (tui as any).doRender();

    // After shrink, hardwareCursorRow should be at IME position again
    assert.strictEqual(
      (tui as any).hardwareCursorRow,
      1,
      "hardwareCursorRow should be at IME position after shrink render",
    );
  });
});
