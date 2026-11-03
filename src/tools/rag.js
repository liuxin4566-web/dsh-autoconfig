/**
 * Agent tools for the RAG knowledge base and the configuration plan workflow.
 *
 * The intended sequence is: device_profile -> kb_search -> plan_create ->
 * (operator approves in the panel) -> plan_execute -> plan_diagnose/plan_revise
 * on failure. Raw device_send is deliberately not part of this flow: config
 * commands must be reviewable as a plan before they reach the terminal.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

function compactProfile(profile) {
  if (!profile) return profile;
  const { raw, ...rest } = profile;
  return rest;
}

function summarizeHit(hit) {
  return {
    docId: hit.docId,
    title: hit.title,
    vendor: hit.vendor,
    section: hit.section,
    locator: hit.locator,
    score: hit.score,
    via: hit.via,
    matchedEntities: hit.matchedEntities?.slice(0, 4) ?? [],
    match: hit.match,
    text: String(hit.text ?? "").slice(0, 900)
  };
}

function planText(plan) {
  const lines = [];
  lines.push(`计划 ${plan.planId}（风险 ${plan.risk}，${plan.steps.length} 步）`);
  for (const step of plan.steps) {
    lines.push(`\n${step.stepId}. ${step.title}${step.intent ? ` — ${step.intent}` : ""}`);
    for (const command of step.commands) {
      lines.push(`  $ ${command.text}`);
      lines.push(`    解释：${command.explanation}`);
    }
    if (step.verify?.length) lines.push(`  验证：${step.verify.map((item) => item.text).join("；")}`);
    if (step.rollback?.length) lines.push(`  回滚：${step.rollback.map((item) => item.text).join("；")}`);
  }
  return lines.join("\n");
}

export function registerRagTools(ctx, manager) {
  ctx.tools.register(defineTool({
    name: "kb_search",
    description:
      "Search the local vendor-manual knowledge base (TGM entity graph + BM25 + dense vectors) and return cited evidence. " +
      "Call device_profile first so the search can filter by vendor/model/version. " +
      "Each hit carries docId, section path, page/line locator, score and channel. " +
      "If coverage is 'insufficient', say the manual does not cover the question instead of guessing.",
    parameters: {
      query: { type: "string", required: true, description: "Configuration question or keywords, e.g. 'VLAN 接口配置 IP 地址'." },
      connection_id: { type: "string", description: "Device connection whose profile should filter the search. Omit to use the active connection." },
      vendor: { type: "string", description: "Override vendor filter (h3c/huawei/maipu/ruijie/cisco)." },
      model: { type: "string", description: "Override device model filter." },
      version: { type: "string", description: "Override device software version filter." },
      top_k: { type: "integer", description: "Number of hits, 1-10 (default 6)." },
      doc_ids: { type: "array", items: { type: "string" }, description: "Restrict to specific documents." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        if (!value.hits?.length) return [{ type: "text", text: `未检索到相关手册片段（coverage=${value.coverage}）。${value.reason ?? ""}` }];
        const lines = value.hits.map((hit) =>
          `- [${hit.docId}] ${hit.title} · ${hit.section} · ${hit.locator} (score=${hit.score}, via=${hit.via.join("+")})\n${String(hit.text).slice(0, 500)}`
        );
        return [{ type: "text", text: `coverage=${value.coverage}  检索到 ${value.hits.length} 条：\n${lines.join("\n\n")}` }];
      }
    },
    async execute(args) {
      let device = null;
      if (args.connection_id || (!args.vendor && !args.model && !args.version)) {
        try {
          const profile = await manager.profile(args.connection_id);
          if (profile) device = { vendor: profile.vendor, model: profile.model, version: profile.version };
        } catch {}
      }
      if (args.vendor) device = { ...(device ?? {}), vendor: args.vendor };
      if (args.model) device = { ...(device ?? {}), model: args.model };
      if (args.version) device = { ...(device ?? {}), version: args.version };
      const result = await manager.search({
        query: args.query,
        device,
        topK: Math.max(1, Math.min(Number(args.top_k ?? 6), 10)),
        docIds: Array.isArray(args.doc_ids) ? args.doc_ids : undefined
      });
      return {
        coverage: result.coverage,
        reason: result.reason,
        device,
        signals: result.signals,
        docs: result.docs,
        hits: (result.hits ?? []).map(summarizeHit)
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: "kb_docs",
    description: "List documents in the local knowledge base with vendor/series/version metadata and index status.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        if (!value.docs?.length) return [{ type: "text", text: "知识库为空。请让操作者在右侧「知识库」抽屉上传 pdf/chm/md 手册。" }];
        return [{ type: "text", text: value.docs.map((doc) =>
          `${doc.docId}  ${doc.title}  [${doc.vendor}] ${doc.status}  ${doc.stats?.nodes ?? 0} 节点`
        ).join("\n") }];
      }
    },
    async execute() {
      const result = await manager.docs();
      return { docs: (result.docs ?? []).map((doc) => ({
        docId: doc.docId,
        title: doc.title,
        vendor: doc.vendor,
        series: doc.series,
        versions: doc.versions,
        status: doc.status,
        stats: doc.stats,
        error: doc.error
      })) };
    }
  }));

  ctx.tools.register(defineTool({
    name: "device_profile",
    description:
      "Read the device profile (vendor, model, software version, serial, hostname) and its matched manuals. " +
      "If no profile is cached, this runs read-only inspect commands (display version / display device manuinfo etc.) in the visible terminal. " +
      "Call this before kb_search and plan_create so commands are checked against the right manual version. " +
      "Set refresh=true after a device upgrade.",
    parameters: {
      connection_id: { type: "string", description: "Target connection. Omit to use the active device." },
      vendor: { type: "string", enum: ["h3c", "huawei", "maipu", "ruijie", "cisco"], description: "Force a vendor when the prompt is ambiguous." },
      refresh: { type: "boolean", description: "Re-run the collection commands even when a cached profile exists." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        const lines = [
          `${value.profile.hostname ?? value.profile.name} · ${value.profile.vendor}/${value.profile.platform} · ${value.profile.model ?? "型号未知"} · ${value.profile.version ?? "版本未知"}`,
          `序列号：${value.profile.serial ?? "未读取"}  deviceId：${value.profile.deviceId}`
        ];
        if (value.profile.bindings?.length) {
          lines.push("匹配手册：");
          for (const binding of value.profile.bindings) lines.push(`  ${binding.status}  ${binding.title} (${binding.docId})`);
        } else {
          lines.push("未匹配到手册：请上传对应厂商/型号/版本的手册。");
        }
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args) {
      const connectionId = args.connection_id;
      if (!args.refresh) {
        const cached = await manager.profile(connectionId);
        if (cached) return { profile: compactProfile(cached), cached: true };
      }
      const profile = await manager.collect(connectionId, args.vendor ?? null);
      return { profile: compactProfile(profile), cached: false };
    }
  }));

  ctx.tools.register(defineTool({
    name: "plan_create",
    description:
      "Create a reviewable configuration plan. Use the exact commands and section citations from kb_search. " +
      "Every command needs a Chinese explanation; config-changing steps need verify commands and rollback where possible. " +
      "The plan is NOT executed here: the operator must approve the whole plan in the right-side 「计划」 drawer, then call plan_execute. " +
      "Never send configuration through device_send directly.",
    parameters: {
      plan: {
        type: "object",
        required: true,
        additionalProperties: true,
        description: "Plan object: {summary, query, connectionId, docRefs:[{docId,title,section,locator}], steps:[{title,intent,commands:[{text,explanation,risk,reply}],verify:[{text,expect}],rollback:[{text}]}]}.",
        properties: {
          summary: { type: "string", description: "One-line goal." },
          query: { type: "string", description: "Original user request." },
          connectionId: { type: "string", description: "Target connection; defaults to the active one." },
          docRefs: { type: "array", items: { type: "object", additionalProperties: true }, description: "Manual citations used for this plan." },
          steps: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                title: { type: "string" },
                intent: { type: "string" },
                commands: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      text: { type: "string", required: true },
                      explanation: { type: "string", required: true },
                      risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
                      reply: {
                        oneOf: [
                          { type: "string" },
                          { type: "array", items: { type: "string" } }
                        ],
                        description: "Answers to interactive [Y/N] or file-name prompts, in order. An empty string presses Enter (keep the default)."
                      }
                    }
                  }
                },
                verify: { type: "array", items: { type: "object", additionalProperties: true } },
                rollback: { type: "array", items: { type: "object", additionalProperties: true } }
              }
            }
          }
        }
      }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        return [{ type: "text", text: `${planText(value)}\n\n状态：${value.approval}。请在右侧「计划」抽屉批准后调用 plan_execute。` }];
      }
    },
    async execute(args) {
      const plan = await manager.createPlan(args.plan);
      // Return only lossless primitives: the host snapshots tool output and
      // rejects any undefined/function value, including ones nested in the
      // original plan record.
      return {
        planId: String(plan.planId),
        risk: String(plan.risk ?? "low"),
        status: String(plan.status ?? "draft"),
        approval: String(plan.approval?.status ?? "none"),
        warnings: (plan.warnings ?? []).map((warning) => String(warning)),
        steps: (plan.steps ?? []).map((step) => ({
          stepId: String(step.stepId),
          title: String(step.title ?? ""),
          risk: String(step.risk ?? "low"),
          commands: (step.commands ?? []).map((command) => ({
            text: String(command.text ?? ""),
            explanation: String(command.explanation ?? "")
          }))
        }))
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: "plan_execute",
    description:
      "Execute an approved plan step by step in the right-side terminal. " +
      "The host rejects this call unless the operator approved the exact current plan hash in the panel. " +
      "On failure the plan pauses and returns the failed step, the raw output and the caret token; call plan_diagnose next.",
    parameters: {
      plan_id: { type: "string", required: true },
      resume: { type: "boolean", description: "Continue a paused plan after the failure was handled." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        const lines = [`计划 ${value.planId}：${value.status}`];
        for (const step of value.steps ?? []) lines.push(`${step.stepId}: ${step.status}`);
        if (value.error) lines.push(`失败：${value.error.message ?? JSON.stringify(value.error)}  修正位置：${value.error.token ?? "?"}`);
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args) {
      return manager.executePlan(args.plan_id, { resume: args.resume === true });
    }
  }));

  ctx.tools.register(defineTool({
    name: "plan_status",
    description: "Read one plan (including step status, approval hash and errors) or list recent plans.",
    parameters: {
      plan_id: { type: "string", description: "Omit to list plans." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        if (value.plans) {
          return [{ type: "text", text: value.plans.map((plan) => `${plan.planId}  ${plan.status}  ${plan.approval}  ${plan.title}`).join("\n") || "暂无计划" }];
        }
        return [{ type: "text", text: planText(value.plan) }];
      }
    },
    async execute(args) {
      if (!args.plan_id) return { plans: await manager.plansList() };
      const plan = await manager.planGet(args.plan_id);
      if (!plan) throw new Error(`计划 ${args.plan_id} 不存在`);
      return { plan };
    }
  }));

  ctx.tools.register(defineTool({
    name: "plan_diagnose",
    description:
      "Diagnose a failed plan step: parse the vendor caret (^) position and probe the CLI with `?` (no Enter) to list the valid next tokens. " +
      "Nothing is executed, so this runs without a new approval. Use the help output to build a corrected step for plan_revise.",
    parameters: {
      plan_id: { type: "string", required: true },
      step_id: { type: "string", required: true }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        const lines = [`失败命令：${value.command ?? ""}`, `错误：${value.errorText ?? ""}`, `可疑 token：${value.token ?? "未识别"}`];
        for (const probe of value.probes ?? []) lines.push(`\n[${probe.prefix} ?]\n${probe.output}`);
        lines.push(`\n${value.guidance ?? ""}`);
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args) {
      return manager.diagnosePlan(args.plan_id, args.step_id);
    }
  }));

  ctx.tools.register(defineTool({
    name: "plan_revise",
    description:
      "Replace one failed step with a corrected step. The plan returns to draft and must be approved again by the operator. " +
      "Use the `?` help from plan_diagnose instead of guessing tokens.",
    parameters: {
      plan_id: { type: "string", required: true },
      step_id: { type: "string", required: true },
      step: { type: "object", required: true, additionalProperties: true, description: "Replacement step: {title,intent,commands:[{text,explanation,risk}],verify,rollback}." },
      reason: { type: "string", description: "Why the command changed (stored in the plan history)." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        return [{ type: "text", text: `已修订 ${value.planId} 的 ${value.stepId}；计划回到 draft，需要操作者在面板重新批准。` }];
      }
    },
    async execute(args) {
      const plan = await manager.revisePlan(args.plan_id, args.step_id, args.step, args.reason ?? "");
      return { planId: plan.planId, stepId: args.step_id, status: plan.status, approval: plan.approval };
    }
  }));

  ctx.tools.register(defineTool({
    name: "plan_abort",
    description: "Abort a plan so no further steps are executed.",
    parameters: {
      plan_id: { type: "string", required: true }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) { return [{ type: "text", text: `计划 ${value.planId} 已中止` }]; }
    },
    async execute(args) {
      const plan = await manager.plans.abort(args.plan_id);
      return { planId: plan.planId, status: plan.status };
    }
  }));
}