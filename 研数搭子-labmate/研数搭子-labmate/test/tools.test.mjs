import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataset } from '../lib/dataset.mjs';
import {
  ToolError,
  executeTool,
  listTools,
  validatePlanSteps,
} from '../lib/tools.mjs';
import {
  PlannerError,
  buildLocalPlan,
  detectUnsupported,
  validateResearchQuestion,
} from '../lib/planner.mjs';
import { loadIrisDataset } from '../lib/examples.mjs';

function fixtureDataset() {
  const rows = [
    ['A', '1', '2', 'x'],
    ['A', '2', '4', 'x'],
    ['A', '3', '6', 'x'],
    ['B', '4', '8', 'y'],
    ['B', '5', '10', 'y'],
    ['B', '6', '12', 'y'],
    ['C', '7', '14', 'z'],
    ['C', '8', '16', 'z'],
    ['C', '9', '18', 'z'],
  ];
  return createDataset({
    id: 'fixture',
    name: 'fixture.csv',
    headers: ['group', 'value', 'other', 'label'],
    rows,
    kind: 'upload',
    source: { type: 'upload', title: 'fixture.csv' },
    fieldMeta: {
      group: { label: '组别' },
      value: { label: '测量值' },
    },
  });
}

test('工具：注册表至少包含需求中的五个真实工具', () => {
  const names = new Set(listTools().map((tool) => tool.name));
  for (const required of [
    'profile_dataset',
    'missingness_report',
    'group_summary',
    'group_comparison',
    'correlation_analysis',
  ]) {
    assert.ok(names.has(required), `missing tool ${required}`);
  }
  assert.ok(names.has('one_way_anova'));
});

test('工具：数据概况、缺失检查、分组汇总都来自真实计算', () => {
  const dataset = fixtureDataset();
  const profile = executeTool(dataset, 'profile_dataset', {});
  assert.equal(profile.output.dataset.rowCount, 9);
  assert.deepEqual(profile.output.numericFields, ['value', 'other']);
  assert.ok(profile.output.groupCandidates.some((group) => group.name === 'group'));

  const missing = executeTool(dataset, 'missingness_report', {});
  assert.equal(missing.output.missingCells, 0);
  assert.equal(missing.output.duplicateRowCount, 0);

  const summary = executeTool(dataset, 'group_summary', { groupBy: 'group', metric: 'value' });
  assert.equal(summary.output.totals.n, 9);
  assert.deepEqual(
    summary.output.groups.map((group) => [group.value, group.n, group.mean]),
    [
      ['A', 3, 2],
      ['B', 3, 5],
      ['C', 3, 8],
    ],
  );
});

test('工具：Welch 比较和单因素方差分析返回有效统计量', () => {
  const dataset = fixtureDataset();
  const comparison = executeTool(dataset, 'group_comparison', {
    groupBy: 'group',
    metric: 'value',
    groupA: 'A',
    groupB: 'B',
  });
  assert.equal(comparison.output.meanDiff, -3);
  assert.ok(comparison.output.p >= 0 && comparison.output.p <= 1);
  assert.ok(comparison.output.p < 0.05);

  const anova = executeTool(dataset, 'one_way_anova', {
    groupBy: 'group',
    metric: 'value',
  });
  assert.equal(anova.output.k, 3);
  assert.equal(anova.output.n, 9);
  assert.ok(anova.output.F > 1);
  assert.ok(anova.output.p < 0.05);
  assert.ok(anova.output.etaSquared > 0 && anova.output.etaSquared <= 1);
});

test('工具：相关分析输出 Pearson / Spearman 与成对样本量', () => {
  const dataset = fixtureDataset();
  const result = executeTool(dataset, 'correlation_analysis', {
    fields: ['value', 'other'],
  });
  assert.equal(result.output.pairs.length, 1);
  assert.equal(result.output.pairs[0].n, 9);
  assert.equal(result.output.pairs[0].pearson.r, 1);
  assert.equal(result.output.pairs[0].spearman.rho, 1);
  assert.equal(result.output.strongest.fieldA, 'value');
});

