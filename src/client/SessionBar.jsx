import * as React from "react";

const PROTOCOL_SHORT = { ssh: "SSH", telnet: "TEL", console: "COM", sftp: "SFTP" };

function sameTarget(profile, connection) {
  if (!profile || !connection) return false;
  return profile.protocol === connection.protocol
    && (profile.host ?? "") === (connection.host ?? "")
    && (profile.port ?? "") === (connection.port ?? "")
    && (profile.username ?? "") === (connection.username ?? "");
}

/**
 * MobaXterm/SecureCRT-style session rail inside the terminal pane. A saved
 * session is a coordinate record (password lives in DSH's credential store);
 * double-click reconnects it, and a lock dot tells the operator whether the
 * password is already available.
 */
export function SessionBar({ profiles, activeConnection, collapsed, onToggle, onOpen, onDelete, onNew }) {
  if (collapsed) {
    return (
      <aside className="ac-sessions" data-collapsed="true">
        <button type="button" className="ac-sessions-expand" onClick={onToggle} title="展开会话栏">
          <span>会话</span>
          <span className="ac-sessions-count">{profiles.length}</span>
          <span aria-hidden="true">›</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="ac-sessions">
      <div className="ac-sessions-head">
        <span className="ac-sessions-title">会话</span>
        <span className="ac-sessions-count">{profiles.length}</span>
        <button type="button" className="ac-sessions-icon" onClick={onNew} title="新建连接">＋</button>
        <button type="button" className="ac-sessions-icon" onClick={onToggle} title="收起会话栏">‹</button>
      </div>
      <div className="ac-sessions-list">
        {profiles.length === 0 && (
          <div className="ac-sessions-empty">
            连接过的设备会保存在这里。
            <br />
            双击有密码的会话即可直连。
          </div>
        )}
        {profiles.map((profile) => (
          <div
            key={profile.profileId}
            className="ac-session"
            data-active={sameTarget(profile, activeConnection) || undefined}
            role="button"
            tabIndex={0}
            title={`${profile.name || profile.host || profile.serial?.path || ""}\n双击连接${profile.hasPassword ? "（已保存密码）" : "（会要求填写密码）"}`}
            onDoubleClick={() => onOpen(profile)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(profile);
              }
            }}
          >
            <span className="ac-session-proto">{PROTOCOL_SHORT[profile.protocol] ?? profile.protocol}</span>
            <span className="ac-session-main">
              <span className="ac-session-name">{profile.name || profile.host || profile.serial?.path}</span>
              <span className="ac-session-sub">
                {profile.username ? `${profile.username}@` : ""}
                {profile.host ?? profile.serial?.path ?? ""}
                {profile.port ? `:${profile.port}` : ""}
              </span>
            </span>
            <span
              className="ac-session-lock"
              data-saved={profile.hasPassword || undefined}
              title={profile.hasPassword ? "已保存密码，双击直连" : "未保存密码，双击后填写"}
            >{profile.hasPassword ? "●" : "○"}</span>
            <button
              type="button"
              className="ac-session-del"
              title="删除会话"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(profile);
              }}
            >×</button>
          </div>
        ))}
      </div>
    </aside>
  );
}
