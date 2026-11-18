import {
  columnByRef,
  groupSeries,
  isMissingValue,
  publicMissingness,
  publicProfile,
  toNumeric,
} from './dataset.mjs';
import { oneWayAnova, pearson, spearman, summarize, welchTTest } from './stats.mjs';

/**
 * 受控分析工具注册表。
 *
 * 安全边界：
 * - 模型只能选择这里的工具、字段和参数；
 * - 工具不接收代码、SQL、表达式或文件路径；
 * - 不执行任何模型生成的代码；
 * - 每个参数在执行前都会被规范化并校验。
 */

export const MAX_TOOL_STEPS = 10;
export const MAX_TOOL_OUTPUT_GROUPS = 12;

export class ToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolError('INVALID_PARAMS', '工具参数必须是一个 JSON 对象。');
  }
}

function assertAllowedParams(params, allowed) {
  assertPlainObject(params);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(params)) {
    if (!allowedSet.has(key)) {
      throw new ToolError('UNKNOWN_PARAM', `工具不支持参数「${key}」。`, { param: key });
    }
  }
}

function requireString(params, key, label) {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError('MISSING_PARAM', `缺少参数「${label}」，或参数不是有效文本。`, { param: key });
  }
  return value.trim();
}

function resolveNumericColumn(dataset, reference, label) {
  const column = columnByRef(dataset, reference);
  if (!column) {
    throw new ToolError('UNKNOWN_COLUMN', `找不到字段「${reference}」。可用字段：${dataset.columns
      .map((item) => item.name)
      .join('、')}。`, { field: reference });
  }
  if (column.type !== 'number' || !column.summary) {
    throw new ToolError(
      'WRONG_COLUMN_TYPE',
      `字段「${column.name}」不是可分析的数值字段（识别为${column.typeLabel}）。`,
      { field: column.name, type: column.type },
    );
  }
  if (column.nonMissing < 2) {
    throw new ToolError('INSUFFICIENT_DATA', `字段「${column.label}」的有效数值不足 2 个。`, {
      field: column.name,
      nonMissing: column.nonMissing,
    });
  }
  if (column.unique < 2) {
    throw new ToolError('ZERO_VARIANCE', `字段「${column.label}」是常量，无法进行${label}。`, {
      field: column.name,
    });
  }
  return column;
}

function resolveGroupColumn(dataset, reference) {
  const column = columnByRef(dataset, reference);
  if (!column) {
    throw new ToolError('UNKNOWN_COLUMN', `找不到分组字段「${reference}」。`, { field: reference });
  }
  if (column.nonMissing === 0) {
    throw new ToolError('EMPTY_COLUMN', `分组字段「${column.label}」全部为空。`, { field: column.name });
  }
  if (column.unique < 2) {
    throw new ToolError('NOT_ENOUGH_GROUPS', `分组字段「${column.label}」只有 1 个取值，无法比较。`, {
      field: column.name,
    });
  }
  if (!column.groupable) {
    throw new ToolError(
      'INVALID_GROUP_COLUMN',
      `字段「${column.label}」不适合作为分组字段：它需要有 2–${MAX_TOOL_OUTPUT_GROUPS} 个重复出现的取值，且不能是连续测量值或高基数文本。`,
      { field: column.name, type: column.type, unique: column.unique },
    );
  }
  return column;
}

function orderedGroupNames(pairs) {
  return [...new Set(pairs.map((pair) => pair.group))];
}

function smallGroupWarning(groups) {
  const small = groups.filter((group) => group.n < 3);
  if (small.length === 0) return null;
  return `以下分组的有效样本少于 3 个：${small
    .map((group) => `${group.value}（n=${group.n}）`)
    .join('、')}。描述统计仍可查看，但推断结论不稳定。`;
}

function describeGroupStats(values) {
  if (values.length === 0) return null;
  if (values.length === 1) {
    return {
      n: 1,
      mean: values[0],
      sd: null,
      se: null,
      min: values[0],
      q1: values[0],
      median: values[0],
      q3: values[0],
      max: values[0],
      ci95: [null, null],
    };
  }
  return summarize(values);
}

function normalizeProfileParams() {
  return {};
}

function normalizeMissingnessParams() {
  return {};
}

function normalizeGroupSummaryParams(dataset, params) {
  assertAllowedParams(params, ['groupBy', 'metric']);
  const groupByRef = requireString(params, 'groupBy', '分组字段 groupBy');
  const metricRef = requireString(params, 'metric', '数值字段 metric');
  const groupColumn = resolveGroupColumn(dataset, groupByRef);
  const metricColumn = resolveNumericColumn(dataset, metricRef, '分组汇总');
  return { groupBy: groupColumn.name, metric: metricColumn.name };
}

