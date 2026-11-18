/**
 * 本地规则规划器（演示模式）。
 *
 * 它不假装是语言模型：界面与运行记录会明确标注“本地规则规划”。
 * 它的职责是依据问题文本、字段结构和基数，选择受控工具与字段，
 * 之后所有数值仍由真实工具计算。
 */

export class PlannerError extends Error {
  constructor(code, message, suggestions = []) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
    this.suggestions = suggestions;
  }
}

export const QUESTION_LIMITS = Object.freeze({ min: 4, max: 300 });

export const SUPPORTED_SCOPE = Object.freeze([
  '数据概况与质量检查',
  '一个分类字段 × 一个数值字段的组间差异（2 组 Welch t，3+ 组 ANOVA）',
  '2–8 个数值字段之间的 Pearson / Spearman 相关',
]);

const UNSUPPORTED_PATTERNS = [
  {
    regex: /因果|causal|影响机制|中介|调节效应|mediation|moderation/i,
    code: 'UNSUPPORTED_CAUSALITY',
    reason: '当前工具只能描述组间差异与相关，不能识别因果效应。',
    suggestions: ['改为描述组间差异，例如“不同品种的花瓣长度有差异吗？”', '把问题限定为变量之间的相关关系。'],
  },
  {
    regex: /预测|回归|regression|predict|机器学习|训练模型|分类模型|聚类|cluster|随机森林|神经网络/i,
    code: 'UNSUPPORTED_MODELING',
    reason: '当前版本不训练预测模型，也不执行回归、聚类或机器学习。',
    suggestions: ['改为组间比较或相关分析。', '在方法部分明确本版只做探索性统计分析。'],
  },
  {
    regex: /时间序列|纵向|重复测量|面板数据|panel|生存分析|mixed.?effects|中介效应/i,
    code: 'UNSUPPORTED_LONGITUDINAL',
    reason: '当前工具面向横断面独立样本，不支持时间序列、重复测量或生存分析。',
    suggestions: ['先按一个时间点或分组做横断面比较。', '改用适合重复测量设计的统计软件。'],
  },
  {
    regex: /文本分析|图像识别|pdf|文献综述|爬虫|网页搜索|问卷开放题/i,
    code: 'UNSUPPORTED_DATA_TYPE',
    reason: '本版唯一支持的数据格式是公开 CSV，不解析论文、网页、图片或文本语料。',
    suggestions: ['把研究变量整理为 CSV 的数值或分类字段。', '使用其他工具完成文献检索与文本分析。'],
  },
];

const GROUP_TERMS =
  /差异|不同|比较|组间|分组|区别|各组|品种|类别|组别|处理组|影响|differ|difference|compare|comparison|group|between/i;
const CORRELATION_TERMS =
  /相关|关系|关联|伴随|共变|线性|correlation|correlate|relationship|associated|association/i;
const GENERIC_TERMS = /分析|看看|探索|概况|描述|数据|explore|analy[sz]e|summar/i;

export function validateResearchQuestion(raw) {
  if (typeof raw !== 'string') {
    throw new PlannerError('INVALID_QUESTION', '请用文本描述你的研究问题。');
  }
  const question = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (question.length < QUESTION_LIMITS.min) {
    throw new PlannerError(
      'QUESTION_TOO_SHORT',
      `研究问题太短（至少 ${QUESTION_LIMITS.min} 个字符）。请说明你想比较或关联哪些字段。`,
    );
  }
  if (question.length > QUESTION_LIMITS.max) {
    throw new PlannerError(
      'QUESTION_TOO_LONG',
      `研究问题超过 ${QUESTION_LIMITS.max} 个字符。请聚焦到一个可检验的问题。`,
    );
  }
  if (!/[\p{L}\p{N}]/u.test(question)) {
    throw new PlannerError('QUESTION_INVALID', '研究问题需要包含文字或数字，不能只有标点。');
  }
  return question;
}

export function detectUnsupported(question) {
  return UNSUPPORTED_PATTERNS.find((rule) => rule.regex.test(question)) ?? null;
}

