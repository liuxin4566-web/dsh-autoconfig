/**
 * Terminal appearance preferences (per browser, persisted in localStorage).
 *
 * The terminal page defaults to a pure black background as requested; the user
 * can pick any color from the toolbar. Chrome (toolbar/log bar) keeps following
 * the DSH host theme, while the terminal itself gets a contrasting foreground
 * derived from the chosen background.
 */
import { isLightBackground } from "./highlight.js";

export const DEFAULT_TERMINAL_BACKGROUND = "#000000";
export const TERMINAL_BG_KEY = "dsh-autoconfig.terminal-background";
export const HIGHLIGHT_KEY = "dsh-autoconfig.keyword-highlight";

function safeGet(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {}
}

/** Normalize #rgb/#rrggbb; invalid values fall back to the black default. */
export function normalizeTerminalBackground(value) {
  const text = String(value ?? "").trim();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short !== null) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  }
  const full = /^#?([0-9a-f]{6})$/i.exec(text);
  if (full !== null) return `#${full[1].toLowerCase()}`;
  return DEFAULT_TERMINAL_BACKGROUND;
}

export function getTerminalBackground() {
  return normalizeTerminalBackground(safeGet(TERMINAL_BG_KEY) ?? DEFAULT_TERMINAL_BACKGROUND);
}

export function setTerminalBackground(color) {
  const normalized = normalizeTerminalBackground(color);
  safeSet(TERMINAL_BG_KEY, normalized);
  return normalized;
}

export function getHighlightEnabled() {
  const stored = safeGet(HIGHLIGHT_KEY);
  return stored === null ? true : stored !== "0";
}

export function setHighlightEnabled(enabled) {
  safeSet(HIGHLIGHT_KEY, enabled ? "1" : "0");
  return enabled === true;
}

/** Full xterm palette for one background, choosing a readable foreground. */
export function terminalThemeFor(background = DEFAULT_TERMINAL_BACKGROUND) {
  const normalized = normalizeTerminalBackground(background);
  const light = isLightBackground(normalized);
  return Object.freeze({
    background: normalized,
    foreground: light ? "#1d2128" : "#e6edf3",
    cursor: light ? "#1d2128" : "#e6edf3",
    cursorAccent: normalized,
    selectionBackground: light ? "#b9d5ff" : "#315a92",
    selectionForeground: light ? "#111827" : "#ffffff"
  });
}

export function terminalBackgroundIsLight(background) {
  return isLightBackground(normalizeTerminalBackground(background));
}
