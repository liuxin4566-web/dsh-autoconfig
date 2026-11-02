import * as React from "react";

const { useEffect, useState } = React;

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

export function LogsDialog({ api, onClose }) {
  const [dir, setDir] = useState("");
  const [logs, setLogs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const value = await api.logList();
      setDir(value.dir);
      setLogs(value.logs ?? []);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openLog = async (log) => {
    setSelected(log);
    setPreview("读取中…");
    try {
      const value = await api.logRead(log.file, 0, 64 * 1024);
      setPreview(value.text || "(空日志)");
    } catch (readError) {
      setPreview(`读取失败：${readError.message}`);
    }
  };

  const download = async (log) => {
    try {
      const chunks = [];
      let offset = 0;
      let total = 0;
      for (;;) {
        const value = await api.logRead(log.file, offset, 512 * 1024);
        chunks.push(value.text);
        total += value.text.length;
        offset = value.nextOffset;
        if (value.eof || total > 8 * 1024 * 1024) break;
      }
      if (total > 8 * 1024 * 1024) setError("日志超过 8 MB，仅下载了前 8 MB。");
      const blob = new Blob(chunks, { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = log.file;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (downloadError) {
      setError(downloadError.message);
    }
  };

  const remove = async (log) => {
    if (!globalThis.confirm?.(`删除日志 ${log.file}？`)) return;
    try {
      await api.logDelete(log.file);
      if (selected?.file === log.file) {
        setSelected(null);
        setPreview("");
      }
      await load();
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const copyDir = async () => {
    try {
      await navigator.clipboard.writeText(dir);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="ac-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="ac-modal" role="dialog" aria-modal="true" aria-label="会话日志">
        <div className="ac-modal-head">
          <h3>会话日志</h3>
          <button type="button" className="ac-tab-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="ac-modal-body">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="ac-hint" style={{ flex: 1, minWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={dir}>
              目录：<span className="ac-mono">{dir || "…"}</span>
            </span>
            <button type="button" className="ac-btn" onClick={() => void load()} disabled={busy}>{busy ? "…" : "刷新"}</button>
            <button type="button" className="ac-btn" onClick={() => void copyDir()}>{copied ? "已复制" : "复制目录"}</button>
          </div>
          {error && <div className="ac-form-error">{error}</div>}
          <div style={{ maxHeight: 280, overflow: "auto", border: "1px solid var(--ac-border)", borderRadius: 6 }}>
            <table className="ac-log-list">
              <thead>
                <tr><th>文件</th><th>时间</th><th>大小</th><th>操作</th></tr>
              </thead>
              <tbody>
                {logs.length === 0 && <tr><td colSpan="4" className="ac-sftp-empty">还没有日志；连接设备后会自动记录。</td></tr>}
                {logs.map((log) => (
                  <tr key={log.file} onClick={() => void openLog(log)} data-selected={selected?.file === log.file || undefined}>
                    <td className="ac-mono" title={log.file}>{log.file}</td>
                    <td>{formatTime(log.startedAt)}</td>
                    <td>{formatBytes(log.bytes)}</td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <button type="button" className="ac-btn" onClick={() => void download(log)}>下载</button>
                      <button type="button" className="ac-btn" data-variant="danger" onClick={() => void remove(log)}>删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && (
            <>
              <div className="ac-hint">预览：<span className="ac-mono">{selected.file}</span></div>
              <pre className="ac-log-preview">{preview}</pre>
            </>
          )}
        </div>
        <div className="ac-modal-foot">
          <button type="button" className="ac-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
