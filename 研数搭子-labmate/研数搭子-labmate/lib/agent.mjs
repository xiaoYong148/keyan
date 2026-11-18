import { randomUUID } from 'node:crypto';
import {
  columnByRef,
  groupSeries,
  isMissingValue,
  toNumeric,
} from './dataset.mjs';
import { ToolError, executeTool, validatePlanSteps } from './tools.mjs';
import {
  PlannerError,
  buildLocalPlan,
  detectUnsupported,
  validateResearchQuestion,
} from './planner.mjs';
import {
  DEEPSEEK_API_ENDPOINT,
  DEEPSEEK_PROVIDER,
  DeepSeekError,
  getDeepSeekConfig,
  requestDeepSeekToolPlan,
} from './llm.mjs';
import { buildReport, buildRunRecord } from './report.mjs';

export const AGENT_STEPS = Object.freeze([
  { id: 'inspect_data', label: '检查数据', en: 'INSPECT' },
  { id: 'understand', label: '理解问题', en: 'UNDERSTAND' },
  { id: 'plan', label: '制定计划', en: 'PLAN' },
  { id: 'execute', label: '执行分析', en: 'EXECUTE' },
  { id: 'verify', label: '校验结果', en: 'VERIFY' },
  { id: 'report', label: '生成报告', en: 'REPORT' },
]);

export class AgentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.details = details;
  }
}

function createRunId() {
  return `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function diffMs(startedAt) {
  return Date.now() - startedAt;
}

function publicStep(step) {
  return {
    id: step.id,
    label: step.label,
    en: step.en,
    status: step.status,
    detail: step.detail ?? '',
    startedAt: step.startedAt ?? null,
    completedAt: step.completedAt ?? null,
    durationMs: step.durationMs ?? null,
  };
}

function toolEventCall(call) {
  return {
    id: call.id,
    seq: call.seq,
    tool: call.tool,
    label: call.label,
    params: call.params,
    status: call.status,
    durationMs: call.durationMs ?? null,
    ...(call.status === 'success' ? { output: call.output } : { error: call.error ?? null }),
  };
}

function toSuggestionArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').slice(0, 5);
  return [];
}

function serializeAgentError(error) {
  if (error instanceof PlannerError) {
    return {
      code: error.code,
      message: error.message,
      suggestions: error.suggestions ?? [],
    };
  }
  if (error instanceof ToolError) {
    return {
      code: error.code,
      message: error.message,
      suggestions: ['可以用其他字段或换一份包含合适数值/分组字段的公开数据。'],
    };
  }
  if (error instanceof AgentError) {
    return {
      code: error.code,
      message: error.message,
      suggestions: toSuggestionArray(error.details?.suggestions),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: '分析过程中出现内部错误。数据没有被修改，请稍后重试。',
    suggestions: [],
  };
}

function modeFromConfig(config) {
  if (!config.enabled) {
    const placeholder = config.keyStatus === 'placeholder';
    return {
      type: 'demo',
      label: '演示模式',
      description: placeholder
        ? '检测到 DEEPSEEK_API_KEY 仍是模板占位值；使用本地规则规划与真实受控统计工具，未调用模型。'
        : '未配置 DEEPSEEK_API_KEY，使用本地规则规划与真实受控统计工具；未调用模型。',
      model: null,
      provider: DEEPSEEK_PROVIDER,
      endpoint: DEEPSEEK_API_ENDPOINT,
      planningSource: 'local_rules',
      fallbackReason: null,
      setupHint: placeholder
        ? '在后端 .env 中把 DEEPSEEK_API_KEY 从模板占位值替换为真实密钥并重启 npm start，才会启用 DeepSeek 工具调用。'
        : '在后端 .env 配置真实的 DEEPSEEK_API_KEY 并重启 npm start，即可启用 DeepSeek 官方 API 的工具调用。',
    };
  }
  return {
    type: 'model',
    label: 'DeepSeek 工具调用模式',
    description:
      'DeepSeek 仅通过官方 API 的 tool calls 选择受控分析工具；统计值与报告由本地工具执行生成。',
    model: config.model,
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_API_ENDPOINT,
    transport: 'deepseek_tool_calls',
    planningSource: 'deepseek_tool_calls',
    fallbackReason: null,
  };
}

function buildModelFallbackMode(config, reason) {
  return {
    type: 'fallback',
    label: '演示模式 · DeepSeek 回退',
    description:
      'DeepSeek 调用或工具计划校验未通过，已回退到本地规则规划；统计工具仍为真实执行。',
    model: config.model,
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_API_ENDPOINT,
    planningSource: 'local_rules',
    fallbackReason: reason,
  };
}

function withModelUsage(mode, usage) {
  if (!usage || (usage.promptTokens == null && usage.completionTokens == null)) return mode;
  return { ...mode, usage };
}

function requiredPlanShapeError(validatedSteps) {
  const summaries = validatedSteps.filter((step) => step.tool === 'group_summary');
  const correlation = validatedSteps.some((step) => step.tool === 'correlation_analysis');
  const groupTests = validatedSteps.filter(
    (step) => step.tool === 'one_way_anova' || step.tool === 'group_comparison',
  );
  if (summaryCount(summaries) === 0 && !correlation) {
    return '计划中缺少能够生成报告的分组汇总或相关性分析。';
  }
  for (const test of groupTests) {
    const hasSummary = summaries.some(
      (summary) =>
        summary.params.groupBy === test.params.groupBy &&
        summary.params.metric === test.params.metric,
    );
    if (!hasSummary) {
      return `计划中的 ${test.tool} 缺少同字段的 group_summary，报告无法建立证据链。`;
    }
  }
  return null;
}

function summaryCount(summaries) {
  return Array.isArray(summaries) ? summaries.length : 0;
}

function normalizeModelSteps(rawSteps) {
  const inspectionTools = new Set(['profile_dataset', 'missingness_report']);
  const filtered = rawSteps.filter((step) => !inspectionTools.has(step.tool));
  const seen = new Set();
  const deduped = [];
  for (const step of filtered) {
    const key = `${step.tool}:${JSON.stringify(step.params)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(step);
  }
  return {
    steps: deduped,
    removedInspectionSteps: rawSteps.length - filtered.length,
    removedDuplicateSteps: filtered.length - deduped.length,
  };
}

