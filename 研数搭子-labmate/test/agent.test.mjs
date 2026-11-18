import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIrisDataset } from '../lib/examples.mjs';
import { runAgent } from '../lib/agent.mjs';
import { reportToMarkdown } from '../lib/report.mjs';
import { formatNumber } from '../lib/format.mjs';

const demoConfig = {
  enabled: false,
  missing: ['DEEPSEEK_API_KEY'],
  model: null,
  provider: 'DeepSeek',
};

function assertNoRawRows(runRecord) {
  const json = JSON.stringify(runRecord);
  assert.equal(json.includes('"preview"'), false);
  assert.equal(JSON.stringify(runRecord.dataset).includes('"rows"'), false);
  assert.equal(json.includes('sepal_length,sepal_width,petal_length'), false);
  assert.equal(json.includes('"5.1","3.5","1.4"'), false);
}

test('Agent 演示模式：真实执行组间分析并生成可追溯报告', async () => {
  const dataset = await loadIrisDataset();
  const events = [];
  const result = await runAgent({
    dataset,
    question: '不同品种的花瓣长度有差异吗？',
    config: demoConfig,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.modeInfo.type, 'demo');
  assert.equal(result.report.mode.type, 'demo');
  assert.equal(result.report.charts.length, 1);
  assert.equal(result.report.charts[0].kind, 'boxplot');
  assert.ok(result.report.charts[0].svg.startsWith('<svg'));

  const analysisCalls = result.runRecord.toolCalls.filter(
    (call) => !['profile_dataset', 'missingness_report'].includes(call.tool),
  );
  assert.deepEqual(
    analysisCalls.map((call) => call.tool),
    [
      'group_summary',
      'one_way_anova',
      'group_comparison',
      'group_comparison',
      'group_comparison',
    ],
  );
  const anova = analysisCalls.find((call) => call.tool === 'one_way_anova').output;
  const summary = analysisCalls.find((call) => call.tool === 'group_summary').output;
  assert.ok(result.report.oneLineAnswer.includes(formatNumber(anova.F, 3)));
  assert.ok(result.report.oneLineAnswer.includes('p < 0.001'));
  assert.ok(result.report.oneLineAnswer.includes('单因素方差分析'));
  assert.ok(result.report.oneLineAnswer.includes('η²'));
  assert.ok(result.report.tables.some((table) => table.id === 'pairwise'));
  assert.ok(result.report.tables.length >= 3);
  assert.ok(
    result.report.tables
      .find((table) => table.id === 'group-summary')
      .rows.some((row) => row.mean === formatNumber(summary.groups[0].mean, 3)),
  );
  assert.equal(result.report.verification.status, 'passed_with_warnings');
  assert.ok(result.report.verification.checks.length >= 8);

  const evidenceIds = new Set(result.report.trace.toolCalls.map((call) => call.id));
  for (const finding of result.report.findings) {
    for (const evidence of finding.evidence ?? []) {
      assert.ok(evidenceIds.has(evidence.callId), `unknown evidence ${evidence.callId}`);
    }
  }

  const stepIds = new Set(result.report.trace.steps.map((step) => step.id));
  assert.deepEqual(
    [...stepIds],
    ['inspect_data', 'understand', 'plan', 'execute', 'verify', 'report'],
  );
  assert.ok(result.report.trace.steps.every((step) => step.status === 'success'));
  assert.ok(result.report.trace.steps.every((step) => typeof step.durationMs === 'number'));
  assert.ok(result.runRecord.agent.steps.every((step) => step.status === 'success'));
  assert.ok(result.report.trace.toolCalls.length === 7);
  assert.equal(result.runRecord.dataset.source.license, 'CC BY 4.0');
  assert.equal(result.runRecord.dataset.source.doi, '10.24432/C56C76');
  assertNoRawRows(result.runRecord);

  const markdown = reportToMarkdown(result.report, result.runRecord);
  assert.match(markdown, /# 研数搭子分析报告/);
  assert.match(markdown, /data:image\/svg\+xml;base64,/);
  assert.match(markdown, /group_summary/);
  assert.match(markdown, /CC BY 4\.0/);
  assert.match(markdown, /结果一致性校验|结果校验/);
  assert.equal(markdown.includes('sepal_length,sepal_width,petal_length'), false);

  const injectionResult = await runAgent({
    dataset,
    question: '不同品种的花瓣长度有差异吗？![x](https://example.com/track.png)',
    config: demoConfig,
  });
  assert.equal(injectionResult.ok, true);
  const injectionMarkdown = reportToMarkdown(
    injectionResult.report,
    injectionResult.runRecord,
  );
  assert.equal(injectionMarkdown.includes('![x](https://example.com/track.png)'), false);
  assert.equal(injectionMarkdown.includes('<img'), false);
  assert.ok(injectionMarkdown.includes('!\\[x\\]'));

  assert.ok(events.some((event) => event.type === 'plan'));
  assert.ok(events.some((event) => event.type === 'tool' && event.call.tool === 'one_way_anova'));
  assert.ok(events.some((event) => event.type === 'verification'));
  assert.equal(events.some((event) => event.type === 'completed'), false); // server emits completed
});

test('Agent 演示模式：相关分析返回散点图与相关系数证据', async () => {
  const dataset = await loadIrisDataset();
  const result = await runAgent({
    dataset,
    question: '花萼长度和花瓣长度是否相关？',
    config: demoConfig,
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const correlationCall = result.runRecord.toolCalls.find(
    (call) => call.tool === 'correlation_analysis',
  );
  assert.ok(correlationCall);
  const strongest = correlationCall.output.strongest;
  assert.ok(result.report.oneLineAnswer.includes(formatNumber(strongest.pearson.r, 3)));
  assert.equal(result.report.charts[0].kind, 'scatter');
  assert.ok(result.report.tables.some((table) => table.id === 'correlation-table'));
  assert.ok(result.report.limitations.some((item) => item.includes('相关不等于因果')));
  assertNoRawRows(result.runRecord);
});

test('Agent 对因果/预测问题明确失败，不编造报告', async () => {
  const dataset = await loadIrisDataset();
  const result = await runAgent({
    dataset,
    question: '不同品种对花瓣长度有因果影响吗？',
    config: demoConfig,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSUPPORTED_CAUSALITY');
  assert.ok(result.error.suggestions.length > 0);
  assert.equal(result.report, undefined);
});