function compact(text) {
  return text.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s_\-]+/g, '');
}

function mentionAliases(column, questionCompact) {
  const tokens = [
    column.name,
    column.label,
    ...(column.aliases ?? []),
    column.name.replace(/_/g, ' '),
  ];
  let best = '';
  for (const token of tokens) {
    if (typeof token !== 'string') continue;
    const normalized = compact(token);
    if (normalized.length >= 2 && questionCompact.includes(normalized) && normalized.length > best.length) {
      best = normalized;
    }
  }
  return best;
}

function findMentionedFields(dataset, question) {
  const questionCompact = compact(question);
  return dataset.columns
    .map((column) => {
      const mention = mentionAliases(column, questionCompact);
      return { column, mention, position: mention ? questionCompact.indexOf(mention) : -1 };
    })
    .filter((item) => item.mention)
    .sort((a, b) => a.position - b.position || b.mention.length - a.mention.length)
    .map((item) => item.column);
}

function groupBalance(column) {
  const counts = (column.topValues ?? []).map((item) => item.count);
  if (counts.length === 0) return 0;
  const total = counts.reduce((sum, count) => sum + count, 0);
  return total === 0 ? 0 : Math.max(...counts) / total;
}

function chooseGroupField(dataset, question, mentioned) {
  const candidates = dataset.columns.filter((column) => {
    if (
      !column.groupable ||
      column.unique < 2 ||
      column.unique > 12 ||
      column.nonMissing < 4 ||
      groupBalance(column) >= 0.95
    ) {
      return false;
    }
    // 至少有 2 个分组具备可做推断的样本量（n>=2）。
    const analyzableGroups = (column.topValues ?? []).filter((item) => item.count >= 2);
    return analyzableGroups.length >= 2;
  });
  if (candidates.length === 0) return null;
  const mentionedGroup = mentioned.find((column) =>
    candidates.some((candidate) => candidate.name === column.name),
  );
  if (mentionedGroup) return mentionedGroup;
  return [...candidates].sort((a, b) => {
    const aMention = mentionAliases(a, compact(question)) ? 1 : 0;
    const bMention = mentionAliases(b, compact(question)) ? 1 : 0;
    if (aMention !== bMention) return bMention - aMention;
    const aCat = a.type === 'category' ? 1 : 0;
    const bCat = b.type === 'category' ? 1 : 0;
    if (aCat !== bCat) return bCat - aCat;
    if (a.unique !== b.unique) return a.unique - b.unique;
    return a.index - b.index;
  })[0];
}

function chooseMetric(dataset, question, mentioned, groupField, options = {}) {
  const numeric = dataset.columns.filter(
    (column) => column.type === 'number' && column.nonMissing >= 3 && column.unique >= 2,
  );
  if (numeric.length === 0) {
    throw new PlannerError(
      'NO_NUMERIC_FIELD',
      '数据中没有可用于统计分析的数值字段。当前工具需要至少一个有变异的数值列。',
      ['确认数值列没有被导入为文本。', '提供一个包含数值测量值的公开 CSV。'],
    );
  }
  const mentionedNumeric = mentioned.filter((column) => numeric.some((item) => item.name === column.name));
  const usable = mentionedNumeric.filter((column) => !groupField || column.name !== groupField.name);
  if (usable.length > 0) {
    return { column: usable[0], assumed: false, alternatives: usable.slice(1) };
  }
  const withoutGroup = numeric.filter((column) => !groupField || column.name !== groupField.name);
  const pool = withoutGroup.length > 0 ? withoutGroup : numeric;
  const explicitOtherNumericMentioned = numeric.some((column) =>
    mentioned.some((item) => item.name === column.name && (!groupField || column.name !== groupField.name)),
  );
  return {
    column: pool[0],
    assumed: options.assume !== false && !explicitOtherNumericMentioned,
    alternatives: pool.slice(1),
  };
}

