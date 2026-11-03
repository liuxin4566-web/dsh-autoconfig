import { Context } from "@deepseek-ai/cordis";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AutoConfigService from "../src/index.js";
import { runCommand } from "../src/rag/terminal.js";
import { getVendor } from "../src/rag/vendors.js";

const PASSWORD = process.env.HCL_PASS;
if (!PASSWORD) { console.error("HCL_PASS required"); process.exit(2); }
const ctx = new Context();
ctx.reflect.provide("tools", { register() {} });
ctx.reflect.provide("credentials", { async set() {}, async unset() {}, async resolve() { return { value: PASSWORD, source: "test" }; }, async describe() { return { configured: true, writable: true }; } });
const logDir = await mkdtemp(join(tmpdir(), "ac-mode-"));
const service = new AutoConfigService(ctx, {
  logDir,
  profileFile: join(logDir, "profiles.json"),
  rag: { autoStart: false, autoCollect: false, dataDir: "E:\\dsh-autoconfig-data" }
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const connected = await service.connect({ protocol: "ssh", host: "192.168.0.200", port: 22, username: "admin", password: PASSWORD, name: "HCL-MODE", legacy: true });
  if (!connected.ok) throw new Error(connected.error?.message);
  const connectionId = connected.value.connectionId;
  const conn = service.connections.get(connectionId);
  const vendor = getVendor("h3c");
  await sleep(1000);

  const base = {
    connectionId,
    docRefs: [{ docId: "test", title: "test", section: "test" }],
    steps: [{
      title: "创建 VLAN 202",
      commands: [
        { text: "vlan 202", explanation: "创建 VLAN 202 用于视图检测测试。" },
        { text: "quit", explanation: "退出 VLAN 视图。" },
        { text: "return", explanation: "回到用户视图。" }
      ],
      verify: [{ text: "display vlan 202", expect: "VLAN ID: 202" }],
      rollback: [{ text: "undo vlan 202", explanation: "删除 VLAN 202。" }]
    }]
  };

  const p1 = await service.rag.createPlan({ ...base, summary: "用户视图创建计划" });
  console.log("p1 mode", p1.mode.mode, "adjustments", p1.adjustments);
  console.log("p1 first command", p1.steps[0].commands[0].text);

  await service.rag.approvePlan(p1.planId);
  console.log("p1 execute", JSON.stringify(await service.rag.executePlan(p1.planId)));

  await runCommand(service, conn, "system-view", { vendor, timeoutMs: 8000, source: "debug" });
  await sleep(300);
  const p2 = await service.rag.createPlan({ ...base, summary: "系统视图创建计划" });
  console.log("p2 mode", p2.mode.mode, "adjustments", p2.adjustments);
  console.log("p2 first command", p2.steps[0].commands[0].text);

  // Runtime fallback: create a plan in user view with system-view, then enter
  // system view before execution. The runner must skip the duplicate command.
  await runCommand(service, conn, "return", { vendor, timeoutMs: 8000, source: "debug" });
  await sleep(300);
  const p3 = await service.rag.createPlan({
    connectionId,
    docRefs: [{ docId: "test", title: "test", section: "test" }],
    summary: "运行期视图跳过测试",
    steps: [{
      title: "查看版本",
      commands: [
        { text: "system-view", explanation: "进入系统视图。" },
        { text: "display version", explanation: "显示版本信息。" }
      ]
    }]
  });
  console.log("p3 create mode", p3.mode.mode, "first", p3.steps[0].commands[0].text);
  await runCommand(service, conn, "system-view", { vendor, timeoutMs: 8000, source: "debug" });
  await sleep(300);
  await service.rag.approvePlan(p3.planId);
  const r3 = await service.rag.executePlan(p3.planId);
  console.log("p3 execute", JSON.stringify(r3).slice(0, 900));

  await service.close({ connectionId });
} catch (error) {
  console.error("FAILED", error);
  process.exitCode = 1;
}
await service.rag.sidecar.stop().catch(() => {});
process.exit(process.exitCode ?? 0);