function localPlanningWarnings(dataset, plan) {
  const warnings = [];
  const usedNames = new Set();
  for (const step of plan.steps) {
    for (const value of Object.values(step.params ?? {})) {
      if (typeof value === 'string') usedNames.add(value);
      if (Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string') usedNames.add(item);
      }
    }
  }
  for (const name of usedNames) {
    const column = columnByRef(dataset, name);
    if (column && column.missingRate >= 0.3) {
      warnings.push(`「${column.label}」缺失率约 ${(column.missingRate * 100).toFixed(1)}%。`);
    }
  }
  if (dataset.quality.duplicateRowCount > 0) {
    warnings.push(`数据含 ${dataset.quality.duplicateRowCount} 行完全重复，本版不自动去重。`);
  }
  if (dataset.source?.dataCaveat) warnings.push(dataset.source.dataCaveat);
  if (dataset.kind !== 'sample') {
    warnings.push('上传数据仅在本机内存处理；请自行确认其为公开、非涉密数据。');
  }
  return warnings;
}

function check(status, id, label, detail) {
  return { id, label, status, detail };
}

function relativeDiff(a, b) {
  const denominator = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / denominator;
}

function independentGroupMeans(dataset, groupSummaryOutput) {
  const groupColumn = columnByRef(dataset, groupSummaryOutput.groupBy.name);
  const metricColumn = columnByRef(dataset, groupSummaryOutput.metric.name);
  if (!groupColumn || !metricColumn) return null;
  const { pairs } = groupSeries(dataset, groupColumn, metricColumn);
  const byGroup = new Map();
  for (const pair of pairs) {
    if (!byGroup.has(pair.group)) byGroup.set(pair.group, []);
    byGroup.get(pair.group).push(pair.value);
  }
  return new Map(
    [...byGroup.entries()].map(([group, values]) => [
      group,
      {
        n: values.length,
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      },
    ]),
  );
}

function recomputeCorrelation(dataset, pair) {
  const a = columnByRef(dataset, pair.fieldA);
  const b = columnByRef(dataset, pair.fieldB);
  if (!a || !b) return null;
  const xs = [];
  const ys = [];
  for (const row of dataset.rows) {
    const x = toNumeric(row[a.index]);
    const y = toNumeric(row[b.index]);
    if (x === null || y === null) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 3) return null;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let denominatorX = 0;
  let denominatorY = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    numerator += dx * dy;
    denominatorX += dx * dx;
    denominatorY += dy * dy;
  }
  if (denominatorX === 0 || denominatorY === 0) return null;
  return { n: xs.length, r: numerator / Math.sqrt(denominatorX * denominatorY) };
}

