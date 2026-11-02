import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createTerminalPool } from "./terminal-pool.js";
import { terminalThemeFor, getTerminalBackground } from "./appearance.js";
import { createTerminalHighlighter } from "./highlight.js";
import { ensureAutoconfigStyles } from "./styles.js";

const { useEffect, useRef, useState } = React;

const terminalPool = createTerminalPool({
  create: () => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: 'Menlo, Monaco, "Cascadia Mono", "Courier New", monospace',
      scrollback: 6000,
      convertEol: true,
      theme: terminalThemeFor(getTerminalBackground())
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    return { term, fit };
  },
  max: 8
});

ensureAutoconfigStyles(terminalPool);

const NO_SESSION_NOTICE = "\r\n\x1b[31m[终端会话已失效：连接已关闭或 DSH 服务已重启。请重新连接设备。]\x1b[0m\r\n";
const EXIT_NOTICE = "\r\n\x1b[90m[session closed]\x1b[0m\r\n";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One xterm bound to one host connection. The terminal instance is pooled by
 * connection id, so switching tabs (which unmounts the panel body) never loses
 * scrollback. Host-side output written while no view is attached is replayed on
 * reattach from the journal offset.
 */
export function XtermView({
  api,
  connectionId,
  readOnly = false,
  background = getTerminalBackground(),
  highlight = true
}) {
  const containerRef = useRef(null);
  const entryRef = useRef(null);
  const appearanceRef = useRef({ background, highlight });
  appearanceRef.current = { background, highlight };
  const highlighterRef = useRef(null);
  if (highlighterRef.current === null) {
    highlighterRef.current = createTerminalHighlighter(() => ({
      enabled: appearanceRef.current.highlight,
      background: appearanceRef.current.background
    }));
  }
  const [closed, setClosed] = useState(() => terminalPool.get(connectionId)?.closed ?? false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const owner = { connectionId };
    const entry = terminalPool.acquire(connectionId, owner);
    entryRef.current = entry;
    const term = entry.term;
    const fit = entry.fit;
    setClosed(terminalPool.get(connectionId)?.closed ?? false);

    if (entry.reused && term.element) {
      if (term.element.parentElement !== container) container.appendChild(term.element);
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {}
    } else {
      term.open(container);
    }
    if (!readOnly) {
      setTimeout(() => {
        try {
          term.focus();
        } catch {}
      }, 0);
    }

    let alive = true;
    let writing = false;
    let pending = "";
    const MAX_PENDING = 64 * 1024;

    const flushInput = () => {
      if (!alive || writing || pending.length === 0) return;
      const data = pending;
      pending = "";
      writing = true;
      api.write(connectionId, data).catch(() => {}).finally(() => {
        writing = false;
        flushInput();
      });
    };
    const onData = (data) => {
      if (!alive) return;
      if (pending.length + data.length > MAX_PENDING) return;
      pending += data;
      flushInput();
    };
    const inputSubscription = readOnly ? null : term.onData(onData);

    const controller = new AbortController();
    const markClosed = () => {
      terminalPool.setClosed(connectionId, true);
      setClosed(true);
    };

    const showItem = ({ data, exit, startOffset, offset }) => {
      const fresh = entry.consume(data ?? "", startOffset, offset);
      if (fresh) term.write(highlighterRef.current.transform(fresh));
      if (exit !== null && exit !== undefined) {
        markClosed();
        term.write(EXIT_NOTICE);
        return true;
      }
      return false;
    };

    const backoff = async (step) => {
      await sleep(Math.min(4000, 500 * 2 ** step));
    };

    const streamLoop = async () => {
      let errorBackoff = 0;
      while (alive) {
        const stream = await api.streamTerminal(connectionId, controller.signal, entry.offset);
        if (!stream) return false;
        try {
          for await (const item of stream) {
            if (!alive) return true;
            errorBackoff = 0;
            if (showItem(item)) return true;
          }
        } catch (error) {
          if (!alive) return true;
          if (error?.code === "no-session") {
            markClosed();
            term.write(NO_SESSION_NOTICE);
            return true;
          }
        }
        if (!alive) return true;
        await backoff(errorBackoff++);
      }
      return true;
    };

    const pollLoop = async () => {
      let errorBackoff = 0;
      while (alive) {
        try {
          const item = await api.read(connectionId, 300, entry.offset);
          if (!alive) return;
          errorBackoff = 0;
          if (showItem(item)) return;
        } catch (error) {
          if (!alive) return;
          if (error?.code === "no-session") {
            markClosed();
            term.write(NO_SESSION_NOTICE);
            return;
          }
          await backoff(errorBackoff++);
        }
      }
    };

    void (async () => {
      const handled = await streamLoop();
      if (!handled && alive) await pollLoop();
    })();

    let lastCols = 0;
    let lastRows = 0;
    const fitNow = () => {
      if (!alive) return;
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0 && (term.cols !== lastCols || term.rows !== lastRows)) {
          lastCols = term.cols;
          lastRows = term.rows;
          api.resize(connectionId, term.cols, term.rows).catch(() => {});
        }
      } catch {}
    };
    const raf = requestAnimationFrame(fitNow);
    const observer = new ResizeObserver(fitNow);
    observer.observe(container);

    return () => {
      alive = false;
      controller.abort();
      cancelAnimationFrame(raf);
      observer.disconnect();
      pending = "";
      inputSubscription?.dispose();
      entryRef.current = null;
      terminalPool.release(connectionId, owner);
    };
  }, [api, connectionId, readOnly]);

  // Repaint this terminal immediately when the user picks another background.
  useEffect(() => {
    const entry = entryRef.current;
    if (entry === null) return;
    entry.term.options.theme = terminalThemeFor(background);
    try {
      entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
    } catch {}
  }, [background]);

  return (
    <div className="ac-terminal-wrap" data-closed={closed || undefined} style={{ background }}>
      <div className="ac-xterm" ref={containerRef} />
    </div>
  );
}

/** Update every pooled terminal (background changes affect all connections). */
export function applyTerminalBackground(background) {
  const theme = terminalThemeFor(background);
  terminalPool.forEachTerm((term) => {
    term.options.theme = theme;
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {}
  });
}

export function disposeAutoconfigTerminals() {
  terminalPool.disposeAll();
}
