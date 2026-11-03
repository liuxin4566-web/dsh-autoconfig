import { Context } from "@deepseek-ai/cordis";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AutoConfigService from "../src/index.js";

const PASSWORD = process.env.HCL_PASS;
if (!PASSWORD) { console.error("HCL_PASS required"); process.exit(2); }
const ctx = new Context();
ctx.reflect.provide("tools", { register() {} });
ctx.reflect.provide("credentials", { async set() {}, async unset() {}, async resolve() { return { value: PASSWORD, source: "test" }; }, async describe() { return { configured: true, writable: true }; } });
const logDir = await mkdtemp(join(tmpdir(), "ac-save-"));
const service = new AutoConfigService(ctx, {
  logDir,
  profileFile: join(logDir, "profiles.json"),
  rag: { autoStart: false, autoCollect: false, dataDir: "E:\\dsh-autoconfig-data" }
});
try {
  const connected = await service.connect({ protocol: "ssh", host: "192.168.0.200", port: 22, username: "admin", password: PASSWORD, name: "HCL-SAVE", legacy: true });
  console.log("connect", connected.ok, connected.error?.message);
  const connectionId = connected.value.connectionId;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const plan = await service.rag.createPlan({
    query: "保存当前配置",
    summary: "保存配置（交互式确认）",
    connectionId,
    docRefs: [{ docId: "test", title: "test", section: "save" }],
    steps: [{
      title: "保存配置",
      commands: [{ text: "save", explanation: "保存当前配置到启动文件；依次确认覆盖、保留默认文件名、覆盖已有文件。", risk: "high", reply: ["Y", "", "Y"] }]
    }]
  });
  await service.rag.approvePlan(plan.planId);
  const result = await service.rag.executePlan(plan.planId);
  console.log("execute", JSON.stringify(result, null, 2).slice(0, 2500));
  await service.close({ connectionId });
} catch (error) {
  console.error("FAILED", error);
  process.exitCode = 1;
}
await service.rag.sidecar.stop().catch(() => {});
process.exit(process.exitCode ?? 0);