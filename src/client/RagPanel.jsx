import * as React from "react";
import { ragRequest, ragUpload } from "./rag-api.js";

const { useCallback, useEffect, useMemo, useRef, useState } = React;

const VENDORS = [
  ["h3c", "H3C / Comware"],
  ["huawei", "Huawei / VRP"],
  ["maipu", "Maipu"],
  ["ruijie", "Ruijie"],
  ["cisco", "Cisco / IOS"]
];

const RAG_CSS = `
.ac-root { position: relative; }
.ac-rag-backdrop { position: absolute; inset: 0; background: rgba(4, 8, 12, 0.45); z-index: 40; display: flex; justify-content: flex-end; }
.ac-rag-drawer { width: min(560px, 96%); height: 100%; background: var(--ac-surface, #161b21); border-left: 1px solid var(--ac-border, #2c333d); display: flex; flex-direction: column; min-height: 0; box-shadow: -12px 0 32px rgba(0,0,0,.35); }
.ac-rag-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--ac-border, #2c333d); }
.ac-rag-title { font-weight: 600; font-size: 13px; flex: 1; }
.ac-rag-tabs { display: flex; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--ac-border, #2c333d); flex-wrap: wrap; }
.ac-rag-tab { border: 1px solid transparent; background: transparent; color: var(--ac-muted, #8b93a1); border-radius: 5px; padding: 4px 9px; font-size: 12px; cursor: pointer; }
.ac-rag-tab[data-active="true"] { color: var(--ac-text, #e6edf3); background: var(--ac-accent-soft, rgba(77,141,255,.14)); border-color: var(--ac-accent, #4d8dff); }
.ac-rag-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px 18px; font-size: 12px; color: var(--ac-text, #e6edf3); }
.ac-rag-section { border: 1px solid var(--ac-border, #2c333d); border-radius: 7px; padding: 9px 10px; margin-bottom: 9px; background: var(--ac-surface-2, #1a1f26); }
.ac-rag-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ac-rag-label { color: var(--ac-muted, #8b93a1); font-size: 11px; }
.ac-rag-input, .ac-rag-select, .ac-rag-textarea { background: var(--ac-bg, #101418); color: var(--ac-text, #e6edf3); border: 1px solid var(--ac-border, #2c333d); border-radius: 5px; padding: 4px 6px; font-size: 12px; min-width: 0; }
.ac-rag-input { flex: 1; }
.ac-rag-textarea { width: 100%; min-height: 52px; resize: vertical; }
.ac-rag-btn { border: 1px solid var(--ac-border, #2c333d); background: var(--ac-surface-2, #1a1f26); color: var(--ac-text, #e6edf3); border-radius: 5px; padding: 4px 9px; font-size: 12px; cursor: pointer; }
.ac-rag-btn:hover { border-color: var(--ac-accent, #4d8dff); }
.ac-rag-btn[data-variant="primary"] { background: var(--ac-accent, #4d8dff); border-color: var(--ac-accent, #4d8dff); color: #fff; }
.ac-rag-btn[data-variant="danger"] { color: var(--ac-danger, #f06464); border-color: var(--ac-danger, #f06464); }
.ac-rag-btn:disabled { opacity: .45; cursor: default; }
.ac-rag-badge { font-size: 10px; border-radius: 9px; padding: 1px 7px; border: 1px solid var(--ac-border, #2c333d); color: var(--ac-muted, #8b93a1); }
.ac-rag-badge[data-tone="ok"] { color: var(--ac-ok, #46c07a); border-color: var(--ac-ok, #46c07a); }
.ac-rag-badge[data-tone="warn"] { color: var(--ac-warn, #e0a84a); border-color: var(--ac-warn, #e0a84a); }
.ac-rag-badge[data-tone="danger"] { color: var(--ac-danger, #f06464); border-color: var(--ac-danger, #f06464); }
.ac-rag-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; }
.ac-rag-code { display: block; white-space: pre-wrap; word-break: break-all; background: var(--ac-bg, #101418); border: 1px solid var(--ac-border, #2c333d); border-radius: 5px; padding: 6px 7px; margin: 4px 0; }
.ac-rag-muted { color: var(--ac-muted, #8b93a1); }
.ac-rag-error { color: var(--ac-danger, #f06464); white-space: pre-wrap; }
.ac-rag-step { border-left: 3px solid var(--ac-border, #2c333d); padding-left: 8px; margin: 8px 0; }
.ac-rag-step[data-status="done"] { border-left-color: var(--ac-ok, #46c07a); }
.ac-rag-step[data-status="failed"] { border-left-color: var(--ac-danger, #f06464); }
.ac-rag-step[data-status="running"] { border-left-color: var(--ac-accent, #4d8dff); }
.ac-rag-kv { display: grid; grid-template-columns: 84px 1fr; gap: 3px 8px; }
.ac-rag-hr { border: 0; border-top: 1px solid var(--ac-border, #2c333d); margin: 8px 0; }
.ac-rag-progress { height: 5px; border-radius: 4px; background: var(--ac-bg, #101418); overflow: hidden; margin: 5px 0; }
.ac-rag-progress > i { display: block; height: 100%; background: var(--ac-accent, #4d8dff); }
`;