function normalizeGroupComparisonParams(dataset, params) {
  assertAllowedParams(params, ['groupBy', 'metric', 'groupA', 'groupB']);
  const groupByRef = requireString(params, 'groupBy', '分组字段 groupBy');
  const metricRef = requireString(params, 'metric', '数值字段 metric');
  const groupA = requireString(params, 'groupA', '组 A groupA');
  const groupB = requireString(params, 'groupB', '组 B groupB');
  if (groupA === groupB) {
    throw new ToolError('INVALID_GROUPS', 'groupA 和 groupB 不能是同一个组。');
  }
  const groupColumn = resolveGroupColumn(dataset, groupByRef);
  const metricColumn = resolveNumericColumn(dataset, metricRef, '两组比较');
  const known = new Set(groupColumn.topValues?.map((item) => item.value) ?? []);
  for (const group of [groupA, groupB]) {
    if (!known.has(group)) {
      throw new ToolError(
        'UNKNOWN_GROUP',
        `分组字段「${groupColumn.label}」中找不到取值「${group}」。可用取值：${[...known]
          .slice(0, 20)
          .join('、')}。`,
        { group, field: groupColumn.name },
      );
    }
  }
  return { groupBy: groupColumn.name, metric: metricColumn.name, groupA, groupB };
}

function normalizeAnovaParams(dataset, params) {
  assertAllowedParams(params, ['groupBy', 'metric']);
  const groupByRef = requireString(params, 'groupBy', '分组字段 groupBy');
  const metricRef = requireString(params, 'metric', '数值字段 metric');
  const groupColumn = resolveGroupColumn(dataset, groupByRef);
  const metricColumn = resolveNumericColumn(dataset, metricRef, '单因素方差分析');
  return { groupBy: groupColumn.name, metric: metricColumn.name };
}

function normalizeCorrelationParams(dataset, params) {
  assertAllowedParams(params, ['fields']);
  if (!Array.isArray(params.fields) || params.fields.length < 2) {
    throw new ToolError('MISSING_PARAM', 'correlation_analysis 需要至少 2 个数值字段（fields 数组）。');
  }
  if (params.fields.length > 8) {
    throw new ToolError('TOO_MANY_FIELDS', '相关性分析一次最多比较 8 个数值字段。');
  }
  const columns = [];
  const seen = new Set();
  for (const reference of params.fields) {
    if (typeof reference !== 'string' || reference.trim() === '') {
      throw new ToolError('INVALID_PARAMS', 'fields 中的每个字段名都必须是非空文本。');
    }
    const column = resolveNumericColumn(dataset, reference, '相关性分析');
    if (seen.has(column.name)) {
      throw new ToolError('DUPLICATE_FIELD', `字段「${column.name}」在 fields 中重复。`);
    }
    seen.add(column.name);
    columns.push(column);
  }
  return { fields: columns.map((column) => column.name) };
}

function runProfile(dataset) {
  return publicProfile(dataset);
}

function runMissingness(dataset) {
  return publicMissingness(dataset);
}

function runGroupSummary(dataset, params) {
  const groupColumn = columnByRef(dataset, params.groupBy);
  const metricColumn = columnByRef(dataset, params.metric);
  const { pairs, excluded } = groupSeries(dataset, groupColumn, metricColumn);
  const names = orderedGroupNames(pairs);
  const groups = names
    .map((name) => {
      const values = pairs.filter((pair) => pair.group === name).map((pair) => pair.value);
      try {
        return { value: name, ...describeGroupStats(values) };
      } catch (error) {
        throw new ToolError(
          'GROUP_SUMMARY_FAILED',
          `分组「${name}」的统计量计算失败：${error.message}`,
          { group: name },
        );
      }
    })
    .filter(Boolean);

  if (groups.length < 2) {
    throw new ToolError('NOT_ENOUGH_GROUPS', '有效分组不足 2 个，无法进行组间汇总。');
  }

  const warnings = [];
  const small = smallGroupWarning(groups);
  if (small) warnings.push(small);
  if (excluded > 0) {
    warnings.push(`有 ${excluded} 行因分组字段或数值字段缺失而未纳入本次汇总。`);
  }

  return {
    groupBy: { name: groupColumn.name, label: groupColumn.label },
    metric: {
      name: metricColumn.name,
      label: metricColumn.label,
      unit: metricColumn.unit ?? '',
    },
    groups,
    totals: { n: pairs.length, groups: groups.length, excluded },
    warnings,
  };
}

