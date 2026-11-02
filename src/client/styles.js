/**
 * Styles for the autoconfig panel. xterm's own stylesheet is injected from the
 * generated module; everything else is a single scoped stylesheet built on the
 * host theme tokens with safe fallbacks.
 */
import { XTERM_CSS } from "./xterm-css.js";
import { createTerminalThemeWatcher, getTerminalTheme } from "./terminal-theme.js";

let injected = false;
let stopWatcher = null;

const PANEL_CSS = `
.ac-root {
  --ac-bg: #101418;
  --ac-surface: #161b21;
  --ac-surface-2: #1a1f26;
  --ac-border: #2c333d;
  --ac-text: #e6edf3;
  --ac-muted: #8b93a1;
  --ac-accent: #4d8dff;
  --ac-accent-soft: rgba(77, 141, 255, 0.14);
  --ac-danger: #f06464;
  --ac-ok: #46c07a;
  --ac-warn: #e0a84a;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: var(--ac-bg);
  color: var(--ac-text);
  font-size: 12.5px;
}
.ac-root[data-theme="light"] {
  --ac-bg: #f7f8fa;
  --ac-surface: #ffffff;
  --ac-surface-2: #eef1f5;
  --ac-border: #d9dee7;
  --ac-text: #1d2128;
  --ac-muted: #667085;
  --ac-accent: #2d6cdf;
  --ac-accent-soft: rgba(45, 108, 223, 0.12);
  --ac-danger: #c0392b;
  --ac-ok: #1f8f55;
  --ac-warn: #9a6700;
}
.ac-root * { box-sizing: border-box; }
.ac-tabs { display: flex; align-items: stretch; gap: 2px; padding: 6px 6px 0; overflow-x: auto; flex: 0 0 auto; border-bottom: 1px solid var(--ac-border); background: var(--ac-surface); scrollbar-width: thin; }
.ac-tab { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; padding: 6px 8px 7px; border: 1px solid transparent; border-bottom: none; border-radius: 7px 7px 0 0; background: transparent; color: var(--ac-muted); cursor: pointer; white-space: nowrap; font: inherit; }
.ac-tab:hover { background: var(--ac-surface-2); color: var(--ac-text); }
.ac-tab[data-active="true"] { background: var(--ac-bg); border-color: var(--ac-border); color: var(--ac-text); }
.ac-tab .ac-tab-name { overflow: hidden; text-overflow: ellipsis; }
.ac-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--ac-muted); }
.ac-dot[data-status="open"] { background: var(--ac-ok); }
.ac-dot[data-status="connecting"] { background: var(--ac-warn); }
.ac-dot[data-status="closed"], .ac-dot[data-status="error"] { background: var(--ac-danger); }
.ac-tab-close { border: none; background: transparent; color: inherit; opacity: .55; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; }
.ac-tab-close:hover { opacity: 1; color: var(--ac-danger); }
.ac-add { margin-left: auto; align-self: center; flex: 0 0 auto; }
.ac-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 9px; border-bottom: 1px solid var(--ac-border); background: var(--ac-surface); flex: 0 0 auto; }
.ac-badge { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px; background: var(--ac-accent-soft); color: var(--ac-accent); font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; }
.ac-badge[data-tone="danger"] { background: rgba(240,100,100,.14); color: var(--ac-danger); }
.ac-badge[data-tone="ok"] { background: rgba(70,192,122,.14); color: var(--ac-ok); }
.ac-identity { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 260px; }
.ac-identity-main { min-width: 0; }
.ac-identity-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-identity-sub { color: var(--ac-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ac-btn { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border: 1px solid var(--ac-border); border-radius: 6px; background: var(--ac-surface-2); color: var(--ac-text); cursor: pointer; font: inherit; white-space: nowrap; }
.ac-btn:hover { border-color: var(--ac-accent); }
.ac-btn[data-active="true"] { border-color: var(--ac-accent); background: var(--ac-accent-soft); color: var(--ac-accent); }
.ac-btn[data-variant="primary"] { background: var(--ac-accent); border-color: var(--ac-accent); color: #fff; font-weight: 600; }
.ac-btn[data-variant="danger"] { color: var(--ac-danger); }
.ac-btn:disabled { opacity: .5; cursor: default; }
.ac-bg { display: inline-flex; align-items: center; gap: 5px; color: var(--ac-muted); font-size: 11px; }
.ac-color { width: 27px; height: 24px; padding: 0; border: 1px solid var(--ac-border); border-radius: 5px; background: transparent; cursor: pointer; }
.ac-color::-webkit-color-swatch-wrapper { padding: 2px; }
.ac-color::-webkit-color-swatch { border: none; border-radius: 3px; }
.ac-body { flex: 1 1 auto; min-height: 0; display: flex; min-width: 0; }
.ac-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.ac-main-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.ac-sessions { flex: 0 0 212px; width: 212px; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--ac-border); background: var(--ac-surface); }
.ac-sessions[data-collapsed="true"] { flex-basis: 34px; width: 34px; }
.ac-sessions-head { display: flex; align-items: center; gap: 5px; padding: 7px 8px; border-bottom: 1px solid var(--ac-border); flex: 0 0 auto; }
.ac-sessions-title { font-weight: 600; }
.ac-sessions-count { color: var(--ac-muted); font-size: 11px; }
.ac-sessions-icon { margin-left: auto; border: none; background: transparent; color: var(--ac-muted); cursor: pointer; font: inherit; padding: 0 3px; }
.ac-sessions-icon:hover { color: var(--ac-text); }
.ac-sessions-icon + .ac-sessions-icon { margin-left: 0; }
.ac-sessions-list { flex: 1 1 auto; min-height: 0; overflow: auto; }
.ac-sessions-empty { padding: 16px 10px; color: var(--ac-muted); font-size: 11px; line-height: 1.6; text-align: center; }
.ac-sessions-expand { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 100%; padding: 10px 0; border: none; background: transparent; color: var(--ac-muted); cursor: pointer; font: inherit; }
.ac-sessions-expand:hover { color: var(--ac-text); }
.ac-sessions-expand > span:first-child { writing-mode: vertical-rl; letter-spacing: .12em; }
.ac-session { display: flex; align-items: center; gap: 6px; padding: 6px 7px; border-bottom: 1px solid var(--ac-border); cursor: default; user-select: none; }
.ac-session:hover { background: var(--ac-surface-2); }
.ac-session[data-active="true"] { background: var(--ac-accent-soft); }
.ac-session-proto { flex: 0 0 auto; padding: 1px 4px; border-radius: 3px; background: var(--ac-bg); color: var(--ac-accent); font-size: 9px; font-weight: 700; letter-spacing: .04em; }
.ac-session-main { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; }
.ac-session-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.ac-session-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ac-muted); font-size: 10.5px; }
.ac-session-lock { flex: 0 0 auto; color: var(--ac-muted); font-size: 9px; }
.ac-session-lock[data-saved="true"] { color: var(--ac-ok); }
.ac-session-del { flex: 0 0 auto; border: none; background: transparent; color: var(--ac-muted); cursor: pointer; padding: 0 2px; opacity: 0; font-size: 14px; line-height: 1; }
.ac-session:hover .ac-session-del { opacity: .8; }
.ac-session-del:hover { color: var(--ac-danger); opacity: 1; }
.ac-terminal-wrap { flex: 1 1 auto; min-height: 0; padding: 5px 6px 6px; background: var(--ac-bg); }
.ac-xterm { width: 100%; height: 100%; min-height: 0; }
.ac-xterm .xterm { height: 100%; padding: 2px 0 0 3px; }
.ac-xterm .xterm .xterm-viewport { background: transparent !important; }
.ac-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 28px; text-align: center; color: var(--ac-muted); }
.ac-empty h3 { margin: 0; color: var(--ac-text); font-size: 15px; }
.ac-empty p { margin: 0; max-width: 520px; line-height: 1.6; }
.ac-empty code { color: var(--ac-text); background: var(--ac-surface-2); border: 1px solid var(--ac-border); border-radius: 4px; padding: 1px 5px; }
.ac-proto-grid { display: grid; grid-template-columns: repeat(2, minmax(140px, 1fr)); gap: 8px; width: min(460px, 100%); }
.ac-proto { text-align: left; padding: 10px; border: 1px solid var(--ac-border); border-radius: 8px; background: var(--ac-surface); color: var(--ac-text); cursor: pointer; font: inherit; }
.ac-proto:hover { border-color: var(--ac-accent); }
.ac-proto b { display: block; margin-bottom: 3px; }
.ac-proto span { color: var(--ac-muted); font-size: 11px; line-height: 1.4; }
.ac-error { margin: 8px 9px 0; padding: 7px 9px; border: 1px solid rgba(240,100,100,.45); border-radius: 6px; background: rgba(240,100,100,.1); color: var(--ac-danger); white-space: pre-wrap; }
.ac-notice { margin: 6px 9px 0; padding: 6px 9px; border: 1px solid var(--ac-border); border-radius: 6px; background: var(--ac-surface); color: var(--ac-muted); }
.ac-logbar { display: flex; align-items: center; gap: 8px; padding: 5px 9px; border-top: 1px solid var(--ac-border); background: var(--ac-surface); color: var(--ac-muted); font-size: 11px; flex: 0 0 auto; overflow: hidden; }
.ac-logbar .ac-logpath { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.ac-modal-backdrop { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); padding: 20px; }
.ac-modal { width: min(720px, 96vw); max-height: 90vh; display: flex; flex-direction: column; border: 1px solid var(--ac-border); border-radius: 10px; background: var(--ac-bg); color: var(--ac-text); box-shadow: 0 18px 60px rgba(0,0,0,.4); overflow: hidden; }
.ac-modal-head { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border-bottom: 1px solid var(--ac-border); background: var(--ac-surface); }
.ac-modal-head h3 { margin: 0; font-size: 14px; flex: 1; }
.ac-modal-body { padding: 12px 14px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.ac-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--ac-border); background: var(--ac-surface); }
.ac-proto-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.ac-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px 12px; }
.ac-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ac-field[data-span="2"] { grid-column: span 2; }
.ac-field > label { color: var(--ac-muted); font-size: 11px; }
.ac-field .ac-hint { color: var(--ac-muted); font-size: 11px; line-height: 1.45; }
.ac-input, .ac-select, .ac-textarea { width: 100%; padding: 6px 8px; border: 1px solid var(--ac-border); border-radius: 6px; background: var(--ac-surface); color: var(--ac-text); font: inherit; outline: none; }
.ac-input:focus, .ac-select:focus, .ac-textarea:focus { border-color: var(--ac-accent); }
.ac-textarea { min-height: 78px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.ac-check { display: flex; align-items: center; gap: 7px; color: var(--ac-text); font-size: 12px; cursor: pointer; }
.ac-check input { accent-color: var(--ac-accent); }
.ac-form-error { padding: 7px 9px; border: 1px solid rgba(240,100,100,.45); border-radius: 6px; background: rgba(240,100,100,.1); color: var(--ac-danger); white-space: pre-wrap; }
.ac-sftp { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--ac-bg); }
.ac-sftp-toolbar { display: flex; gap: 6px; align-items: center; padding: 7px 9px; border-bottom: 1px solid var(--ac-border); background: var(--ac-surface); flex-wrap: wrap; }
.ac-sftp-path { flex: 1; min-width: 160px; }
.ac-sftp-table-wrap { flex: 1; min-height: 0; overflow: auto; }
.ac-sftp-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.ac-sftp-table th, .ac-sftp-table td { padding: 4px 8px; border-bottom: 1px solid var(--ac-border); text-align: left; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-sftp-table th { position: sticky; top: 0; z-index: 1; background: var(--ac-surface); color: var(--ac-muted); font-weight: 500; }
.ac-sftp-table tbody tr { cursor: default; }
.ac-sftp-table tbody tr:hover { background: var(--ac-surface-2); }
.ac-sftp-table tbody tr[data-selected="true"] { background: var(--ac-accent-soft); }
.ac-sftp-name { display: flex; align-items: center; gap: 6px; }
.ac-sftp-name button { border: none; background: transparent; color: inherit; padding: 0; cursor: pointer; font: inherit; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-sftp-name button:hover { color: var(--ac-accent); text-decoration: underline; }
.ac-sftp-empty { padding: 24px; text-align: center; color: var(--ac-muted); }
.ac-log-list { width: 100%; border-collapse: collapse; }
.ac-log-list th, .ac-log-list td { padding: 5px 7px; border-bottom: 1px solid var(--ac-border); text-align: left; font-size: 12px; }
.ac-log-list th { color: var(--ac-muted); font-weight: 500; position: sticky; top: 0; background: var(--ac-surface); }
.ac-log-list tbody tr { cursor: pointer; }
.ac-log-list tbody tr:hover { background: var(--ac-surface-2); }
.ac-log-preview { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.45; max-height: 260px; overflow: auto; background: var(--ac-surface); border: 1px solid var(--ac-border); border-radius: 6px; padding: 8px; }
.ac-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ac-kbd { display: inline-block; padding: 0 4px; border: 1px solid var(--ac-border); border-bottom-width: 2px; border-radius: 4px; background: var(--ac-surface-2); font-size: 11px; }
`;

/** Keep xterm and the panel palette in step with the host theme. */
export function applyTheme(theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.dshAutoconfigTheme = theme.background === "#f7f8fa" ? "light" : "dark";
  for (const panel of document.querySelectorAll(".ac-root")) {
    panel.dataset.theme = theme.background === "#f7f8fa" ? "light" : "dark";
  }
}

export function ensureAutoconfigStyles(termPool) {
  if (typeof document === "undefined") return;
  if (!injected) {
    injected = true;
    const style = document.createElement("style");
    style.dataset.dshAutoconfig = "true";
    style.textContent = XTERM_CSS + PANEL_CSS;
    document.head.appendChild(style);
  }
  if (termPool && stopWatcher === null) {
    stopWatcher = createTerminalThemeWatcher({
      // Only the panel chrome follows the host theme. The terminal keeps the
      // user's chosen background (black by default) and a contrasting palette.
      apply: (theme) => applyTheme(theme)
    });
    applyTheme(getTerminalTheme());
  }
}
