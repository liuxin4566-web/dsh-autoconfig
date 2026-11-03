/**
 * CLI mode detection for config plans.
 *
 * Network CLIs are modal: `system-view` (Comware/VRP) or `configure terminal`
 * (IOS) only exist in user/privileged view. If a previous plan left the session
 * in system view, the next plan's `system-view` is rejected with
 * "% Unrecognized command found at '^' position.".
 *
 * The prompt is the only reliable signal, and it is already in the terminal
 * journal, so plan creation can adapt before anything is sent.
 */
import { stripAnsi } from "../prompt.js";

const ENTRY_COMMANDS = new Set(["system-view", "configure terminal", "conf t", "config terminal"]);
const EXIT_COMMANDS = new Set(["return", "end"]);

export function vendorPlatform(vendor) {
  return String(vendor?.platform ?? vendor?.id ?? "").toLowerCase();
}

export function entryCommandFor(vendor) {
  return vendorPlatform(vendor) === "ios" ? "configure terminal" : "system-view";
}

export function exitCommandFor(vendor) {
  return vendorPlatform(vendor) === "ios" ? "end" : "return";
}

export function isConfigMode(mode) {
  return mode === "system" || mode === "subview";
}

export function isEntryCommand(text) {
  return ENTRY_COMMANDS.has(String(text ?? "").trim().toLowerCase());
}

export function isExitCommand(text) {
  return EXIT_COMMANDS.has(String(text ?? "").trim().toLowerCase());
}

export function isReadOnlyCommand(text) {
  return /^(?:display|show|dir|ping|tracert|more|terminal length)\b/i.test(String(text ?? "").trim());
}

/**
 * Inspect the tail of the journal and return the last CLI prompt.
 * `[plan] ...` / `[probe] ...` markers are ignored because they are not a
 * standalone bracketed prompt like `[H3C]`.
 */
export function detectCliMode(raw) {
  const clean = stripAnsi(String(raw ?? "")).replace(/\r/g, "").replace(/[\u0000\u0007]/g, "");
  const lines = clean.split("\n").map((line) => line.trim()).filter(Boolean).slice(-40);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^<[^<>\r\n]{1,64}>$/.test(line)) {
      return { mode: "user", label: "用户视图", prompt: line };
    }
    if (/^\[~?[^[\]\r\n]{1,64}\]$/.test(line)) {
      const inner = line.slice(1, -1).replace(/^~/, "");
      const subview = inner.includes("-");
      return { mode: subview ? "subview" : "system", label: subview ? "子视图" : "系统视图", prompt: line };
    }
    if (/\(config(?:-[^)]+)?\)#$/.test(line)) {
      const subview = /\(config-[^)]+\)#/.test(line);
      return { mode: subview ? "subview" : "system", label: subview ? "子视图" : "系统视图", prompt: line };
    }
    if (/#$/.test(line)) {
      return { mode: "privileged", label: "特权视图", prompt: line };
    }
    if (/>$/.test(line)) {
      return { mode: "user", label: "用户视图", prompt: line };
    }
  }
  return { mode: "unknown", label: "未知视图", prompt: null };
}

function reindex(steps) {
  steps.forEach((step, index) => {
    step.stepId = `s${index + 1}`;
  });
  return steps;
}

/**
 * Adapt a validated plan to the current CLI mode.
 *
 * - already in system view and the plan starts with `system-view` -> remove it
 * - in user/privileged view and the plan configures something without an entry
 *   command -> prepend the vendor's entry command
 * - already in a sub-view -> warn (the operator/agent must decide whether to
 *   `quit` first); a redundant entry command is removed
 */
export function adjustPlanForMode(plan, modeInfo, vendor) {
  const next = JSON.parse(JSON.stringify(plan));
  const warnings = [];
  const adjustments = [];
  const entry = entryCommandFor(vendor);
  const mode = modeInfo?.mode ?? "unknown";
  const steps = next.steps ?? [];
  if (steps.length === 0) return { plan: next, warnings, adjustments };

  const firstStep = steps[0];
  const firstCommand = firstStep.commands?.[0];
  const firstText = String(firstCommand?.text ?? "").trim().toLowerCase();

  if (mode === "unknown") {
    warnings.push("无法识别当前终端视图，计划中的视图切换命令可能重复或被拒绝；执行前请确认提示符。");
  }

  if (isConfigMode(mode) && isEntryCommand(firstText)) {
    firstStep.commands.shift();
    adjustments.push(`当前已在${modeInfo.label}，已移除重复的 ${firstCommand.text}`);
    if (firstStep.commands.length === 0) {
      steps.shift();
      if (steps.length === 0) {
        warnings.push("移除重复的视图切换命令后计划为空，请重新生成。");
      }
    }
  } else if (mode === "subview") {
    warnings.push(`当前在${modeInfo.label}（${modeInfo.prompt}），计划中的命令可能先需要 quit/return；执行前请确认。`);
    if (isEntryCommand(firstText)) {
      firstStep.commands.shift();
      adjustments.push(`当前在${modeInfo.label}，无法直接执行 ${firstCommand.text}，已移除该命令`);
    }
  } else if ((mode === "user" || mode === "privileged") && !isEntryCommand(firstText)) {
    const configures = steps.some((step) => (step.commands ?? []).some((command) => !isReadOnlyCommand(command.text)));
    if (configures) {
      firstStep.commands.unshift({
        text: entry,
        explanation: `检测到当前在${modeInfo.label}，自动进入系统视图后再执行后续配置。`,
        risk: "low",
        expect: null,
        reply: null,
        replyWhen: null
      });
      adjustments.push(`当前在${modeInfo.label}，已在计划开头补充 ${entry}`);
    }
  }

  const allCommands = steps.flatMap((step) => step.commands ?? []);
  const last = allCommands[allCommands.length - 1];
  if (last && !isExitCommand(last.text) && steps.some((step) => (step.commands ?? []).some((command) => !isReadOnlyCommand(command.text)))) {
    warnings.push(`计划结束时可能停留在配置视图（最后一条是 "${last.text}"），建议末尾加 ${exitCommandFor(vendor)} 回到用户视图。`);
  }

  next.steps = reindex(steps);
  return { plan: next, warnings, adjustments };
}