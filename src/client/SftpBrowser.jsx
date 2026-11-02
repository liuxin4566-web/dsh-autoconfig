import * as React from "react";

const { useCallback, useEffect, useRef, useState } = React;

function joinRemote(base, name) {
  if (base === "" || base === ".") return name;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function modeText(mode) {
  const value = Number(mode) || 0;
  let out = (value & 0o170000) === 0o040000 ? "d" : "-";
  for (let shift = 6; shift >= 0; shift -= 3) {
    out += (value >> shift) & 4 ? "r" : "-";
    out += (value >> shift) & 2 ? "w" : "-";
    out += (value >> shift) & 1 ? "x" : "-";
  }
  return out;
}

export function SftpBrowser({ api, connectionId }) {
  const [path, setPath] = useState(".");
  const [pathInput, setPathInput] = useState(".");
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  const pathRef = useRef(".");

  const list = useCallback(async (target = path) => {
    setLoading(true);
    setError(null);
    try {
      const value = await api.sftpList(connectionId, target, true);
      if (!alive.current) return;
      setEntries(Array.isArray(value.entries) ? value.entries : []);
      const nextPath = value.path || target;
      pathRef.current = nextPath;
      setPath(nextPath);
      setPathInput(nextPath);
      setSelected(null);
    } catch (listError) {
      if (alive.current) setError(listError.message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [api, connectionId, path]);

  useEffect(() => {
    alive.current = true;
    pathRef.current = ".";
    void list(".");
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void list(pathRef.current);
    }, 3500);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [connectionId]);

  const open = (entry) => {
    if (!entry.isDirectory) return;
    const next = joinRemote(path, entry.name);
    setPath(next);
    void list(next);
  };

  const goUp = () => {
    if (path === "/" || path === ".") return;
    const next = path.replace(/\/+[^/]+\/?$/, "") || "/";
    setPath(next);
    void list(next);
  };

  const fullPath = (entry) => joinRemote(path, entry.name);

  const download = async (entry) => {
    if (!entry || entry.isDirectory) return;
    setError(null);
    setLoading(true);
    try {
      const value = await api.sftpReadFile(connectionId, fullPath(entry), 4 * 1024 * 1024);
      if (value.truncated) setError("文件超过 4 MB，仅下载了前 4 MB。");
      const blob = new Blob([value.bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = entry.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (downloadError) {
      setError(downloadError.message);
    } finally {
      setLoading(false);
    }
  };

  const upload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 16 * 1024 * 1024) {
        setError("单个文件上限 16 MB；更大的文件请用命令行或分片工具。");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        await api.sftpWriteFile(connectionId, joinRemote(path, file.name), buffer);
        await list(path);
      } catch (uploadError) {
        setError(uploadError.message);
      } finally {
        setLoading(false);
      }
    };
    input.click();
  };

  const mkdir = async () => {
    const name = globalThis.prompt?.("新建文件夹名称");
    if (!name) return;
    try {
      await api.sftpMkdir(connectionId, joinRemote(path, name.trim()));
      await list(path);
    } catch (mkdirError) {
      setError(mkdirError.message);
    }
  };

  const rename = async (entry) => {
    if (!entry) return;
    const name = globalThis.prompt?.("重命名为", entry.name);
    if (!name || name === entry.name) return;
    try {
      await api.sftpRename(connectionId, fullPath(entry), name.trim());
      await list(path);
    } catch (renameError) {
      setError(renameError.message);
    }
  };

  const remove = async (entry) => {
    if (!entry) return;
    if (!globalThis.confirm?.(`删除 ${fullPath(entry)}${entry.isDirectory ? "（空目录）" : ""}？此操作不可撤销。`)) return;
    try {
      await api.sftpDelete(connectionId, fullPath(entry));
      await list(path);
    } catch (removeError) {
      setError(removeError.message);
    }
  };

  return (
    <div className="ac-sftp">
      <div className="ac-sftp-toolbar">
        <button type="button" className="ac-btn" onClick={goUp} disabled={path === "/" || path === "."} title="上一级">↑</button>
        <input
          className="ac-input ac-sftp-path"
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setPath(pathInput);
              void list(pathInput);
            }
          }}
          aria-label="远程路径"
        />
        <button type="button" className="ac-btn" onClick={() => { setPath(pathInput); void list(pathInput); }}>前往</button>
        <button type="button" className="ac-btn" onClick={() => void list(path)} disabled={loading}>{loading ? "…" : "刷新"}</button>
        <button type="button" className="ac-btn" onClick={mkdir}>新建文件夹</button>
        <button type="button" className="ac-btn" onClick={upload}>上传</button>
        <button type="button" className="ac-btn" onClick={() => download(selected)} disabled={!selected || selected.isDirectory}>下载</button>
        <button type="button" className="ac-btn" onClick={() => rename(selected)} disabled={!selected}>重命名</button>
        <button type="button" className="ac-btn" data-variant="danger" onClick={() => remove(selected)} disabled={!selected}>删除</button>
      </div>
      {error && <div className="ac-error">{error}</div>}
      <div className="ac-sftp-table-wrap">
        <table className="ac-sftp-table">
          <colgroup>
            <col />
            <col style={{ width: 92 }} />
            <col style={{ width: 138 }} />
            <col style={{ width: 92 }} />
          </colgroup>
          <thead>
            <tr><th>名称</th><th>大小</th><th>修改时间</th><th>权限</th></tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr><td colSpan="4" className="ac-sftp-empty">{loading ? "读取目录…" : "空目录"}</td></tr>
            )}
            {entries.map((entry) => (
              <tr
                key={entry.name}
                data-selected={selected?.name === entry.name || undefined}
                onClick={() => setSelected(entry)}
                onDoubleClick={() => open(entry)}
              >
                <td>
                  <div className="ac-sftp-name">
                    <span aria-hidden="true">{entry.isDirectory ? "📁" : "📄"}</span>
                    <button type="button" onClick={(event) => { event.stopPropagation(); if (entry.isDirectory) open(entry); else setSelected(entry); }} title={entry.name}>
                      {entry.name}
                    </button>
                  </div>
                </td>
                <td>{entry.isDirectory ? "—" : formatSize(entry.size)}</td>
                <td>{formatTime(entry.mtime)}</td>
                <td className="ac-mono">{modeText(entry.mode)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
