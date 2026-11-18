import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 可选的本地 .env（不覆盖已经存在的进程环境变量）。没有 .env 时静默进入演示模式。
try {
  process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.warn('[labmate] .env 读取失败，继续使用现有环境变量：', error.message);
  }
}
import { CsvError, CSV_LIMITS, parseCsv } from './lib/csv.mjs';
import { createDataset, publicDataset } from './lib/dataset.mjs';
import {
  IRIS_META,
  loadIrisDataset,
  publicExampleMeta,
} from './lib/examples.mjs';
import { runAgent } from './lib/agent.mjs';
import { getDeepSeekConfig, publicDeepSeekStatus } from './lib/llm.mjs';
import { listTools } from './lib/tools.mjs';
import { reportToMarkdown } from './lib/report.mjs';

const APP_VERSION = '1.0.0';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MAX_JSON_BODY = 16 * 1024 * 1024;
const MAX_DATASETS = 12;
const MAX_RUNS = 100;
const DATASET_TTL_MS = 2 * 60 * 60 * 1000;
const RUN_TTL_MS = 24 * 60 * 60 * 1000;

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
]);

export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function securityHeaders() {
  return {
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'SAMEORIGIN',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'x-robots-tag': 'noindex, nofollow',
  };
}

function json(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function htmlError(res, status, message) {
  const body = Buffer.from(
    `<!doctype html><meta charset="utf-8"><title>${status}</title><body style="font-family:system-ui;padding:3rem;color:#1f3046"><h1>${status}</h1><p>${escapeHtml(
      message,
    )}</p></body>`,
    'utf8',
  );
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.byteLength,
  });
  res.end(body);
}

function apiError(res, error) {
  if (error instanceof HttpError) {
    return json(res, error.status, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  }
  if (error instanceof CsvError) {
    return json(res, 422, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && Object.keys(error.details).length ? { details: error.details } : {}),
      },
    });
  }
  console.error('[labmate] unhandled API error:', error);
  return json(res, 500, {
    error: {
      code: 'INTERNAL_ERROR',
      message: '服务端出现未处理错误，请稍后重试。',
    },
  });
}

function readJson(req, limitBytes = MAX_JSON_BODY) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        fail(new HttpError(413, 'BODY_TOO_LARGE', '请求体过大，请减小 CSV 文件后重试。'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (size === 0) {
        reject(new HttpError(400, 'EMPTY_BODY', '请求体为空。'));
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('body must be a JSON object');
        }
        resolvePromise(parsed);
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', '请求体不是有效的 JSON 对象。'));
      }
    });
    req.on('error', (error) => fail(error));
  });
}

function normalizeFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new HttpError(400, 'MISSING_FILENAME', '请选择要导入的 CSV 文件。');
  }
  const base = filename.split(/[\\/]/).pop()?.trim() ?? '';
  if (!base) {
    throw new HttpError(400, 'INVALID_FILENAME', '文件名无效。');
  }
  if (extname(base).toLowerCase() !== '.csv') {
    throw new HttpError(415, 'UNSUPPORTED_FILE_TYPE', '当前版本只支持 .csv 格式的公开数据文件。');
  }
  if (base.length > 160) {
    throw new HttpError(400, 'FILENAME_TOO_LONG', '文件名过长，请重命名后再上传。');
  }
  if (/[\u0000-\u001f\u007f]/.test(base)) {
    throw new HttpError(400, 'INVALID_FILENAME', '文件名包含不可见控制字符，请重命名后再上传。');
  }
  return base;
}

function checkContentLengthHeader(req) {
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY) {
    throw new HttpError(413, 'BODY_TOO_LARGE', '请求体过大，请减小 CSV 文件后重试。');
  }
}