function chooseCorrelationFields(dataset, question, mentioned) {
  const numeric = dataset.columns.filter(
    (column) => column.type === 'number' && column.nonMissing >= 3 && column.unique >= 2,
  );
  if (numeric.length < 2) {
    throw new PlannerError(
      'NOT_ENOUGH_NUMERIC_FIELDS',
      '相关性分析至少需要 2 个数值字段。当前数据不足，无法执行。',
      ['确认数据中至少有两列是数值测量值。', '如果数据只有分类变量，请改用分组汇总或换一份数据。'],
    );
  }
  const mentionedNumeric = numeric.filter((column) =>
    mentioned.some((item) => item.name === column.name),
  );
  if (mentionedNumeric.length >= 2) {
    return {
      columns: mentionedNumeric.slice(0, 8),
      assumed: false,
      expandedToAll: false,
    };
  }
  const first = mentionedNumeric[0] ?? numeric[0];
  const ordered = [first, ...numeric.filter((column) => column.name !== first.name)].slice(0, 6);
  return {
    columns: ordered,
    assumed: mentionedNumeric.length === 0,
    expandedToAll: true,
  };
}

function groupSteps(groupField, metricField) {
  const steps = [
    {
      tool: 'group_summary',
      params: { groupBy: groupField.name, metric: metricField.name },
      reason: `按「${groupField.label}」汇总「${metricField.label}」的样本量、均值、中位数和四分位距。`,
    },
  ];
  if (groupField.unique === 2) {
    const values = (groupField.topValues ?? []).map((item) => item.value).slice(0, 2);
    steps.push({
      tool: 'group_comparison',
      params: {
        groupBy: groupField.name,
        metric: metricField.name,
        groupA: values[0],
        groupB: values[1],
      },
      reason: `对「${values[0]}」与「${values[1]}」执行 Welch t 检验，并报告均值差与 95% 置信区间。`,
    });
  } else {
    steps.push({
      tool: 'one_way_anova',
      params: { groupBy: groupField.name, metric: metricField.name },
      reason: `比较 ${groupField.unique} 组的均值，执行单因素方差分析并报告效应量 η²。`,
    });
    if (groupField.unique <= 3) {
      // 只对每组至少有 2 个有效观测的组做两两检验，避免把无法推断的小组带进计划。
      const values = (groupField.topValues ?? [])
        .filter((item) => item.count >= 2)
        .map((item) => item.value)
        .slice(0, 3);
      for (let i = 0; i < values.length; i += 1) {
        for (let j = i + 1; j < values.length; j += 1) {
          steps.push({
            tool: 'group_comparison',
            params: {
              groupBy: groupField.name,
              metric: metricField.name,
              groupA: values[i],
              groupB: values[j],
            },
            reason: `补充「${values[i]}」与「${values[j]}」的 Welch t 检验；报告中会标注多重比较校正。`,
          });
        }
      }
    }
  }
  return steps;
}

function qualityWarnings(dataset, fields) {
  const warnings = [];
  for (const field of fields.filter(Boolean)) {
    if (field.nonMissing === 0) {
      warnings.push(`「${field.label}」全为空，不能用于推断。`);
    } else if (field.missingRate >= 0.3) {
      warnings.push(`「${field.label}」缺失率约 ${(field.missingRate * 100).toFixed(1)}%，结论可能不稳健。`);
    }
  }
  if (dataset.quality.duplicateRowCount > 0) {
    warnings.push(`数据含 ${dataset.quality.duplicateRowCount} 行完全重复，本版未自动去重。`);
  }
  if (dataset.source?.dataCaveat) warnings.push(dataset.source.dataCaveat);
  return warnings;
}

function makePlan({ intent, interpretation, steps, selectionNotes = [], warnings = [] }) {
  if (steps.length === 0) {
    throw new PlannerError('EMPTY_PLAN', '没有找到可执行的分析步骤。');
  }
  return {
    intent,
    interpretation,
    steps,
    selectionNotes,
    warnings,
    source: 'local_rules',
    scope: SUPPORTED_SCOPE,
  };
}

/**
 * @param {object} dataset
 * @param {string} rawQuestion
 */
