import * as React from "react";
import { XtermView, applyTerminalBackground } from "./XtermView.jsx";
import {
  getTerminalBackground,
  setTerminalBackground,
  getHighlightEnabled,
  setHighlightEnabled
} from "./appearance.js";
import { SftpBrowser } from "./SftpBrowser.jsx";
import { ConnectDialog } from "./ConnectDialog.jsx";
import { LogsDialog } from "./LogsDialog.jsx";
import { SessionBar } from "./SessionBar.jsx";
import { getTerminalTheme } from "./terminal-theme.js";
import { applyTheme } from "./styles.js";

const { useCallback, useEffect, useRef, useState } = React;

const PROTOCOL_LABEL = { ssh: "SSH", telnet: "Telnet", console: "Console", sftp: "SFTP" };

function supportsFiles(connection) {
  return connection?.protocol === "ssh" || connection?.protocol === "sftp";
}

function statusText(connection) {
  if (!connection) return "";
  if (connection.status === "open") return "已连接";
  if (connection.status === "connecting") return "连接中";
  if (connection.status === "error") return "连接失败";
  return "已关闭";
}

export function AutoconfigPanel({ api }) {
  const [connections, setConnections] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [logDir, setLogDir] = useState("");
  const [view, setView] = useState("terminal");
  const [dismissed, setDismissed] = useState([]);
  const [dialogProtocol, setDialogProtocol] = useState(null);
  const [dialogProfile, setDialogProfile] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [logsOpen, setLogsOpen] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [termBackground, setTermBackground] = useState(() => getTerminalBackground());
  const [highlight, setHighlight] = useState(() => getHighlightEnabled());
  const pollRef = useRef(null);
  const hostActiveRef = useRef(null);

  const changeBackground = (value) => {
    const next = setTerminalBackground(value);
    setTermBackground(next);
    applyTerminalBackground(next);
  };

  const toggleHighlight = () => {
    const next = !highlight;
    setHighlight(next);
    setHighlightEnabled(next);
  };

  // The panel can mount after the module-level theme watcher ran; apply the
  // host's current surface theme to this instance so dark terminals never put
  // dark text on a dark panel.
  useEffect(() => {
    applyTheme(getTerminalTheme());
  }, []);

  const refresh = useCallback(async () => {
    try {
      const listed = await api.list();
      // The host keeps closed records for logs/agent history. A freshly mounted
      // panel (for example a new chat tab) must not resurrect them as ghost
      // "disconnected" terminal tabs.
      const visible = (listed.connections ?? []).filter((conn) =>
        !dismissed.includes(conn.connectionId) && conn.status !== "closed"
      );
      setConnections(visible);
      setLogDir(listed.logDir ?? "");
      setError(null);
      const hostActive = listed.activeConnectionId;
      if (hostActive && hostActive !== hostActiveRef.current && visible.some((conn) => conn.connectionId === hostActive)) {
        // A new agent-requested connection becomes the host's active one; follow
        // it so the operator sees the machine the model just started using.
        hostActiveRef.current = hostActive;
        setActiveId(hostActive);
      } else {
        setActiveId((current) => {
          if (current && visible.some((conn) => conn.connectionId === current)) return current;
          if (hostActive && visible.some((conn) => conn.connectionId === hostActive)) return hostActive;
          return visible[0]?.connectionId ?? null;
        });
      }
    } catch (refreshError) {
      setError(refreshError.message);
    }
  }, [api, dismissed]);

  useEffect(() => {
    void refresh();
    pollRef.current = setInterval(() => { void refresh(); }, 2000);
    return () => {
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const loadProfiles = useCallback(async () => {
    try {
      const listed = await api.profileList();
      setProfiles(Array.isArray(listed.profiles) ? listed.profiles : []);
    } catch {
      // Saved sessions are auxiliary; a host hiccup must not break the terminal.
    }
  }, [api]);

  useEffect(() => {
    void loadProfiles();
    const timer = setInterval(() => { void loadProfiles(); }, 5000);
    return () => clearInterval(timer);
  }, [loadProfiles]);

  const active = connections.find((conn) => conn.connectionId === activeId) ?? null;

  useEffect(() => {
    if (!active) return;
    setView(active.protocol === "sftp" ? "files" : "terminal");
    setError(null);
  }, [active?.connectionId]);

  const select = async (connectionId) => {
    setActiveId(connectionId);
    try {
      await api.select(connectionId);
    } catch {}
  };

  const close = async (connection) => {
    setDismissed((current) => [...current, connection.connectionId]);
    setConnections((current) => current.filter((entry) => entry.connectionId !== connection.connectionId));
    setActiveId((current) => (current === connection.connectionId ? null : current));
    try {
      await api.close(connection.connectionId);
    } catch (closeError) {
      setError(closeError.message);
    }
    void refresh();
  };

  const openProfile = async (profile) => {
    const existing = connections.find((conn) =>
      conn.status === "open"
      && conn.protocol === profile.protocol
      && (conn.host ?? "") === (profile.host ?? "")
      && (conn.port ?? "") === (profile.port ?? "")
      && (conn.username ?? "") === (profile.username ?? "")
    );
    if (existing) {
      await select(existing.connectionId);
      return;
    }
    if (profile.hasPassword) {
      try {
        const info = await api.profileConnect(profile.profileId);
        setDismissed((current) => current.filter((id) => id !== info.connectionId));
        setActiveId(info.connectionId);
        void refresh();
        void loadProfiles();
        return;
      } catch (openError) {
        setError(openError.message);
      }
    }
    setDialogProtocol(profile.protocol);
    setDialogProfile(profile);
  };

  const deleteProfile = async (profile) => {
    if (!globalThis.confirm?.(`删除会话「${profile.name}」？`)) return;
    try {
      await api.profileDelete(profile.profileId);
      setProfiles((current) => current.filter((entry) => entry.profileId !== profile.profileId));
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const copyLogPath = async () => {
    if (!active?.logFile) return;
    try {
      await navigator.clipboard.writeText(`${logDir}/${active.logFile}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="ac-root">
      <div className="ac-tabs" role="tablist" aria-label="设备终端">
        {connections.map((connection) => (
          <button
            key={connection.connectionId}
            type="button"
            className="ac-tab"
            data-active={connection.connectionId === activeId}
            onClick={() => void select(connection.connectionId)}
            title={`${connection.name} · ${PROTOCOL_LABEL[connection.protocol]} · ${statusText(connection)}`}
          >
            <span className="ac-dot" data-status={connection.status} />
            <span className="ac-tab-name">{connection.name}</span>
            <span className="ac-tab-close" role="button" tabIndex={0} aria-label={`关闭 ${connection.name}`} onClick={(event) => {
              event.stopPropagation();
              void close(connection);
            }}>×</span>
          </button>
        ))}
        <button type="button" className="ac-btn ac-add" onClick={() => { setDialogProfile(null); setDialogProtocol("ssh"); }} title="连接新设备">+ 连接</button>
      </div>

      {error && <div className="ac-error">{error}</div>}

      <div className="ac-body">
        <SessionBar
          profiles={profiles}
          activeConnection={active}
          collapsed={!sessionsOpen}
          onToggle={() => setSessionsOpen((current) => !current)}
          onOpen={(profile) => void openProfile(profile)}
          onDelete={(profile) => void deleteProfile(profile)}
          onNew={() => { setDialogProfile(null); setDialogProtocol("ssh"); }}
        />
        <div className="ac-main">
      {active ? (
        <>
          <div className="ac-toolbar">
            <span className="ac-badge">{PROTOCOL_LABEL[active.protocol]}</span>
            <div className="ac-identity">
              <div className="ac-identity-main">
                <div className="ac-identity-name">{active.name}{active.hostname && active.hostname !== active.name ? ` · ${active.hostname}` : ""}</div>
                <div className="ac-identity-sub">
                  {active.username ? `${active.username}@` : ""}{active.host ?? active.logFile ?? ""}{active.port ? `:${active.port}` : ""}
                  {active.ip && active.ip !== active.host ? ` · ${active.ip}` : ""}
                  {" · "}{statusText(active)}
                </div>
              </div>
            </div>
            <div className="ac-actions">
              {supportsFiles(active) && (
                <>
                  <button type="button" className="ac-btn" data-active={view === "terminal"} onClick={() => setView("terminal")}>终端</button>
                  <button type="button" className="ac-btn" data-active={view === "files"} onClick={() => setView("files")}>文件</button>
                </>
              )}
              <button type="button" className="ac-btn" onClick={() => changeBackground("#000000")} title="黑色背景（默认）">黑</button>
              <button type="button" className="ac-btn" onClick={() => changeBackground("#101820")} title="深蓝黑背景">深</button>
              <button type="button" className="ac-btn" onClick={() => changeBackground("#f7f8fa")} title="浅色背景">浅</button>
              <label className="ac-bg" title="自定义终端背景色">
                <input
                  className="ac-color"
                  type="color"
                  value={termBackground}
                  onChange={(event) => changeBackground(event.target.value)}
                  aria-label="终端背景色"
                />
              </label>
              <button
                type="button"
                className="ac-btn"
                data-active={highlight}
                onClick={toggleHighlight}
                title="按 colorful-network 规则高亮终端关键字"
              >高亮</button>
              <button type="button" className="ac-btn" onClick={() => setLogsOpen(true)}>日志</button>
              <button type="button" className="ac-btn" data-variant="danger" onClick={() => void close(active)} disabled={active.status !== "open"}>断开</button>
            </div>
          </div>
          <div className="ac-main-body">
            {view === "files" && supportsFiles(active) ? (
              <SftpBrowser api={api} connectionId={active.connectionId} />
            ) : (
              <XtermView
                api={api}
                connectionId={active.connectionId}
                readOnly={active.protocol === "sftp"}
                background={termBackground}
                highlight={highlight}
              />
            )}
          </div>
          <div className="ac-logbar">
            <span>自动记录</span>
            <span className="ac-logpath ac-mono" title={active.logFile ? `${logDir}\\${active.logFile}` : "未记录"}>{active.logFile ?? "未记录"}</span>
            <button type="button" className="ac-btn" onClick={() => void copyLogPath()} disabled={!active.logFile}>{copied ? "已复制" : "复制路径"}</button>
            <span style={{ marginLeft: "auto" }}>{active.ip ? `IP ${active.ip}` : ""}</span>
          </div>
        </>
      ) : (
        <div className="ac-empty">
          <h3>设备自动配置终端</h3>
          <p>支持 SSH、Telnet、串口 Console 与 SFTP。AI 的每一次连接、输入和文件操作都会显示在这里，并自动记录到按 <code>hostname_ip_时间.log</code> 命名的日志文件。</p>
          <div className="ac-proto-grid">
            <button type="button" className="ac-proto" onClick={() => setDialogProtocol("ssh")}><b>SSH</b><span>交互式 shell，支持旧设备 KEX</span></button>
            <button type="button" className="ac-proto" onClick={() => setDialogProtocol("telnet")}><b>Telnet</b><span>老设备带外管理，自动登录</span></button>
            <button type="button" className="ac-proto" onClick={() => setDialogProtocol("console")}><b>串口 Console</b><span>COM / ttyUSB，9600 8N1</span></button>
            <button type="button" className="ac-proto" onClick={() => setDialogProtocol("sftp")}><b>SFTP</b><span>配置/镜像上传下载</span></button>
          </div>
          <p style={{ fontSize: 11 }}>也可以直接在对话中让 AI 连接：<span className="ac-kbd">device_connect</span> → <span className="ac-kbd">device_send</span> → <span className="ac-kbd">device_read</span></p>
        </div>
      )}
        </div>
      </div>

      {dialogProtocol && (
        <ConnectDialog
          api={api}
          initialProtocol={dialogProtocol}
          initial={dialogProfile}
          onClose={() => { setDialogProtocol(null); setDialogProfile(null); }}
          onConnected={(info) => {
            setDialogProtocol(null);
            setDialogProfile(null);
            setDismissed((current) => current.filter((id) => id !== info.connectionId));
            setActiveId(info.connectionId);
            void refresh();
            void loadProfiles();
          }}
        />
      )}
      {logsOpen && <LogsDialog api={api} onClose={() => setLogsOpen(false)} />}
    </div>
  );
}
