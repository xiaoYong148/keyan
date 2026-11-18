import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabmateApp } from '../server.mjs';
import { DEEPSEEK_API_ENDPOINT } from '../lib/llm.mjs';

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
  return events;
}

function createModelFetch(responseFor) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({
        url,
        headers: options.headers,
        body,
      });
      const payload = responseFor(body, calls.length);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

function deepSeekResponse(toolCalls, overrides = {}) {
  return {
    id: 'deepseek-response-test',
    object: 'chat.completion',
    model: 'deepseek-flash',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls,
        },
      },
    ],
    usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
    ...overrides,
  };
}

function functionCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

async function boot(modelFetch) {
  const env = {
    DEEPSEEK_API_KEY: 'test-key-not-real',
    DEEPSEEK_MODEL: 'deepseek-flash',
  };
  const app = await createLabmateApp({ env, modelFetch });
  const listener = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, listener };
}

async function loadSample(base) {
  return fetch(base + '/api/datasets/sample', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'iris-fisher-1936' }),
  }).then((response) => response.json());
}

async function analyze(base, datasetId, question) {
  const response = await fetch(base + '/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetId, question }),
  });
  return readNdjson(response);
}

test('DeepSeek 工具调用：官方端点、固定工具集、参数校验与真实执行', async (t) => {
  const mock = createModelFetch(() =>
    deepSeekResponse([
      functionCall('call_deepseek_1', 'group_summary', {
        groupBy: 'species',
        metric: 'petal_length',
      }),
      functionCall('call_deepseek_2', 'one_way_anova', {
        groupBy: 'species',
        metric: 'petal_length',
      }),
    ]),
  );
  const { app, listener } = await boot(mock.fetchImpl);
  t.after(() => app.close());

  const base = listener.url;
  const sample = await loadSample(base);
  const events = await analyze(
    base,
    sample.dataset.id,
    '不同品种的花瓣长度有差异吗？',
  );
  const completed = events.find((event) => event.type === 'completed');
  assert.ok(completed, JSON.stringify(events.at(-1)));

  assert.equal(completed.mode.type, 'model');
  assert.equal(completed.mode.provider, 'DeepSeek');
  assert.equal(completed.mode.endpoint, DEEPSEEK_API_ENDPOINT);
  assert.equal(completed.mode.transport, 'deepseek_tool_calls');
  assert.equal(completed.report.mode.model, 'deepseek-flash');
  assert.equal(completed.report.plan.source, 'model');
  assert.ok(
    completed.report.plan.selectionNotes.some((note) =>
      note.includes('DeepSeek 官方 API 原生 tool calls'),
    ),
  );

  const analysisTools = completed.report.trace.toolCalls
    .filter((call) => !['profile_dataset', 'missingness_report'].includes(call.tool))
    .map((call) => call.tool);
  assert.deepEqual(analysisTools, ['group_summary', 'one_way_anova']);

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.headers.authorization, 'Bearer test-key-not-real');
  assert.equal(call.body.model, 'deepseek-flash');
  assert.equal(call.body.tool_choice, 'auto');
  assert.deepEqual(call.body.thinking, { type: 'disabled' });
  assert.deepEqual(
    call.body.tools.map((tool) => tool.function.name),
    ['group_summary', 'one_way_anova', 'group_comparison', 'correlation_analysis'],
  );
  assert.ok(call.body.messages.some((message) => message.content.includes('不同品种的花瓣长度有差异吗')));
  // 原始 CSV 行和预览行不应进入模型请求。
  assert.equal(JSON.stringify(call.body).includes('5.1,3.5,1.4'), false);
  assert.equal(JSON.stringify(call.body).includes('"rows"'), false);
  assert.equal(JSON.stringify(call.body).includes('"preview"'), false);

  const runRecord = await fetch(base + completed.downloads.json).then((response) => response.json());
  assert.equal(runRecord.mode.provider, 'DeepSeek');
  assert.equal(runRecord.mode.endpoint, DEEPSEEK_API_ENDPOINT);
  assert.deepEqual(runRecord.mode.usage, {
    promptTokens: 500,
    completionTokens: 100,
    totalTokens: 600,
  });
  const exportedMarkdown = await fetch(base + completed.downloads.markdown).then((response) =>
    response.text(),
  );
  assert.match(exportedMarkdown, /prompt 500 tokens \/ completion 100 tokens/);
});