function runGroupComparison(dataset, params) {
  const groupColumn = columnByRef(dataset, params.groupBy);
  const metricColumn = columnByRef(dataset, params.metric);
  const { pairs, excluded } = groupSeries(dataset, groupColumn, metricColumn);
  const valuesA = pairs.filter((pair) => pair.group === params.groupA).map((pair) => pair.value);
  const valuesB = pairs.filter((pair) => pair.group === params.groupB).map((pair) => pair.value);
  if (valuesA.length < 2 || valuesB.length < 2) {
    throw new ToolError(
      'INSUFFICIENT_GROUP',
      `两组有效样本都至少需要 2 个。当前：${params.groupA} n=${valuesA.length}，${params.groupB} n=${valuesB.length}。`,
    );
  }

  let result;
  try {
    result = welchTTest(valuesA, valuesB);
  } catch (error) {
    if (error.code === 'ZERO_VARIANCE') {
      throw new ToolError(
        'ZERO_VARIANCE',
        '至少一组数值完全没有变异，Welch t 检验无法定义。可以查看描述统计，但不能给出显著性结论。',
      );
    }
    throw new ToolError('TEST_FAILED', `Welch t 检验失败：${error.message}`);
  }

  const summaryA = summarize(valuesA);
  const summaryB = summarize(valuesB);
  const warnings = [];
  if (excluded > 0) {
    warnings.push(`有 ${excluded} 行因分组字段或数值字段缺失而未纳入本次比较。`);
  }
  if (Math.min(valuesA.length, valuesB.length) < 3) {
    warnings.push('至少一组样本少于 3 个，Welch 检验的正态近似可能不可靠。');
  }
  warnings.push('Welch t 检验用于比较两组均值；结果依赖独立观测与近似正态假设，请结合研究设计解释。');

  return {
    groupBy: { name: groupColumn.name, label: groupColumn.label },
    metric: {
      name: metricColumn.name,
      label: metricColumn.label,
      unit: metricColumn.unit ?? '',
    },
    groupA: {
      value: params.groupA,
      n: result.nA,
      mean: result.meanA,
      sd: result.sdA,
      ...pickSummary(summaryA),
    },
    groupB: {
      value: params.groupB,
      n: result.nB,
      mean: result.meanB,
      sd: result.sdB,
      ...pickSummary(summaryB),
    },
    test: 'Welch 双侧 t 检验',
    meanDiff: result.meanDiff,
    meanDiffCi95: result.ci95,
    t: result.t,
    df: result.df,
    p: result.p,
    cohensD: result.cohenD,
    excluded,
    warnings,
  };
}

function pickSummary(summary) {
  return {
    min: summary.min,
    q1: summary.q1,
    median: summary.median,
    q3: summary.q3,
    max: summary.max,
  };
}

function runAnova(dataset, params) {
  const groupColumn = columnByRef(dataset, params.groupBy);
  const metricColumn = columnByRef(dataset, params.metric);
  const { pairs, excluded } = groupSeries(dataset, groupColumn, metricColumn);
  const names = orderedGroupNames(pairs);
  const groups = names.map((name) => ({
    value: name,
    values: pairs.filter((pair) => pair.group === name).map((pair) => pair.value),
  }));
  const analyzable = groups.filter((group) => group.values.length >= 2);
  const omitted = groups.filter((group) => group.values.length < 2);
  if (analyzable.length < 2) {
    throw new ToolError('NOT_ENOUGH_GROUPS', '有效样本不少于 2 的分组不足 2 个，无法执行方差分析。');
  }

  let result;
  try {
    result = oneWayAnova(analyzable.map((group) => group.values));
  } catch (error) {
    if (error.code === 'ZERO_VARIANCE') {
      throw new ToolError('ZERO_VARIANCE', '所有分组内数值均无变异，方差分析无法定义。');
    }
    throw new ToolError('TEST_FAILED', `方差分析失败：${error.message}`);
  }

  const groupDetails = analyzable.map((group) => {
    const summary = summarize(group.values);
    return {
      value: group.value,
      n: summary.n,
      mean: summary.mean,
      sd: summary.sd,
      median: summary.median,
      min: summary.min,
      max: summary.max,
    };
  });
  const warnings = [];
  if (excluded > 0) warnings.push(`有 ${excluded} 行因缺失未纳入方差分析。`);
  if (omitted.length > 0) {
    warnings.push(
      `${omitted.map((group) => `${group.value}（n=${group.values.length}）`).join('、')} 因样本不足被排除。`,
    );
  }
  warnings.push(
    '单因素方差分析假设组间独立、组内近似正态且方差齐性；ANOVA 本身不包含多重比较校正，若执行两两比较需在报告中明确校正方法。',
  );

  return {
    groupBy: { name: groupColumn.name, label: groupColumn.label },
    metric: {
      name: metricColumn.name,
      label: metricColumn.label,
      unit: metricColumn.unit ?? '',
    },
    groups: groupDetails,
    test: '单因素方差分析（one-way ANOVA）',
    n: result.n,
    k: result.k,
    F: result.F,
    dfBetween: result.dfBetween,
    dfWithin: result.dfWithin,
    p: result.p,
    etaSquared: result.etaSquared,
    excluded,
    omittedGroups: omitted.map((group) => group.value),
    warnings,
  };
}

