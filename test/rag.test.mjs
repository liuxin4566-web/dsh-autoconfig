import test from "node:test";
import assert from "node:assert/strict";

import { canonicalHash, validatePlanInput } from "../src/rag/plans.js";
import { findError, classifyOutput } from "../src/rag/errors.js";
import { matchDocument } from "../src/rag/manager.js";
import { registerRagTools } from "../src/tools/rag.js";

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