test('DeepSeek 工具调用：模型返回多余参数时拒绝执行并回退本地规则', async (t) => {
  const mock = createModelFetch(() =>
    deepSeekResponse([
      functionCall('call_bad_params', 'group_summary', {
        groupBy: 'species',
        metric: 'petal_length',
        shell: 'curl https://example.com',
      }),
    ]),
  );
  const { app, listener } = await boot(mock.fetchImpl);
  t.after(() => app.close());

  const base = listener.url;
  const sample = await loadSample(base);
  const events = await analyze(
    base,
    sample.dataset.id,
    '不同品种的花瓣长度有差异吗？',
  );
  const modeEvent = events.find((event) => event.type === 'mode' && event.warning);
  assert.ok(modeEvent, 'fallback mode event missing');
  const completed = events.find((event) => event.type === 'completed');
  assert.ok(completed, JSON.stringify(events.at(-1)));
  assert.equal(completed.mode.type, 'fallback');
  assert.match(completed.mode.fallbackReason, /DeepSeek|校验|参数/i);
  assert.deepEqual(completed.mode.usage, {
    promptTokens: 500,
    completionTokens: 100,
    totalTokens: 600,
  });
  assert.equal(completed.report.plan.source, 'local_rules');
  assert.ok(completed.report.trace.toolCalls.every((call) => call.tool !== 'shell_exec'));
  assert.ok(completed.report.trace.toolCalls.some((call) => call.tool === 'group_summary'));
  assert.equal(
    completed.report.trace.toolCalls.some(
      (call) => JSON.stringify(call.params).includes('shell'),
    ),
    false,
  );
});

test('未配置 DEEPSEEK_API_KEY：明确演示模式与配置说明，不发起模型请求', async (t) => {
  let modelCalls = 0;
  const failingFetch = async () => {
    modelCalls += 1;
    throw new Error('should not call DeepSeek without key');
  };
  const app = await createLabmateApp({ env: {}, modelFetch: failingFetch });
  const listener = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());

  const base = listener.url;
  const health = await fetch(base + '/api/health').then((response) => response.json());
  assert.equal(health.mode.mode, 'demo');
  assert.equal(health.mode.provider, 'DeepSeek');
  assert.equal(health.mode.endpoint, DEEPSEEK_API_ENDPOINT);
  assert.equal(health.mode.transport, 'local_rules');
  assert.equal(health.mode.configured, false);
  assert.equal(health.mode.keyStatus, 'missing');
  assert.match(health.mode.reason, /DEEPSEEK_API_KEY/);
  assert.equal(health.mode.setup.envKey, 'DEEPSEEK_API_KEY');

  const sample = await loadSample(base);
  const events = await analyze(base, sample.dataset.id, '不同品种的花瓣长度有差异吗？');
  const completed = events.find((event) => event.type === 'completed');
  assert.ok(completed, JSON.stringify(events.at(-1)));
  assert.equal(completed.mode.type, 'demo');
  assert.match(completed.mode.description, /DEEPSEEK_API_KEY/);
  assert.equal(modelCalls, 0);
});

test('模板占位 Key 被识别为未配置，不发出任何 DeepSeek 请求', async (t) => {
  let modelCalls = 0;
  const failingFetch = async () => {
    modelCalls += 1;
    throw new Error('should not call DeepSeek with placeholder key');
  };
  const app = await createLabmateApp({
    env: { DEEPSEEK_API_KEY: 'sk-your-key-here' },
    modelFetch: failingFetch,
  });
  const listener = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());

  const base = listener.url;
  const health = await fetch(base + '/api/health').then((response) => response.json());
  assert.equal(health.mode.mode, 'demo');
  assert.equal(health.mode.configured, false);
  assert.equal(health.mode.keyStatus, 'placeholder');
  assert.match(health.mode.reason, /占位值/);
  assert.match(health.mode.reason, /不会自动生成或获取密钥/);
  assert.equal('apiKey' in health.mode, false);
  assert.equal(JSON.stringify(health.mode).includes('sk-your-key-here'), false);

  const sample = await loadSample(base);
  const events = await analyze(base, sample.dataset.id, '不同品种的花瓣长度有差异吗？');
  const completed = events.find((event) => event.type === 'completed');
  assert.ok(completed, JSON.stringify(events.at(-1)));
  assert.equal(completed.mode.type, 'demo');
  assert.match(completed.mode.description, /占位值/);
  assert.equal(modelCalls, 0);
});