function tone(status) {
  if (status === "ready" || status === "done" || status === "approved" || status === "exact" || status === "ok") return "ok";
  if (status === "failed" || status === "aborted" || status === "mismatch") return "danger";
  if (status === "partial" || status === "paused" || status === "unknown" || status === "building") return "warn";
  return "muted";
}

function useRagData(tab, connectionId) {
  const [status, setStatus] = useState(null);
  const [docs, setDocs] = useState([]);
  const [plans, setPlans] = useState([]);
  const [devices, setDevices] = useState([]);
  const [errors, setErrors] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const value = await ragRequest("status");
      setStatus(value);
      setDocs(value.docs ?? []);
      setPlans(value.plans ?? []);
      setError(null);
    } catch (loadError) {
      setError(loadError.message);
    }
  }, []);

  const loadTab = useCallback(async () => {
    try {
      if (tab === "devices") setDevices(await ragRequest("devices.list"));
      if (tab === "errors") setErrors(await ragRequest("errors.list"));
    } catch (loadError) {
      setError(loadError.message);
    }
  }, [tab]);

  useEffect(() => {
    void refresh();
    void loadTab();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh, loadTab]);

  return { status, docs, plans, devices, errors, error, busy, setBusy, refresh, loadTab, setError };
}

function UploadForm({ onUploaded, setError }) {
  const [file, setFile] = useState(null);
  const [meta, setMeta] = useState({ title: "", vendor: "h3c", series: "", models: "", versions: "", docType: "configuration-guide" });
  const [uploading, setUploading] = useState(false);

  const choose = (event) => {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    if (selected) setMeta((current) => ({ ...current, title: current.title || selected.name.replace(/\.[^.]+$/, "") }));
  };

  const submit = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("metadata", JSON.stringify({
        title: meta.title || file.name,
        vendor: meta.vendor,
        series: meta.series,
        models: meta.models,
        versions: meta.versions,
        docType: meta.docType
      }));
      form.append("build", "true");
      const result = await ragUpload(form);
      onUploaded(result);
      setFile(null);
      setMeta((current) => ({ ...current, title: "" }));
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="ac-rag-section">
      <div className="ac-rag-row" style={{ marginBottom: 6 }}>
        <strong>上传手册</strong>
        <span className="ac-rag-muted">pdf / chm / md，文字可选型 PDF</span>
      </div>
      <input className="ac-rag-input" style={{ width: "100%", marginBottom: 6 }} type="file" accept=".pdf,.chm,.md,.markdown" onChange={choose} />
      <div className="ac-rag-row" style={{ marginBottom: 5 }}>
        <span className="ac-rag-label" style={{ width: 48 }}>标题</span>
        <input className="ac-rag-input" value={meta.title} onChange={(event) => setMeta({ ...meta, title: event.target.value })} placeholder="手册标题" />
      </div>
      <div className="ac-rag-row" style={{ marginBottom: 5 }}>
        <span className="ac-rag-label" style={{ width: 48 }}>厂家</span>
        <select className="ac-rag-select" value={meta.vendor} onChange={(event) => setMeta({ ...meta, vendor: event.target.value })}>
          {VENDORS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <input className="ac-rag-input" value={meta.docType} onChange={(event) => setMeta({ ...meta, docType: event.target.value })} placeholder="文档类型" />
      </div>
      <div className="ac-rag-row" style={{ marginBottom: 5 }}>
        <span className="ac-rag-label" style={{ width: 48 }}>系列</span>
        <input className="ac-rag-input" value={meta.series} onChange={(event) => setMeta({ ...meta, series: event.target.value })} placeholder="S5820V2,S5830V2（逗号分隔）" />
      </div>
      <div className="ac-rag-row" style={{ marginBottom: 5 }}>
        <span className="ac-rag-label" style={{ width: 48 }}>型号</span>
        <input className="ac-rag-input" value={meta.models} onChange={(event) => setMeta({ ...meta, models: event.target.value })} placeholder="可选，精确型号" />
      </div>
      <div className="ac-rag-row" style={{ marginBottom: 6 }}>
        <span className="ac-rag-label" style={{ width: 48 }}>版本</span>
        <input className="ac-rag-input" value={meta.versions} onChange={(event) => setMeta({ ...meta, versions: event.target.value })} placeholder="V7.1.075 或 7.1.0-7.1.99" />
      </div>
      <button className="ac-rag-btn" data-variant="primary" disabled={!file || uploading} onClick={() => void submit()}>
        {uploading ? "上传中…" : "上传并建索引"}
      </button>
    </div>
  );
}

