import { Context } from "@deepseek-ai/cordis";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AutoConfigService from "../src/index.js";

const HOST = process.env.HCL_HOST ?? "192.168.0.200";
const USER = process.env.HCL_USER ?? "admin";
const PASSWORD = process.env.HCL_PASS;
const DATA_DIR = process.env.DSH_AUTOCONFIG_KB ?? "E:\\dsh-autoconfig-data";
const PYTHON = process.env.DSH_AUTOCONFIG_PYTHON;
const MODEL = process.env.DSH_AUTOCONFIG_MODEL;
if (!PASSWORD) {
  console.error("HCL_PASS is required");
  process.exit(2);
}

const ctx = new Context();
ctx.reflect.provide("tools", { register() {} });
ctx.reflect.provide("credentials", {
  async set() {},
  async unset() {},
  async resolve() { return { value: PASSWORD, source: "test" }; },
  async describe() { return { configured: true, writable: true }; }
});

const logDir = await mkdtemp(join(tmpdir(), "ac-rag-e2e-"));
const service = new AutoConfigService(ctx, {
  logDir,
  profileFile: join(logDir, "profiles.json"),
  rag: {
    dataDir: DATA_DIR,
    python: PYTHON,
    modelPath: MODEL,
    device: "cuda",
    autoStart: true
  }
});
await service.rag.init();

function log(...args) {
  console.log(...args);
}

try {
  const connected = await service.connect({
    protocol: "ssh",
    host: HOST,
    port: 22,
    username: USER,
    password: PASSWORD,
    name: "HCL-S5820",
    legacy: true
  });
  log("connect", JSON.stringify(connected));
  if (!connected.ok) process.exit(1);
  const connectionId = connected.value.connectionId;

  // Let the login banner settle before the first probe.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const profile = await service.rag.collect(connectionId, "h3c");
  log("profile", JSON.stringify({
    deviceId: profile.deviceId,
    hostname: profile.hostname,
    vendor: profile.vendor,
    platform: profile.platform,
    model: profile.model,
    version: profile.version,
    serial: profile.serial,
    bindings: profile.bindings
  }, null, 2));

  const search = await service.rag.search({
    query: "配置 VLAN 接口 IP 地址",
    device: { vendor: profile.vendor, model: profile.model, version: profile.version },
    topK: 4
  });
  log("search coverage", search.coverage, "signals", JSON.stringify(search.signals));
  for (const hit of search.hits) {
    log("HIT", hit.score, hit.via.join("+"), hit.section, hit.locator, "|", hit.text.slice(0, 80).replace(/\n/g, " "));
  }

  const plan = await service.rag.createPlan({
    query: "在 HCL 交换机上创建 VLAN 100 并验证",
    summary: "创建 VLAN 100",
    connectionId,
    device: { vendor: profile.vendor, platform: profile.platform, model: profile.model, version: profile.version },
    docRefs: [{ docId: search.hits[0]?.docId, title: search.hits[0]?.title, section: search.hits[0]?.section, locator: search.hits[0]?.locator }],
    steps: [
      {
        title: "创建 VLAN 100",
        intent: "验证计划审批与终端执行链路",
        commands: [
          { text: "system-view", explanation: "进入系统视图，后续配置都在系统视图下执行。", risk: "low" },
          { text: "vlan 100", explanation: "创建 VLAN 100 并进入 VLAN 视图；VLAN ID 范围 1-4094。", risk: "low" },
          { text: "quit", explanation: "退出 VLAN 视图回到系统视图。", risk: "low" }
        ],
        verify: [{ text: "display vlan 100", expect: "100" }],
        rollback: [{ text: "undo vlan 100", explanation: "删除 VLAN 100。" }]
      }
    ]
  });
  log("plan", plan.planId, plan.risk, plan.status, plan.approval.status);

  await service.rag.approvePlan(plan.planId);
  const result = await service.rag.executePlan(plan.planId);
  log("execute", JSON.stringify(result, null, 2));

  const after = await service.read({ connectionId, after: 0 });
  const text = Buffer.from(after.value.data, "base64").toString("utf8");
  log("terminal tail", text.slice(-1200));
  await service.close({ connectionId });
} catch (error) {
  console.error("FAILED", error);
  process.exitCode = 1;
} finally {
  await service.rag?.sidecar?.stop().catch(() => {});
  ctx.dispose?.();
}