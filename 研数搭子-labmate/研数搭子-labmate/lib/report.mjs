import {
  formatCI,
  formatDate,
  formatNumber,
  formatP,
  formatPercent,
  formatSigned,
  pStars,
} from './format.mjs';
import { buildCharts } from './charts.mjs';

const SOFTWARE_VERSION = '1.0.0';

function callId(call) {
  return call.id ?? `call_${call.seq ?? 'x'}`;
}

function evidence(call) {
  return {
    callId: callId(call),
    tool: call.tool,
    label: call.label,
  };
}

function uniqueStrings(items) {
  const seen = new Set();
  const output = [];
  for (const item of items.filter(Boolean)) {
    const text = String(item).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function unitSuffix(unit) {
  return unit ? ` ${unit}` : '';
}

function withUnit(value, unit, digits = 3) {
  return `${formatNumber(value, digits)}${unitSuffix(unit)}`;
}

function distributionText(field) {
  if (field.nonMissing === 0) return '全空，无法分析';
  if (field.type === 'number') {
    if (!field.summary) return '—';
    return `${formatNumber(field.summary.mean, 3)} ± ${formatNumber(
      field.summary.sd,
      3,
    )}；范围 ${formatNumber(field.summary.min, 2)}–${formatNumber(field.summary.max, 2)}`;
  }
  if (field.type === 'text') return '高基数文本（不在报告中展示取值）';
  if (field.type === 'date') return '日期字段（不在报告中逐项展示）';
  if (field.topValues?.length) {
    return field.topValues
      .slice(0, 3)
      .map((item) => `${item.value}（${item.count}）`)
      .join('；');
  }
  return '类别数较多，取值不在报告中展示';
}

function findSuccessCalls(toolCalls, tool) {
  return toolCalls.filter((call) => call.status === 'success' && call.tool === tool);
}

function matchingCalls(toolCalls, tool, params) {
  return findSuccessCalls(toolCalls, tool).filter((call) => {
    const p = call.params ?? {};
    if (tool === 'group_comparison') {
      return p.groupBy === params.groupBy && p.metric === params.metric;
    }
    return p.groupBy === params.groupBy && p.metric === params.metric;
  });
}

function buildGroupBundle(groupCall, toolCalls) {
  const output = groupCall.output;
  const anova = matchingCalls(toolCalls, 'one_way_anova', groupCall.params).find(
    (call) =>
      call.params.groupBy === groupCall.params.groupBy &&
      call.params.metric === groupCall.params.metric,
  );
  const comparisons = matchingCalls(toolCalls, 'group_comparison', groupCall.params);
  const metric = output.metric ?? {};
  const groupBy = output.groupBy ?? {};
  const groups = Array.isArray(output.groups) ? output.groups : [];
  const sortedByMean = [...groups].sort((a, b) => a.mean - b.mean);
  const lowest = sortedByMean[0] ?? null;
  const highest = sortedByMean[sortedByMean.length - 1] ?? null;
  const m = comparisons.length;
  const adjusted = comparisons.map((call) => {
    const p = call.output?.p;
    return {
      call,
      p,
      pAdjusted: typeof p === 'number' ? Math.min(1, p * Math.max(1, m)) : null,
    };
  });
  const adjustedSignificant = adjusted.filter((item) => item.pAdjusted != null && item.pAdjusted < 0.05);
  const primaryTest = anova
    ? {
        kind: 'anova',
        call: anova,
        output: anova.output,
        p: anova.output.p,
        label: '单因素方差分析',
      }
    : comparisons[0]
      ? {
          kind: 'welch',
          call: comparisons[0],
          output: comparisons[0].output,
          p: comparisons[0].output.p,
          label: 'Welch t 检验',
        }
      : null;

  const findings = [];
  const significance =
    primaryTest && typeof primaryTest.p === 'number' ? primaryTest.p < 0.05 : null;
  let conclusionText;

  if (primaryTest?.kind === 'anova') {
    const test = primaryTest.output;
    conclusionText = `在这份数据中，不同「${groupBy.label}」下「${metric.label}」的均值${
      significance ? '存在统计学显著差异' : '未观察到统计学显著差异'
    }（单因素方差分析，F(${test.dfBetween}, ${test.dfWithin}) = ${formatNumber(
      test.F,
      3,
    )}，${formatP(test.p)}，η² = ${formatNumber(test.etaSquared, 3)}）。`;
    findings.push({
      id: 'inference-anova',
      title: '组间总体差异',
      text: conclusionText,
      tone: significance ? 'positive' : 'neutral',
      evidence: [evidence(primaryTest.call)],
    });
    if (!significance) {
      findings.push({
        id: 'inference-anova-caution',
        title: '如何理解这个结果',
        text: 'p ≥ 0.05 表示当前样本没有提供足够证据支持组间均值存在差异，并不等于证明各组完全相同。效应量与置信区间同样重要。',
        tone: 'caution',
        evidence: [evidence(primaryTest.call)],
      });
    }
  } else if (primaryTest?.kind === 'welch') {
    const test = primaryTest.output;
    conclusionText = `在这份数据中，「${test.groupA.value}」与「${test.groupB.value}」的「${metric.label}」均值${
      significance ? '存在统计学显著差异' : '未观察到统计学显著差异'
    }（Welch t 检验，t(${formatNumber(test.df, 2)}) = ${formatNumber(test.t, 3)}，${formatP(
      test.p,
    )}；均值差 ${formatSigned(test.meanDiff, 3)}${unitSuffix(metric.unit)}，95% CI ${formatCI(
      test.meanDiffCi95,
      3,
      metric.unit,
    )}，Cohen's d = ${formatNumber(test.cohensD, 3)}）。`;
    findings.push({
      id: 'inference-welch',
      title: '两组均值差异',
      text: conclusionText,
      tone: significance ? 'positive' : 'neutral',
      evidence: [evidence(primaryTest.call)],
    });
    if (!significance) {
      findings.push({
        id: 'inference-welch-caution',
        title: '如何理解这个结果',
        text: 'p ≥ 0.05 表示当前样本没有提供足够证据支持两组均值存在差异，并不等于证明两组完全相同。请结合均值差及其置信区间判断实际意义。',
        tone: 'caution',
        evidence: [evidence(primaryTest.call)],
      });
    }
  } else {
    conclusionText = `已完成「${groupBy.label}」各组「${metric.label}」的描述统计；当前分析计划未包含推断性检验，因此不能判断组间差异是否具有统计学意义。`;
    findings.push({
      id: 'descriptive-only',
      title: '描述性结果',
      text: conclusionText,
      tone: 'neutral',
      evidence: groupCall ? [evidence(groupCall)] : [],
    });
  }

  if (lowest && highest && lowest !== highest) {
    findings.unshift({
      id: 'group-description',
      title: '组间描述',
      text: `按「${groupBy.label}」分组，有效样本共 n=${formatNumber(output.totals?.n, 0)}。${metric.label}均值最低的是「${lowest.value}」（${withUnit(lowest.mean, metric.unit)}），最高的是「${highest.value}」（${withUnit(highest.mean, metric.unit)}），两者均值相差 ${formatNumber(highest.mean - lowest.mean, 3)}${unitSuffix(metric.unit)}。`,
      tone: 'neutral',
      evidence: [evidence(groupCall)],
    });
  }

  if (comparisons.length > 0 && primaryTest?.kind !== 'welch') {
    const sigCount = adjustedSignificant.length;
    const correction = `，并对 ${m} 次比较采用 Bonferroni 校正`;
    findings.push({
      id: 'pairwise',
      title: '两两比较与多重比较',
      text: `补充执行了两两 Welch t 检验${correction}。${
        sigCount > 0
          ? `有 ${sigCount}/${m} 对比较在校正后 p < 0.05。`
          : '所有比较在校正后均未达到 p < 0.05。'
      }具体均值差、置信区间与校正后 p 值见下表。`,
      tone: sigCount > 0 ? 'positive' : 'neutral',
      evidence: comparisons.map(evidence),
    });
  } else if (primaryTest?.kind === 'anova' && groups.length > 3) {
    findings.push({
      id: 'no-posthoc',
      title: '未进行两两事后比较',
      text: `本次计划只执行总体方差分析，未对 ${groups.length} 个分组做两两事后比较。总体 p 值显著只说明“至少有一组不同”，不能直接判断具体是哪两组不同。`,
      tone: 'caution',
      evidence: [evidence(primaryTest.call)],
    });
  }

  const tables = [];
  tables.push({
    id: 'group-summary',
    title: '分组描述统计',
    description: `字段：${groupBy.label} × ${metric.label}${metric.unit ? `（${metric.unit}）` : ''}；合计 n=${output.totals?.n ?? '—'}。`,
    columns: [
      { key: 'group', label: groupBy.label ?? '分组' },
      { key: 'n', label: 'n', align: 'right' },
      { key: 'mean', label: '均值', align: 'right' },
      { key: 'sd', label: '标准差', align: 'right' },
      { key: 'median', label: '中位数', align: 'right' },
      { key: 'iqr', label: 'Q1–Q3', align: 'right' },
      { key: 'range', label: '最小值–最大值', align: 'right' },
    ],
    rows: groups.map((group) => ({
      group: String(group.value),
      n: formatNumber(group.n, 0),
      mean: formatNumber(group.mean, 3),
      sd: formatNumber(group.sd, 3),
      median: formatNumber(group.median, 3),
      iqr: `${formatNumber(group.q1, 3)}–${formatNumber(group.q3, 3)}`,
      range: `${formatNumber(group.min, 2)}–${formatNumber(group.max, 2)}`,
    })),
    evidence: [evidence(groupCall)],
  });

  if (anova) {
    const test = anova.output;
    tables.push({
      id: 'anova',
      title: '单因素方差分析',
      description: `因变量：${metric.label}；分组：${groupBy.label}；n=${test.n}。`,
      columns: [
        { key: 'test', label: '检验' },
        { key: 'F', label: 'F', align: 'right' },
        { key: 'df', label: '自由度', align: 'right' },
        { key: 'p', label: 'p 值', align: 'right' },
        { key: 'eta', label: 'η²', align: 'right' },
      ],
      rows: [
        {
          test: test.test,
          F: formatNumber(test.F, 3),
          df: `${test.dfBetween}, ${test.dfWithin}`,
          p: formatP(test.p).replace('p = ', '').replace('p ', ''),
          eta: formatNumber(test.etaSquared, 3),
        },
      ],
      evidence: [evidence(anova)],
    });
  }

  if (comparisons.length > 0) {
    tables.push({
      id: 'pairwise',
      title:
        comparisons.length > 1
          ? '两两 Welch 比较（Bonferroni 校正）'
          : '两组 Welch 比较',
      description:
        comparisons.length > 1
          ? `共 ${comparisons.length} 次比较；校正后 p = min(1, 原始 p × ${comparisons.length})。95% CI 为未校正的均值差区间。`
          : 'Welch t 检验不假设两组方差相等；95% CI 为均值差区间。',
      columns: [
        { key: 'comparison', label: '比较' },
        { key: 'meanDiff', label: '均值差', align: 'right' },
        { key: 'ci', label: '均值差 95% CI', align: 'right' },
        { key: 't', label: 't', align: 'right' },
        { key: 'df', label: 'df', align: 'right' },
        { key: 'p', label: '原始 p', align: 'right' },
        ...(comparisons.length > 1 ? [{ key: 'pAdj', label: '校正后 p', align: 'right' }] : []),
        { key: 'd', label: "Cohen's d", align: 'right' },
      ],
      rows: adjusted.map(({ call, pAdjusted }) => {
        const out = call.output;
        return {
          comparison: `${out.groupA.value} vs ${out.groupB.value}`,
          meanDiff: formatSigned(out.meanDiff, 3),
          ci: formatCI(out.meanDiffCi95, 3, metric.unit),
          t: formatNumber(out.t, 3),
          df: formatNumber(out.df, 2),
          p: formatP(out.p).replace('p = ', '').replace('p ', ''),
          ...(comparisons.length > 1
            ? { pAdj: pAdjusted == null ? '—' : formatP(pAdjusted).replace('p = ', '').replace('p ', '') }
            : {}),
          d: formatNumber(out.cohensD, 3),
        };
      }),
      evidence: comparisons.map(evidence),
    });
  }

  const methodCalls = [groupCall, anova, ...comparisons].filter(Boolean);
  const methodRows = methodCalls.map((call) => {
    let sampleSize = '—';
    let params = '';
    if (call.tool === 'group_summary') {
      sampleSize = formatNumber(call.output?.totals?.n, 0);
      params = `group_summary(groupBy=${call.params.groupBy}, metric=${call.params.metric})`;
    } else if (call.tool === 'one_way_anova') {
      sampleSize = formatNumber(call.output?.n, 0);
      params = `groupBy=${call.params.groupBy}, metric=${call.params.metric}`;
    } else {
      sampleSize = formatNumber((call.output?.groupA?.n ?? 0) + (call.output?.groupB?.n ?? 0), 0);
      params = `groupBy=${call.params.groupBy}, metric=${call.params.metric}, ${call.params.groupA} vs ${call.params.groupB}`;
    }
    return {
      callId: callId(call),
      tool: call.tool,
      label: call.label,
      sampleSize,
      params,
      what:
        call.tool === 'group_summary'
          ? '按分组计算样本量、均值、标准差、中位数和四分位距'
          : call.tool === 'one_way_anova'
            ? '检验多组均值是否存在总体差异（单因素方差分析）'
            : '用 Welch t 检验比较两组均值，并报告均值差、95% CI 与 Cohen’s d',
    };
  });

  const limitations = [
    '组间差异与相关关系不能仅凭此分析推断因果关系；观察性数据可能受混杂因素影响。',
    '本版没有自动检验正态性、方差齐性或异常值影响；ANOVA / Welch 结果应结合研究设计与图形诊断解释。',
    '本版使用完整案例（按字段成对排除缺失），未做插补；缺失机制未知时，估计可能存在偏倚。',
    ...(comparisons.length > 1
      ? ['两两比较使用了 Bonferroni 校正，但表中均值差的 95% CI 未做多重比较校正。']
      : []),
    ...(primaryTest?.kind === 'anova' && groups.length > 3
      ? ['本计划未执行两两事后比较，不能根据总体 ANOVA 的显著结果判断具体组间差异。']
      : []),
    ...(anova?.output?.warnings ?? []),
    ...(comparisons.flatMap((call) => call.output?.warnings ?? [])),
  ];

  return {
    groupCall,
    anova,
    comparisons,
    metric,
    groupBy,
    groups,
    primaryTest,
    significance,
    findings,
    tables,
    methods: methodRows,
    limitations,
    oneLine: conclusionText,
    chartSummary: output,
  };
}

function buildCorrelationBundle(call) {
  const output = call.output;
  const pairs = Array.isArray(output.pairs) ? output.pairs : [];
  const strongest = output.strongest ?? [...pairs].sort(
    (a, b) => Math.abs(b.pearson.r) - Math.abs(a.pearson.r),
  )[0];
  const findings = [];
  const significance = strongest?.pearson?.p != null ? strongest.pearson.p < 0.05 : null;
  let conclusionText;
  if (strongest) {
    const direction = strongest.pearson.r > 0 ? '正向' : strongest.pearson.r < 0 ? '负向' : '零';
    conclusionText = `在这份数据中，对 n=${strongest.n} 个成对有效样本，「${strongest.labelA}」与「${strongest.labelB}」的 Pearson 相关系数为 r = ${formatNumber(
      strongest.pearson.r,
      3,
    )}（95% CI ${formatCI(strongest.pearson.ci95, 3)}，${formatP(strongest.pearson.p)}），Spearman ρ = ${formatNumber(
      strongest.spearman.rho,
      3,
    )}（${formatP(strongest.spearman.p)}）。${
      significance
        ? `在本样本中观察到统计学显著的${direction}关联；相关不等于因果。`
        : '在本样本中未观察到统计学显著的线性关联；这不等同于证明两个变量无关。'
    }`;
    findings.push({
      id: 'correlation-strongest',
      title: '最强相关字段对',
      text: conclusionText,
      tone: significance ? 'positive' : 'neutral',
      evidence: [evidence(call)],
    });
    findings.push({
      id: 'correlation-reading',
      title: '如何阅读相关系数',
      text: `Pearson r 衡量线性关联，Spearman ρ 衡量单调关联。两者在本字段对上的数值${
        Math.abs(strongest.pearson.r - strongest.spearman.rho) < 0.05 ? '接近' : '存在差异'
      }；请结合散点图与 95% 置信区间判断关系形态，而不是只看 p 值。`,
      tone: 'neutral',
      evidence: [evidence(call)],
    });
  }
  const unadjustedSignificant = pairs.filter((pair) => pair.pearson.p < 0.05).length;
  if (pairs.length > 1) {
    findings.push({
      id: 'correlation-multiple',
      title: '多字段探索',
      text: `${pairs.length} 个字段对中，有 ${unadjustedSignificant} 个在未校正的 Pearson p < 0.05。由于未做多重比较校正，这些显著性仅作为探索性线索。`,
      tone: 'caution',
      evidence: [evidence(call)],
    });
  }

  const table = {
    id: 'correlation-table',
    title: '相关系数与样本量',
    description: 'Pearson 与 Spearman 为两种不同的关联度量；p 值为未校正结果。',
    columns: [
      { key: 'pair', label: '字段对' },
      { key: 'n', label: '成对 n', align: 'right' },
      { key: 'r', label: 'Pearson r', align: 'right' },
      { key: 'ci', label: 'r 的 95% CI', align: 'right' },
      { key: 'p', label: 'Pearson p', align: 'right' },
      { key: 'rho', label: 'Spearman ρ', align: 'right' },
      { key: 'rhoP', label: 'Spearman p', align: 'right' },
      { key: 'stars', label: '未校正', align: 'center' },
    ],
    rows: pairs.map((pair) => ({
      pair: `${pair.labelA} × ${pair.labelB}`,
      n: formatNumber(pair.n, 0),
      r: formatNumber(pair.pearson.r, 3),
      ci: formatCI(pair.pearson.ci95, 3),
      p: formatP(pair.pearson.p).replace('p = ', '').replace('p ', ''),
      rho: formatNumber(pair.spearman.rho, 3),
      rhoP: formatP(pair.spearman.p).replace('p = ', '').replace('p ', ''),
      stars: pStars(pair.pearson.p),
    })),
    evidence: [evidence(call)],
  };

  const limitations = [
    '相关不等于因果；即使相关显著，也不能据此判断一个变量导致另一个变量变化。',
    ...(pairs.length > 1
      ? ['多个字段对的相关检验未做多重比较校正；表中 p 值应作为探索性证据。']
      : []),
    'Pearson 相关度量线性关系，Spearman 度量单调关系；二者都不能完整描述非线性或分段关系。',
    '本版使用成对完整数据，未做缺失插补；横断面观测数据的相关可能受未测量混杂影响。',
    ...(output.warnings ?? []),
    ...(output.skipped ?? []).map((item) => `${item.fieldA} × ${item.fieldB} 未计算：${item.reason}`),
  ];

  return {
    call,
    output,
    pairs,
    strongest,
    significance,
    findings,
    tables: [table],
    methods: [
      {
        callId: callId(call),
        tool: call.tool,
        label: call.label,
        sampleSize: strongest ? formatNumber(strongest.n, 0) : '—',
        params: `fields=[${output.fields.map((field) => field.name).join(', ')}]`,
        what: '成对计算 Pearson 线性相关与 Spearman 等级相关，并给出 r 的 Fisher z 95% CI',
      },
    ],
    limitations,
    oneLine: conclusionText,
    chartSummary: output,
  };
}

function buildQuality(profileCall, missingnessCall) {
  const profile = profileCall?.output ?? {};
  const missingness = missingnessCall?.output ?? {};
  const fields = (profile.fields ?? []).map((field) => ({
    name: field.name,
    label: field.label,
    type: field.typeLabel,
    missing: `${formatNumber(field.missing, 0)}（${formatPercent(field.missingRate, 1)}）`,
    unique: formatNumber(field.unique, 0),
    distribution: distributionText(field),
  }));
  const warnings = uniqueStrings([
    ...((profile.quality?.warnings ?? []).map((warning) => warning.message)),
    ...(missingness.notes ?? []),
  ]);
  const status =
    (missingness.missingCells ?? 0) === 0 && (missingness.duplicateRowCount ?? 0) === 0
      ? '检查通过'
      : '需要关注';
  return {
    status,
    rowCount: profile.dataset?.rowCount ?? missingness.rowCount ?? null,
    columnCount: profile.dataset?.columnCount ?? null,
    completeRows: missingness.completeRows ?? null,
    incompleteRows: missingness.incompleteRows ?? null,
    missingCells: missingness.missingCells ?? null,
    missingRate: missingness.missingRate ?? null,
    duplicateRowCount: missingness.duplicateRowCount ?? null,
    numericFieldCount: profile.numericFields?.length ?? null,
    groupCandidateCount: profile.groupCandidates?.length ?? null,
    fields,
    warnings,
  };
}

function buildKpis(groupBundles, correlationBundles) {
  const kpis = [];
  if (groupBundles.length > 0) {
    const first = groupBundles[0];
    const primary = first.primaryTest;
    kpis.push({
      label: '有效分析样本',
      value: formatNumber(first.chartSummary.totals?.n, 0),
      detail: '剔除分组或指标缺失后的记录',
      tone: 'neutral',
    });
    kpis.push({
      label: '分组数',
      value: formatNumber(first.groups.length, 0),
      detail: first.groupBy.label,
      tone: 'neutral',
    });
    if (primary) {
      kpis.push({
        label: primary.kind === 'anova' ? 'ANOVA p' : 'Welch p',
        value: primary.p < 0.001 ? '< 0.001' : formatNumber(primary.p, 3),
        detail:
          primary.kind === 'anova'
            ? `F(${primary.output.dfBetween}, ${primary.output.dfWithin}) = ${formatNumber(primary.output.F, 3)}`
            : `t(${formatNumber(primary.output.df, 2)}) = ${formatNumber(primary.output.t, 3)}`,
        tone: primary.p < 0.05 ? 'positive' : 'neutral',
      });
      kpis.push({
        label: primary.kind === 'anova' ? '效应量 η²' : "效应量 Cohen's d",
        value:
          primary.kind === 'anova'
            ? formatNumber(primary.output.etaSquared, 3)
            : formatNumber(primary.output.cohensD, 3),
        detail: primary.kind === 'anova' ? '组别解释的总变异比例' : '均值差的标准化效应量',
        tone: 'neutral',
      });
    } else {
      kpis.push({
        label: '推断性检验',
        value: '不包含',
        detail: '当前计划仅做描述统计',
        tone: 'caution',
      });
    }
  }
  const corr = correlationBundles[0];
  if (corr?.strongest) {
    if (groupBundles.length === 0) {
      kpis.push({
        label: '成对有效样本',
        value: formatNumber(corr.strongest.n, 0),
        detail: '按字段对完整数据计算',
        tone: 'neutral',
      });
      kpis.push({
        label: '最强 Pearson r',
        value: formatNumber(corr.strongest.pearson.r, 3),
        detail: `${corr.strongest.labelA} × ${corr.strongest.labelB}`,
        tone: corr.strongest.pearson.p < 0.05 ? 'positive' : 'neutral',
      });
      kpis.push({
        label: '95% CI',
        value: formatCI(corr.strongest.pearson.ci95, 2),
        detail: 'Fisher z 区间',
        tone: 'neutral',
      });
      kpis.push({
        label: 'Pearson p',
        value:
          corr.strongest.pearson.p < 0.001 ? '< 0.001' : formatNumber(corr.strongest.pearson.p, 3),
        detail: '未校正',
        tone: corr.strongest.pearson.p < 0.05 ? 'positive' : 'neutral',
      });
    } else {
      kpis.push({
        label: '最强 Pearson r',
        value: formatNumber(corr.strongest.pearson.r, 3),
        detail: `${corr.strongest.labelA} × ${corr.strongest.labelB}`,
        tone: corr.strongest.pearson.p < 0.05 ? 'positive' : 'neutral',
      });
    }
  }
  return kpis.slice(0, 5);
}

function collectLimitations({ groupBundles, correlationBundles, quality, dataset }) {
  const base = [
    ...groupBundles.flatMap((bundle) => bundle.limitations),
    ...correlationBundles.flatMap((bundle) => bundle.limitations),
  ];
  if (!groupBundles.length && !correlationBundles.length) {
    base.push('本次运行没有产生可解释的推断性分析结果。');
  }
  if ((quality.missingCells ?? 0) > 0) {
    base.push('存在缺失值，所有分析均采用相应字段的完整案例；本版未做缺失值插补。');
  }
  if ((quality.duplicateRowCount ?? 0) > 0) {
    base.push('数据包含完全重复的记录；本版未自动去重，可能影响有效样本量与稳定性。');
  }
  if (dataset.kind === 'sample') {
    base.push('示例数据是经典公开数据集，通常不是从目标研究总体随机抽样得到，结论不宜直接外推。');
  } else {
    base.push('样本的来源、抽样方式与独立性由数据提供者决定；本工具不能验证研究设计。');
  }
  if (dataset.source?.dataCaveat) {
    base.push(dataset.source.dataCaveat);
  }
  base.push('本工具用于探索性统计分析与教学演示，不替代统计咨询、同行评审或领域判断。');
  return uniqueStrings(base);
}

function collectMethods(groupBundles, correlationBundles, toolCalls) {
  const methods = [
    ...groupBundles.flatMap((bundle) => bundle.methods),
    ...correlationBundles.flatMap((bundle) => bundle.methods),
  ];
  const usedTools = new Set(methods.map((method) => method.tool));
  const dataPrep = toolCalls.find((call) => call.tool === 'profile_dataset' && call.status === 'success');
  const missingness = toolCalls.find(
    (call) => call.tool === 'missingness_report' && call.status === 'success',
  );
  const prepMethods = [];
  if (dataPrep) {
    prepMethods.push({
      callId: callId(dataPrep),
      tool: dataPrep.tool,
      label: dataPrep.label,
      sampleSize: formatNumber(dataPrep.output?.dataset?.rowCount, 0),
      params: '无参数',
      what: '识别字段类型、缺失率和基础分布；不修改原始数据',
    });
  }
  if (missingness) {
    prepMethods.push({
      callId: callId(missingness),
      tool: missingness.tool,
      label: missingness.label,
      sampleSize: formatNumber(missingness.output?.rowCount, 0),
      params: '无参数',
      what: '统计完整行、缺失单元格、重复记录与零变异字段',
    });
  }
  return [...prepMethods, ...methods];
}

function intentLabel(groupBundles, correlationBundles) {
  if (groupBundles.length && correlationBundles.length) return '组间差异 + 相关性';
  if (groupBundles.length) return '组间差异';
  if (correlationBundles.length) return '相关性分析';
  return '数据概况';
}

export function buildReport({
  runId,
  dataset,
  question,
  plan,
  modeInfo,
  steps,
  toolCalls,
  verification,
  createdAt,
  generatedAt,
  durationMs,
}) {
  const groupSummaryCalls = findSuccessCalls(toolCalls, 'group_summary');
  const correlationCalls = findSuccessCalls(toolCalls, 'correlation_analysis');
  const groupBundles = groupSummaryCalls.map((call) => buildGroupBundle(call, toolCalls));
  const correlationBundles = correlationCalls.map(buildCorrelationBundle);
  const profileCall = toolCalls.find((call) => call.tool === 'profile_dataset' && call.status === 'success');
  const missingnessCall = toolCalls.find(
    (call) => call.tool === 'missingness_report' && call.status === 'success',
  );
  if (!profileCall || !missingnessCall) {
    throw new Error('报告生成缺少数据检查工具输出。');
  }
  const quality = buildQuality(profileCall, missingnessCall);
  const charts = buildCharts({
    dataset,
    groupSummary: groupBundles[0]?.chartSummary ?? null,
    correlation: correlationBundles[0]?.output ?? null,
    intent: plan.intent,
  });
  const kpis = buildKpis(groupBundles, correlationBundles);
  const primaryOneLine =
    groupBundles[0]?.oneLine ??
    correlationBundles[0]?.oneLine ??
    '数据检查已完成，但当前计划没有产生推断性结论。';
  const secondaryOneLine =
    groupBundles.length && correlationBundles[0]?.oneLine ? correlationBundles[0].oneLine : null;
  const findings = [
    ...groupBundles.flatMap((bundle) => bundle.findings),
    ...correlationBundles.flatMap((bundle) => bundle.findings),
  ];
  const tables = [
    ...groupBundles.flatMap((bundle) => bundle.tables),
    ...correlationBundles.flatMap((bundle) => bundle.tables),
  ];
  const methods = collectMethods(groupBundles, correlationBundles, toolCalls);
  const limitations = collectLimitations({ groupBundles, correlationBundles, quality, dataset });
  const intent = intentLabel(groupBundles, correlationBundles);
  const usedFields = new Map();
  for (const call of methods) {
    for (const match of String(call.params).matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)) {
      const column = dataset.columns.find((item) => item.name === match[0]);
      if (column) usedFields.set(column.name, column.label);
    }
  }
  const trace = {
    steps: steps.map((step) => ({
      id: step.id,
      label: step.label,
      status: step.status,
      durationMs: step.durationMs ?? null,
      detail: step.detail ?? '',
    })),
    toolCalls: toolCalls.map((call) => ({
      id: callId(call),
      tool: call.tool,
      label: call.label,
      status: call.status,
      durationMs: call.durationMs,
      params: call.params,
      summary: summarizeToolCall(call),
      warnings: call.output?.warnings ?? [],
      error: call.error ?? null,
    })),
  };
  const source = dataset.source ?? {
    type: dataset.kind,
    title: dataset.name,
    note: '来源未提供。',
  };
  const report = {
    schemaVersion: 'labmate-report/1.0',
    runId,
    createdAt,
    generatedAt: generatedAt ?? new Date().toISOString(),
    durationMs,
    mode: modeInfo,
    eyebrow: `ANALYSIS REPORT · ${intent}`,
    title: question,
    intent,
    question,
    oneLineAnswer: primaryOneLine,
    secondaryAnswer: secondaryOneLine,
    kpis,
    findings,
    charts,
    tables,
    methods,
    quality,
    limitations,
    source,
    dataset: {
      name: dataset.name,
      kind: dataset.kind,
      rowCount: quality.rowCount,
      columnCount: quality.columnCount,
      fields: dataset.columns.map((column) => ({
        name: column.name,
        label: column.label,
        type: column.typeLabel,
        unit: column.unit ?? '',
      })),
    },
    usedFields: [...usedFields.entries()].map(([name, label]) => ({ name, label })),
    plan: {
      intent: plan.intent,
      source: plan.source,
      interpretation: plan.interpretation,
      selectionNotes: plan.selectionNotes ?? [],
      warnings: plan.warnings ?? [],
    },
    trace,
    verification,
    reproduction: {
      dataFingerprint: source.sha256 ?? null,
      fingerprintAlgorithm: source.sha256 ? 'SHA-256' : null,
      toolRegistry: 'labmate-controlled-tools/1.0',
      software: `研数搭子 ${SOFTWARE_VERSION}`,
      privacy:
        '原始 CSV 行未写入报告或运行记录；如启用 DeepSeek，仅发送问题、字段结构和聚合统计。',
    },
    privacy: {
      rawRowsIncluded: false,
      modelReceivedRawRows: false,
      note: '报告与运行记录不包含原始数据行。',
    },
  };
  return report;
}

function summarizeToolCall(call) {
  if (call.status !== 'success') return call.error?.message ?? '执行失败';
  const output = call.output ?? {};
  switch (call.tool) {
    case 'profile_dataset':
      return `${output.dataset?.rowCount ?? '—'} 行 × ${output.dataset?.columnCount ?? '—'} 列；${output.numericFields?.length ?? 0} 个数值字段。`;
    case 'missingness_report':
      return `缺失 ${output.missingCells ?? '—'} 个单元格，完整行 ${output.completeRows ?? '—'}，重复行 ${output.duplicateRowCount ?? '—'}。`;
    case 'group_summary':
      return `${output.totals?.groups ?? '—'} 组，n=${output.totals?.n ?? '—'}。`;
    case 'one_way_anova':
      return `F(${output.dfBetween}, ${output.dfWithin}) = ${formatNumber(output.F, 3)}，${formatP(output.p)}。`;
    case 'group_comparison':
      return `${output.groupA?.value} vs ${output.groupB?.value}：均值差 ${formatSigned(output.meanDiff, 3)}，${formatP(output.p)}。`;
    case 'correlation_analysis':
      return `${output.pairs?.length ?? 0} 个字段对；最强 r = ${formatNumber(output.strongest?.pearson?.r, 3)}。`;
    default:
      return '已执行。';
  }
}

function stripSvgFromCharts(charts) {
  return charts.map(({ svg, ...chart }) => chart);
}

export function buildRunRecord({
  runId,
  dataset,
  question,
  plan,
  modeInfo,
  steps,
  toolCalls,
  verification,
  report,
  createdAt,
  completedAt,
  durationMs,
}) {
  const source = dataset.source ?? {};
  return {
    schemaVersion: 'labmate-run/1.0',
    runId,
    createdAt,
    completedAt,
    durationMs,
    mode: modeInfo,
    question,
    dataset: {
      id: dataset.id,
      name: dataset.name,
      kind: dataset.kind,
      rowCount: report.quality.rowCount,
      columnCount: report.quality.columnCount,
      source: {
        title: source.title ?? dataset.name,
        provider: source.provider ?? (source.type === 'upload' ? '本地上传' : null),
        url: source.url ?? null,
        license: source.license ?? null,
        licenseUrl: source.licenseUrl ?? null,
        citation: source.citation ?? null,
        doi: source.doi ?? null,
        accessed: source.accessed ?? null,
        sha256: source.sha256 ?? null,
        note: source.note ?? null,
        dataCaveat: source.dataCaveat ?? null,
      },
      fields: report.dataset.fields,
    },
    plan: {
      intent: plan.intent,
      source: plan.source,
      interpretation: plan.interpretation,
      selectionNotes: plan.selectionNotes ?? [],
      warnings: plan.warnings ?? [],
      steps: plan.steps.map((step) => ({
        tool: step.tool,
        params: step.params,
        reason: step.reason,
      })),
    },
    agent: {
      steps: steps.map((step) => ({
        id: step.id,
        label: step.label,
        status: step.status,
        startedAt: step.startedAt ?? null,
        completedAt: step.completedAt ?? null,
        durationMs: step.durationMs ?? null,
        detail: step.detail ?? '',
      })),
    },
    toolCalls: toolCalls.map((call) => ({
      id: callId(call),
      seq: call.seq ?? null,
      tool: call.tool,
      label: call.label,
      params: call.params,
      status: call.status,
      startedAt: call.startedAt ?? null,
      completedAt: call.completedAt ?? null,
      durationMs: call.durationMs,
      ...(call.status === 'success' ? { output: call.output } : { error: call.error ?? null }),
    })),
    verification,
    report: {
      title: report.title,
      intent: report.intent,
      oneLineAnswer: report.oneLineAnswer,
      secondaryAnswer: report.secondaryAnswer,
      kpis: report.kpis,
      findings: report.findings,
      tables: report.tables,
      charts: stripSvgFromCharts(report.charts),
      methods: report.methods,
      quality: report.quality,
      limitations: report.limitations,
      reproduction: report.reproduction,
    },
    privacy: {
      rawRowsIncluded: false,
      previewRowsIncluded: false,
      modelReceivedRawRows: false,
      note: '运行记录不包含原始 CSV 行或预览行。DeepSeek（如启用）只接收研究问题、字段结构和聚合统计。',
    },
    software: {
      name: '研数搭子',
      version: SOFTWARE_VERSION,
      toolRegistry: 'labmate-controlled-tools/1.0',
    },
  };
}

/**
 * 把用户/数据提供的文本放进 Markdown 时中和 HTML 与链接/图片语法，
 * 避免导出文件在支持 HTML 的 Markdown 渲染器里发起远程请求或伪造结构。
 */
function mdSafe(value) {
  if (value == null) return '—';
  return String(value)
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`\[\]])/g, '\\$1');
}

function mdCell(value) {
  return mdSafe(value).replace(/\|/g, '\\|');
}

function mdTable(columns, rows) {
  const header = `| ${columns.map((column) => mdCell(column.label)).join(' | ')} |`;
  const align = `| ${columns
    .map((column) => (column.align === 'right' ? '---:' : column.align === 'center' ? ':---:' : '---'))
    .join(' | ')} |`;
  const body = rows
    .map((row) => `| ${columns.map((column) => mdCell(row[column.key])).join(' | ')} |`)
    .join('\n');
  return `${header}\n${align}\n${body}`;
}

function imageMarkdown(chart) {
  if (!chart?.svg) return '';
  const base64 = Buffer.from(chart.svg, 'utf8').toString('base64');
  const alt = mdSafe(chart.title).replace(/\|/g, '\\|');
  return `![${alt}](data:image/svg+xml;base64,${base64})\n\n*${mdSafe(chart.caption)}*`;
}

function uniqueWarnings(report) {
  // 数据质量问题已在“数据概况与质量”中列出，这里只保留方法/推断层面的局限性，
  // 避免同一提示在报告里出现两次。
  return uniqueStrings(report.limitations);
}

function statusLabel(status) {
  return (
    {
      pending: '待执行',
      running: '进行中',
      success: '已完成',
      failed: '失败',
    }[status] ?? status
  );
}

/**
 * Markdown 报告。嵌入 SVG 图片；不包含原始数据行。
 */
export function reportToMarkdown(report, runRecord) {
  const lines = [];
  lines.push('# 研数搭子分析报告');
  lines.push('');
  lines.push(`> ${mdSafe(report.title)}`);
  lines.push('');
  lines.push('## 概览');
  lines.push('');
  lines.push(`- **运行编号**：\`${mdSafe(report.runId)}\``);
  lines.push(`- **生成时间**：${formatDate(report.generatedAt)}（Asia/Shanghai）`);
  lines.push(
    `- **规划模式**：${mdSafe(report.mode?.label ?? '—')}${
      report.mode?.model ? `（DeepSeek 模型：${mdSafe(report.mode.model)}）` : ''
    }`,
  );
  if (report.mode?.endpoint && report.mode?.type !== 'demo') {
    lines.push(`- **模型端点**：${mdSafe(report.mode.endpoint)}`);
  }
  if (report.mode?.usage?.promptTokens != null || report.mode?.usage?.completionTokens != null) {
    lines.push(
      `- **DeepSeek token 用量**：prompt ${mdSafe(
        report.mode.usage.promptTokens ?? '—',
      )} tokens / completion ${mdSafe(report.mode.usage.completionTokens ?? '—')} tokens`,
    );
  }
  lines.push(`- **分析类型**：${mdSafe(report.intent)}`);
  lines.push(
    `- **数据**：${mdSafe(report.dataset.name)}（${report.dataset.rowCount} 行 × ${report.dataset.columnCount} 列）`,
  );
  lines.push('');
  lines.push('## 一句话结论');
  lines.push('');
  lines.push(mdSafe(report.oneLineAnswer));
  if (report.secondaryAnswer) {
    lines.push('');
    lines.push(mdSafe(report.secondaryAnswer));
  }
  lines.push('');
  lines.push('## 关键指标');
  lines.push('');
  lines.push(
    mdTable(
      [
        { key: 'label', label: '指标' },
        { key: 'value', label: '值' },
        { key: 'detail', label: '说明' },
      ],
      report.kpis,
    ),
  );
  lines.push('');
  lines.push('## 关键发现');
  lines.push('');
  for (const finding of report.findings) {
    lines.push(`### ${mdSafe(finding.title)}`);
    lines.push('');
    lines.push(mdSafe(finding.text));
    if (finding.evidence?.length) {
      lines.push('');
      lines.push(
        `*证据：${finding.evidence
          .map((item) => `\`${mdSafe(item.tool)}\` / ${mdSafe(item.callId)}`)
          .join('、')}*`,
      );
    }
    lines.push('');
  }

  if (report.charts?.length) {
    lines.push('## 图表');
    lines.push('');
    for (const chart of report.charts) {
      lines.push(`### ${mdSafe(chart.title)}`);
      lines.push('');
      lines.push(imageMarkdown(chart));
      lines.push('');
    }
  }

  lines.push('## 数据概况与质量');
  lines.push('');
  lines.push(
    `- **规模**：${report.quality.rowCount} 行 × ${report.quality.columnCount} 列`,
  );
  lines.push(
    `- **完整记录**：${report.quality.completeRows}（不完整 ${report.quality.incompleteRows}）`,
  );
  lines.push(`- **缺失单元格**：${report.quality.missingCells}（${formatPercent(report.quality.missingRate)}）`);
  lines.push(`- **完全重复行**：${report.quality.duplicateRowCount}`);
  lines.push(`- **检查状态**：${mdSafe(report.quality.status)}`);
  lines.push('');
  lines.push(
    mdTable(
      [
        { key: 'label', label: '字段' },
        { key: 'type', label: '类型' },
        { key: 'missing', label: '缺失' },
        { key: 'unique', label: '唯一值' },
        { key: 'distribution', label: '分布/范围' },
      ],
      report.quality.fields,
    ),
  );
  if (report.quality.warnings?.length) {
    lines.push('');
    lines.push('**数据提示**');
    for (const warning of report.quality.warnings) lines.push(`- ${mdSafe(warning)}`);
  }
  lines.push('');

  if (report.findings.length) {
    lines.push('## 统计结果');
    lines.push('');
    for (const table of report.tables) {
      lines.push(`### ${mdSafe(table.title)}`);
      lines.push('');
      if (table.description) lines.push(`${mdSafe(table.description)}\n`);
      lines.push(mdTable(table.columns, table.rows));
      if (table.evidence?.length) {
        lines.push('');
        lines.push(
          `*证据：${table.evidence
            .map((item) => `\`${mdSafe(item.tool)}\` / ${mdSafe(item.callId)}`)
            .join('、')}*`,
        );
      }
      lines.push('');
    }
  }

  lines.push('## 方法与可复现性');
  lines.push('');
  lines.push(
    mdTable(
      [
        { key: 'label', label: '工具' },
        { key: 'what', label: '用途' },
        { key: 'sampleSize', label: '实际 n' },
        { key: 'params', label: '参数' },
      ],
      report.methods,
    ),
  );
  lines.push('');
  lines.push(
    `- 数据指纹（SHA-256）：${mdSafe(report.reproduction?.dataFingerprint ?? '未记录')}`,
  );
  lines.push(`- 工具注册表：${mdSafe(report.reproduction?.toolRegistry ?? '—')}`);
  lines.push(`- 软件：${mdSafe(report.reproduction?.software ?? '—')}`);
  lines.push('');

  lines.push('## 局限性与无法判断的部分');
  lines.push('');
  for (const limitation of uniqueWarnings(report)) {
    lines.push(`- ${mdSafe(limitation)}`);
  }
  lines.push('');
  lines.push('## Agent 执行轨迹');
  lines.push('');
  lines.push(
    mdTable(
      [
        { key: 'step', label: '步骤' },
        { key: 'status', label: '状态' },
        { key: 'duration', label: '用时' },
        { key: 'detail', label: '说明' },
      ],
      report.trace.steps.map((step) => ({
        step: step.label,
        status: statusLabel(step.status),
        duration: step.durationMs == null ? '—' : `${formatNumber(step.durationMs, 1)} ms`,
        detail: step.detail,
      })),
    ),
  );
  lines.push('');
  lines.push('## 工具运行记录');
  lines.push('');
  lines.push(
    mdTable(
      [
        { key: 'id', label: '证据 ID' },
        { key: 'tool', label: '工具' },
        { key: 'params', label: '实际参数' },
        { key: 'status', label: '状态' },
        { key: 'duration', label: '用时' },
        { key: 'summary', label: '真实输出摘要' },
      ],
      report.trace.toolCalls.map((call) => ({
        id: call.id,
        tool: call.tool,
        params: JSON.stringify(call.params),
        status: statusLabel(call.status),
        duration: call.durationMs == null ? '—' : `${formatNumber(call.durationMs, 1)} ms`,
        summary: call.summary,
      })),
    ),
  );
  lines.push('');
  if (report.verification) {
    lines.push('## 结果校验');
    lines.push('');
    lines.push(
      `校验状态：**${report.verification.status === 'passed' ? '通过' : '通过（含提示）'}**。`,
    );
    lines.push('');
    lines.push(
      mdTable(
        [
          { key: 'label', label: '检查项' },
          { key: 'status', label: '结果' },
          { key: 'detail', label: '详情' },
        ],
        report.verification.checks.map((check) => ({
          label: check.label,
          status: check.status === 'passed' ? '通过' : '提示',
          detail: check.detail,
        })),
      ),
    );
    lines.push('');
  }

  lines.push('## 数据来源与许可');
  lines.push('');
  const source = report.source;
  lines.push(`- **数据集**：${mdSafe(source.title ?? report.dataset.name)}`);
  if (source.provider) lines.push(`- **提供方**：${mdSafe(source.provider)}`);
  if (source.url) lines.push(`- **来源链接**：${mdSafe(source.url)}`);
  if (source.license) {
    lines.push(
      `- **许可**：${mdSafe(source.license)}${
        source.licenseUrl ? `（${mdSafe(source.licenseUrl)}）` : ''
      }`,
    );
  }
  if (source.citation) lines.push(`- **建议引用**：${mdSafe(source.citation)}`);
  if (source.doi) lines.push(`- **DOI**：${mdSafe(source.doi)}`);
  if (source.accessed) lines.push(`- **数据访问日期**：${mdSafe(source.accessed)}`);
  if (source.note) lines.push(`- **处理说明**：${mdSafe(source.note)}`);
  if (source.type === 'upload') {
    lines.push('- **本地上传**：原始 CSV 只在本机内存中处理，不写入磁盘，不发送给模型。');
  }
  lines.push('');
  lines.push('## 隐私与边界');
  lines.push('');
  lines.push(`- ${mdSafe(report.privacy.note)}`);
  lines.push('- 所有统计数字由受控工具真实计算；本报告未使用 DeepSeek 生成统计结论。');
  lines.push(
    '- DeepSeek 只通过官方 API 的原生 tool calls 选择受控工具，不执行代码；本工具不支持因果推断、预测建模或任意数据处理脚本。',
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('由 **研数搭子 LabMate** 生成。探索性分析结果不构成同行评审结论。');
  return lines.join('\n');
}

export function safeFilenamePart(text, fallback = 'analysis') {
  const normalized = String(text ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 40);
  return normalized || fallback;
}