function DocsTab({ docs, status, connectionId, refresh, setError }) {
  const [task, setTask] = useState(null);
  const [preview, setPreview] = useState(null);

  const poll = async (taskId) => {
    for (let attempt = 0; attempt < 900; attempt += 1) {
      const current = await ragRequest("task.get", { taskId });
      setTask(current);
      if (current.status === "done" || current.status === "failed") {
        await refresh();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  };

  const build = async (docId) => {
    try {
      const result = await ragRequest("docs.build", { docId });
      await poll(result.taskId);
    } catch (error) {
      setError(error.message);
    }
  };

  const remove = async (docId) => {
    if (!globalThis.confirm?.(`删除文档 ${docId}？索引文件也会删除。`)) return;
    try {
      await ragRequest("docs.delete", { docId });
      await refresh();
    } catch (error) {
      setError(error.message);
    }
  };

  return (
    <>
      <UploadForm
        setError={setError}
        onUploaded={(result) => {
          if (result.taskId) void poll(result.taskId);
          void refresh();
        }}
      />
      {task && (
        <div className="ac-rag-section">
          <div className="ac-rag-row">
            <span className="ac-rag-badge" data-tone={tone(task.status)}>{task.status}</span>
            <span>{task.title}</span>
            <span className="ac-rag-muted" style={{ marginLeft: "auto" }}>{Math.round((task.progress ?? 0) * 100)}%</span>
          </div>
          <div className="ac-rag-progress"><i style={{ width: `${Math.round((task.progress ?? 0) * 100)}%` }} /></div>
          <div className="ac-rag-muted">{task.message}</div>
          {task.error && <div className="ac-rag-error">{task.error}</div>}
        </div>
      )}
      <div className="ac-rag-section">
        <div className="ac-rag-row" style={{ marginBottom: 6 }}>
          <strong>文档（{docs.length}）</strong>
          <span className="ac-rag-muted" style={{ marginLeft: "auto" }}>
            {status?.sidecar?.ready ? "检索服务已就绪" : `检索服务未启动${status?.sidecar?.error ? `：${status.sidecar.error}` : ""}`}
          </span>
        </div>
        {docs.length === 0 && <div className="ac-rag-muted">还没有文档。上传一本手册开始。</div>}
        {docs.map((doc) => (
          <div key={doc.docId} className="ac-rag-section" style={{ marginBottom: 6 }}>
            <div className="ac-rag-row">
              <span className="ac-rag-badge" data-tone={tone(doc.status)}>{doc.status}</span>
              <span style={{ flex: 1 }}>{doc.title}</span>
              <span className="ac-rag-muted">{doc.stats?.nodes ?? 0} 节点</span>
            </div>
            <div className="ac-rag-muted ac-rag-mono" style={{ marginTop: 3 }}>
              {doc.docId} · {doc.vendor || "厂家未填"} · {(doc.series ?? []).join("/") || "系列未填"} · {(doc.versions ?? []).map((item) => item.raw || `${item.min ?? ""}-${item.max ?? ""}`).join(",") || "版本未填"}
            </div>
            {doc.error && <div className="ac-rag-error">{doc.error}</div>}
            <div className="ac-rag-row" style={{ marginTop: 5 }}>
              <button className="ac-rag-btn" onClick={() => void build(doc.docId)}>{doc.status === "ready" ? "重建索引" : "建索引"}</button>
              <button className="ac-rag-btn" onClick={async () => {
                try {
                  setPreview(await ragRequest("docs.preview", { docId: doc.docId, limit: 8 }));
                } catch (error) {
                  setError(error.message);
                }
              }}>预览</button>
              <button className="ac-rag-btn" data-variant="danger" onClick={() => void remove(doc.docId)}>删除</button>
            </div>
            {preview?.docId === doc.docId && (
              <div style={{ marginTop: 6 }}>
                {preview.nodes.map((node) => (
                  <div key={node.id} className="ac-rag-code">{node.section} · {node.locator}\n{node.text.slice(0, 240)}</div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="ac-rag-section">
        <div className="ac-rag-muted">
          数据目录：{status?.config?.dataDir}<br />
          模型：{status?.sidecar?.health?.model?.model ?? "未加载"} · {status?.sidecar?.health?.model?.device ?? "-"} · 维度 {status?.sidecar?.health?.model?.dim ?? "-"}
        </div>
      </div>
    </>
  );
}

function PlansTab({ plans, refresh, setError }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState(null);
  const [result, setResult] = useState(null);

  const loadPlan = async (planId) => {
    try {
      setPlan(await ragRequest("plans.get", { planId }));
      setDiagnosis(null);
      setResult(null);
    } catch (error) {
      setError(error.message);
    }
  };

  const approve = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      setPlan(await ragRequest("plans.approve", { planId: plan.planId }));
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      setResult(await ragRequest("plans.execute", { planId: plan.planId }));
      setPlan(await ragRequest("plans.get", { planId: plan.planId }));
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    if (!plan) return;
    try {
      setPlan(await ragRequest("plans.abort", { planId: plan.planId }));
    } catch (error) {
      setError(error.message);
    }
  };

  const diagnose = async (stepId) => {
    try {
      setDiagnosis(await ragRequest("plans.diagnose", { planId: plan.planId, stepId }));
    } catch (error) {
      setError(error.message);
    }
  };

  return (
    <>
      <div className="ac-rag-section">
        <div className="ac-rag-row" style={{ marginBottom: 6 }}>
          <strong>计划（{plans.length}）</strong>
          <button className="ac-rag-btn" onClick={() => void refresh()} style={{ marginLeft: "auto" }}>刷新</button>
        </div>
        {plans.length === 0 && <div className="ac-rag-muted">还没有计划。在对话中让 AI 检索手册并调用 plan_create。</div>}
        {plans.map((item) => (
          <button
            key={item.planId}
            className="ac-rag-btn"
            style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 5 }}
            data-active={plan?.planId === item.planId}
            onClick={() => void loadPlan(item.planId)}
          >
            <span className="ac-rag-badge" data-tone={tone(item.status)}>{item.status}</span>{" "}
            {item.title || item.planId} <span className="ac-rag-muted">· {item.steps} 步 · {item.risk}</span>
          </button>
        ))}
      </div>
      {plan && (
        <div className="ac-rag-section">
          <div className="ac-rag-row">
            <strong>{plan.summary || plan.query || plan.planId}</strong>
            <span className="ac-rag-badge" data-tone={tone(plan.risk)}>{plan.risk}</span>
            <span className="ac-rag-badge" data-tone={plan.approval?.status === "approved" ? "ok" : "warn"}>{plan.approval?.status ?? "none"}</span>
          </div>
          <div className="ac-rag-muted ac-rag-mono" style={{ margin: "4px 0" }}>{plan.planId} · hash {(plan.planHash ?? "").slice(0, 12)}</div>
          {plan.mode && (
            <div className="ac-rag-muted">
              创建时视图：{plan.mode.label}{plan.mode.prompt ? `（${plan.mode.prompt}）` : ""}
              {plan.adjustments?.length > 0 ? ` · ${plan.adjustments.join("；")}` : ""}
            </div>
          )}
          {plan.warnings?.length > 0 && (
            <div className="ac-rag-error" style={{ color: "var(--ac-warn)" }}>{plan.warnings.join("\n")}</div>
          )}
          {plan.docRefs?.length > 0 && (
            <div className="ac-rag-muted" style={{ marginTop: 4 }}>
              依据：{plan.docRefs.map((ref) => `${ref.title ?? ref.docId} ${ref.section ?? ""}`).join("；")}
            </div>
          )}
          <div className="ac-rag-row" style={{ marginTop: 8 }}>
            <button className="ac-rag-btn" data-variant="primary" disabled={busy || plan.approval?.status === "approved"} onClick={() => void approve()}>批准整份计划</button>
            <button className="ac-rag-btn" data-variant="primary" disabled={busy || plan.approval?.status !== "approved"} onClick={() => void execute()}>{busy ? "执行中…" : "执行"}</button>
            <button className="ac-rag-btn" data-variant="danger" disabled={busy} onClick={() => void abort()}>中止</button>
          </div>
          <hr className="ac-rag-hr" />
          {plan.steps.map((step) => (
            <div key={step.stepId} className="ac-rag-step" data-status={step.status}>
              <div className="ac-rag-row">
                <strong>{step.stepId}. {step.title}</strong>
                <span className="ac-rag-badge" data-tone={tone(step.risk)}>{step.risk}</span>
                <span className="ac-rag-badge" data-tone={tone(step.status)}>{step.status}</span>
              </div>
              {step.intent && <div className="ac-rag-muted">{step.intent}</div>}
              {step.commands.map((command, index) => (
                <div key={`${step.stepId}-${index}`}>
                  <code className="ac-rag-code">{command.text}</code>
                  <div className="ac-rag-muted">{command.explanation}</div>
                  {command.reply && <div className="ac-rag-muted">交互回答：{command.reply}</div>}
                </div>
              ))}
              {step.verify?.length > 0 && <div className="ac-rag-muted">验证：{step.verify.map((item) => item.text).join("；")}</div>}
              {step.rollback?.length > 0 && <div className="ac-rag-muted">回滚：{step.rollback.map((item) => item.text).join("；")}</div>}
              {step.error && (
                <div className="ac-rag-error" style={{ marginTop: 4 }}>
                  {step.error.message} {step.error.token ? `（token: ${step.error.token}）` : ""}
                  <button className="ac-rag-btn" style={{ marginLeft: 6 }} onClick={() => void diagnose(step.stepId)}>诊断 ?</button>
                </div>
              )}
              {step.verification?.length > 0 && (
                <div className="ac-rag-muted" style={{ marginTop: 4 }}>
                  验证结果：{step.verification.map((item) => `${item.command}=${item.ok ? "ok" : "mismatch"}`).join("；")}
                </div>
              )}
            </div>
          ))}
          {diagnosis && (
            <div className="ac-rag-section">
              <strong>帮助输出</strong>
              {diagnosis.probes?.map((probe) => (
                <div key={probe.prefix}>
                  <div className="ac-rag-mono">{probe.prefix} ?</div>
                  <pre className="ac-rag-code">{probe.output}</pre>
                </div>
              ))}
            </div>
          )}
          {result && <pre className="ac-rag-code">{JSON.stringify(result, null, 2)}</pre>}
        </div>
      )}
    </>
  );
}

function DevicesTab({ devices, connectionId, refresh, loadTab, setError }) {
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState(null);

  const collect = async () => {
    if (!connectionId) {
      setError("先在终端里连接一台设备，再采集档案。");
      return;
    }
    setBusy(true);
    try {
      setProfile(await ragRequest("devices.collect", { connectionId }));
      await loadTab();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };

  const exportAll = async () => {
    try {
      const payload = await ragRequest("devices.export");
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dsh-autoconfig-devices-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setError(error.message);
    }
  };

  const importFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      await ragRequest("devices.import", { payload });
      await loadTab();
    } catch (error) {
      setError(error.message);
    }
  };

  return (
    <>
      <div className="ac-rag-section">
        <div className="ac-rag-row">
          <strong>设备档案</strong>
          <span className="ac-rag-muted">本机记录，可导出共享</span>
        </div>
        <div className="ac-rag-row" style={{ marginTop: 6 }}>
          <button className="ac-rag-btn" data-variant="primary" disabled={busy || !connectionId} onClick={() => void collect()}>{busy ? "采集中…" : "采集当前设备"}</button>
          <button className="ac-rag-btn" onClick={() => void exportAll()}>导出全部</button>
          <label className="ac-rag-btn" style={{ cursor: "pointer" }}>
            导入
            <input type="file" accept=".json" style={{ display: "none" }} onChange={(event) => void importFile(event)} />
          </label>
        </div>
        {profile && (
          <div className="ac-rag-kv" style={{ marginTop: 8 }}>
            <span className="ac-rag-label">设备</span><span>{profile.hostname ?? profile.name}</span>
            <span className="ac-rag-label">厂商/平台</span><span>{profile.vendor}/{profile.platform}</span>
            <span className="ac-rag-label">型号</span><span>{profile.model ?? "未知"}</span>
            <span className="ac-rag-label">版本</span><span>{profile.version ?? "未知"}</span>
            <span className="ac-rag-label">序列号</span><span>{profile.serial ?? "未读取"}</span>
          </div>
        )}
      </div>
      <div className="ac-rag-section">
        {devices.length === 0 && <div className="ac-rag-muted">还没有设备档案。</div>}
        {devices.map((device) => (
          <div key={device.deviceId} className="ac-rag-section" style={{ marginBottom: 6 }}>
            <div className="ac-rag-row">
              <strong>{device.hostname ?? device.name}</strong>
              <span className="ac-rag-muted">{device.vendor}/{device.model ?? "?"}/{device.version ?? "?"}</span>
              <button className="ac-rag-btn" data-variant="danger" style={{ marginLeft: "auto" }} onClick={async () => {
                await ragRequest("devices.remove", { deviceId: device.deviceId });
                await loadTab();
              }}>删除</button>
            </div>
            <div className="ac-rag-muted ac-rag-mono">{device.host ?? ""}:{device.port ?? ""} · SN {device.serial ?? "-"} · {device.collectedAt}</div>
            {device.bindings?.length > 0 && (
              <div style={{ marginTop: 3 }}>
                {device.bindings.map((binding) => (
                  <div key={binding.docId} className="ac-rag-muted">
                    <span className="ac-rag-badge" data-tone={tone(binding.status)}>{binding.status}</span> {binding.title}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function ErrorsTab({ errors, setError }) {
  return (
    <div className="ac-rag-section">
      <div className="ac-rag-row" style={{ marginBottom: 6 }}>
        <strong>错误案例（{errors.length}）</strong>
        <span className="ac-rag-muted">用于后续计划注入与手册缺口分析</span>
      </div>
      {errors.length === 0 && <div className="ac-rag-muted">还没有失败记录。</div>}
      {errors.map((item, index) => (
        <div key={`${item.recordedAt}-${index}`} className="ac-rag-section" style={{ marginBottom: 6 }}>
          <div className="ac-rag-row">
            <span className="ac-rag-badge" data-tone="danger">{item.vendor ?? "?"}</span>
            <span className="ac-rag-muted">{item.model ?? ""} {item.version ?? ""}</span>
          </div>
          <code className="ac-rag-code">{item.command}</code>
          <div className="ac-rag-error">{item.errorText}</div>
          {item.token && <div className="ac-rag-muted">可疑 token：{item.token}</div>}
          {item.fix && <div className="ac-rag-muted">修复：{item.fix}</div>}
        </div>
      ))}
    </div>
  );
}

export function RagPanel({ tab, connectionId, onClose }) {
  const [activeTab, setActiveTab] = useState(tab ?? "docs");
  const { status, docs, plans, devices, errors, error, refresh, loadTab, setError } = useRagData(activeTab, connectionId);
  const injected = useRef(false);

  useEffect(() => {
    setActiveTab(tab ?? "docs");
  }, [tab]);

  useEffect(() => {
    if (injected.current) return;
    injected.current = true;
    const style = document.createElement("style");
    style.dataset.dshAutoconfigRag = "true";
    style.textContent = RAG_CSS;
    document.head.appendChild(style);
  }, []);

  const tabs = useMemo(() => ([
    ["docs", "知识库"],
    ["plans", "计划"],
    ["devices", "档案"],
    ["errors", "错误"]
  ]), []);

  return (
    <div className="ac-rag-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ac-rag-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="ac-rag-head">
          <span className="ac-rag-title">手册知识库与配置计划</span>
          <span className="ac-rag-badge" data-tone={status?.sidecar?.ready ? "ok" : "warn"}>
            {status?.sidecar?.ready ? "RAG 就绪" : "RAG 未启动"}
          </span>
          {!status?.sidecar?.ready && (
            <button className="ac-rag-btn" onClick={async () => {
              try {
                await ragRequest("start");
                await refresh();
              } catch (error) {
                setError(error.message);
              }
            }}>启动</button>
          )}
          <button className="ac-rag-btn" onClick={onClose}>关闭</button>
        </div>
        <div className="ac-rag-tabs">
          {tabs.map(([id, label]) => (
            <button key={id} className="ac-rag-tab" data-active={activeTab === id} onClick={() => setActiveTab(id)}>{label}</button>
          ))}
        </div>
        <div className="ac-rag-body">
          {error && <div className="ac-rag-error" style={{ marginBottom: 8 }}>{error}</div>}
          {!status && <div className="ac-rag-muted">正在读取 RAG 状态…</div>}
          {activeTab === "docs" && <DocsTab docs={docs} status={status} connectionId={connectionId} refresh={refresh} setError={setError} />}
          {activeTab === "plans" && <PlansTab plans={plans} refresh={refresh} setError={setError} />}
          {activeTab === "devices" && <DevicesTab devices={devices} connectionId={connectionId} refresh={refresh} loadTab={loadTab} setError={setError} />}
          {activeTab === "errors" && <ErrorsTab errors={errors} setError={setError} />}
        </div>
      </div>
    </div>
  );
}