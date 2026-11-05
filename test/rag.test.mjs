import test from "node:test";
import assert from "node:assert/strict";

import { canonicalHash, validatePlanInput } from "../src/rag/plans.js";
import { findError, classifyOutput } from "../src/rag/errors.js";
import { matchDocument } from "../src/rag/manager.js";
import { registerRagTools } from "../src/tools/rag.js";
import { adjustPlanForMode, detectCliMode } from "../src/rag/mode.js";
import { getVendor } from "../src/rag/vendors.js";
import { createTerminalHighlighter } from "../src/client/highlight.js";

test("plan validation rejects a command without explanation", () => {
  const { errors } = validatePlanInput({
    steps: [{ title: "x", commands: [{ text: "vlan 10" }] }]
  });
  assert.ok(errors.some((error) => error.includes("解释")));
});

test("plan validation accepts a grounded step and raises risk", () => {
  const { errors, plan } = validatePlanInput({
    connectionId: "ac-1",
    docRefs: [{ docId: "d1", title: "手册", section: "VLAN" }],
    steps: [{
      title: "创建 VLAN",
      commands: [{ text: "vlan 100", explanation: "创建 VLAN 100。", risk: "low" }],
      verify: [{ text: "display vlan 100", expect: "100" }],
      rollback: [{ text: "undo vlan 100" }]
    }]
  });
  assert.deepEqual(errors, []);
  assert.equal(plan.risk, "low");
  assert.equal(plan.steps[0].commands[0].text, "vlan 100");
});

test("approval hash changes when one command changes", () => {
  const base = {
    connectionId: "ac-1",
    steps: [{ stepId: "s1", commands: [{ text: "vlan 10" }] }]
  };
  const other = {
    connectionId: "ac-1",
    steps: [{ stepId: "s1", commands: [{ text: "vlan 20" }] }]
  };
  assert.notEqual(canonicalHash(base), canonicalHash(other));
});

test("caret line maps to the offending H3C token", () => {
  const raw = "<H3C>display ip interface briefion | include ssh\n                          ^\n % Wrong parameter found at '^' position.";
  const parsed = findError(raw, "h3c");
  assert.equal(parsed.isError, true);
  assert.ok(parsed.token);
  assert.match(parsed.message, /Wrong parameter/);
});

test("classifyOutput marks a caret error as failed but a normal display as ok", () => {
  const failed = classifyOutput("<H3C>dis foo\n     ^\n% Unrecognized command found at '^' position.", { vendorId: "h3c" });
  assert.equal(failed.status, "failed");
  const ok = classifyOutput("<H3C>display vlan 10\n VLAN ID: 10", { vendorId: "h3c" });
  assert.equal(ok.status, "ok");
});

test("document matching prefers vendor/model/version agreement", () => {
  const doc = { vendor: "h3c", series: ["S5820V2", "S5830V2"], versions: [{ raw: "7.1.075" }] };
  assert.equal(matchDocument(doc, { vendor: "h3c", model: "S5820V2-54QS-GE", version: "7.1.075" }).status, "exact");
  assert.equal(matchDocument(doc, { vendor: "h3c", model: "S5820V2-54QS-GE", version: "9.5.0.2" }).status, "partial");
  assert.equal(matchDocument(doc, { vendor: "huawei", model: "S5820V2", version: "7.1.075" }).status, "mismatch");
});

test("CLI mode detection distinguishes user, system and sub-views", () => {
  assert.equal(detectCliMode("<H3C>").mode, "user");
  assert.equal(detectCliMode("<H3C>\n[H3C]").mode, "system");
  assert.equal(detectCliMode("[H3C]\n[H3C-GigabitEthernet1/0/1]").mode, "subview");
  assert.equal(detectCliMode("SW(config)#").mode, "system");
  assert.equal(detectCliMode("SW(config-if)#").mode, "subview");
  assert.equal(detectCliMode("[plan] system-view\n<H3C>").mode, "user");
});

test("plan creation removes a redundant system-view in system view", () => {
  const { plan } = validatePlanInput({
    steps: [{
      commands: [
        { text: "system-view", explanation: "进入系统视图" },
        { text: "vlan 10", explanation: "创建 VLAN 10" }
      ]
    }]
  });
  const adjusted = adjustPlanForMode(plan, { mode: "system", label: "系统视图", prompt: "[H3C]" }, getVendor("h3c"));
  assert.equal(adjusted.plan.steps[0].commands[0].text, "vlan 10");
  assert.ok(adjusted.adjustments.some((item) => item.includes("已移除重复")));
});

test("plan creation inserts system-view when in user view", () => {
  const { plan } = validatePlanInput({
    steps: [{ commands: [{ text: "vlan 10", explanation: "创建 VLAN 10" }] }]
  });
  const adjusted = adjustPlanForMode(plan, { mode: "user", label: "用户视图", prompt: "<H3C>" }, getVendor("h3c"));
  assert.equal(adjusted.plan.steps[0].commands[0].text, "system-view");
  assert.ok(adjusted.adjustments.some((item) => item.includes("补充")));
});

test("read-only plans are not given a system-view entry", () => {
  const { plan } = validatePlanInput({
    steps: [{ commands: [{ text: "display version", explanation: "查看设备版本信息" }] }]
  });
  const adjusted = adjustPlanForMode(plan, { mode: "user", label: "用户视图", prompt: "<H3C>" }, getVendor("h3c"));
  assert.equal(adjusted.plan.steps[0].commands[0].text, "display version");
  assert.equal(adjusted.adjustments.length, 0);
});

test("keyword highlighter buffers lines split across terminal chunks", () => {
  const highlighter = createTerminalHighlighter(() => ({ enabled: true, background: "#000000" }));
  assert.equal(highlighter.transform("Interface Gigabit"), "");
  const output = highlighter.transform("Ethernet1/0/1 is UP\n");
  assert.match(output, /\x1b\[38;2;/);
  assert.match(output, /UP/);
  assert.equal(highlighter.flush(), "");

  highlighter.transform("prompt<H3C>");
  assert.equal(highlighter.flush(), "prompt<H3C>");
});

test("keyword highlighter passes data through when disabled", () => {
  const highlighter = createTerminalHighlighter(() => ({ enabled: false, background: "#000000" }));
  assert.equal(highlighter.transform("Interface UP"), "Interface UP");
  assert.equal(highlighter.flush(), "");
});

test("plan_create returns lossless JSON even when the plan has undefined fields", async () => {
  const tools = [];
  const manager = {
    async createPlan() {
      return {
        planId: "p1",
        risk: "low",
        status: "draft",
        approval: { status: "none" },
        warnings: [],
        pitfalls: [{ model: undefined, command: "x" }],
        steps: [{ stepId: "s1", title: "t", risk: "low", commands: [{ text: "vlan 1", explanation: "e" }] }]
      };
    }
  };
  registerRagTools({ tools: { register: (tool) => tools.push(tool) } }, manager);
  const tool = tools.find((item) => item.name === "plan_create");
  const value = await tool.execute({ plan: { steps: [{ commands: [{ text: "vlan 1", explanation: "e" }] }] } });
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  assert.equal(value.steps[0].commands[0].text, "vlan 1");
  const rendered = tool.output.render({}, value);
  assert.match(rendered[0].text, /vlan 1/);
});