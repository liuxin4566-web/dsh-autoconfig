import { Context } from "@deepseek-ai/cordis";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AutoConfigService from "../src/index.js";

const PASSWORD = process.env.HCL_PASS;
if (!PASSWORD) { console.error("HCL_PASS required"); process.exit(2); }
const ctx = new Context();
ctx.reflect.provide("tools", { register() {} });
ctx.reflect.provide("credentials", {
  async set() {}, async unset() {}, async resolve() { return { value: PASSWORD, source: "test" }; }, async describe() { return { configured: true, writable: true }; }
});
const logDir = await mkdtemp(join(tmpdir(), "ac-rag-error-"));
const service = new AutoConfigService(ctx, {
  logDir,
  profileFile: join(logDir, "profiles.json"),
  rag: {
    dataDir: process.env.DSH_AUTOCONFIG_KB ?? "E:\\dsh-autoconfig-data",
    python: process.env.DSH_AUTOCONFIG_PYTHON,
    modelPath: process.env.DSH_AUTOCONFIG_MODEL,
    device: "cuda",
    autoStart: true
  }
});
await service.rag.init();

try {
  const connected = await service.connect({ protocol: "ssh", host: "192.168.0.200", port: 22, username: "admin", password: PASSWORD, name: "HCL-ERR", legacy: true });
  console.log("connect", connected.ok, connected.error?.message);
  if (!connected.ok) process.exit(1);
  const connectionId = connected.value.connectionId;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const profile = await service.rag.collect(connectionId, "h3c");
  console.log("profile", profile.model, profile.version);

  const plan = await service.rag.createPlan({
    query: "查询接口（故意使用错误命令）",
    summary: "错误命令自愈测试",
    connectionId,
    device: { vendor: profile.vendor, platform: profile.platform, model: profile.model, version: profile.version },
    docRefs: [{ docId: "test", title: "test", section: "test" }],
    steps: [{
      title: "查询接口状态",
      intent: "验证错误识别与 ? 诊断",
      commands: [{ text: "display ip interface briefion", explanation: "故意拼错 briefion，预期设备返回 ^ 错误。", risk: "low" }]
    }]
  });
  console.log("plan", plan.planId, plan.status, plan.risk);
  await service.rag.approvePlan(plan.planId);
  const first = await service.rag.executePlan(plan.planId);
  console.log("first execute", JSON.stringify(first, null, 2).slice(0, 2000));

  const diagnosis = await service.rag.diagnosePlan(plan.planId, "s1");
  console.log("diagnosis", JSON.stringify(diagnosis, null, 2).slice(0, 3000));

  await service.rag.revisePlan(plan.planId, "s1", {
    title: "查询接口状态",
    intent: "使用正确命令验证",
    commands: [{ text: "display ip interface brief", explanation: "显示三层接口的 IP 地址与状态。", risk: "low" }],
    verify: []
  }, "根据 ? 帮助修正拼写");
  console.log("revised");
  await service.rag.approvePlan(plan.planId);
  const second = await service.rag.executePlan(plan.planId);
  console.log("second execute", JSON.stringify(second, null, 2).slice(0, 3000));
  await service.close({ connectionId });
} catch (error) {
  console.error("FAILED", error);
  process.exitCode = 1;
} finally {
  await service.rag.sidecar.stop().catch(() => {});
}