export function buildLocalPlan(dataset, rawQuestion) {
  const question = validateResearchQuestion(rawQuestion);
  const unsupported = detectUnsupported(question);
  if (unsupported) {
    throw new PlannerError(unsupported.code, unsupported.reason, unsupported.suggestions);
  }

  const mentioned = findMentionedFields(dataset, question);
  const wantsGroup = GROUP_TERMS.test(question);
  const wantsCorrelation = CORRELATION_TERMS.test(question);
  const generic = GENERIC_TERMS.test(question);

  const groupField = chooseGroupField(dataset, question, mentioned);
  const numericFields = dataset.columns.filter(
    (column) => column.type === 'number' && column.nonMissing >= 3 && column.unique >= 2,
  );
  const mentionedNumeric = mentioned.filter((column) => column.type === 'number');
  const groupFieldMentioned = Boolean(
    groupField && mentioned.some((column) => column.name === groupField.name),
  );
  const explicitGroupPhrase =
    /各组|每组|组间|分组|按[^，。?！!]{0,16}(?:组|类别|品种)|不同[^，。?！!]{0,20}(?:组|品种|类别|类型|处理)/.test(
      question,
    );
  if (
    mentionedNumeric.length >= 2 &&
    !wantsCorrelation &&
    !groupFieldMentioned &&
    !explicitGroupPhrase &&
    !generic
  ) {
    throw new PlannerError(
      'UNSUPPORTED_PAIRED_COMPARISON',
      '你在问同一行内两个数值字段的比较或差值。当前受控工具不支持配对检验，也不会把这两个字段误当成“分组字段”继续分析。',
      [
        '改为询问两个数值字段是否相关，例如“花瓣长度和花瓣宽度是否相关？”。',
        '如果要比较组间差异，请在问题中写出分组字段，例如“不同品种的花瓣长度有差异吗？”。',
      ],
    );
  }
  if (numericFields.length === 0) {
    throw new PlannerError(
      'NO_NUMERIC_FIELD',
      '没有识别到有变异的数值字段，无法执行组间比较或相关分析。',
      ['确认数值列没有混入单位或文本。', '换一份至少包含 1 个数值列的 CSV。'],
    );
  }

  const selectionNotes = [];
  let intent = 'exploratory';
  let steps = [];

  // 只有明确的分组意图，或“帮我看看这份数据”这类无字段指向的探索请求，
  // 才默认选择一个分组字段；避免把无关问题硬套成组间比较。
  const doGroup = Boolean(
    groupField && (wantsGroup || (generic && !wantsCorrelation && mentionedNumeric.length === 0)),
  );
  const doCorrelation =
    wantsCorrelation || (generic && numericFields.length >= 2);

  if (wantsGroup && !groupField) {
    throw new PlannerError(
      'NO_GROUP_FIELD',
      '你在问组间差异，但数据里没有识别到 2–12 个取值的分类字段。',
      ['额外提供一列“分组/品种/处理”标签。', '改为询问两个数值字段之间的相关关系。'],
    );
  }

  if (doGroup && groupField) {
    const metricChoice = chooseMetric(dataset, question, mentioned, groupField);
    const metricField = metricChoice.column;
    steps.push(...groupSteps(groupField, metricField));
    intent = doCorrelation ? 'mixed' : 'group_difference';
    if (metricChoice.assumed) {
      selectionNotes.push(
        `问题没有明确指向某个数值字段，本地规则选择「${metricField.label}」。你可以在问题中直接写出字段名。`,
      );
    }
    if (metricChoice.alternatives.length > 0) {
      selectionNotes.push(
        `本版每次聚焦一个数值指标；其余可用指标：${metricChoice.alternatives
          .slice(0, 4)
          .map((column) => `「${column.label}」`)
          .join('、')}。`,
      );
    }
    if (groupField.unique > 3) {
      selectionNotes.push('分组数超过 3 个，本版只报告总体方差分析，不自动执行两两事后比较。');
    }
    if (groupField.unique === 2) {
      selectionNotes.push('两组比较使用 Welch t 检验，不假设两组方差相等。');
    }
  }

  if (doCorrelation && numericFields.length >= 2) {
    const corrChoice = chooseCorrelationFields(dataset, question, mentioned);
    steps.push({
      tool: 'correlation_analysis',
      params: { fields: corrChoice.columns.map((column) => column.name) },
      reason: `计算 ${corrChoice.columns.map((column) => `「${column.label}」`).join('、')} 的 Pearson 与 Spearman 相关。`,
    });
    if (intent === 'exploratory') intent = 'correlation';
    else if (intent === 'group_difference') intent = 'mixed';
    if (corrChoice.assumed) {
      selectionNotes.push('问题没有点名具体字段，相关性部分采用数据中的全部数值字段（最多 6 个）。');
    } else if (corrChoice.expandedToAll) {
      selectionNotes.push('问题只点名了 1 个数值字段，相关性部分自动扩展到全部数值字段以供探索。');
    }
  }

  if (steps.length === 0) {
    throw new PlannerError(
      'NO_SUPPORTED_ANALYSIS',
      '这个问题没有匹配到当前受控工具能够完成的比较或相关分析。',
      SUPPORTED_SCOPE,
    );
  }

  const usedFields = new Set();
  for (const step of steps) {
    for (const value of Object.values(step.params)) {
      if (typeof value === 'string') {
        const col = dataset.columns.find((item) => item.name === value);
        if (col) usedFields.add(col.name);
      }
      if (Array.isArray(value)) {
        for (const ref of value) {
          const col = dataset.columns.find((item) => item.name === ref);
          if (col) usedFields.add(col.name);
        }
      }
    }
  }
  const warnings = qualityWarnings(
    dataset,
    dataset.columns.filter((column) => usedFields.has(column.name)),
  );
  if (dataset.quality.missingCells > 0) {
    warnings.push(
      `数据共有 ${dataset.quality.missingCells} 个缺失单元格；每个工具会按字段成对排除缺失，并在输出中记录实际样本量。`,
    );
  }
  if (!dataset.source?.type || dataset.source.type === 'upload') {
    warnings.push('上传数据仅在本机内存处理；请自行确认该数据为公开、非涉密数据。');
  }

  let interpretation;
  if (intent === 'group_difference') {
    const groupStep = steps[0];
    const anova = steps.find((step) => step.tool === 'one_way_anova');
    const comparison = steps.find((step) => step.tool === 'group_comparison');
    const groupName = dataset.columns.find((column) => column.name === groupStep.params.groupBy)?.label;
    const metricName = dataset.columns.find((column) => column.name === groupStep.params.metric)?.label;
    interpretation = `你希望比较不同「${groupName}」下「${metricName}」的差异。计划先做分组描述，再用${
      anova ? '单因素方差分析' : comparison ? ' Welch t 检验' : '组间统计'
    }判断差异是否具有统计学意义。`;
  } else if (intent === 'correlation') {
    const corrStep = steps.find((step) => step.tool === 'correlation_analysis');
    const labels = corrStep.params.fields
      .map((name) => dataset.columns.find((column) => column.name === name)?.label ?? name)
      .join('」「');
    interpretation = `你想判断「${labels}」之间是否存在关联。计划同时计算 Pearson 线性相关与 Spearman 等级相关，并报告样本量、p 值和不确定性。`;
  } else {
    interpretation =
      '这个问题适合做探索性分析。计划同时查看分组差异和数值字段之间的相关关系，并明确区分描述性结果与推断性结果。';
  }

  return makePlan({ intent, interpretation, steps, selectionNotes, warnings });
}

export function planFieldSummary(dataset, plan) {
  const names = new Set();
  for (const step of plan.steps) {
    for (const value of Object.values(step.params)) {
      if (typeof value === 'string') {
        const column = dataset.columns.find((item) => item.name === value);
        if (column) names.add(column.name);
      }
      if (Array.isArray(value)) {
        for (const ref of value) {
          const column = dataset.columns.find((item) => item.name === ref);
          if (column) names.add(column.name);
        }
      }
    }
  }
  return [...names].map((name) => {
    const column = dataset.columns.find((item) => item.name === name);
    return { name, label: column?.label ?? name };
  });
}
