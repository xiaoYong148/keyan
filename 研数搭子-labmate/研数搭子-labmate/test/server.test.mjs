import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabmateApp } from '../server.mjs';

async function readNdjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) events.push(JSON.parse(line));
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) events.push(JSON.parse(buffer.trim()));
  return events;
}

async function postJson(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('HTTP API：健康检查、示例载入、流式分析、Markdown/JSON 下载与上传校验', async (t) => {
  const app = await createLabmateApp({ env: {} });
  const listener = await app.listen({ port: 0, host: '127.0.0.1' });
  const base = listener.url;
  t.after(() => app.close());

  const healthResponse = await fetch(base + '/api/health');
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.mode.mode, 'demo');
  assert.equal(health.mode.provider, 'DeepSeek');
  assert.equal(health.mode.endpoint, 'https://api.deepseek.com/chat/completions');
  assert.match(health.mode.reason, /DEEPSEEK_API_KEY/);
  assert.equal(health.mode.setup.envKey, 'DEEPSEEK_API_KEY');
  assert.equal(health.sample.available, true);
  assert.ok(health.tools.some((tool) => tool.name === 'group_comparison'));

  const examples = await fetch(base + '/api/examples').then((response) => response.json());
  assert.equal(examples.examples.length, 1);
  assert.equal(examples.examples[0].source.license, 'CC BY 4.0');

  const sampleResponse = await postJson(base, '/api/datasets/sample', { id: 'iris-fisher-1936' });
  assert.equal(sampleResponse.status, 200);
  const sample = await sampleResponse.json();
  assert.equal(sample.dataset.rowCount, 150);
  assert.equal(sample.dataset.columns.length, 5);
  assert.ok(sample.dataset.preview.rows.length > 0);

  const analyzeResponse = await postJson(base, '/api/analyze', {
    datasetId: sample.dataset.id,
    question: '不同品种的花瓣长度有差异吗？',
  });
  assert.equal(analyzeResponse.status, 200);
  assert.match(analyzeResponse.headers.get('content-type'), /application\/x-ndjson/);
  const events = await readNdjson(analyzeResponse);
  const completed = events.find((event) => event.type === 'completed');
  assert.ok(completed, `no completed event: ${JSON.stringify(events.at(-1))}`);
  assert.equal(completed.report.findings.length >= 2, true);
  assert.ok(completed.report.oneLineAnswer.includes('单因素方差分析'));
  assert.equal(completed.report.verification.status, 'passed_with_warnings');
  assert.ok(completed.downloads.markdown.startsWith('/api/runs/'));

  const officialRun = events.find((event) => event.type === 'run_started').runId;
  assert.equal(completed.runId, officialRun);

  const markdownResponse = await fetch(base + completed.downloads.markdown);
  assert.equal(markdownResponse.status, 200);
  assert.match(markdownResponse.headers.get('content-type'), /text\/markdown/);
  assert.match(markdownResponse.headers.get('content-disposition'), /attachment/);
  const markdown = await markdownResponse.text();
  assert.match(markdown, /工具运行记录/);
  assert.match(markdown, /数据来源与许可/);

  const recordResponse = await fetch(base + completed.downloads.json);
  assert.equal(recordResponse.status, 200);
  const record = await recordResponse.json();
  assert.equal(record.schemaVersion, 'labmate-run/1.0');
  assert.equal(record.privacy.rawRowsIncluded, false);
  assert.equal(JSON.stringify(record).includes('"preview"'), false);
  assert.ok(record.verification.checks.length >= 8);
  assert.equal(record.dataset.source.license, 'CC BY 4.0');

  const csv = '组别,数值,备注\nA,1.2,x\nA,2.3,y\nB,3.4,z\nB,4.5,w\n';
  const uploadResponse = await postJson(base, '/api/datasets', {
    filename: '公开小样本.csv',
    content: csv,
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json();
  assert.equal(uploaded.dataset.rowCount, 4);
  assert.equal(uploaded.dataset.columnCount, 3);
  assert.ok(uploaded.dataset.columns.find((column) => column.name === '组别').groupable);
  assert.equal(uploaded.dataset.columns.find((column) => column.name === '数值').groupable, false);
  assert.match(uploaded.dataset.source.sha256, /^[a-f0-9]{64}$/);

  const customAnalysisResponse = await postJson(base, '/api/analyze', {
    datasetId: uploaded.dataset.id,
    question: '不同「组别」的「数值」有差异吗？',
  });
  assert.equal(customAnalysisResponse.status, 200);
  const customEvents = await readNdjson(customAnalysisResponse);
  const customCompleted = customEvents.find((event) => event.type === 'completed');
  assert.ok(customCompleted, JSON.stringify(customEvents.at(-1)));
  assert.ok(customCompleted.report.oneLineAnswer.includes('Welch'));
  const customTools = customCompleted.report.trace.toolCalls.map((call) => call.tool);
  assert.ok(customTools.includes('group_summary'));
  assert.ok(customTools.includes('group_comparison'));
  assert.equal(customTools.includes('one_way_anova'), false);
  assert.equal(customCompleted.report.charts.length, 1);

  const badExtension = await postJson(base, '/api/datasets', {
    filename: 'notes.txt',
    content: csv,
  });
  assert.equal(badExtension.status, 415);

  const duplicateHeader = await postJson(base, '/api/datasets', {
    filename: 'bad.csv',
    content: 'a,A\n1,2\n',
  });
  assert.equal(duplicateHeader.status, 422);
  const duplicateError = await duplicateHeader.json();
  assert.equal(duplicateError.error.code, 'E_DUPLICATE_HEADER');

  const emptyCsv = await postJson(base, '/api/datasets', {
    filename: 'empty.csv',
    content: 'a,b\n',
  });
  assert.equal(emptyCsv.status, 422);
  assert.equal((await emptyCsv.json()).error.code, 'E_HEADER_ONLY');

  const unknownRun = await fetch(base + '/api/runs/not-a-run/report.md');
  assert.equal(unknownRun.status, 404);

  const malformedUrl = await fetch(base + '/%E0%A4%A');
  assert.equal(malformedUrl.status, 400);
  assert.equal((await malformedUrl.json()).error.code, 'INVALID_URL');

  const controlFilename = await postJson(base, '/api/datasets', {
    filename: 'bad\nname.csv',
    content: csv,
  });
  assert.equal(controlFilename.status, 400);
  assert.equal((await controlFilename.json()).error.code, 'INVALID_FILENAME');

  const privateRows = Array.from(
    { length: 12 },
    (_, index) => `${index < 6 ? 'A' : 'B'},SECRETCELL_${index},${index + 1}`,
  );
  const privateCsv = `group,payload,measure\n${privateRows.join('\n')}\n`;
  const privateUploadResponse = await postJson(base, '/api/datasets', {
    filename: 'private-payload.csv',
    content: privateCsv,
  });
  assert.equal(privateUploadResponse.status, 201);
  const privateDataset = (await privateUploadResponse.json()).dataset;
  const payloadColumn = privateDataset.columns.find((column) => column.name === 'payload');
  assert.equal(payloadColumn.type, 'text');
  assert.equal(payloadColumn.topValues, undefined);
  const privateAnalysisResponse = await postJson(base, '/api/analyze', {
    datasetId: privateDataset.id,
    question: '不同 group 的 measure 有差异吗？',
  });
  const privateCompleted = (await readNdjson(privateAnalysisResponse)).find(
    (event) => event.type === 'completed',
  );
  assert.ok(privateCompleted);
  const privateRecordText = await fetch(base + privateCompleted.downloads.json).then((response) =>
    response.text(),
  );
  const privateMarkdown = await fetch(base + privateCompleted.downloads.markdown).then((response) =>
    response.text(),
  );
  assert.equal(privateRecordText.includes('SECRETCELL'), false);
  assert.equal(privateMarkdown.includes('SECRETCELL'), false);
  assert.match(privateMarkdown, /高基数文本（不在报告中展示取值）/);

  const unsupportedResponse = await postJson(base, '/api/analyze', {
    datasetId: sample.dataset.id,
    question: '请训练一个模型预测花瓣长度。',
  });
  assert.equal(unsupportedResponse.status, 200);
  const unsupportedEvents = await readNdjson(unsupportedResponse);
  const failed = unsupportedEvents.find((event) => event.type === 'failed');
  assert.ok(failed);
  assert.equal(failed.error.code, 'UNSUPPORTED_MODELING');
  assert.ok(failed.error.suggestions.length > 0);

  assert.equal(health.privacy.rawDataStoredOnDisk, false);
});
