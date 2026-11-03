/**
 * Configuration plans: validation, one-shot approval, step execution, repair.
 *
 * Approval is a host-side fact, not a tool argument: only the panel route can
 * call `approvePlan`, while the agent's `plan_execute` tool merely checks the
 * stored hash. Changing one command invalidates the hash and forces re-approval.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getVendor, detectVendorFromText } from "./vendors.js";
import { classifyOutput, findPitfalls, recordErrorCase } from "./errors.js";
import { cleanCommandOutput, probeHelp, runCommand, runInteractive, tailText, writeRawMarked } from "./terminal.js";

export const PLAN_DIR = join(homedir(), ".dsh", "autoconfig-plans");
const MAX_STEPS = 40;
const MAX_COMMANDS_PER_STEP = 12;
const STEP_TIMEOUT_MS = 60_000;

const HIGH_RISK = [
  /\bsave\b/i,
  /\bwrite\b/i,
  /\breboot\b/i,
  /\breset\s+(?:saved|current)/i,
  /\bformat\b/i,
  /\bdelete\b/i,
  /\bundo\s+(?:ssh|telnet|acl|aaa|snmp|ip\s+route|interface|local-user)/i,
  /\bshutdown\b/i,
  /\baaa\b/i,
  /\bssh\b/i,
  /\btelnet\b/i,
  /\bsnmp\b/i,
  /\buser-interface\b/i
];
const CRITICAL_RISK = [/\breboot\b/i, /\breset\s+saved/i, /\bformat\b/i, /\bdelete\s+\/unreserved/i];

const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

function riskOfText(text) {
  if (CRITICAL_RISK.some((pattern) => pattern.test(text))) return "critical";
  if (HIGH_RISK.some((pattern) => pattern.test(text))) return "high";
  if (/\bundo\b|\bno\b\s+/i.test(text)) return "medium";
  if (/^(?:display|show|dir|ping|tracert|more)\b/i.test(text.trim())) return "low";
  return "medium";
}

function maxRisk(left, right) {
  return (RISK_ORDER[left] ?? 0) >= (RISK_ORDER[right] ?? 0) ? left : right;
}

function stepId(index) {
  return `s${index + 1}`;
}

export function canonicalHash(plan) {
  const material = {
    connectionId: plan.connectionId,
    steps: (plan.steps ?? []).map((step) => ({
      id: step.stepId,
      commands: (step.commands ?? []).map((command) => command.text),
      verify: (step.verify ?? []).map((command) => command.text),
      rollback: (step.rollback ?? []).map((command) => command.text)
    }))
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function validateCommand(command, stepIndex, commandIndex) {
  const errors = [];
  const text = String(command?.text ?? "").trim();
  if (!text) errors.push(`步骤 ${stepIndex + 1} 的命令 ${commandIndex + 1} 缺少 text`);
  if (text.length > 400) errors.push(`步骤 ${stepIndex + 1} 命令过长（>400 字符）`);
  if (/[\r\n]/.test(text)) errors.push(`步骤 ${stepIndex + 1} 的命令不能包含换行：${text.slice(0, 40)}`);
  if (text.startsWith("?")) errors.push(`步骤 ${stepIndex + 1} 的命令不能以 ? 开头`);
  const explanation = String(command?.explanation ?? "").trim();
  if (explanation.length < 6) errors.push(`步骤 ${stepIndex + 1} 的命令 "${text}" 缺少解释（explanation）`);
  return errors;
}

export function validatePlanInput(input) {
  const errors = [];
  const warnings = [];
  if (!input || typeof input !== "object") return { errors: ["plan 必须是对象"], warnings, plan: null };
  if (!Array.isArray(input.steps) || input.steps.length === 0) errors.push("steps 不能为空");
  if (Array.isArray(input.steps) && input.steps.length > MAX_STEPS) errors.push(`steps 不能超过 ${MAX_STEPS} 个`);
  const steps = [];
  for (const [index, rawStep] of (input.steps ?? []).entries()) {
    const commands = Array.isArray(rawStep?.commands) ? rawStep.commands : [];
    if (commands.length === 0) errors.push(`步骤 ${index + 1} 没有 commands`);
    if (commands.length > MAX_COMMANDS_PER_STEP) errors.push(`步骤 ${index + 1} 命令过多（>${MAX_COMMANDS_PER_STEP}）`);
    const normalized = [];
    let stepRisk = "low";
    for (const [commandIndex, command] of commands.entries()) {
      errors.push(...validateCommand(command, index, commandIndex));
      const risk = command?.risk && RISK_ORDER[command.risk] !== undefined ? command.risk : riskOfText(command?.text ?? "");
      stepRisk = maxRisk(stepRisk, risk);
      normalized.push({
        text: String(command?.text ?? "").trim(),
        explanation: String(command?.explanation ?? "").trim(),
        risk,
        expect: command?.expect ?? null,
        reply: command?.reply ?? null,
        replyWhen: command?.replyWhen ?? null
      });
    }
    const verify = (Array.isArray(rawStep?.verify) ? rawStep.verify : []).map((command) => ({
      text: String(command?.text ?? "").trim(),
      expect: command?.expect ?? null
    })).filter((command) => command.text);
    const rollback = (Array.isArray(rawStep?.rollback) ? rawStep.rollback : []).map((command) => ({
      text: String(command?.text ?? "").trim(),
      explanation: String(command?.explanation ?? "").trim()
    })).filter((command) => command.text);
    const changesConfig = normalized.some((command) => !/^(?:display|show|dir|ping|tracert|more)\b/i.test(command.text));
    if (changesConfig && verify.length === 0) warnings.push(`步骤 ${index + 1} 没有验证命令（verify）`);
    if (changesConfig && stepRisk !== "low" && rollback.length === 0) {
      warnings.push(`步骤 ${index + 1} 为 ${stepRisk} 风险但没有回滚命令（rollback）`);
    }
    steps.push({
      stepId: stepId(index),
      title: String(rawStep?.title ?? `步骤 ${index + 1}`).trim(),
      intent: String(rawStep?.intent ?? "").trim(),
      commands: normalized,
      verify,
      rollback,
      risk: stepRisk,
      status: "pending",
      attempts: 0,
      outputDigest: null,
      error: null
    });
  }
  if (!Array.isArray(input.docRefs) || input.docRefs.length === 0) {
    warnings.push("计划没有引用任何手册片段（docRefs），答案可能未受手册兜底");
  }
  const risk = steps.reduce((current, step) => maxRisk(current, step.risk), "low");
  if (errors.length) return { errors, warnings, plan: null };
  return {
    errors,
    warnings,
    plan: {
      planId: input.planId || `plan-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
      connectionId: String(input.connectionId ?? "").trim() || null,
      query: String(input.query ?? "").trim(),
      summary: String(input.summary ?? "").trim(),
      device: input.device && typeof input.device === "object" ? input.device : null,
      docRefs: Array.isArray(input.docRefs) ? input.docRefs : [],
      warnings,
      risk,
      steps,
      status: "draft",
      approval: { status: "none", hash: null, at: null, by: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      planHash: null
    }
  };
}

export class PlanEngine {
  constructor(service, sidecar) {
    this.service = service;
    this.sidecar = sidecar;
    this.running = new Map();
    this.autoCollect = true;
  }

  async _ensureDir() {
    await mkdir(PLAN_DIR, { recursive: true });
  }

  async save(plan) {
    await this._ensureDir();
    plan.updatedAt = new Date().toISOString();
    plan.planHash = canonicalHash(plan);
    await writeFile(join(PLAN_DIR, `${plan.planId}.json`), JSON.stringify(plan, null, 2), "utf8");
    return plan;
  }

  async load(planId) {
    try {
      return JSON.parse(await readFile(join(PLAN_DIR, `${planId}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  async list() {
    await this._ensureDir();
    const files = (await readdir(PLAN_DIR)).filter((file) => file.endsWith(".json"));
    const plans = [];
    for (const file of files) {
      try {
        const plan = JSON.parse(await readFile(join(PLAN_DIR, file), "utf8"));
        plans.push({
          planId: plan.planId,
          title: plan.summary || plan.query,
          connectionId: plan.connectionId,
          risk: plan.risk,
          status: plan.status,
          approval: plan.approval?.status ?? "none",
          steps: plan.steps?.length ?? 0,
          updatedAt: plan.updatedAt
        });
      } catch {}
    }
    return plans.sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  }

  async create(input) {
    const { errors, warnings, plan } = validatePlanInput(input);
    if (errors.length) {
      const error = new Error(`计划校验失败：\n${errors.join("\n")}`);
      error.code = "plan-invalid";
      error.details = { errors, warnings };
      throw error;
    }
    if (!plan.connectionId) {
      const active = this.service._activeLive();
      if (!active) {
        const error = new Error("没有活动连接；请先连接设备，或在 plan 中提供 connectionId。");
        error.code = "no-active-connection";
        throw error;
      }
      plan.connectionId = active.id;
    }
    const conn = this.service.connections.get(plan.connectionId);
    if (!conn) {
      const error = new Error(`连接 ${plan.connectionId} 不存在或已关闭。`);
      error.code = "no-session";
      throw error;
    }
    if (!plan.device) {
      plan.device = {
        name: conn.name,
        host: conn.host,
        vendor: this._vendorForConn(conn)?.id ?? null,
        hostname: conn.hostname
      };
    }
    const pitfalls = await findPitfalls({
      vendor: plan.device?.vendor,
      command: plan.steps.flatMap((step) => step.commands.map((command) => command.text)).join(" "),
      query: plan.query
    });
    if (pitfalls.length) {
      plan.warnings = [...plan.warnings, `历史坑：${pitfalls.length} 条相似错误案例，执行时注意 ${pitfalls[0].token ?? pitfalls[0].command}`];
      plan.pitfalls = pitfalls;
    }
    return this.save(plan);
  }

  async approve(planId) {
    const plan = await this.load(planId);
    if (!plan) throw new Error(`计划 ${planId} 不存在`);
    if (plan.status === "running") throw new Error("计划正在执行，不能重复批准");
    const hash = canonicalHash(plan);
    plan.approval = { status: "approved", hash, at: new Date().toISOString(), by: "panel" };
    plan.status = "approved";
    plan.planHash = hash;
    await this.save(plan);
    return plan;
  }

  async revoke(planId) {
    const plan = await this.load(planId);
    if (!plan) throw new Error(`计划 ${planId} 不存在`);
    plan.approval = { status: "none", hash: null, at: null, by: null };
    if (plan.status === "approved") plan.status = "draft";
    await this.save(plan);
    return plan;
  }

  _vendorForConn(conn) {
    if (!conn) return null;
    try {
      const recorded = this.deviceProfiles?.get?.(conn.id);
      if (recorded) return getVendor(recorded.vendor);
    } catch {}
    const tail = tailText(conn.journal.readWindow(undefined, 8_000).data, 3_000);
    const detected = detectVendorFromText(tail);
    if (detected) return getVendor(detected);
    if (/<H3C>|\[H3C/.test(tail)) return getVendor("h3c");
    if (/<[A-Za-z0-9._-]+>/.test(tail)) return getVendor("huawei");
    return null;
  }

  async _runPlanCommands(plan) {
    const conn = this.service.connections.get(plan.connectionId);
    if (!conn || conn.status !== "open") {
      const error = new Error("设备连接已关闭；请重新连接后再执行计划。");
      error.code = "no-session";
      throw error;
    }
    const vendor = getVendor(plan.device?.vendor) ?? this._vendorForConn(conn);
    if (!vendor) {
      const error = new Error("无法识别设备厂商，拒绝执行。请先运行 device_profile。");
      error.code = "vendor-unknown";
      throw error;
    }
    return { conn, vendor };
  }

  async execute(planId, { resume = false } = {}) {
    const plan = await this.load(planId);
    if (!plan) throw new Error(`计划 ${planId} 不存在`);
    if (this.running.get(planId)) {
      const error = new Error("计划正在执行中");
      error.code = "plan-running";
      throw error;
    }
    const hash = canonicalHash(plan);
    if (plan.approval?.status !== "approved" || plan.approval.hash !== hash) {
      const error = new Error("计划未批准，或批准后内容已变更；请由操作者在右侧面板确认后再执行。");
      error.code = "not-approved";
      throw error;
    }
    if (plan.status === "done") return { planId, status: "done", steps: plan.steps.map((step) => ({ stepId: step.stepId, status: step.status })) };
    if (plan.status === "aborted") throw new Error("计划已中止");
    if (!resume && plan.status === "paused") {
      // Resume is explicit; a plain execute keeps the pause.
      return { planId, status: "paused", message: "计划处于暂停状态；请先处理失败步骤或调用 resume。" };
    }
    this.running.set(planId, true);
    plan.status = "running";
    await this.save(plan);
    const { conn, vendor } = await this._runPlanCommands(plan);
    const summaries = [];
    try {
      for (const step of plan.steps) {
        if (step.status === "done") continue;
        if (step.status === "skipped") continue;
        step.status = "running";
        step.attempts = (step.attempts ?? 0) + 1;
        await this.save(plan);
        const stepResult = await this._executeStep(conn, vendor, plan, step);
        summaries.push(stepResult);
        await this.save(plan);
        if (stepResult.status !== "done") {
          plan.status = stepResult.status === "failed" ? "paused" : "paused";
          await this.save(plan);
          return { planId, status: plan.status, steps: summaries, failedStep: step.stepId, error: stepResult.error ?? null };
        }
      }
      plan.status = "done";
      await this.save(plan);
      return { planId, status: "done", steps: summaries };
    } finally {
      this.running.delete(planId);
    }
  }

  async _executeStep(conn, vendor, plan, step) {
    step.error = null;
    const outputs = [];
    for (const command of step.commands) {
      const result = await this._executeCommand(conn, vendor, plan, step, command);
      outputs.push(result);
      if (result.status === "failed") {
        step.status = "failed";
        step.error = result.error;
        return { stepId: step.stepId, status: "failed", error: result.error, outputs: summarizeOutputs(outputs) };
      }
      if (result.status === "unknown") {
        step.status = "unknown";
        step.error = { message: "命令执行后未在超时内看到提示符", command: command.text };
        return { stepId: step.stepId, status: "unknown", error: step.error, outputs: summarizeOutputs(outputs) };
      }
    }
    // Verification is best-effort: a mismatch is surfaced but does not abort the
    // plan, because some commands only take effect after a later step.
    const verification = [];
    for (const check of step.verify ?? []) {
      const result = await runCommand(this.service, conn, check.text, {
        vendor,
        timeoutMs: 15_000,
        source: "plan verify"
      });
      const output = cleanCommandOutput(result.text, check.text);
      const expected = check.expect ? new RegExp(String(check.expect).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
      verification.push({
        command: check.text,
        ok: expected ? expected.test(output) : true,
        output: output.slice(0, 1_200)
      });
    }
    step.status = "done";
    step.verification = verification;
    step.outputDigest = digestOutputs(outputs);
    return { stepId: step.stepId, status: "done", verification, outputs: summarizeOutputs(outputs) };
  }

  async _executeCommand(conn, vendor, plan, step, command) {
    const started = Date.now();
    const runner = command.reply
      ? runInteractive(this.service, conn, command.text, {
          vendor,
          reply: command.reply,
          ...(command.replyWhen ? { replyWhen: new RegExp(command.replyWhen, "i") } : {}),
          timeoutMs: STEP_TIMEOUT_MS,
          source: "plan",
          note: command.explanation
        })
      : runCommand(this.service, conn, command.text, {
          vendor,
          timeoutMs: STEP_TIMEOUT_MS,
          source: "plan",
          note: command.explanation
        });
    const result = await runner;
    let raw = result.text;
    const classification = classifyOutput(raw, { vendorId: vendor.id, timedOut: result.timedOut });
    const output = cleanCommandOutput(raw, command.text);
    const entry = {
      command: command.text,
      explanation: command.explanation,
      status: classification.status,
      output: output.slice(0, 4_000),
      durationMs: Date.now() - started
    };
    if (classification.status === "failed") {
      const error = {
        ...classification.error,
        command: command.text,
        output: output.slice(0, 4_000)
      };
      // The caret column is absolute on the echoed line (which includes the
      // prompt); convert it to an offset inside the command for ? probes.
      if (error.echoLine && Number.isInteger(error.tokenIndex)) {
        const start = String(error.echoLine).indexOf(command.text.trim());
        if (start >= 0 && error.tokenIndex >= start) error.tokenIndex -= start;
      }
      try {
        await recordErrorCase({
          vendor: vendor.id,
          platform: plan.device?.platform,
          model: plan.device?.model,
          version: plan.device?.version,
          command: command.text,
          errorText: error.message,
          token: error.token,
          caretColumn: error.caretColumn,
          docId: plan.docRefs?.[0]?.docId,
          planId: plan.planId,
          stepId: step.stepId
        });
      } catch {}
      return { ...entry, error };
    }
    return entry;
  }

  async diagnose(planId, stepIdValue) {
    const plan = await this.load(planId);
    if (!plan) throw new Error(`计划 ${planId} 不存在`);
    const step = plan.steps.find((item) => item.stepId === stepIdValue);
    if (!step) throw new Error(`步骤 ${stepIdValue} 不存在`);
    const conn = this.service.connections.get(plan.connectionId);
    if (!conn || conn.status !== "open") throw new Error("设备连接已关闭");
    const vendor = getVendor(plan.device?.vendor) ?? this._vendorForConn(conn);
    const failure = step.error;
    if (!failure) return { planId, stepId: stepIdValue, probes: [], message: "该步骤没有失败记录" };
    const command = failure.command ?? step.commands[0]?.text ?? "";
    const tokenIndex = Number.isInteger(failure.tokenIndex) ? failure.tokenIndex : -1;
    const prefixes = [];
    if (tokenIndex > 0) prefixes.push(command.slice(0, tokenIndex).trim());
    const firstWord = command.split(/\s+/)[0];
    if (firstWord) prefixes.push(firstWord);
    prefixes.push(command.replace(/\s+\S+\s*$/, "").trim());
    const probes = [];
    for (const prefix of [...new Set(prefixes)].filter(Boolean).slice(0, 3)) {
      try {
        const result = await probeHelp(this.service, conn, `${prefix} `, { vendor });
        probes.push({ prefix, output: cleanCommandOutput(result.text, "").slice(0, 1_500) });
      } catch (error) {
        probes.push({ prefix, output: `probe failed: ${error.message}` });
      }
    }
    return {
      planId,
      stepId: stepIdValue,
      command,
      token: failure.token,
      errorText: failure.message,
      probes,
      guidance:
        "根据帮助输出确认正确的命令/参数；修改该步骤后调用 plan_revise，计划会回到未批准状态，需要操作者重新确认。"
    };
  }

  async revise(planId, stepIdValue, replacement, reason = "") {
    const plan = await this.load(planId);
    if (!plan) throw new Error(`计划 ${planId} 不存在`);
    const index = plan.steps.findIndex((item) => item.stepId === stepIdValue);
    if (index < 0) throw new Error(`步骤 ${stepIdValue} 不存在`);
    const merged = {
      ...plan,
      steps: plan.steps.map((step, stepIndex) => (stepIndex === index ? replacement : step))
    };
    const { errors, warnings, plan: validated } = validatePlanInput(merged);
    if (errors.length) {
      const error = new Error(`修订校验失败：\n${errors.join("\n")}`);
      error.code = "plan-invalid";
      throw error;
    }
    const next = {
      ...plan,
      steps: validated.steps,
      warnings: [...(plan.warnings ?? []), ...warnings, reason ? `修订原因：${reason}` : ""].filter(Boolean),
      status: "draft",
      approval: { status: "none", hash: null, at: null, by: null },
      risk: validated.risk
    };
    // Preserve completed steps before the failure.
    for (let cursor = 0; cursor < index; cursor += 1) {
      next.steps[cursor].status = plan.steps[cursor].status;
    }
    return this.save(next);
  }

  async pause(planId) {
    const plan = await this.load(planId);
    if (!plan) throw new Error(`计划 ${planId} 不存在`);
    plan.status = "paused";
    await this.save(plan);
    return plan;
  }

  async abort(planId) {
    const plan = await this.load(planId);
    if (!plan) throw new Error(`计划 ${planId} 不存在`);
    plan.status = "aborted";
    await this.save(plan);
    return plan;
  }

  async resume(planId) {
    const plan = await this.load(planId);
    if (!plan) throw new Error(`计划 ${planId} 不存在`);
    return this.execute(planId, { resume: true });
  }
}

function digestOutputs(outputs) {
  return outputs.map((output) => `${output.command}=>${output.status}`).join("; ");
}

function summarizeOutputs(outputs) {
  return outputs.map((output) => ({
    command: output.command,
    status: output.status,
    output: String(output.output ?? "").slice(0, 1_000),
    durationMs: output.durationMs
  }));
}