function runCorrelation(dataset, params) {
  const columns = params.fields.map((reference) => columnByRef(dataset, reference));
  const pairs = [];
  const skipped = [];
  for (let i = 0; i < columns.length; i += 1) {
    for (let j = i + 1; j < columns.length; j += 1) {
      const a = columns[i];
      const b = columns[j];
      const xs = [];
      const ys = [];
      let excluded = 0;
      for (const row of dataset.rows) {
        const x = toNumeric(row[a.index]);
        const y = toNumeric(row[b.index]);
        if (x === null || y === null) {
          excluded += 1;
          continue;
        }
        xs.push(x);
        ys.push(y);
      }
      if (xs.length < 3) {
        skipped.push({
          fieldA: a.name,
          fieldB: b.name,
          reason: `成对有效样本仅 ${xs.length} 个（至少需要 3 个）。`,
        });
        continue;
      }
      try {
        const p = pearson(xs, ys);
        const s = spearman(xs, ys);
        pairs.push({
          fieldA: a.name,
          fieldB: b.name,
          labelA: a.label,
          labelB: b.label,
          n: p.n,
          excluded,
          pearson: { r: p.r, p: p.p, ci95: p.ci95 },
          spearman: { rho: s.rho, p: s.p },
        });
      } catch (error) {
        skipped.push({
          fieldA: a.name,
          fieldB: b.name,
          reason:
            error.code === 'ZERO_VARIANCE'
              ? '至少一个字段没有变异，相关系数无定义。'
              : `无法计算相关系数：${error.message}`,
        });
      }
    }
  }
  if (pairs.length === 0) {
    throw new ToolError('NO_VALID_PAIRS', '没有可计算的有效字段对。请检查字段缺失和变异情况。');
  }
  const strongest = [...pairs].sort(
    (left, right) => Math.abs(right.pearson.r) - Math.abs(left.pearson.r),
  )[0];
  return {
    fields: columns.map((column) => ({
      name: column.name,
      label: column.label,
      unit: column.unit ?? '',
    })),
    pairs,
    skipped,
    strongest,
    methods: ['Pearson 相关系数（线性关系）', 'Spearman 等级相关（单调关系）'],
    warnings: [
      '相关不等于因果；横断面观测数据中的相关可能受未测量混杂影响。',
      '本版未对多字段相关矩阵做多重比较校正，相关结果的显著性应作为探索性证据。',
    ],
  };
}