function createId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function contentDispositionFilename(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function readStatic(file) {
  const fullPath = resolve(PUBLIC_DIR, file);
  if (!fullPath.startsWith(resolve(PUBLIC_DIR))) {
    throw new HttpError(404, 'NOT_FOUND', '页面不存在。');
  }
  return readFile(fullPath);
}

export async function createLabmateApp({ env = process.env, modelFetch = fetch } = {}) {
  const config = getDeepSeekConfig(env);
  /** @type {Map<string, any>} */
  const datasets = new Map();
  /** @type {Map<string, any>} */
  const runs = new Map();
  let sampleDataset = null;
  let sampleError = null;

  try {
    sampleDataset = await loadIrisDataset();
    datasets.set(sampleDataset.id, {
      ...sampleDataset,
      lastAccess: Date.now(),
    });
  } catch (error) {
    sampleError = error;
    console.error('[labmate] 无法载入 Iris 示例数据：', error.message);
  }

  function touchDataset(dataset) {
    const stored = datasets.get(dataset.id);
    if (stored) stored.lastAccess = Date.now();
  }

  function pruneDatasets() {
    const now = Date.now();
    const uploads = [...datasets.values()]
      .filter((dataset) => dataset.kind !== 'sample')
      .sort((a, b) => a.lastAccess - b.lastAccess);
    for (const dataset of uploads) {
      if (Date.now() - dataset.lastAccess > DATASET_TTL_MS) {
        datasets.delete(dataset.id);
      }
    }
    while (datasets.size > MAX_DATASETS) {
      const oldest = [...datasets.values()]
        .filter((dataset) => dataset.kind !== 'sample')
        .sort((a, b) => a.lastAccess - b.lastAccess)[0];
      if (!oldest) break;
      datasets.delete(oldest.id);
    }
    const activeUploads = uploads.filter((dataset) => Date.now() - dataset.lastAccess <= DATASET_TTL_MS);
    return activeUploads.length;
  }

  function pruneRuns() {
    for (const [id, run] of runs) {
      if (Date.now() - run.createdAt > RUN_TTL_MS) runs.delete(id);
    }
    while (runs.size > MAX_RUNS) {
      const oldest = [...runs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      runs.delete(oldest[0]);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'INVALID_URL', '请求地址包含无效的百分号编码。');
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        app: '研数搭子',
        version: APP_VERSION,
        mode: publicDeepSeekStatus(config),
        sample: sampleDataset
          ? {
              available: true,
              id: IRIS_META.id,
              title: IRIS_META.title,
              rowCount: sampleDataset.rowCount,
              columnCount: sampleDataset.columnCount,
            }
          : { available: false, error: sampleError?.message ?? '示例数据未载入' },
        tools: listTools().map((tool) => ({ name: tool.name, label: tool.label })),
        limits: {
          maxBytes: CSV_LIMITS.maxBytes,
          maxRows: CSV_LIMITS.maxRows,
          maxColumns: CSV_LIMITS.maxColumns,
          formats: ['csv'],
        },
        privacy: {
          rawDataStoredOnDisk: false,
          rawRowsSentToModel: false,
          dataResidency: '仅当前本机 Node.js 进程内存；重启即清空上传数据。',
        },
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    if (pathname === '/api/examples' && req.method === 'GET') {
      if (!sampleDataset) {
        throw new HttpError(503, 'SAMPLE_UNAVAILABLE', '示例数据未载入，请检查 data/iris.csv。');
      }
      return json(res, 200, {
        examples: [publicExampleMeta(sampleDataset)],
      });
    }

    if (pathname === '/api/datasets/sample' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.id !== IRIS_META.id) {
        throw new HttpError(404, 'EXAMPLE_NOT_FOUND', '找不到这个内置示例数据集。');
      }
      if (!sampleDataset) {
        throw new HttpError(503, 'SAMPLE_UNAVAILABLE', '示例数据未载入，请检查 data/iris.csv。');
      }
      touchDataset(sampleDataset);
      return json(res, 200, {
        dataset: publicDataset(sampleDataset, 8),
        example: publicExampleMeta(sampleDataset),
      });
    }

    if (pathname === '/api/datasets' && req.method === 'POST') {
      checkContentLengthHeader(req);
      const body = await readJson(req);
      const filename = normalizeFilename(body.filename);
      if (typeof body.content !== 'string' || body.content.length === 0) {
        throw new HttpError(400, 'MISSING_CONTENT', 'CSV 内容为空，请重新选择文件。');
      }
      const byteLength = Buffer.byteLength(body.content, 'utf8');
      if (byteLength > CSV_LIMITS.maxBytes) {
        throw new HttpError(
          413,
          'FILE_TOO_LARGE',
          `文件超过 ${Math.round(CSV_LIMITS.maxBytes / 1024 / 1024)} MB。请先抽样或拆分数据。`,
        );
      }
      const parsed = parseCsv(body.content, {
        maxRows: CSV_LIMITS.maxRows,
        maxColumns: CSV_LIMITS.maxColumns,
      });
      const sha256 = createHash('sha256').update(Buffer.from(body.content, 'utf8')).digest('hex');
      const id = createId('ds');
      const dataset = createDataset({
        id,
        name: filename,
        headers: parsed.headers,
        rows: parsed.rows,
        source: {
          type: 'upload',
          title: filename,
          provider: '本地上传',
          fileName: filename,
          byteSize: byteLength,
          sha256,
          uploadedAt: new Date().toISOString(),
          note: '原始 CSV 仅在本机内存中处理，未写入磁盘，也未发送给模型；页面预览仅保存在当前浏览器会话。',
          dataCaveat: null,
        },
        fieldMeta: {},
        parserWarnings: parsed.warnings,
        kind: 'upload',
      });
      datasets.set(id, { ...dataset, lastAccess: Date.now() });
      const activeUploads = pruneDatasets();
      return json(res, 201, {
        dataset: publicDataset(dataset, 8),
        meta: {
          activeUploads,
          note: '数据仅保存在当前分析进程的内存中。',
        },
      });
    }

    if (pathname === '/api/analyze' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body.datasetId !== 'string' || !body.datasetId.trim()) {
        throw new HttpError(400, 'MISSING_DATASET', '请先选择示例数据或导入 CSV。');
      }
      if (typeof body.question !== 'string' || !body.question.trim()) {
        throw new HttpError(400, 'MISSING_QUESTION', '请输入研究问题。');
      }
      if (body.question.length > 1000) {
        throw new HttpError(400, 'QUESTION_TOO_LONG', '研究问题过长，请聚焦到一个可检验的问题。');
      }
      const dataset = datasets.get(body.datasetId);
      if (!dataset) {
        throw new HttpError(
          404,
          'DATASET_NOT_FOUND',
          '找不到这个数据集。服务重启后上传数据会被清空，请重新导入。',
        );
      }
      touchDataset(dataset);

      res.writeHead(200, {
        ...securityHeaders(),
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      res.flushHeaders?.();

      let responseClosed = false;
      res.on('close', () => {
        if (!res.writableEnded) responseClosed = true;
      });
      const writeEvent = (event) => {
        if (responseClosed || res.writableEnded) return;
        try {
          res.write(`${JSON.stringify(event)}\n`);
        } catch {
          responseClosed = true;
        }
      };

      let result;
      try {
        result = await runAgent({
          dataset,
          question: body.question,
          config,
          onEvent: writeEvent,
          modelFetch,
        });
      } catch (error) {
        console.error('[labmate] agent crashed:', error);
        writeEvent({
          type: 'failed',
          runId: null,
          error: {
            code: 'AGENT_CRASH',
            message: '分析服务出现内部错误，请重试。',
            suggestions: [],
          },
          steps: [],
          mode: publicDeepSeekStatus(config),
          toolCalls: [],
        });
        if (!responseClosed) res.end();
        return;
      }

      if (result.ok) {
        pruneRuns();
        runs.set(result.runId, {
          report: result.report,
          runRecord: result.runRecord,
          createdAt: Date.parse(result.runRecord.createdAt) || Date.now(),
          datasetId: dataset.id,
        });
        writeEvent({
          type: 'completed',
          runId: result.runId,
          report: result.report,
          mode: result.modeInfo,
          durationMs: result.durationMs,
          verification: result.runRecord.verification,
          downloads: {
            markdown: `/api/runs/${result.runId}/report.md`,
            json: `/api/runs/${result.runId}/record.json`,
          },
        });
      }
      if (!responseClosed) res.end();
      return;
    }

    const runMatch = pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/(report\.md|record\.json)$/);
    if (runMatch && req.method === 'GET') {
      const [, runId, format] = runMatch;
      const record = runs.get(runId);
      if (!record) {
        throw new HttpError(404, 'RUN_NOT_FOUND', '找不到这次运行记录；它可能已过期或服务已重启。');
      }
      const safeQuestion = String(record.report.title ?? 'analysis')
        .replace(/[\\/:*?"<>|\r\n]/g, '')
        .replace(/\s+/g, '_')
        .slice(0, 32) || 'analysis';
      if (format === 'report.md') {
        const markdown = reportToMarkdown(record.report, record.runRecord);
        const body = Buffer.from(markdown, 'utf8');
        res.writeHead(200, {
          ...securityHeaders(),
          'content-type': 'text/markdown; charset=utf-8',
          'content-length': body.byteLength,
          'content-disposition': contentDispositionFilename(`研数搭子_${safeQuestion}_${runId}.md`),
          'cache-control': 'no-store',
        });
        return res.end(body);
      }
      const body = Buffer.from(JSON.stringify(record.runRecord, null, 2), 'utf8');
      res.writeHead(200, {
        ...securityHeaders(),
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.byteLength,
        'content-disposition': contentDispositionFilename(`研数搭子_${safeQuestion}_${runId}.json`),
        'cache-control': 'no-store',
      });
      return res.end(body);
    }

    if (pathname.startsWith('/api/')) {
      throw new HttpError(404, 'API_NOT_FOUND', '接口不存在。');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该页面只支持 GET 请求。');
    }
    const staticFile = STATIC_FILES.get(pathname);
    if (!staticFile) {
      return htmlError(res, 404, '页面不存在。');
    }
    const file = await readStatic(staticFile.file);
    res.writeHead(200, {
      ...securityHeaders(),
      'content-type': staticFile.type,
      'content-length': file.byteLength,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(file);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // ignore
        }
        return;
      }
      if (error instanceof HttpError) {
        if ((req.headers.accept ?? '').includes('text/html') && !new URL(req.url ?? '/', 'http://x').pathname.startsWith('/api/')) {
          return htmlError(res, error.status, error.message);
        }
        return apiError(res, error);
      }
      if (error instanceof CsvError) return apiError(res, error);
      return apiError(res, error);
    }
  });

  return {
    server,
    config,
    sampleDataset,
    sampleError,
    datasets,
    runs,
    listen({ port = 4173, host = '127.0.0.1' } = {}) {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolvePromise({
            server,
            port: typeof address === 'object' && address ? address.port : port,
            host,
            url: `http://${host}:${typeof address === 'object' && address ? address.port : port}`,
          });
        });
      });
    },
    async close() {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

async function main() {
  const env = process.env;
  const port = Number.parseInt(env.PORT ?? '4173', 10) || 4173;
  const host = env.HOST?.trim() || '127.0.0.1';
  const app = await createLabmateApp({ env });
  if (app.sampleError) {
    console.error(
      '[labmate] 示例数据不可用。请确认 labmate/data/iris.csv 存在且为有效 CSV。',
    );
  }
  await app.listen({ port, host });
  const status = publicDeepSeekStatus(app.config);
  console.log(`\n研数搭子 LabMate`);
  console.log(`  ${status.modeLabel}${status.model ? ` · ${status.model}` : ''}`);
  if (!status.configured) {
    console.log('  提示: 设置后端环境变量 DEEPSEEK_API_KEY 后可启用 DeepSeek 工具调用。');
  }
  console.log(`  本地地址: http://${host}:${port}`);
  console.log(`  数据目录: ./data   |  原始 CSV 不上传云端`);
  console.log(`  停止服务: Ctrl+C\n`);
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((error) => {
    console.error('[labmate] 启动失败：', error);
    process.exitCode = 1;
  });
}

export { APP_VERSION, MAX_JSON_BODY };