function verifyResult({ dataset, toolCalls, plan }) {
  const checks = [];
  const failures = [];
  const profileCall = toolCalls.find((call) => call.tool === 'profile_dataset');
  const missingnessCall = toolCalls.find((call) => call.tool === 'missingness_report');
  if (!profileCall || profileCall.status !== 'success') {
    failures.push(check('failed', 'profile-present', '数据概况存在', '缺少 profile_dataset 的成功输出。'));
  } else {
    const profile = profileCall.output;
    const shapeOk =
      profile.dataset?.rowCount === dataset.rowCount &&
      profile.dataset?.columnCount === dataset.columnCount;
    checks.push(
      check(
        shapeOk ? 'passed' : 'failed',
        'data-shape',
        '数据维度一致',
        shapeOk
          ? `${dataset.rowCount} 行 × ${dataset.columnCount} 列与工具输出一致。`
          : '工具输出的行数/列数与内存数据不一致。',
      ),
    );
    if (!shapeOk) failures.push(checks[checks.length - 1]);
  }

  if (!missingnessCall || missingnessCall.status !== 'success') {
    failures.push(
      check('failed', 'missingness-present', '缺失检查存在', '缺少 missingness_report 的成功输出。'),
    );
  } else {
    const output = missingnessCall.output;
    const summedMissing = Array.isArray(output.columns)
      ? output.columns.reduce((sum, column) => sum + (column.missing ?? 0), 0)
      : NaN;
    const missingConsistent = summedMissing === output.missingCells;
    checks.push(
      check(
        missingConsistent ? 'passed' : 'failed',
        'missingness-sum',
        '缺失计数一致',
        missingConsistent
          ? `字段缺失计数合计 ${summedMissing}，与总缺失单元格一致。`
          : '各字段缺失数之和与总缺失单元格不一致。',
      ),
    );
    if (!missingConsistent) failures.push(checks[checks.length - 1]);
    const completeRowsValid =
      Number.isInteger(output.completeRows) &&
      output.completeRows >= 0 &&
      output.completeRows <= output.rowCount;
    checks.push(
      check(
        completeRowsValid ? 'passed' : 'failed',
        'complete-rows',
        '完整行范围有效',
        `完整行 ${output.completeRows} / ${output.rowCount}。`,
      ),
    );
    if (!completeRowsValid) failures.push(checks[checks.length - 1]);
  }

  const plannedCalls = toolCalls.filter(
    (call) => !['profile_dataset', 'missingness_report'].includes(call.tool),
  );
  const expected = plan.steps.length;
  const executed = plannedCalls.filter((call) => call.status === 'success').length;
  const countOk = executed === expected;
  checks.push(
    check(
      countOk ? 'passed' : 'failed',
      'plan-executed',
      '计划工具全部执行',
      `计划 ${expected} 个分析工具，成功执行 ${executed} 个。`,
    ),
  );
  if (!countOk) failures.push(checks[checks.length - 1]);

  const groupSummaries = plannedCalls.filter(
    (call) => call.status === 'success' && call.tool === 'group_summary',
  );
  for (const call of groupSummaries) {
    const groups = call.output?.groups;
    if (!Array.isArray(groups) || groups.length < 2) {
      const failed = check(
        'failed',
        `group-shape-${call.id}`,
        '分组统计结构',
        `${call.id} 的输出分组不足。`,
      );
      checks.push(failed);
      failures.push(failed);
      continue;
    }
    const independent = independentGroupMeans(dataset, call.output);
    let meanOk = Boolean(independent);
    let nOk = Boolean(independent);
    let worstMeanDiff = 0;
    if (independent) {
      for (const group of groups) {
        const direct = independent.get(String(group.value));
        if (!direct) {
          meanOk = false;
          nOk = false;
          break;
        }
        if (direct.n !== group.n) nOk = false;
        worstMeanDiff = Math.max(worstMeanDiff, relativeDiff(direct.mean, group.mean));
        if (relativeDiff(direct.mean, group.mean) > 1e-9) meanOk = false;
      }
    }
    checks.push(
      check(
        nOk ? 'passed' : 'failed',
        `group-n-${call.id}`,
        '分组样本量复核',
        `${call.id}：${groups.length} 个分组的 n 与原始记录重算结果${nOk ? '一致' : '不一致'}。`,
      ),
    );
    if (!nOk) failures.push(checks[checks.length - 1]);
    checks.push(
      check(
        meanOk ? 'passed' : 'failed',
        `group-mean-${call.id}`,
        '分组均值独立复核',
        `${call.id}：分组均值最大相对误差 ${worstMeanDiff.toExponential(2)}。`,
      ),
    );
    if (!meanOk) failures.push(checks[checks.length - 1]);
  }

  const anovas = plannedCalls.filter(
    (call) => call.status === 'success' && call.tool === 'one_way_anova',
  );
  for (const call of anovas) {
    const out = call.output;
    const pOk = Number.isFinite(out.p) && out.p >= 0 && out.p <= 1;
    const dfOk =
      out.dfBetween === out.k - 1 &&
      out.dfWithin === out.n - out.k &&
      Number.isFinite(out.dfWithin) &&
      out.dfWithin > 0;
    const fOk = Number.isFinite(out.F) && out.F >= 0;
    const fatal = !pOk || !dfOk || !fOk;
    checks.push(
      check(
        fatal ? 'failed' : 'passed',
        `anova-invariants-${call.id}`,
        '方差分析不变量',
        fatal
          ? `${call.id}：F / 自由度 / p 值中存在越界或无效值。`
          : `${call.id}：F=${out.F.toFixed(3)}，df=(${out.dfBetween}, ${out.dfWithin})，p=${out.p.toExponential(2)}。`,
      ),
    );
    if (fatal) failures.push(checks[checks.length - 1]);
  }

  const comparisons = plannedCalls.filter(
    (call) => call.status === 'success' && call.tool === 'group_comparison',
  );
  for (const call of comparisons) {
    const out = call.output;
    const pOk = Number.isFinite(out.p) && out.p >= 0 && out.p <= 1;
    const diffOk =
      Number.isFinite(out.meanDiff) &&
      relativeDiff(out.meanDiff, out.groupA.mean - out.groupB.mean) < 1e-9;
    const ciOk =
      Array.isArray(out.meanDiffCi95) &&
      Number.isFinite(out.meanDiffCi95[0]) &&
      Number.isFinite(out.meanDiffCi95[1]) &&
      out.meanDiffCi95[0] <= out.meanDiff &&
      out.meanDiff <= out.meanDiffCi95[1];
    const fatal = !pOk || !diffOk || !ciOk;
    checks.push(
      check(
        fatal ? 'failed' : 'passed',
        `comparison-invariants-${call.id}`,
        `Welch 结果不变量（${out.groupA.value} vs ${out.groupB.value}）`,
        fatal
          ? `${call.id}：均值差、95% CI 或 p 值未通过一致性检查。`
          : `${call.id}：均值差 = 组 A 均值 − 组 B 均值，且落在 95% CI 内。`,
      ),
    );
    if (fatal) failures.push(checks[checks.length - 1]);
  }

  const correlations = plannedCalls.filter(
    (call) => call.status === 'success' && call.tool === 'correlation_analysis',
  );
  for (const call of correlations) {
    const pairs = call.output?.pairs ?? [];
    let allOk = pairs.length > 0;
    let detail = `${call.id}：${pairs.length} 个字段对。`;
    for (const pair of pairs) {
      const r = pair.pearson?.r;
      const p = pair.pearson?.p;
      const ci = pair.pearson?.ci95;
      if (
        !Number.isFinite(r) ||
        r < -1 ||
        r > 1 ||
        !Number.isFinite(p) ||
        p < 0 ||
        p > 1 ||
        !Array.isArray(ci) ||
        ci[0] > r ||
        ci[1] < r
      ) {
        allOk = false;
        detail = `${call.id}：字段对 ${pair.fieldA}/${pair.fieldB} 的 r、p 或置信区间不合法。`;
        break;
      }
    }
    if (allOk && call.output?.strongest) {
      const direct = recomputeCorrelation(dataset, call.output.strongest);
      if (!direct || direct.n !== call.output.strongest.n) {
        allOk = false;
        detail = `${call.id}：原始记录重算的样本量与工具输出不一致。`;
      } else if (relativeDiff(direct.r, call.output.strongest.pearson.r) > 1e-8) {
        allOk = false;
        detail = `${call.id}：原始记录独立重算的 Pearson r 与工具输出不一致。`;
      } else {
        detail += ` 最强相关字段对的 r 已由原始记录独立复算一致。`;
      }
    }
    checks.push(
      check(
        allOk ? 'passed' : 'failed',
        `correlation-invariants-${call.id}`,
        '相关性与样本量复核',
        allOk ? detail : detail,
      ),
    );
    if (!allOk) failures.push(checks[checks.length - 1]);
  }

  const warnings = [];
  const toolWarnings = new Set();
  for (const call of plannedCalls) {
    for (const warning of call.output?.warnings ?? []) {
      if (!toolWarnings.has(warning)) {
        toolWarnings.add(warning);
        warnings.push(warning);
      }
    }
  }
  if (failures.length > 0) {
    const error = new AgentError(
      'VERIFICATION_FAILED',
      '结果一致性校验未通过，已停止生成报告，避免展示不一致的统计数字。',
      { verification: { checks, failures, warnings } },
    );
    error.verification = { checks, failures, warnings };
    throw error;
  }
  return {
    status: warnings.length > 0 ? 'passed_with_warnings' : 'passed',
    checks,
    warnings,
    verifiedAt: nowIso(),
    summary: `通过 ${checks.length} 项一致性检查${
      warnings.length ? `，另有 ${warnings.length} 条方法提示` : ''
    }。`,
  };
}

