import test from "node:test";
import assert from "node:assert/strict";

import {
  HIGHLIGHT_RULES,
  createTerminalHighlighter,
  highlightLine,
  isLightBackground
} from "../src/client/highlight.js";
import {
  DEFAULT_TERMINAL_BACKGROUND,
  normalizeTerminalBackground,
  terminalThemeFor
} from "../src/client/appearance.js";

const BG = "#000000";

test("all colorful-network rules compile", () => {
  assert.equal(HIGHLIGHT_RULES.length, 22);
});

test("interfaces, IPs, link state and protocols are decorated", () => {
  const line = "GigabitEthernet0/1 10.0.0.1/24 is up, line protocol is up";
  const output = highlightLine(line, BG);
  assert.ok(output.startsWith("\x1b[38;2;"));
  assert.ok(output.includes("GigabitEthernet0/1"));
  assert.ok(output.includes("10.0.0.1/24"));
  // "up" appears twice and is green; the interface/IP rule is the orange group.
  assert.ok((output.match(/\x1b\[38;2;255;128;0m/g) ?? []).length >= 2);
  assert.ok(output.includes("\x1b[0m"));
  assert.ok(output.endsWith("\n") === false);
});

test("keyword fragments inside larger words are not highlighted", () => {
  const usage = highlightLine("Usage: show interface", BG);
  assert.equal((usage.match(/\x1b\[38;2;/g) ?? []).length, 1, usage); // "interface" only
  assert.ok(!usage.includes("\x1b[38;2;255;128;0mge"));

  const canonical = highlightLine("Canonical address", BG);
  assert.ok(!canonical.includes("\x1b[38;2;255;0;0mno"));

  // Standalone words still match.
  const standalone = highlightLine("no shutdown", BG);
  assert.ok(standalone.includes("\x1b[38;2;255;0;0mno"));
});

test("matching is case-insensitive and down/error is red", () => {
  const output = highlightLine("INTERFACE DOWN, ERROR-DISABLED", BG);
  assert.ok(output.includes("\x1b[38;2;255;0;0m"));
  assert.ok(output.includes("DOWN"));
  assert.ok(output.includes("ERROR"));
});

test("percentage bands pick red for 100% and magenta for 50%", () => {
  const hundred = highlightLine("CPU 100%", BG);
  assert.ok(hundred.includes("\x1b[38;2;255;0;0m"));
  const fifty = highlightLine("CPU 50%", BG);
  assert.ok(fifty.includes("\x1b[38;2;255;0;255m"));
  const twenty = highlightLine("CPU 20%", BG);
  assert.ok(twenty.includes("\x1b[38;2;0;255;0m"));
});

test("ANSI-colored lines pass through untouched", () => {
  const line = "\x1b[31mdown\x1b[0m\n";
  assert.equal(highlightLine(line, BG), line);
});

test("light backgrounds get darkened highlight colors", () => {
  const dark = highlightLine("down", "#000000");
  const light = highlightLine("down", "#ffffff");
  assert.ok(dark.includes("\x1b[38;2;255;0;0m"));
  assert.ok(!light.includes("\x1b[38;2;255;0;0m"));
  assert.ok(isLightBackground("#ffffff"));
  assert.equal(isLightBackground("#000000"), false);
});

test("chunk highlighter decorates complete lines and buffers the incomplete tail", () => {
  const highlighter = createTerminalHighlighter(() => ({ enabled: true, background: BG }));
  const output = highlighter.transform("down\nincomplete tail");
  assert.ok(output.includes("\x1b[38;2;255;0;0m"));
  assert.equal(output.endsWith("incomplete tail"), false);
  assert.equal(highlighter.flush(), "incomplete tail");
  assert.equal(highlighter.transform("down\n"), highlightLine("down\n", BG));
});

test("highlighting can be disabled", () => {
  const highlighter = createTerminalHighlighter(() => ({ enabled: false, background: BG }));
  assert.equal(highlighter.transform("down\n"), "down\n");
});

test("terminal appearance defaults to black and flips contrast", () => {
  assert.equal(DEFAULT_TERMINAL_BACKGROUND, "#000000");
  assert.equal(normalizeTerminalBackground("zzzzzz"), "#000000");
  assert.equal(normalizeTerminalBackground("#ABC"), "#aabbcc");
  const darkTheme = terminalThemeFor("#000000");
  assert.equal(darkTheme.background, "#000000");
  assert.equal(darkTheme.foreground, "#e6edf3");
  const lightTheme = terminalThemeFor("#ffffff");
  assert.equal(lightTheme.foreground, "#1d2128");
});