test('工具：非法工具、未知列、错误类型、未知分组与多余参数全部拒绝', () => {
  const dataset = fixtureDataset();
  assert.throws(
    () => executeTool(dataset, 'run_python', {}),
    (error) => error instanceof ToolError && error.code === 'UNKNOWN_TOOL',
  );
  assert.throws(
    () => executeTool(dataset, 'group_summary', { groupBy: 'nope', metric: 'value' }),
    (error) => error.code === 'UNKNOWN_COLUMN',
  );
  assert.throws(
    () => executeTool(dataset, 'group_summary', { groupBy: 'group', metric: 'label' }),
    (error) => error.code === 'WRONG_COLUMN_TYPE',
  );
  assert.throws(
    () =>
      executeTool(dataset, 'group_comparison', {
        groupBy: 'group',
        metric: 'value',
        groupA: 'A',
        groupB: 'Z',
      }),
    (error) => error.code === 'UNKNOWN_GROUP',
  );
  assert.throws(
    () =>
      executeTool(dataset, 'group_summary', {
        groupBy: 'group',
        metric: 'value',
        shell: 'rm -rf /',
      }),
    (error) => error.code === 'UNKNOWN_PARAM',
  );
  assert.throws(
    () => executeTool(dataset, 'correlation_analysis', { fields: ['value', 'value'] }),
    (error) => error.code === 'DUPLICATE_FIELD',
  );
});

test('计划校验：标签可规范化为真实列名，不执行任何代码', () => {
  const dataset = fixtureDataset();
  const steps = validatePlanSteps(dataset, [
    {
      tool: 'group_summary',
      params: { groupBy: '组别', metric: '测量值' },
      reason: 'test',
    },
  ]);
  assert.equal(steps[0].params.groupBy, 'group');
  assert.equal(steps[0].params.metric, 'value');
  assert.throws(
    () =>
      validatePlanSteps(dataset, [
        { tool: 'group_summary', params: { groupBy: 'group', metric: 'value', code: 'x' } },
      ]),
    (error) => error.code === 'UNKNOWN_PARAM',
  );
});

test('本地规划：Iris 组间问题生成分组比较与 ANOVA 的受控计划', async () => {
  const dataset = await loadIrisDataset();
  const question = '不同品种的花瓣长度有差异吗？';
  assert.ok(validateResearchQuestion(question));
  const plan = buildLocalPlan(dataset, question);
  assert.equal(plan.intent, 'group_difference');
  assert.ok(plan.steps.some((step) => step.tool === 'group_summary'));
  assert.ok(plan.steps.some((step) => step.tool === 'one_way_anova'));
  assert.ok(plan.steps.every((step) => step.params.groupBy === 'species'));
  assert.ok(plan.steps.every((step) => step.tool !== 'profile_dataset'));

  const normalized = validatePlanSteps(dataset, plan.steps);
  assert.ok(normalized.length >= 2);
});

test('本地规划：相关性分析、因果/预测拒绝、问题边界', async () => {
  const dataset = await loadIrisDataset();
  const plan = buildLocalPlan(dataset, '花萼长度和花瓣长度是否相关？');
  assert.equal(plan.intent, 'correlation');
  assert.ok(plan.steps.some((step) => step.tool === 'correlation_analysis'));
  assert.deepEqual(plan.steps.find((step) => step.tool === 'correlation_analysis').params.fields, [
    'sepal_length',
    'petal_length',
  ]);

  assert.ok(detectUnsupported('不同品种对花瓣长度有因果影响吗？'));
  assert.throws(
    () => buildLocalPlan(dataset, '请预测下一个样本的花瓣长度。'),
    (error) => error instanceof PlannerError && error.code === 'UNSUPPORTED_MODELING',
  );
  assert.throws(
    () => buildLocalPlan(dataset, '花瓣长度和花瓣宽度哪个更大？'),
    (error) =>
      error instanceof PlannerError && error.code === 'UNSUPPORTED_PAIRED_COMPARISON',
  );
  assert.throws(
    () => validateResearchQuestion('？'),
    (error) => error.code === 'QUESTION_TOO_SHORT' || error.code === 'QUESTION_INVALID',
  );
});
