// xterm renders to its own canvas. It cannot inherit DSH's CSS text color,
// so every terminal theme must provide the full contrast-critical palette.
const DARK_TERMINAL_THEME = Object.freeze({
  background: "#101418",
  foreground: "#e6edf3",
  cursor: "#e6edf3",
  cursorAccent: "#101418",
  selectionBackground: "#315a92",
  selectionForeground: "#ffffff"
});

const LIGHT_TERMINAL_THEME = Object.freeze({
  background: "#f7f8fa",
  foreground: "#1d2128",
  cursor: "#1d2128",
  cursorAccent: "#f7f8fa",
  selectionBackground: "#b9d5ff",
  selectionForeground: "#111827"
});

function parseColor(value) {
  const match = /rgba?\(([^)]+)\)/.exec(String(value ?? ""));
  if (!match) return null;
  const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const normalized = Math.max(0, Math.min(255, value)) / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * DSH does not always expose a theme marker on <html>/<body>; the rendered
 * surface background is the reliable signal. Read it before falling back to the
 * OS preference so terminal text never ends up dark-on-dark.
 */
function surfaceThemeHint(getComputedStyle, ...elements) {
  if (typeof getComputedStyle !== "function") return undefined;
  for (const element of elements) {
    if (!element) continue;
    const color = parseColor(getComputedStyle(element).backgroundColor);
    if (color !== null && color.a > 0.15) return relativeLuminance(color) < 0.45;
  }
  return undefined;
}

function rootThemeHint(root, computed) {
  const attributes = ["class", "data-theme", "data-color-scheme", "color-scheme"]
    .map((name) => root?.getAttribute?.(name) ?? "").join(" ").toLowerCase();
  if (/(^|[\s_-])(dark|night)(?=$|[\s_-])/.test(attributes)) return true;
  if (/(^|[\s_-])light(?=$|[\s_-])/.test(attributes)) return false;
  const colorScheme = String(computed?.colorScheme ?? "").toLowerCase();
  if (colorScheme.includes("dark")) return true;
  if (colorScheme.includes("light")) return false;
  return undefined;
}

/** Read the host's effective color preference with a safe dark fallback. */
export function getTerminalTheme({
  root = typeof document === "undefined" ? undefined : document.documentElement,
  body = typeof document === "undefined" ? undefined : document.body,
  getComputedStyle = typeof window === "undefined" ? undefined : window.getComputedStyle,
  media = typeof window === "undefined" ? undefined : window.matchMedia?.("(prefers-color-scheme: dark)")
} = {}) {
  const hint = rootThemeHint(root, root && getComputedStyle ? getComputedStyle(root) : undefined);
  const bodyHint = hint ?? rootThemeHint(body, body && getComputedStyle ? getComputedStyle(body) : undefined);
  const surfaceHint = bodyHint ?? surfaceThemeHint(getComputedStyle, body, root);
  return (surfaceHint ?? media?.matches ?? true) ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
}

/** Apply and immediately repaint an already-open xterm canvas. */
export function applyTerminalTheme(term, theme) {
  term.options.theme = theme;
  try { term.refresh(0, Math.max(0, (term.rows ?? 1) - 1)); } catch {}
}

/** Watch DSH's theme markers and the OS colour-scheme query. */
export function createTerminalThemeWatcher({
  root = typeof document === "undefined" ? undefined : document.documentElement,
  body = typeof document === "undefined" ? undefined : document.body,
  getComputedStyle = typeof window === "undefined" ? undefined : window.getComputedStyle,
  media = typeof window === "undefined" ? undefined : window.matchMedia?.("(prefers-color-scheme: dark)"),
  MutationObserver = typeof window === "undefined" ? undefined : window.MutationObserver,
  apply
} = {}) {
  const sync = () => apply?.(getTerminalTheme({ root, body, getComputedStyle, media }));
  sync();
  const observer = MutationObserver && root ? new MutationObserver(sync) : undefined;
  observer?.observe(root, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme", "color-scheme"] });
  if (body) observer?.observe(body, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme", "color-scheme"] });
  media?.addEventListener?.("change", sync);
  return () => {
    observer?.disconnect();
    media?.removeEventListener?.("change", sync);
  };
}