/**
 * 执行一次完整 Agent 工作流。
 * 事件通过 onEvent 推送；最终返回 report/runRecord，由服务器负责存储与提供下载。
 */
export async function runAgent({
  dataset,
  question: rawQuestion,
  config = getDeepSeekConfig(),
  onEvent = () => {},
  signal,
  modelFetch = fetch,
}) {
  const runId = createRunId();
  const createdAt = nowIso();
  const startedAt = Date.now();
  const steps = AGENT_STEPS.map((step) => ({
    ...step,
    status: 'pending',
    detail: '',
    startedAt: null,
    completedAt: null,
    durationMs: null,
  }));
  const toolCalls = [];
  let activeStep = null;
  let currentPlan = null;
  let modeInfo = modeFromConfig(config);
  let modelDraft = null;
  let modelFallbackReason = null;
  let modelUsage = null;
  let seq = 0;

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // 前端断开不应影响分析本身；运行记录仍由调用方保存。
    }
  };

  const publicSteps = () => steps.map(publicStep);

  const setStep = (id, status, patch = {}) => {
    const step = steps.find((item) => item.id === id);
    if (!step) return;
    step.status = status;
    Object.assign(step, patch);
    activeStep = step.id;
    emit({
      type: 'step',
      runId,
      step: publicStep(step),
      steps: publicSteps(),
    });
    return step;
  };

  const beginStep = (id, detail) => {
    const step = setStep(id, 'running', {
      detail,
      startedAt: nowIso(),
      completedAt: null,
      durationMs: null,
    });
    return step;
  };

  const finishStep = (step, detail, status = 'success') => {
    step.status = status;
    step.detail = detail;
    step.completedAt = nowIso();
    step.durationMs = diffMs(Date.parse(step.startedAt));
    emit({ type: 'step', runId, step: publicStep(step), steps: publicSteps() });
  };

  const failStep = (step, error) => {
    if (!step) return;
    step.status = 'failed';
    step.detail = error.message;
    step.completedAt = nowIso();
    step.durationMs = diffMs(Date.parse(step.startedAt));
    emit({ type: 'step', runId, step: publicStep(step), steps: publicSteps() });
  };

  const runInspectionTool = (tool, params) => {
    seq += 1;
    const id = `call_${String(seq).padStart(3, '0')}`;
    const startedAtIso = nowIso();
    const startPerf = Date.now();
    try {
      const result = executeTool(dataset, tool, params);
      const call = {
        id,
        seq,
        tool: result.tool,
        label: result.label,
        params: result.params,
        status: 'success',
        startedAt: startedAtIso,
        completedAt: nowIso(),
        durationMs: result.durationMs,
        output: result.output,
      };
      toolCalls.push(call);
      emit({ type: 'tool', runId, call: toolEventCall(call) });
      return call;
    } catch (error) {
      const call = {
        id,
        seq,
        tool,
        label: tool,
        params,
        status: 'failed',
        startedAt: startedAtIso,
        completedAt: nowIso(),
        durationMs: Date.now() - startPerf,
        error: serializeAgentError(error),
      };
      toolCalls.push(call);
      emit({ type: 'tool', runId, call: toolEventCall(call) });
      throw error;
    }
  };

  emit({
    type: 'run_started',
    runId,
    createdAt,
    question: rawQuestion,
    dataset: {
      id: dataset.id,
      name: dataset.name,
      rowCount: dataset.rowCount,
      columnCount: dataset.columnCount,
      kind: dataset.kind,
    },
    mode: modeInfo,
    steps: publicSteps(),
  });

  try {
    if (signal?.aborted) {
      throw new AgentError('ABORTED', '运行已停止。');
    }
    const question = validateResearchQuestion(rawQuestion);

    // 1. 检查数据：真实调用两个工具。
    let step = beginStep('inspect_data', '读取字段结构，执行数据概况与缺失检查…');
    try {
      const profileCall = runInspectionTool('profile_dataset', {});
      const missingnessCall = runInspectionTool('missingness_report', {});
      const profile = profileCall.output;
      finishStep(
        step,
        `${profile.dataset.rowCount} 行 × ${profile.dataset.columnCount} 列；识别 ${profile.numericFields.length} 个数值字段、${profile.groupCandidates.length} 个可分组字段、${missingnessCall.output.duplicateRowCount} 行重复记录。`,
      );
    } catch (error) {
      failStep(step, error);
      throw new AgentError('INSPECTION_FAILED', `数据检查失败：${error.message}`, {
        cause: error,
      });
    }

    // 2. 理解问题：本地先做不支持范围检查；DeepSeek 模式请求原生 tool calls。
    step = beginStep('understand', '解析研究问题，确认当前受控工具能回答的范围…');
    const unsupportedRule = detectUnsupported(question);
    if (unsupportedRule) {
      throw new PlannerError(
        unsupportedRule.code,
        unsupportedRule.reason,
        unsupportedRule.suggestions,
      );
    }
    if (config.enabled) {
      setStep('understand', 'running', {
        detail: `正在请求 DeepSeek 官方 API（${config.model}）选择分析工具；只发送问题、字段结构与聚合概况…`,
      });
      try {
        modelDraft = await requestDeepSeekToolPlan({
          config,
          dataset,
          question,
          fetchImpl: modelFetch,
          signal,
        });
        modelUsage = modelDraft.usage;
        modeInfo = withModelUsage(modeFromConfig(config), modelUsage);
        finishStep(
          step,
          `DeepSeek 通过原生 tool calls 返回 ${modelDraft.steps.length} 个分析工具选择；下一步逐项校验工具名、字段与参数。`,
        );
        emit({ type: 'mode', runId, mode: modeInfo });
      } catch (error) {
        const reason =
          error instanceof DeepSeekError
            ? error.message
            : `DeepSeek 工具调用响应无法使用：${error.message}`;
        modelFallbackReason = reason;
        modeInfo = withModelUsage(buildModelFallbackMode(config, reason), modelUsage);
        finishStep(
          step,
          `DeepSeek 暂未返回可用工具调用，已透明回退到本地规则规划。原因：${reason}`,
        );
        emit({ type: 'mode', runId, mode: modeInfo, warning: reason });
      }
    } else {
      finishStep(
        step,
        '演示模式：未配置 DEEPSEEK_API_KEY，使用本地确定性规则理解问题，不调用任何模型。',
      );
      emit({ type: 'mode', runId, mode: modeInfo });
    }

    // 3. 制定计划：计划必须来自受控注册表，并逐项校验字段/参数。
    step = beginStep('plan', '把问题转换成受控工具步骤，并校验字段与参数…');
    let validatedPlan;
    let usingModelPlan = false;
    let modelPlanNotes = [];
    try {
      if (modelDraft && !modelFallbackReason) {
        usingModelPlan = true;
        const { steps: filteredSteps, removedInspectionSteps, removedDuplicateSteps } =
          normalizeModelSteps(modelDraft.steps);
        if (removedInspectionSteps > 0) {
          modelPlanNotes.push(
            `DeepSeek 返回了 ${removedInspectionSteps} 个已执行过的数据检查步骤，已去重。`,
          );
        }
        if (removedDuplicateSteps > 0) {
          modelPlanNotes.push(`DeepSeek 返回了 ${removedDuplicateSteps} 个重复工具步骤，已去重。`);
        }
        if (filteredSteps.length === 0) {
          throw new ToolError('EMPTY_PLAN', 'DeepSeek 工具调用移除重复步骤后没有分析步骤。');
        }
        const normalized = validatePlanSteps(dataset, filteredSteps);
        const shapeError = requiredPlanShapeError(normalized);
        if (shapeError) {
          throw new ToolError('INVALID_PLAN_SHAPE', shapeError);
        }
        validatedPlan = {
          intent: modelDraft.intent,
          interpretation: modelDraft.interpretation,
          steps: normalized,
          source: 'model',
          transport: modelDraft.transport,
          selectionNotes: [
            ...(modelDraft.caveats ?? []).map((item) => `DeepSeek 规划说明：${item}`),
            ...modelPlanNotes,
            '工具选择由 DeepSeek 官方 API 原生 tool calls 返回；本地注册表重新校验参数后才执行。',
          ],
          warnings: localPlanningWarnings(dataset, { steps: normalized }),
          model: {
            provider: DEEPSEEK_PROVIDER,
            endpoint: DEEPSEEK_API_ENDPOINT,
            model: config.model,
            usage: modelUsage,
            requestId: modelDraft.requestId,
            finishReason: modelDraft.finishReason,
          },
        };
      } else {
        const localPlan = buildLocalPlan(dataset, question);
        const normalized = validatePlanSteps(dataset, localPlan.steps);
        const shapeError = requiredPlanShapeError(normalized);
        if (shapeError) {
          throw new ToolError('INVALID_PLAN_SHAPE', shapeError);
        }
        validatedPlan = {
          ...localPlan,
          steps: normalized,
          warnings: [...new Set(localPlan.warnings ?? [])],
          selectionNotes: [...(localPlan.selectionNotes ?? [])],
        };
      }
    } catch (error) {
      // DeepSeek 工具调用被拒时，本地规则再尝试一次；所有回退都有明确提示。
      if (usingModelPlan) {
        const reason = `DeepSeek 工具调用未通过校验：${error.message}`;
        modelFallbackReason = reason;
        modeInfo = withModelUsage(buildModelFallbackMode(config, reason), modelUsage);
        try {
          const localPlan = buildLocalPlan(dataset, question);
          const normalized = validatePlanSteps(dataset, localPlan.steps);
          const shapeError = requiredPlanShapeError(normalized);
          if (shapeError) throw new ToolError('INVALID_PLAN_SHAPE', shapeError);
          validatedPlan = {
            ...localPlan,
            steps: normalized,
            warnings: [
              ...new Set([
                ...(localPlan.warnings ?? []),
                ...localPlanningWarnings(dataset, localPlan),
                reason,
              ]),
            ],
            selectionNotes: [...(localPlan.selectionNotes ?? []), ...modelPlanNotes],
          };
          emit({ type: 'mode', runId, mode: modeInfo, warning: reason });
        } catch (localError) {
          failStep(step, error);
          throw new AgentError(
            'PLAN_FAILED',
            `DeepSeek 工具调用未通过校验，本地规则也未能形成可行计划：${localError.message}`,
            { cause: localError },
          );
        }
      } else {
        failStep(step, error);
        throw error;
      }
    }

    currentPlan = validatedPlan;
    emit({
      type: 'plan',
      runId,
      plan: {
        intent: currentPlan.intent,
        interpretation: currentPlan.interpretation,
        source: currentPlan.source,
        selectionNotes: currentPlan.selectionNotes,
        warnings: currentPlan.warnings,
        steps: currentPlan.steps.map((planStep) => ({
          tool: planStep.tool,
          label: planStep.label,
          params: planStep.params,
          reason: planStep.reason,
        })),
      },
      mode: modeInfo,
    });
    finishStep(
      step,
      `${currentPlan.steps.length} 个受控工具通过校验：${currentPlan.steps
        .map((planStep) => planStep.tool)
        .join(' → ')}`,
    );

    // 4. 执行分析：只调用已校验的注册表工具。
    step = beginStep(
      'execute',
      `开始执行 ${currentPlan.steps.length} 个受控工具；不会运行 DeepSeek 生成的代码…`,
    );
    const analysisCalls = [];
    try {
      for (let index = 0; index < currentPlan.steps.length; index += 1) {
        if (signal?.aborted) {
          throw new AgentError('ABORTED', '运行已停止。');
        }
        const planStep = currentPlan.steps[index];
        setStep('execute', 'running', {
          detail: `正在执行 ${index + 1}/${currentPlan.steps.length}：${planStep.label}…`,
        });
        seq += 1;
        const id = `call_${String(seq).padStart(3, '0')}`;
        const startedAtIso = nowIso();
        const perf = Date.now();
        try {
          const result = executeTool(dataset, planStep.tool, planStep.params);
          const call = {
            id,
            seq,
            tool: result.tool,
            label: result.label,
            params: result.params,
            status: 'success',
            startedAt: startedAtIso,
            completedAt: nowIso(),
            durationMs: result.durationMs,
            output: result.output,
          };
          toolCalls.push(call);
          analysisCalls.push(call);
          emit({ type: 'tool', runId, call: toolEventCall(call) });
        } catch (error) {
          const call = {
            id,
            seq,
            tool: planStep.tool,
            label: planStep.label,
            params: planStep.params,
            status: 'failed',
            startedAt: startedAtIso,
            completedAt: nowIso(),
            durationMs: Date.now() - perf,
            error: serializeAgentError(error),
          };
          toolCalls.push(call);
          emit({ type: 'tool', runId, call: toolEventCall(call) });
          throw error;
        }
      }
      finishStep(
        step,
        `${currentPlan.steps.length} 个受控工具真实执行完成；原始输出已记录，未使用 DeepSeek 生成的统计数字。`,
      );
    } catch (error) {
      failStep(step, error);
      const suggestions =
        error instanceof ToolError
          ? [
              '检查相关分组是否有足够的有效样本（建议每组至少 2 个）。',
              '如果数据量较小或缺失较多，请简化问题或换一份更完整的数据。',
            ]
          : error instanceof PlannerError
            ? error.suggestions
            : [];
      throw new AgentError(
        'EXECUTION_FAILED',
        error instanceof ToolError
          ? `工具执行失败：${error.message}`
          : `分析执行失败：${error.message}`,
        { cause: error, suggestions },
      );
    }

    // 5. 校验结果：独立复算均值/相关，检查 p、CI、样本量与计划完整性。
    step = beginStep('verify', '独立复核样本量、分组均值和相关系数，检查统计量边界…');
    let verification;
    try {
      verification = verifyResult({ dataset, toolCalls, plan: currentPlan });
      finishStep(
        step,
        verification.summary,
      );
      emit({
        type: 'verification',
        runId,
        verification: {
          status: verification.status,
          summary: verification.summary,
          checks: verification.checks,
          warnings: verification.warnings,
        },
      });
    } catch (error) {
      failStep(step, error);
      if (error instanceof AgentError && error.code === 'VERIFICATION_FAILED') {
        throw new AgentError('VERIFICATION_FAILED', error.message, {
          verification: error.verification,
        });
      }
      throw new AgentError('VERIFICATION_ERROR', `结果校验失败：${error.message}`);
    }

    // 6. 生成报告：所有数字只在展示层格式化，来源仍是工具输出。
    step = beginStep('report', '从工具证据生成报告、图表与可导出运行记录…');
    let report;
    let runRecord;
    try {
      const completedAt = nowIso();
      report = buildReport({
        runId,
        dataset,
        question,
        plan: currentPlan,
        modeInfo,
        steps,
        toolCalls,
        verification,
        createdAt,
        generatedAt: completedAt,
        durationMs: Date.now() - startedAt,
      });
      runRecord = buildRunRecord({
        runId,
        dataset,
        question,
        plan: currentPlan,
        modeInfo,
        steps,
        toolCalls,
        verification,
        report,
        createdAt,
        completedAt,
        durationMs: Date.now() - startedAt,
      });
      const chartCount = report.charts.length;
      const tableCount = report.tables.length;
      finishStep(
        step,
        `报告已生成：${report.findings.length} 条关键发现、${chartCount} 张图、${tableCount} 张统计表；含 ${toolCalls.length} 条工具证据。`,
      );
      // 报告是在“生成报告”步骤运行期间构建的；步骤完成后同步证据快照，
      // 避免导出的报告里最后一步永远停留在 running。
      const finalizedSteps = steps.map(publicStep);
      report.trace.steps = finalizedSteps.map((item) => ({
        id: item.id,
        label: item.label,
        status: item.status,
        durationMs: item.durationMs,
        detail: item.detail,
      }));
      runRecord.agent.steps = finalizedSteps.map((item) => ({
        id: item.id,
        label: item.label,
        status: item.status,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        durationMs: item.durationMs,
        detail: item.detail,
      }));
      runRecord.durationMs = Date.now() - startedAt;
      report.durationMs = runRecord.durationMs;
    } catch (error) {
      failStep(step, error);
      throw new AgentError('REPORT_FAILED', `报告生成失败：${error.message}`);
    }

    return {
      ok: true,
      runId,
      report,
      runRecord,
      modeInfo,
      durationMs: Date.now() - startedAt,
      steps: steps.map(publicStep),
      toolCalls,
    };
  } catch (error) {
    if (activeStep) {
      const step = steps.find((item) => item.id === activeStep);
      if (step && step.status === 'running') failStep(step, error);
    }
    const serialized = serializeAgentError(error);
    emit({
      type: 'failed',
      runId,
      error: {
        ...serialized,
        ...(error instanceof AgentError && error.details?.verification
          ? { verification: error.details.verification }
          : {}),
      },
      steps: publicSteps(),
      mode: modeInfo,
      toolCalls: toolCalls.map(toolEventCall),
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      runId,
      error: serialized,
      steps: steps.map(publicStep),
      toolCalls,
      modeInfo,
      durationMs: Date.now() - startedAt,
    };
  }
}

export { getDeepSeekConfig };