export const TOOL_DEFINITIONS = Object.freeze({
  profile_dataset: {
    name: 'profile_dataset',
    label: '数据概况',
    description: '读取数据规模、字段类型、缺失率和基础分布，生成数据概况。无参数。',
    params: [],
    normalize: normalizeProfileParams,
    run: runProfile,
  },
  missingness_report: {
    name: 'missingness_report',
    label: '缺失与重复检查',
    description: '计算每个字段缺失情况、完整行数、重复记录与零变异字段。无参数。',
    params: [],
    normalize: normalizeMissingnessParams,
    run: runMissingness,
  },
  group_summary: {
    name: 'group_summary',
    label: '分组统计汇总',
    description: '按一个分组字段汇总一个数值字段，返回每组的样本量、均值、标准差、中位数和四分位数。',
    params: [
      { name: 'groupBy', type: 'column', columnType: 'group', required: true, description: '分组字段' },
      { name: 'metric', type: 'column', columnType: 'number', required: true, description: '数值指标字段' },
    ],
    normalize: normalizeGroupSummaryParams,
    run: runGroupSummary,
  },
  group_comparison: {
    name: 'group_comparison',
    label: '两组差异比较',
    description:
      '比较指定两组的数值均值，执行 Welch 双侧 t 检验，返回均值差、95% 置信区间、Cohen’s d 和 p 值。',
    params: [
      { name: 'groupBy', type: 'column', columnType: 'group', required: true, description: '分组字段' },
      { name: 'metric', type: 'column', columnType: 'number', required: true, description: '数值指标字段' },
      { name: 'groupA', type: 'groupValue', required: true, description: '第一组取值' },
      { name: 'groupB', type: 'groupValue', required: true, description: '第二组取值' },
    ],
    normalize: normalizeGroupComparisonParams,
    run: runGroupComparison,
  },
  one_way_anova: {
    name: 'one_way_anova',
    label: '多组方差分析',
    description:
      '对 2 个及以上分组的数值均值执行单因素方差分析，返回 F、自由度、p 值与 η²。',
    params: [
      { name: 'groupBy', type: 'column', columnType: 'group', required: true, description: '分组字段' },
      { name: 'metric', type: 'column', columnType: 'number', required: true, description: '数值指标字段' },
    ],
    normalize: normalizeAnovaParams,
    run: runAnova,
  },
  correlation_analysis: {
    name: 'correlation_analysis',
    label: '相关性分析',
    description:
      '对 2–8 个数值字段计算 Pearson 与 Spearman 相关，返回成对样本量、相关系数、p 值与置信区间。',
    params: [
      {
        name: 'fields',
        type: 'array<column>',
        columnType: 'number',
        minItems: 2,
        maxItems: 8,
        required: true,
        description: '要分析的数值字段名称数组',
      },
    ],
    normalize: normalizeCorrelationParams,
    run: runCorrelation,
  },
});

export function listTools() {
  return Object.values(TOOL_DEFINITIONS).map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    params: tool.params,
  }));
}

export function catalogForPrompt() {
  return Object.values(TOOL_DEFINITIONS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    params: tool.params.map((param) => ({
      name: param.name,
      type: param.type,
      required: Boolean(param.required),
      ...(param.description ? { description: param.description } : {}),
    })),
  }));
}

export function validateToolParams(dataset, toolName, params) {
  const tool = TOOL_DEFINITIONS[toolName];
  if (!tool) {
    throw new ToolError('UNKNOWN_TOOL', `不支持的工具「${toolName}」。只能使用注册表中的工具。`, {
      tool: toolName,
    });
  }
  return tool.normalize(dataset, params ?? {});
}

/**
 * 只校验计划，不执行工具。返回规范化后的步骤。
 */
export function validatePlanSteps(dataset, steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ToolError('EMPTY_PLAN', '分析计划中没有可执行工具。');
  }
  if (steps.length > MAX_TOOL_STEPS) {
    throw new ToolError('PLAN_TOO_LONG', `分析计划超过 ${MAX_TOOL_STEPS} 个工具调用。`);
  }
  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new ToolError('INVALID_STEP', `第 ${index + 1} 个计划步骤格式不正确。`);
    }
    const tool = TOOL_DEFINITIONS[step.tool];
    if (!tool) {
      throw new ToolError(
        'UNKNOWN_TOOL',
        `第 ${index + 1} 个计划步骤使用了不支持的工具「${step.tool}」。`,
        { tool: step.tool },
      );
    }
    const params = validateToolParams(dataset, step.tool, step.params ?? {});
    return {
      tool: tool.name,
      label: tool.label,
      params,
      reason:
        typeof step.reason === 'string' && step.reason.trim()
          ? step.reason.trim().slice(0, 240)
          : tool.description,
    };
  });
}

/**
 * 实际执行工具。计划先通过 validatePlanSteps，调用方仍不应跳过校验。
 */
export function executeTool(dataset, toolName, rawParams) {
  const tool = TOOL_DEFINITIONS[toolName];
  if (!tool) {
    throw new ToolError('UNKNOWN_TOOL', `不支持的工具「${toolName}」。`);
  }
  const params = validateToolParams(dataset, toolName, rawParams);
  const startedAt = performance.now();
  const output = tool.run(dataset, params);
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  return {
    tool: tool.name,
    label: tool.label,
    params,
    output,
    durationMs,
    executedAt: new Date().toISOString(),
  };
}

export function groupValuesFor(dataset, columnRef) {
  const column = columnByRef(dataset, columnRef);
  if (!column) return [];
  return (column.topValues ?? []).map((item) => item.value);
}

export function missingSafe(value) {
  return isMissingValue(value) ? null : value;
}
