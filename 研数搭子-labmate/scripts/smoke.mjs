/**
 * 无浏览器烟雾测试：
 * 启动本地服务 → 载入示例 → 执行一次真实 Agent 分析 → 校验关键输出。
 * 用法：npm run test:smoke
 */
import assert from 'node:assert/strict';
import { createLabmateApp } from '../server.mjs';

const app = await createLabmateApp({ env: {} });
const listener = await app.listen({ port: 0, host: '127.0.0.1' });
const base = listener.url;

try {
  const health = await fetch(base + '/api/health').then((response) => response.json());
  assert.equal(health.ok, true);
  console.log(`✓ 本地服务已启动：${base}（${health.mode.modeLabel}）`);

  const sample = await fetch(base + '/api/datasets/sample', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'iris-fisher-1936' }),
  }).then((response) => response.json());
  console.log(
    `✓ 示例数据：${sample.dataset.name}（${sample.dataset.rowCount} 行 × ${sample.dataset.columnCount} 列）`,
  );

  const response = await fetch(base + '/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      datasetId: sample.dataset.id,
      question: '不同品种的花瓣长度有差异吗？',
    }),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const event = JSON.parse(line);
        if (event.type === 'completed') completed = event;
      }
      newline = buffer.indexOf('\n');
    }
  }
  assert.ok(completed, '未收到 completed 事件');
  console.log(`✓ 分析完成：${completed.report.oneLineAnswer}`);
  console.log(
    `✓ 证据：${completed.report.trace.toolCalls.length} 次工具调用，${completed.report.charts.length} 张图，${completed.report.tables.length} 张统计表`,
  );

  const markdown = await fetch(base + completed.downloads.markdown).then((res) => res.text());
  const runRecord = await fetch(base + completed.downloads.json).then((res) => res.json());
  assert.match(markdown, /研数搭子分析报告/);
  assert.equal(runRecord.privacy.rawRowsIncluded, false);
  console.log('✓ Markdown 报告与 JSON 运行记录可下载，未包含原始数据行');
  console.log(`\n烟雾测试通过。打开页面：${base}`);
} finally {
  await app.close();
}
