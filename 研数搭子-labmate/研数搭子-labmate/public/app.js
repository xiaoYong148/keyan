/* global document, window, fetch, AbortController, TextDecoder, IntersectionObserver */
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STEP_DEFS = [
  { id: 'inspect_data', label: '检查数据', en: 'INSPECT' },
  { id: 'understand', label: '理解问题', en: 'UNDERSTAND' },
  { id: 'plan', label: '制定计划', en: 'PLAN' },
  { id: 'execute', label: '执行分析', en: 'EXECUTE' },
  { id: 'verify', label: '校验结果', en: 'VERIFY' },
  { id: 'report', label: '生成报告', en: 'REPORT' },
];

const INTENT_LABELS = {
  group_difference: '组间差异',
  correlation: '相关性分析',
  mixed: '组间差异 + 相关性',
  exploratory: '探索性分析',
  unsupported: '超出范围',
};

const STATUS_LABELS = {
  pending: '待执行',
  running: '进行中',
  success: '已完成',
  failed: '失败',
};

const MISSING_TOKENS = new Set(['', 'na', 'n/a', 'null', 'nan', 'none', 'missing', '缺失', '无数据']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const state = {
  health: null,
  mode: null,
  examples: [],
  dataset: null,
  datasetLoading: false,
  running: false,
  runSequence: 0,
  abortController: null,
  runId: null,
  steps: defaultSteps(),
  modeInfo: null,
  plan: null,
  toolCalls: new Map(),
  logs: [],
  verification: null,
  report: null,
  downloads: null,
  startedAt: null,
  elapsedTimer: null,
  terminalReceived: false,
};

function defaultSteps() {
  return STEP_DEFS.map((step) => ({ ...step, status: 'pending', detail: '' }));
}

function esc(value) {
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

function icon(name, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function safeExternalUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return esc(parsed.href);
  } catch {
    // ignore
  }
  return '';
}

function formatNumber(value, digits = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1_000_000 || abs < 0.0001)) return value.toExponential(2);
  return Number(value.toFixed(digits)).toLocaleString('zh-CN', {
    maximumFractionDigits: digits,
  });
}

function formatPercent(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms > 0 && ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function isMissingRaw(value) {
  return MISSING_TOKENS.has(String(value ?? '').trim().toLowerCase());
}

function normalizeMode(mode) {
  if (!mode) return null;
  if (mode.type) {
    return {
      type: mode.type,
      label: mode.label ?? mode.type,
      description: mode.description ?? '',
      model: mode.model ?? null,
      provider: mode.provider ?? 'DeepSeek',
      endpoint: mode.endpoint ?? null,
      planningSource: mode.planningSource ?? null,
      fallbackReason: mode.fallbackReason ?? null,
      setupHint: mode.setupHint ?? null,
    };
  }
  const type = mode.mode === 'model' ? 'model' : 'demo';
  return {
    type,
    label: mode.modeLabel ?? (type === 'model' ? 'DeepSeek 工具调用模式' : '演示模式'),
    description:
      type === 'model'
        ? 'DeepSeek 通过官方 API 工具调用选择受控分析工具；统计值由本地工具真实计算。'
        : '本地规则规划 + 真实受控统计工具执行；未调用模型。',
    model: mode.model ?? null,
    provider: mode.provider ?? 'DeepSeek',
    endpoint: mode.endpoint ?? null,
    planningSource: type === 'model' ? 'deepseek_tool_calls' : 'local_rules',
    fallbackReason: mode.reason ?? null,
    setupHint: mode.setup?.steps?.join(' ') ?? null,
  };
}

class ApiError extends Error {
  constructor(message, { code = 'REQUEST_FAILED', details = null, suggestions = [] } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.suggestions = suggestions;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = data?.error ?? {};
    throw new ApiError(error.message ?? `请求失败（HTTP ${response.status}）。`, {
      code: error.code ?? `HTTP_${response.status}`,
      details: error.details ?? null,
      suggestions: Array.isArray(error.suggestions) ? error.suggestions : [],
    });
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Initialization                                                     */
/* ------------------------------------------------------------------ */

async function init() {
  bindEvents();
  renderStepper(defaultSteps());
  renderModeBanner();
  resetReportPanel();
  updateRunAvailability();
  updateQuestionUi();

  await loadHealth();
  await loadExamples();
}

async function loadHealth() {
  try {
    const data = await fetchJson('/api/health');
    state.health = data;
    state.mode = normalizeMode(data.mode);
    state.modeInfo = state.mode;
    updateServiceState(true);
    updateModeBadge(state.mode);
    renderModeBanner();
    updatePrivacyNote();
    if (!data.sample?.available) {
      setSampleUnavailable(data.sample?.error ?? '内置示例数据暂不可用。');
    }
  } catch (error) {
    updateServiceState(false);
    setModeError();
    showDataError(`无法连接本地分析服务。${error.message}`, {
      code: error.code ?? 'SERVICE_OFFLINE',
    });
    disableDataInputs();
  }
}

async function loadExamples() {
  try {
    const data = await fetchJson('/api/examples');
    state.examples = Array.isArray(data.examples) ? data.examples : [];
    renderSampleCard(state.examples[0] ?? null);
    renderSuggestionChips();
  } catch (error) {
    state.examples = [];
    renderSampleCard(null);
    setSampleUnavailable('示例元数据读取失败。');
    renderSuggestionChips();
  }
}

function updateServiceState(online) {
  const el = $('#service-state');
  el.classList.toggle('is-offline', !online);
  el.innerHTML = `<i></i>${online ? '本地分析服务 · 已连接' : '本地分析服务 · 未连接'}`;
}

function setModeError() {
  const badge = $('#mode-badge');
  badge.className = 'mode-badge is-loading';
  $('#mode-badge-text').textContent = '服务未连接';
}

function renderSampleCard(example) {
  const card = $('#sample-card');
  const button = $('#sample-load');
  const title = $('#sample-title');
  const description = $('#sample-description');
  const meta = $('#sample-meta');
  card.setAttribute('aria-busy', 'false');
  card.classList.remove('is-loaded');

  if (!example) {
    title.textContent = '示例数据暂不可用';
    description.textContent = '请导入一个公开 CSV，或检查本地 data/iris.csv 是否存在。';
    meta.innerHTML = '';
    button.disabled = true;
    button.textContent = '不可用';
    return;
  }

  title.textContent = example.shortTitle ?? example.title ?? 'Iris 鸢尾花数据集';
  description.textContent =
    example.description ?? '公开可追溯的经典形态测量数据，适合演示组间比较与相关分析。';
  meta.innerHTML = [
    `${esc(example.rowCount ?? 150)} 行`,
    `${esc(example.columnCount ?? 5)} 字段`,
    '3 个品种',
  ]
    .map((item) => `<span>${item}</span>`)
    .join('');
  button.disabled = state.datasetLoading || Boolean(state.running);
  button.textContent = state.dataset?.kind === 'sample' ? '重新载入' : '载入';
  if (state.dataset?.kind === 'sample') card.classList.add('is-loaded');
}

function setSampleUnavailable(message) {
  const button = $('#sample-load');
  button.disabled = true;
  button.textContent = '不可用';
  const description = $('#sample-description');
  if (description) description.textContent = message;
  showDataError(message, { code: 'SAMPLE_UNAVAILABLE' });
}

function disableDataInputs() {
  $('#sample-load').disabled = true;
  $('#dropzone').disabled = true;
  $('#file-input').disabled = true;
  $('#run-button').disabled = true;
}

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('#sample-load').addEventListener('click', () => loadSampleDataset());
  $('#dropzone').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) uploadFile(file);
    event.target.value = '';
  });

  const dropzone = $('#dropzone');
  for (const eventName of ['dragenter', 'dragover']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.add('is-dragging');
    });
  }
  for (const eventName of ['dragleave', 'dragend']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragging');
    });
  }
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.remove('is-dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) uploadFile(file);
  });

  $('#change-data').addEventListener('click', changeDataset);
  $('#preview-open').addEventListener('click', openDatasetDialog);
  $('#data-error-close').addEventListener('click', () => hideDataError());

  $('#question-input').addEventListener('input', (event) => {
    state.question = event.target.value;
    updateQuestionUi();
    updateRunAvailability();
    hideQuestionError();
  });
  $('#question-input').addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!isRunDisabled()) runAnalysis();
    }
  });

  $('#run-button').addEventListener('click', () => {
    if (!isRunDisabled()) runAnalysis();
  });
  $('#retry-button').addEventListener('click', () => {
    $('#question-input').focus();
    $('#question-input').select();
  });

  $('#print-report').addEventListener('click', () => {
    if (!state.report) return;
    openAllReportDetails();
    window.print();
  });
  window.addEventListener('beforeprint', openAllReportDetails);

  for (const id of ['help-open', 'how-open', 'footer-help']) {
    $(`#${id}`).addEventListener('click', () => openDialog('help-dialog'));
  }
  for (const button of $$('[data-close-dialog]')) {
    button.addEventListener('click', () => closeDialog(button.dataset.closeDialog));
  }
  for (const dialog of $$('dialog.modal')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  $('#suggestion-chips').addEventListener('click', (event) => {
    const button = event.target.closest('.suggestion-chip');
    if (!button) return;
    const input = $('#question-input');
    input.value = button.textContent.trim();
    state.question = input.value;
    updateQuestionUi();
    updateRunAvailability();
    hideQuestionError();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      for (const dialog of $$('dialog.modal[open]')) dialog.close();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Data input                                                         */
/* ------------------------------------------------------------------ */

async function loadSampleDataset() {
  if (state.datasetLoading || state.running) return;
  const example = state.examples[0];
  if (!example) return;
  setDatasetLoading(true, '正在载入 Iris…');
  hideDataError();
  try {
    const data = await fetchJson('/api/datasets/sample', {
      method: 'POST',
      body: JSON.stringify({ id: example.id }),
    });
    applyDataset(data.dataset);
    showToast('Iris 示例已载入，数据检查将在分析时重新执行。', 'success');
  } catch (error) {
    showDataError(error.message, { code: error.code });
  } finally {
    setDatasetLoading(false);
  }
}

async function uploadFile(file) {
  if (state.datasetLoading || state.running) return;
  hideDataError();
  if (!file.name.toLowerCase().endsWith('.csv')) {
    showDataError('当前版本只支持 .csv 文件。请将数据导出为 CSV 后再上传。', {
      code: 'UNSUPPORTED_FILE_TYPE',
    });
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showDataError(
      `文件超过 5 MB（当前 ${(file.size / 1024 / 1024).toFixed(1)} MB）。请先抽样或拆分数据。`,
      { code: 'FILE_TOO_LARGE' },
    );
    return;
  }
  let content;
  try {
    const buffer = await file.arrayBuffer();
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    showDataError('文件不是有效的 UTF-8 文本。请用 Excel 以「CSV UTF-8」格式重新导出。', {
      code: 'INVALID_ENCODING',
    });
    return;
  }
  setDatasetLoading(true, '正在只读检查 CSV…');
  try {
    const data = await fetchJson('/api/datasets', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, content }),
    });
    applyDataset(data.dataset);
    const warningCount = data.dataset?.quality?.warnings?.length ?? 0;
    showToast(
      warningCount > 0
        ? `CSV 已载入，发现 ${warningCount} 条数据提示，可点击“字段质量”查看。`
        : 'CSV 已载入并通过基础格式检查。',
      warningCount > 0 ? 'default' : 'success',
    );
  } catch (error) {
    showDataError(error.message, { code: error.code });
  } finally {
    setDatasetLoading(false);
  }
}

function setDatasetLoading(loading, note = '') {
  state.datasetLoading = loading;
  const sampleButton = $('#sample-load');
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const dataState = $('#data-state');
  sampleButton.disabled = loading || Boolean(state.running);
  dropzone.disabled = loading || Boolean(state.running);
  fileInput.disabled = loading || Boolean(state.running);
  if (loading) {
    dataState.className = 'state-chip state-loading';
    dataState.textContent = '读取中';
    dropzone.querySelector('.dropzone-title').textContent = note || '正在检查文件…';
    sampleButton.textContent = '载入中…';
  } else {
    dropzone.querySelector('.dropzone-title').textContent = '拖入 CSV 或点击选择';
    if (!state.dataset) {
      dataState.className = 'state-chip state-idle';
      dataState.textContent = '未载入';
    }
    sampleButton.textContent = state.dataset?.kind === 'sample' ? '重新载入' : '载入';
    sampleButton.disabled = !state.examples.length || Boolean(state.running);
  }
  updateRunAvailability();
}

function applyDataset(dataset) {
  if (!dataset) return;
  abortActiveRun({ silent: true });
  const changed = state.dataset?.id !== dataset.id;
  state.dataset = dataset;
  if (changed) {
    state.question = '';
    $('#question-input').value = '';
  }
  hideDataError();
  hideQuestionError();
  resetAnalysisOutput();
  renderDatasetSummary();
  renderSuggestionChips();
  updateQuestionUi();
  updateRunAvailability();
  $('#data-chooser').hidden = true;
  $('#dataset-loaded').hidden = false;
  $('#data-state').className = 'state-chip state-success';
  $('#data-state').textContent = dataset.quality?.warnings?.length ? '检查完成 · 有提示' : '检查完成';
  $('#sample-card').classList.toggle('is-loaded', dataset.kind === 'sample');
  renderSampleCard(state.examples[0] ?? null);
}

function renderDatasetSummary() {
  const dataset = state.dataset;
  if (!dataset) return;
  const quality = dataset.quality ?? {};
  $('#loaded-name').textContent = dataset.name;
  $('#loaded-source').textContent =
    dataset.source?.provider ?? (dataset.kind === 'sample' ? '公开示例数据' : '本地上传');
  $('#metric-rows').textContent = formatNumber(dataset.rowCount, 0);
  $('#metric-columns').textContent = formatNumber(dataset.columnCount, 0);
  $('#metric-missing').textContent = formatPercent(quality.missingRate ?? 0, 1);
  $('#metric-duplicates').textContent = formatNumber(quality.duplicateRowCount ?? 0, 0);

  $('#schema-chips').innerHTML = dataset.columns
    .map(
      (column) =>
        `<span class="schema-chip type-${esc(column.type)}" title="${esc(column.name)} · ${esc(
          column.typeLabel,
        )}${column.unit ? ` · ${esc(column.unit)}` : ''}">${esc(column.label)}</span>`,
    )
    .join('');

  const headers = dataset.preview?.headers ?? dataset.columns.map((column) => column.name);
  const rows = dataset.preview?.rows?.slice(0, 3) ?? [];
  $('#mini-preview').innerHTML = `<table>
    <thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map(
        (row) =>
          `<tr>${headers
            .map((_, index) => {
              const value = row[index] ?? '';
              return `<td class="${isMissingRaw(value) ? 'is-missing' : ''}">${esc(
                isMissingRaw(value) ? '空值' : value,
              )}</td>`;
            })
            .join('')}</tr>`,
      )
      .join('')}</tbody>
  </table>`;
  const warnings = quality.warnings ?? [];
  $('#preview-note').textContent =
    warnings.length > 0
      ? `仅展示前 ${rows.length} 行；发现 ${warnings.length} 条数据提示，点击“字段质量与完整预览”查看。`
      : `仅展示前 ${rows.length} 行；原始文件不离开本机。`;
  updatePreviewDialogIfOpen();
}

function changeDataset() {
  if (state.running) {
    showToast('分析正在执行，请等当前运行结束后再更换数据。', 'error');
    return;
  }
  if (
    state.report &&
    !window.confirm('更换数据会清空当前分析结果，确定继续吗？')
  ) {
    return;
  }
  state.dataset = null;
  state.question = '';
  $('#question-input').value = '';
  $('#dataset-loaded').hidden = true;
  $('#data-chooser').hidden = false;
  $('#data-state').className = 'state-chip state-idle';
  $('#data-state').textContent = '未载入';
  $('#sample-card').classList.remove('is-loaded');
  $('#sample-load').textContent = '载入';
  resetAnalysisOutput();
  renderSuggestionChips();
  updateQuestionUi();
  updateRunAvailability();
  if (document.activeElement) document.activeElement.blur();
  $('#dropzone').focus();
}

function renderSuggestionChips() {
  const container = $('#suggestion-chips');
  let questions = [];
  if (state.dataset) {
    const numeric = state.dataset.columns.filter((column) => column.type === 'number');
    const groups = state.dataset.columns.filter((column) => column.groupable);
    if (groups.length > 0 && numeric.length > 0) {
      questions.push(`不同「${groups[0].label}」的「${numeric[0].label}」有差异吗？`);
    }
    if (numeric.length >= 2) {
      questions.push(`「${numeric[0].label}」和「${numeric[1].label}」是否相关？`);
    }
    if (groups.length > 0 && numeric.length > 1) {
      questions.push(`不同「${groups[0].label}」的「${numeric[1].label}」有显著差异吗？`);
    } else if (numeric.length >= 3) {
      questions.push(`「${numeric[1].label}」和「${numeric[2].label}」有什么关系？`);
    }
    if (questions.length === 0) {
      questions.push('这份数据的字段质量怎么样？');
    }
  } else {
    questions = state.examples[0]?.suggestedQuestions ?? [
      '不同品种的花瓣长度有差异吗？',
      '花萼长度和花瓣长度是否相关？',
    ];
  }
  questions = [...new Set(questions)].slice(0, 3);
  container.innerHTML = questions
    .map(
      (question) =>
        `<button class="suggestion-chip" type="button" title="${esc(question)}">${esc(question)}</button>`,
    )
    .join('');
}

function showDataError(message, { code = '' } = {}) {
  const box = $('#data-error');
  $('#data-error-text').textContent = message;
  box.hidden = false;
  box.dataset.code = code;
  $('#live-status').textContent = `数据提示：${message}`;
}

function hideDataError() {
  $('#data-error').hidden = true;
}

function updateQuestionUi() {
  const value = $('#question-input').value ?? '';
  state.question = value;
  $('#char-count').textContent = `${value.length} / 300`;
  const dataset = state.dataset;
  if (dataset) {
    const numeric = dataset.columns.find((column) => column.type === 'number');
    const group = dataset.columns.find((column) => column.groupable);
    if (group && numeric) {
      $('#question-input').placeholder = `例如：不同「${group.label}」的「${numeric.label}」有差异吗？`;
    } else if (dataset.columns.filter((column) => column.type === 'number').length >= 2) {
      $('#question-input').placeholder = `例如：数据中的两个数值字段之间是否相关？`;
    } else {
      $('#question-input').placeholder = '例如：这份数据的质量与字段分布怎么样？';
    }
  } else {
    $('#question-input').placeholder = '例如：不同品种的花瓣长度有差异吗？';
  }
}

function showQuestionError(message) {
  $('#question-error').hidden = false;
  $('#question-error-text').textContent = message;
  $('#question-input').classList.add('has-error');
  $('#live-status').textContent = message;
}

function hideQuestionError() {
  $('#question-error').hidden = true;
  $('#question-input').classList.remove('has-error');
}

function updateRunAvailability() {
  const button = $('#run-button');
  const disabled = isRunDisabled();
  button.disabled = disabled;
  button.classList.toggle('is-running', state.running);
  const label = $('.run-button-label');
  const note = $('#run-button-note');
  if (state.running) {
    label.textContent = 'Agent 正在分析';
    note.textContent = '正在执行受控工具，请稍候';
    return;
  }
  if (!state.dataset) {
    label.textContent = '开始分析';
    note.textContent = '先选择数据并输入问题';
    return;
  }
  if (!state.question.trim()) {
    label.textContent = '开始分析';
    note.textContent = '再输入一个研究问题';
    return;
  }
  if (state.question.trim().length < 4) {
    label.textContent = '开始分析';
    note.textContent = '问题至少需要 4 个字符';
    return;
  }
  label.textContent = '开始分析';
  note.textContent = '真实工具执行 · 约数秒完成';
}

function isRunDisabled() {
  return (
    state.running ||
    state.datasetLoading ||
    !state.dataset ||
    state.question.trim().length < 4 ||
    !state.mode
  );
}

/* ------------------------------------------------------------------ */
/* Mode & status                                                      */
/* ------------------------------------------------------------------ */

function updateModeBadge(mode) {
  const badge = $('#mode-badge');
  const text = $('#mode-badge-text');
  if (!mode) {
    badge.className = 'mode-badge is-loading';
    text.textContent = '连接中';
    return;
  }
  const type = mode.type === 'model' ? 'is-model' : mode.type === 'fallback' ? 'is-fallback' : 'is-demo';
  badge.className = `mode-badge ${type}`;
  text.textContent =
    mode.type === 'model'
      ? 'DeepSeek 协同'
      : mode.type === 'fallback'
        ? '演示模式 · DeepSeek 回退'
        : mode.label || '演示模式';
}

function renderModeBanner() {
  const banner = $('#mode-banner');
  const title = $('#mode-banner-title');
  const text = $('#mode-banner-text');
  const mode = state.modeInfo ?? state.mode;
  banner.classList.remove('is-demo', 'is-model', 'is-fallback');
  if (!mode) {
    title.textContent = '正在读取运行模式';
    text.textContent = '正在检查后端是否配置了 DEEPSEEK_API_KEY。';
    return;
  }
  banner.classList.add(
    mode.type === 'model' ? 'is-model' : mode.type === 'fallback' ? 'is-fallback' : 'is-demo',
  );
  if (mode.type === 'model') {
    title.textContent = `DeepSeek 工具调用模式${mode.model ? ` · ${mode.model}` : ''}`;
    text.textContent =
      'DeepSeek 通过官方 API 的原生 tool calls 选择分析工具；工具名、字段和参数由后端校验后才执行，统计由本地工具真实计算，原始数据行不会发送给模型。';
  } else if (mode.type === 'fallback') {
    title.textContent = '演示模式 · DeepSeek 回退';
    text.textContent =
      mode.fallbackReason ??
      'DeepSeek 调用或工具计划校验未通过，已回退到本地规则规划；统计工具仍为真实执行。';
  } else {
    const configNote = `${mode.fallbackReason ?? ''} ${mode.description ?? ''}`;
    const placeholder = configNote.includes('占位');
    title.textContent = placeholder
      ? '演示模式 · DeepSeek Key 仍是占位值'
      : '演示模式 · 未配置有效 DeepSeek API Key';
    text.textContent = placeholder
      ? '当前 .env 里的 DEEPSEEK_API_KEY 仍是模板占位值，未发起任何 DeepSeek 请求。请自行在 DeepSeek 平台创建密钥并替换后重启；统计工具仍真实执行。'
      : '当前没有有效的 DEEPSEEK_API_KEY，不调用任何模型；使用本地规则规划，统计工具仍真实执行。请在后端 .env 中填写真实 DeepSeek API Key 后重启 npm start；只连接 DeepSeek 官方 API。';
  }
  updateModeBadge(mode);
}

function updatePrivacyNote() {
  const note = $('#model-privacy-note');
  const mode = state.modeInfo ?? state.mode;
  if (!note) return;
  if (mode?.type === 'model') {
    note.textContent =
      'DeepSeek 仅接收研究问题、字段结构与聚合统计；原始数据行不会离开本机。所有统计值来自受控工具。';
  } else {
    note.textContent =
      '演示模式不调用模型；所有统计由本地受控工具执行。原始数据行不会离开本机。配置 DEEPSEEK_API_KEY 后可启用 DeepSeek 工具调用。';
  }
}

function setRunState(status, label) {
  const el = $('#run-state');
  el.className = `state-chip state-${status}`;
  el.textContent = label;
}

/* ------------------------------------------------------------------ */
/* Running                                                            */
/* ------------------------------------------------------------------ */

async function runAnalysis() {
  if (state.running || !state.dataset) return;
  const question = $('#question-input').value.trim();
  if (question.length < 4) {
    showQuestionError('请先写下一个至少 4 个字符的研究问题。');
    $('#question-input').focus();
    return;
  }
  if (question.length > 300) {
    showQuestionError('研究问题超过 300 个字符，请聚焦到一个可检验的问题。');
    return;
  }
  hideQuestionError();
  hideDataError();

  const token = ++state.runSequence;
  state.running = true;
  state.terminalReceived = false;
  state.question = question;
  state.abortController = new AbortController();
  state.runId = null;
  state.steps = defaultSteps();
  state.toolCalls = new Map();
  state.logs = [];
  state.plan = null;
  state.verification = null;
  state.report = null;
  state.downloads = null;
  state.modeInfo = state.mode;
  state.startedAt = Date.now();
  state.runError = null;

  $('#trace-empty').hidden = true;
  $('#trace-live').hidden = false;
  $('#run-error').hidden = true;
  $('#plan-box').hidden = true;
  $('#verification-box').hidden = true;
  $('#tool-details').hidden = true;
  $('#tool-calls').innerHTML = '';
  $('#tool-count').textContent = '0';
  $('#trace-log').innerHTML = '';
  $('#current-step').textContent = '准备运行';
  $('#elapsed').textContent = '0.0s';
  $('#report-empty').hidden = true;
  $('#report-error').hidden = true;
  $('#report-content').hidden = true;
  $('#report-running').hidden = false;
  $('#report-running-text').textContent = '正在连接本地 Agent 并检查数据…';
  $('#report-actions').hidden = true;
  setRunState('running', '运行中');
  setReportActions(null);
  renderStepper();
  renderModeBanner();
  updateRunAvailability();
  startElapsedTimer();
  appendLog('创建运行，等待 Agent 返回第一步状态。', 'running', 'RUN');
  $('#live-status').textContent = '分析开始。';

  let terminal = false;
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
      body: JSON.stringify({ datasetId: state.dataset.id, question }),
      signal: state.abortController.signal,
    });

    if (!response.ok) {
      let data = null;
      try {
        data = await response.json();
      } catch {
        // ignore
      }
      const error = data?.error ?? {};
      throw new ApiError(error.message ?? `分析请求失败（HTTP ${response.status}）。`, {
        code: error.code ?? `HTTP_${response.status}`,
        suggestions: error.suggestions ?? [],
      });
    }
    if (!response.body) {
      throw new ApiError('浏览器无法读取分析流。请升级浏览器后重试。', {
        code: 'STREAM_UNSUPPORTED',
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (token !== state.runSequence) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        return;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const event = parseStreamLine(line);
          if (event) {
            handleAgentEvent(event, token);
            if (event.type === 'completed' || event.type === 'failed') {
              terminal = true;
              state.terminalReceived = true;
            }
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseStreamLine(buffer.trim());
      if (event) {
        handleAgentEvent(event, token);
        if (event.type === 'completed' || event.type === 'failed') {
          terminal = true;
          state.terminalReceived = true;
        }
      }
    }
    if (!terminal && token === state.runSequence) {
      finishWithError({
        code: 'STREAM_INTERRUPTED',
        message: '分析流在完成前中断，未生成报告。请重试。',
        suggestions: ['检查本地服务是否仍在运行。', '如果问题超出支持范围，请改用受支持的组间比较或相关分析。'],
      });
    }
  } catch (error) {
    if (token !== state.runSequence) return;
    if (error.name === 'AbortError') {
      finishWithError({
        code: 'ABORTED',
        message: '本次运行已停止，未生成报告。',
        suggestions: [],
      });
      return;
    }
    finishWithError({
      code: error.code ?? 'NETWORK_ERROR',
      message: error.message || '网络或本地服务异常，未能完成分析。',
      suggestions:
        error.suggestions?.length > 0
          ? error.suggestions
          : ['确认本地分析服务仍在运行。', '重新载入页面或更换问题后再试一次。'],
    });
  } finally {
    if (token === state.runSequence) {
      state.running = false;
      state.abortController = null;
      updateRunAvailability();
      if (state.elapsedTimer) {
        clearInterval(state.elapsedTimer);
        state.elapsedTimer = null;
      }
      if (state.report) {
        setRunState('success', '已完成');
      } else if (!terminal) {
        setRunState('failed', '已停止');
      }
      renderStepper();
      updateDataInputDisabledState();
    }
  }
}

function parseStreamLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function handleAgentEvent(event, token) {
  if (token !== state.runSequence) return;
  switch (event.type) {
    case 'run_started': {
      state.runId = event.runId;
      if (Array.isArray(event.steps)) state.steps = event.steps;
      if (event.mode) {
        state.modeInfo = normalizeMode(event.mode);
        renderModeBanner();
        updatePrivacyNote();
      }
      renderStepper();
      $('#report-running-text').textContent = '正在检查数据、字段类型与缺失情况…';
      appendLog(`运行 ${event.runId} 已创建。`, 'running', 'RUN');
      $('#live-status').textContent = 'Agent 已开始。';
      break;
    }
    case 'step': {
      if (Array.isArray(event.steps)) state.steps = event.steps;
      else if (event.step) {
        const index = state.steps.findIndex((step) => step.id === event.step.id);
        if (index >= 0) state.steps[index] = event.step;
      }
      renderStepper();
      const current = currentStep();
      if (current) {
        $('#current-step').textContent = current.label;
        $('#report-running-text').textContent = current.detail || `${current.label}进行中…`;
        const status =
          current.status === 'failed' ? 'failed' : current.status === 'success' ? 'success' : 'running';
        appendLog(current.detail || `${current.label}…`, status, current.label);
      }
      break;
    }
    case 'mode': {
      state.modeInfo = normalizeMode(event.mode);
      renderModeBanner();
      updatePrivacyNote();
      if (event.warning) {
        appendLog(`运行模式变更：${event.warning}`, 'failed', 'MODE');
        showToast(`已回退到本地规则：${event.warning}`, 'error', 6000);
      } else {
        appendLog(`运行模式：${state.modeInfo?.label ?? '—'}`, 'success', 'MODE');
      }
      break;
    }
    case 'plan': {
      state.plan = event.plan;
      renderPlan(event.plan);
      appendLog(
        `计划已生成：${event.plan.steps?.length ?? 0} 个受控工具，来源 ${
          event.plan.source === 'model' ? 'DeepSeek 工具调用' : '本地规则'
        }。`,
        'success',
        'PLAN',
      );
      break;
    }
    case 'tool': {
      if (event.call) {
        state.toolCalls.set(event.call.id, event.call);
        renderToolCalls();
        appendLog(
          event.call.status === 'success'
            ? `工具 ${event.call.tool} 执行完成，用时 ${formatDuration(event.call.durationMs)}。`
            : `工具 ${event.call.tool} 执行失败：${event.call.error?.message ?? '未知错误'}`,
          event.call.status === 'success' ? 'tool' : 'failed',
          'TOOL',
        );
      }
      break;
    }
    case 'verification': {
      state.verification = event.verification;
      renderVerification(event.verification);
      appendLog(event.verification.summary ?? '结果校验完成。', 'success', 'VERIFY');
      break;
    }
    case 'completed': {
      completeRun(event);
      break;
    }
    case 'failed': {
      if (event.steps) state.steps = event.steps;
      if (event.mode) {
        state.modeInfo = normalizeMode(event.mode);
        renderModeBanner();
        updatePrivacyNote();
      }
      if (Array.isArray(event.toolCalls)) {
        state.toolCalls = new Map(event.toolCalls.map((call) => [call.id, call]));
        renderToolCalls();
      }
      if (event.error?.verification) {
        state.verification = event.error.verification;
        renderVerification(state.verification);
      }
      renderStepper();
      finishWithError(event.error ?? { message: '分析未完成。' }, event.durationMs);
      break;
    }
    default:
      break;
  }
}

function currentStep() {
  return (
    state.steps.find((step) => step.status === 'running') ??
    [...state.steps].reverse().find((step) => step.status !== 'pending') ??
    state.steps[0] ??
    null
  );
}

function completeRun(event) {
  state.report = event.report;
  state.runId = event.runId;
  state.modeInfo = normalizeMode(event.mode) ?? state.modeInfo;
  state.downloads = event.downloads ?? null;
  state.verification = event.verification ?? event.report?.verification ?? state.verification;
  state.terminalReceived = true;
  state.running = false;
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
  setRunState('success', '已完成');
  $('#run-error').hidden = true;
  const finalDuration =
    typeof event.durationMs === 'number'
      ? event.durationMs
      : Number(state.report?.durationMs) || Date.now() - state.startedAt;
  $('#elapsed').textContent = formatDuration(finalDuration);
  $('#current-step').textContent = '完成';
  $('#report-running').hidden = true;
  $('#report-error').hidden = true;
  $('#report-empty').hidden = true;
  $('#report-content').hidden = false;
  renderReport(state.report);
  setReportActions(event.downloads ?? null);
  renderModeBanner();
  updatePrivacyNote();
  renderStepper();
  appendLog(
    `分析完成：${state.report.findings?.length ?? 0} 条关键发现，${state.report.charts?.length ?? 0} 张图，${state.report.trace?.toolCalls?.length ?? 0} 次工具调用。`,
    'success',
    'DONE',
  );
  if (state.verification) {
    renderVerification(state.verification);
  }
  updateRunAvailability();
  updateDataInputDisabledState();
  setReportActions(event.downloads ?? null);
  showToast('分析完成。报告、Markdown 与 JSON 运行记录已就绪。', 'success', 4200);
  $('#live-status').textContent = '分析完成，结果报告已生成。';
  $('#report-panel').setAttribute('tabindex', '-1');
}

function finishWithError(error, durationMs) {
  state.running = false;
  state.terminalReceived = true;
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
  if (typeof durationMs === 'number') {
    $('#elapsed').textContent = formatDuration(durationMs);
  }
  const message = error?.message ?? '分析未完成。';
  const suggestions = Array.isArray(error?.suggestions) ? error.suggestions : [];
  setRunState('failed', '已停止');
  $('#report-running').hidden = true;
  $('#report-content').hidden = true;
  $('#report-error').hidden = false;
  $('#report-empty').hidden = true;
  $('#report-actions').hidden = true;
  $('#report-error-title').textContent = errorTitle(error?.code);
  $('#report-error-message').textContent = message;
  $('#report-error-suggestions').innerHTML = suggestions
    .map((item) => `<li>${esc(item)}</li>`)
    .join('');
  $('#run-error').hidden = false;
  $('#run-error-title').textContent = errorTitle(error?.code);
  $('#run-error-message').textContent = message;
  $('#run-error-suggestions').innerHTML = suggestions
    .map((item) => `<li>${esc(item)}</li>`)
    .join('');
  renderStepper();
  appendLog(message, 'failed', 'STOP');
  updateRunAvailability();
  updateDataInputDisabledState();
  setReportActions(null);
  $('#live-status').textContent = `分析停止：${message}`;
  showToast(message, 'error', 5500);
}

function errorTitle(code) {
  const titles = {
    UNSUPPORTED_CAUSALITY: '这个问题需要因果推断，本版无法回答',
    UNSUPPORTED_MODELING: '本版不训练预测或回归模型',
    UNSUPPORTED_LONGITUDINAL: '本版不支持纵向或时间序列设计',
    UNSUPPORTED_DATA_TYPE: '本版只分析结构化 CSV',
    UNSUPPORTED_PAIRED_COMPARISON: '本版不支持同一行内的配对比较',
    NO_GROUP_FIELD: '数据中没有合适的分组字段',
    NO_NUMERIC_FIELD: '数据中没有可分析的数值字段',
    NOT_ENOUGH_NUMERIC_FIELDS: '相关性分析需要至少两个数值字段',
    INSUFFICIENT_DATA: '有效样本不足以执行检验',
    INSUFFICIENT_GROUP: '至少一组的分组样本量不足',
    UNKNOWN_GROUP: '分析计划引用了不存在的分组取值',
    NO_VALID_PAIRS: '没有可计算的有效字段对',
    ZERO_VARIANCE: '字段没有变异，统计检验无法定义',
    VERIFICATION_FAILED: '结果一致性校验未通过',
    NO_TOOL_CALLS: 'DeepSeek 没有返回工具调用',
    DEEPSEEK_HTTP: 'DeepSeek 官方 API 请求失败',
    PLAN_FAILED: '无法形成可执行的分析计划',
    EXECUTION_FAILED: '分析工具没有成功执行',
    DATASET_NOT_FOUND: '找不到这次使用的数据',
    STREAM_INTERRUPTED: '分析连接中断',
    ABORTED: '分析已停止',
  };
  return titles[code] ?? '这次分析没有生成报告';
}

function startElapsedTimer() {
  if (state.elapsedTimer) clearInterval(state.elapsedTimer);
  const update = () => {
    if (!state.running) return;
    $('#elapsed').textContent = formatDuration(Date.now() - state.startedAt);
  };
  update();
  state.elapsedTimer = setInterval(update, 150);
}

function abortActiveRun({ silent = false } = {}) {
  state.runSequence += 1;
  if (state.abortController) {
    try {
      state.abortController.abort();
    } catch {
      // ignore
    }
    state.abortController = null;
  }
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
  state.running = false;
  if (!silent) updateRunAvailability();
}

function updateDataInputDisabledState() {
  const disabled = state.datasetLoading || state.running;
  $('#sample-load').disabled = disabled || !state.examples.length;
  $('#dropzone').disabled = disabled;
  $('#file-input').disabled = disabled;
  $('#change-data').disabled = disabled;
}

/* ------------------------------------------------------------------ */
/* Trace rendering                                                    */
/* ------------------------------------------------------------------ */

function renderStepper(steps = state.steps) {
  const list = $('#stepper');
  const items = steps?.length ? steps : defaultSteps();
  list.innerHTML = items
    .map((step, index) => {
      const cls =
        step.status === 'success'
          ? 'is-done'
          : step.status === 'running'
            ? 'is-active'
            : step.status === 'failed'
              ? 'is-failed'
              : 'is-pending';
      const node =
        step.status === 'success'
          ? icon('check')
          : step.status === 'failed'
            ? icon('close')
            : String(index + 1).padStart(2, '0');
      return `<li class="stepper-item ${cls}" ${step.status === 'running' ? 'aria-current="step"' : ''}>
        <span class="step-node">${node}</span>
        <span class="step-name">${esc(step.label ?? STEP_DEFS[index]?.label ?? '')}</span>
        <span class="step-en">${esc(step.en ?? STEP_DEFS[index]?.en ?? '')}</span>
      </li>`;
    })
    .join('');
}

function appendLog(text, status = 'running', label = '') {
  if (!text) return;
  const last = state.logs[state.logs.length - 1];
  if (last && last.text === text && last.status === status) return;
  state.logs.push({
    text,
    status,
    label,
    time: new Date(),
  });
  if (state.logs.length > 80) state.logs.shift();
  renderLogs();
}

function renderLogs() {
  const list = $('#trace-log');
  list.innerHTML = state.logs
    .map((entry) => {
      const time = new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(entry.time);
      return `<li class="log-item is-${esc(entry.status)}">
        <span class="log-time">${esc(time)}</span>
        <span class="log-mark" aria-hidden="true"></span>
        <p class="log-text">${entry.label ? `<strong>${esc(entry.label)}</strong>` : ''}${esc(
          entry.text,
        )}</p>
      </li>`;
    })
    .join('');
  list.scrollTop = list.scrollHeight;
}

function renderPlan(plan) {
  if (!plan) return;
  $('#plan-box').hidden = false;
  $('#plan-intent').textContent = INTENT_LABELS[plan.intent] ?? '分析计划';
  $('#plan-source').textContent = plan.source === 'model' ? 'DeepSeek 工具调用' : '本地规则';
  $('#plan-interpretation').textContent = plan.interpretation ?? '';
  $('#plan-steps').innerHTML = (plan.steps ?? [])
    .map(
      (step, index) => `<li class="plan-step-item" title="${esc(step.reason ?? '')}">
        <span class="plan-step-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="plan-step-body">${esc(step.label ?? step.tool)}</span>
      </li>`,
    )
    .join('');
  const notes = [...new Set([...(plan.selectionNotes ?? []), ...(plan.warnings ?? [])])];
  const notesEl = $('#plan-notes');
  if (notes.length > 0) {
    notesEl.hidden = false;
    notesEl.innerHTML = notes.map((note) => `<span>· ${esc(note)}</span>`).join('');
  } else {
    notesEl.hidden = true;
    notesEl.innerHTML = '';
  }
}

function renderToolCalls() {
  const details = $('#tool-details');
  const list = $('#tool-calls');
  const calls = [...state.toolCalls.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  $('#tool-count').textContent = String(calls.length);
  if (calls.length === 0) {
    details.hidden = true;
    list.innerHTML = '';
    return;
  }
  details.hidden = false;
  const opened = new Set(
    $$('.tool-call[open]', list).map((node) => node.dataset.callId).filter(Boolean),
  );
  list.innerHTML = calls
    .map((call) => {
      const failed = call.status === 'failed';
      const payload = failed ? call.error ?? {} : call.output ?? {};
      const pre = esc(JSON.stringify(payload, null, 2));
      const params = esc(JSON.stringify(call.params ?? {}, null, 2));
      const open = opened.has(call.id) || failed;
      return `<details class="tool-call" data-call-id="${esc(call.id)}" ${open ? 'open' : ''}>
        <summary>
          <span class="tool-status ${failed ? 'is-failed' : ''}"></span>
          <span class="tool-name">${esc(call.tool)}</span>
          <span class="tool-duration">${failed ? '失败' : formatDuration(call.durationMs)}</span>
        </summary>
        <div class="tool-call-body">
          <h4>实际参数</h4>
          <pre>${params}</pre>
          <h4>${failed ? '错误输出' : '真实输出（原始 JSON）'}</h4>
          <pre>${pre}</pre>
        </div>
      </details>`;
    })
    .join('');
}

function renderVerification(verification) {
  if (!verification) return;
  const box = $('#verification-box');
  box.hidden = false;
  const summary = $('#verification-summary');
  summary.textContent =
    verification.summary ??
    `通过 ${verification.checks?.length ?? 0} 项一致性检查。`;
  const checks = verification.checks ?? [];
  $('#verification-checks').innerHTML = checks
    .map(
      (check) =>
        `<span class="verification-check ${
          check.status === 'failed' || check.status === 'warning' ? 'is-warning' : ''
        }" title="${esc(check.detail ?? '')}">${esc(check.label)}</span>`,
    )
    .join('');
  box.classList.toggle('is-failed', verification.status === 'failed');
}

/* ------------------------------------------------------------------ */
/* Dataset modal                                                      */
/* ------------------------------------------------------------------ */

function openDatasetDialog() {
  if (!state.dataset) return;
  renderPreviewDialog();
  openDialog('dataset-dialog');
}

function updatePreviewDialogIfOpen() {
  const dialog = $('#dataset-dialog');
  if (dialog.open) renderPreviewDialog();
}

function renderPreviewDialog() {
  const dataset = state.dataset;
  if (!dataset) return;
  const quality = dataset.quality ?? {};
  const preview = dataset.preview ?? { headers: [], rows: [] };
  const headers = preview.headers ?? [];
  const rows = preview.rows ?? [];
  const fields = dataset.columns
    .map((column) => {
      let distribution = '—';
      if (column.type === 'number' && column.summary) {
        distribution = `${formatNumber(column.summary.mean, 3)} ± ${formatNumber(
          column.summary.sd,
          3,
        )}；${formatNumber(column.summary.min, 2)}–${formatNumber(column.summary.max, 2)}`;
      } else if (column.type === 'text') {
        distribution = '高基数文本（不展示取值）';
      } else if (column.type === 'date') {
        distribution = '日期字段（不逐项展示）';
      } else if (column.topValues?.length) {
        distribution = column.topValues
          .slice(0, 3)
          .map((item) => `${item.value}（${item.count}）`)
          .join('、');
      } else {
        distribution = '类别数较多，取值不在预览中展示';
      }
      return `<tr>
        <td><strong>${esc(column.label)}</strong><br /><span class="cell-muted">${esc(column.name)}</span></td>
        <td>${esc(column.typeLabel)}</td>
        <td>${esc(formatNumber(column.nonMissing, 0))}</td>
        <td>${esc(formatNumber(column.missing, 0))}（${esc(formatPercent(column.missingRate, 1))}）</td>
        <td>${esc(formatNumber(column.unique, 0))}</td>
        <td>${esc(distribution)}</td>
      </tr>`;
    })
    .join('');
  const source = dataset.source ?? {};
  const warnings = quality.warnings ?? [];
  $('#dataset-dialog-body').innerHTML = `
    <div class="data-metrics">
      <div><strong>${esc(formatNumber(dataset.rowCount, 0))}</strong><span>数据行</span></div>
      <div><strong>${esc(formatNumber(dataset.columnCount, 0))}</strong><span>字段</span></div>
      <div><strong>${esc(formatPercent(quality.missingRate ?? 0, 1))}</strong><span>缺失率</span></div>
      <div><strong>${esc(formatNumber(quality.duplicateRowCount ?? 0, 0))}</strong><span>完全重复行</span></div>
    </div>
    <h3>字段结构与质量</h3>
    <div class="modal-table-wrap">
      <table class="modal-table">
        <thead><tr><th>字段</th><th>类型</th><th>有效值</th><th>缺失</th><th>唯一值</th><th>分布 / 高频值</th></tr></thead>
        <tbody>${fields}</tbody>
      </table>
    </div>
    ${
      warnings.length
        ? `<h3>数据提示</h3><ul class="warning-list">${warnings
            .map(
              (warning) =>
                `<li>${icon('warning')}${esc(warning.message ?? warning)}</li>`,
            )
            .join('')}</ul>`
        : ''
    }
    <h3>数据预览</h3>
    <div class="modal-table-wrap">
      <table class="modal-table">
        <thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead>
        <tbody>${rows
          .map(
            (row) =>
              `<tr>${headers
                .map((_, index) => {
                  const value = row[index] ?? '';
                  return `<td class="${isMissingRaw(value) ? 'cell-muted' : ''}">${esc(
                    isMissingRaw(value) ? '空值' : value,
                  )}</td>`;
                })
                .join('')}</tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>
    <p class="modal-source-note">
      展示前 ${esc(rows.length)} 行，共 ${esc(formatNumber(dataset.rowCount, 0))} 行。${
        source.type === 'upload'
          ? '原始 CSV 仅在本机内存中处理，不写入磁盘。'
          : '公开示例数据来自 UCI，许可与署名见页面底部。'
      }
      ${source.sha256 ? `<br />SHA-256：<code>${esc(source.sha256)}</code>` : ''}
    </p>`;
}

/* ------------------------------------------------------------------ */
/* Report rendering                                                   */
/* ------------------------------------------------------------------ */

function setReportActions(downloads) {
  const actions = $('#report-actions');
  if (!downloads) {
    actions.hidden = true;
    $('#export-md').setAttribute('href', '#');
    $('#export-json').setAttribute('href', '#');
    return;
  }
  actions.hidden = false;
  $('#export-md').setAttribute('href', downloads.markdown);
  $('#export-json').setAttribute('href', downloads.json);
}

function resetReportPanel() {
  $('#report-empty').hidden = false;
  $('#report-running').hidden = true;
  $('#report-error').hidden = true;
  $('#report-content').hidden = true;
  $('#report-content').innerHTML = '';
  $('#report-actions').hidden = true;
}

function resetAnalysisOutput() {
  abortActiveRun({ silent: true });
  state.runSequence += 1;
  state.running = false;
  state.terminalReceived = false;
  state.runId = null;
  state.steps = defaultSteps();
  state.modeInfo = state.mode;
  state.plan = null;
  state.toolCalls = new Map();
  state.logs = [];
  state.verification = null;
  state.report = null;
  state.downloads = null;
  state.startedAt = null;
  renderStepper();
  $('#trace-empty').hidden = false;
  $('#trace-live').hidden = true;
  $('#run-error').hidden = true;
  $('#plan-box').hidden = true;
  $('#verification-box').hidden = true;
  $('#tool-details').hidden = true;
  $('#tool-calls').innerHTML = '';
  $('#tool-count').textContent = '0';
  $('#trace-log').innerHTML = '';
  $('#current-step').textContent = '等待开始';
  $('#elapsed').textContent = '0.0s';
  $('#report-running-text').textContent = 'Agent 正在检查数据与构建受控分析计划…';
  setRunState('idle', '待运行');
  resetReportPanel();
  setReportActions(null);
  renderModeBanner();
  updatePrivacyNote();
  updateRunAvailability();
}

function renderReport(report) {
  if (!report) return;
  const charts = Array.isArray(report.charts) ? report.charts : [];
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const tables = Array.isArray(report.tables) ? report.tables : [];
  const kpis = Array.isArray(report.kpis) ? report.kpis : [];
  const mode = report.mode ?? state.modeInfo ?? state.mode ?? {};
  const answerTone = deriveReportTone(report);
  const sections = [];
  let sectionNumber = 0;
  const nextIndex = () => String(++sectionNumber).padStart(2, '0');

  sections.push(reportSection(nextIndex(), '关键发现', '每条结论都可回到一次工具调用', renderFindings(findings)));
  if (charts.length > 0) {
    sections.push(reportSection(nextIndex(), '图表证据', `${charts.length} 张图 · 由工具输出生成`, renderCharts(charts)));
  }
  if (tables.length > 0) {
    sections.push(reportSection(nextIndex(), '统计结果', `${tables.length} 张表 · 参数与样本量可追溯`, renderTables(tables)));
  }
  sections.push(reportSection(nextIndex(), '数据概况与质量', '只展示聚合信息', renderQuality(report.quality ?? {})));
  sections.push(reportSection(nextIndex(), '方法与复现', '受控工具注册表', renderMethods(report.methods ?? [], report.reproduction ?? {})));
  sections.push(reportSection(nextIndex(), '局限性与无法判断的部分', '请结合研究设计阅读', renderLimitations(report.limitations ?? [])));
  sections.push(reportSection(nextIndex(), '数据来源与结果校验', '公开数据 · 证据可追溯', renderSourceAndVerification(report)));
  sections.push(reportSection(nextIndex(), '运行证据', 'Agent 步骤与工具调用摘要', renderEvidence(report)));

  const title = escapeReportText(report.title ?? '分析报告');
  const eyebrow = escapeReportText(report.eyebrow ?? 'ANALYSIS REPORT');
  const modeLabel = escapeReportText(mode.label ?? '—');
  const dataset = report.dataset ?? {};
  const kpiHtml = kpis
    .map((kpi) => {
      const tone = ['positive', 'caution'].includes(kpi.tone) ? `is-${kpi.tone}` : '';
      return `<div class="kpi-card ${tone}">
        <span class="kpi-label">${esc(kpi.label)}</span>
        <strong class="kpi-value" title="${esc(kpi.value)}">${esc(kpi.value)}</strong>
        <span class="kpi-detail">${esc(kpi.detail ?? '')}</span>
      </div>`;
    })
    .join('');

  $('#report-content').innerHTML = `
    <section class="report-hero">
      <div class="report-eyebrow">
        <span>${eyebrow}</span>
        <span class="report-mode">${modeLabel}</span>
      </div>
      <h2 class="report-title">${title}</h2>
      <div class="report-submeta">
        <span class="report-meta-item">${icon('database')}${esc(dataset.name ?? '—')} · ${esc(
          formatNumber(dataset.rowCount, 0),
        )} 行 × ${esc(formatNumber(dataset.columnCount, 0))} 列</span>
        <span class="report-meta-item">${icon('file')}运行 ${esc(report.runId ?? state.runId ?? '—')}</span>
        <span class="report-meta-item">${icon('info')}生成于 ${esc(formatDateTime(report.generatedAt))}</span>
      </div>
      <div class="report-kpis">${kpiHtml}</div>
      <div class="answer-panel is-${answerTone}">
        <span class="answer-label">${icon('spark')}CORE FINDING · 核心结论</span>
        <p class="answer-text">${esc(report.oneLineAnswer ?? '—')}</p>
        ${
          report.secondaryAnswer
            ? `<p class="answer-secondary">${esc(report.secondaryAnswer)}</p>`
            : ''
        }
      </div>
    </section>
    ${sections.join('')}
    <p class="report-footer-note">
      <strong>研数搭子 LabMate</strong> · 本报告为探索性分析，不构成统计咨询或同行评审结论。
      所有统计值来自受控工具的真实输出；DeepSeek（如启用）只通过官方 API 的 tool calls 选择受控工具。
      ${report.reproduction?.privacy ? `<br />${esc(report.reproduction.privacy)}` : ''}
    </p>`;
  openAllReportDetails(false);
}

function deriveReportTone(report) {
  const findings = report.findings ?? [];
  if (findings.some((finding) => finding.tone === 'caution')) return 'caution';
  if (findings.some((finding) => finding.tone === 'positive')) return 'positive';
  return 'neutral';
}

function reportSection(index, title, aside, body) {
  return `<section class="report-section">
    <div class="section-label-row">
      <h3 class="section-label"><span class="section-index">${index}</span>${esc(title)}</h3>
      <span class="section-aside">${esc(aside)}</span>
    </div>
    ${body}
  </section>`;
}

function renderFindings(findings) {
  if (!findings.length) {
    return `<p class="section-aside">本次运行没有额外关键发现。</p>`;
  }
  return `<div class="findings-list">${findings
    .map((finding, index) => {
      const tone = ['positive', 'caution'].includes(finding.tone) ? `is-${finding.tone}` : '';
      const evidence = (finding.evidence ?? [])
        .map(
          (item) =>
            `<span class="evidence-chip" title="${esc(item.tool)} / ${esc(item.callId)}"><span class="evidence-dot"></span>${esc(
              item.tool,
            )} · ${esc(item.callId)}</span>`,
        )
        .join('');
      return `<article class="finding-card ${tone}">
        <span class="finding-index">${String(index + 1).padStart(2, '0')}</span>
        <div class="finding-head">
          <h4>${esc(finding.title)}</h4>
          <p class="finding-text">${esc(finding.text)}</p>
          ${
            evidence
              ? `<div class="evidence-row"><span class="evidence-label">EVIDENCE</span>${evidence}</div>`
              : ''
          }
        </div>
      </article>`;
    })
    .join('')}</div>`;
}

function renderCharts(charts) {
  const kindLabels = {
    boxplot: '箱线图',
    scatter: '散点图',
    'correlation-heatmap': '相关热图',
  };
  return `<div class="chart-stack">${charts
    .map((chart, index) => {
      const safeSvg =
        typeof chart.svg === 'string' && chart.svg.trim().startsWith('<svg') ? chart.svg : '';
      if (!safeSvg) return '';
      return `<figure class="chart-card">
        <div class="chart-heading">
          <h4>FIG. ${String(index + 1).padStart(2, '0')} / ${esc(
            kindLabels[chart.kind] ?? '图表',
          )}</h4>
          <span>REAL TOOL OUTPUT</span>
        </div>
        <div class="chart-canvas">${safeSvg}</div>
        <figcaption class="chart-caption">${esc(chart.caption ?? '')}</figcaption>
      </figure>`;
    })
    .join('')}</div>`;
}

function renderTables(tables) {
  return tables
    .map((table) => {
      const columns = Array.isArray(table.columns) ? table.columns : [];
      const rows = Array.isArray(table.rows) ? table.rows : [];
      return `<article class="table-card">
        <div class="table-card-head">
          <div><h4>${esc(table.title ?? '统计表')}</h4><p>${esc(table.description ?? '')}</p></div>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>${columns
              .map(
                (column) =>
                  `<th class="align-${esc(column.align ?? 'left')}">${esc(column.label)}</th>`,
              )
              .join('')}</tr></thead>
            <tbody>${rows
              .map(
                (row) =>
                  `<tr>${columns
                    .map(
                      (column) =>
                        `<td class="align-${esc(column.align ?? 'left')}">${esc(row[column.key] ?? '—')}</td>`,
                    )
                    .join('')}</tr>`,
              )
              .join('')}</tbody>
          </table>
        </div>
        ${
          table.evidence?.length
            ? `<div class="table-evidence">${table.evidence
                .map((item) => `<span class="evidence-chip"><span class="evidence-dot"></span>${esc(item.tool)} · ${esc(item.callId)}</span>`)
                .join('')}</div>`
            : ''
        }
      </article>`;
    })
    .join('');
}

function renderQuality(quality) {
  const warnings = quality.warnings ?? [];
  const fields = quality.fields ?? [];
  return `
    <div class="quality-strip">
      <div class="quality-stat"><span>数据规模</span><strong>${esc(
        formatNumber(quality.rowCount, 0),
      )} × ${esc(formatNumber(quality.columnCount, 0))}</strong></div>
      <div class="quality-stat"><span>完整记录</span><strong>${esc(
        formatNumber(quality.completeRows, 0),
      )}</strong></div>
      <div class="quality-stat ${quality.missingCells ? 'is-warning' : ''}"><span>缺失单元格</span><strong>${esc(
        formatNumber(quality.missingCells, 0),
      )} · ${esc(formatPercent(quality.missingRate, 1))}</strong></div>
      <div class="quality-stat ${quality.duplicateRowCount ? 'is-warning' : ''}"><span>完全重复行</span><strong>${esc(
        formatNumber(quality.duplicateRowCount, 0),
      )}</strong></div>
    </div>
    ${
      warnings.length
        ? `<ul class="warning-list">${warnings
            .map((warning) => `<li>${icon('warning')}${esc(warning)}</li>`)
            .join('')}</ul>`
        : ''
    }
    <div class="quality-fields">
      <div class="table-card">
        <div class="table-card-head"><div><h4>字段检查</h4><p>类型由数据内容自动推断；缺失率以全部行为分母。</p></div></div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>字段</th><th>类型</th><th>缺失</th><th>唯一值</th><th>分布 / 高频值</th></tr></thead>
            <tbody>${fields
              .map(
                (field) => `<tr>
                  <td>${esc(field.label)}</td>
                  <td>${esc(field.type)}</td>
                  <td>${esc(field.missing)}</td>
                  <td>${esc(field.unique)}</td>
                  <td>${esc(field.distribution)}</td>
                </tr>`,
              )
              .join('')}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderMethods(methods, reproduction) {
  const rows = methods
    .map(
      (method, index) => `<div class="method-row">
        <span class="method-row-index">${String(index + 1).padStart(2, '0')}</span>
        <div class="method-row-main">
          <strong>${esc(method.label ?? method.tool)}</strong>
          <span>${esc(method.what ?? '')}</span>
        </div>
        <span class="method-row-params" title="${esc(method.params ?? '')}">${esc(
          method.params ?? '—',
        )}</span>
        <span class="method-row-n">n=${esc(method.sampleSize ?? '—')}</span>
      </div>`,
    )
    .join('');
  return `<div class="method-list">${rows}</div>
    <div class="repro-note">
      <span>数据指纹 <code title="${esc(reproduction.dataFingerprint ?? '未记录')}">${
        reproduction.dataFingerprint
          ? `${esc(reproduction.dataFingerprint.slice(0, 18))}…`
          : '未记录'
      }</code></span>
      <span>工具注册表 <code>${esc(reproduction.toolRegistry ?? '—')}</code></span>
      <span>软件 <code>${esc(reproduction.software ?? '—')}</code></span>
    </div>`;
}

function renderLimitations(limitations) {
  if (!limitations.length) {
    return `<p class="section-aside">没有额外局限性记录。</p>`;
  }
  return `<div class="limitations-box"><ul>${limitations
    .map((item) => `<li>${esc(item)}</li>`)
    .join('')}</ul></div>`;
}

function renderSourceAndVerification(report) {
  const source = report.source ?? {};
  const verification = report.verification;
  const licenseUrl = source.licenseUrl ? safeExternalUrl(source.licenseUrl) : '';
  const sourceUrl = source.url ? safeExternalUrl(source.url) : '';
  const doiUrl = source.doi ? safeExternalUrl(`https://doi.org/${source.doi}`) : '';
  const verificationChecks = verification?.checks ?? [];
  return `
    <div class="source-box">
      <div>
        <h4>${esc(source.title ?? report.dataset?.name ?? '数据来源未记录')}</h4>
        <p>${esc(source.note ?? '数据来源信息未提供。')}</p>
        <div class="source-tags">
          ${source.license ? `<span>${icon('check')}${esc(source.license)}</span>` : ''}
          ${source.provider ? `<span>${icon('database')}${esc(source.provider)}</span>` : ''}
          ${source.accessed ? `<span>${icon('info')}访问于 ${esc(source.accessed)}</span>` : ''}
        </div>
      </div>
      <div class="source-box-meta">
        ${
          sourceUrl
            ? `<span>数据集页面：<a href="${sourceUrl}" target="_blank" rel="noreferrer">打开官方来源</a></span>`
            : ''
        }
        ${
          licenseUrl
            ? `<span>许可全文：<a href="${licenseUrl}" target="_blank" rel="noreferrer">${esc(
                source.license ?? '查看许可',
              )}</a></span>`
            : ''
        }
        ${doiUrl ? `<span>DOI：<a href="${doiUrl}" target="_blank" rel="noreferrer">${esc(source.doi)}</a></span>` : ''}
        ${source.citation ? `<span>引用：${esc(source.citation)}</span>` : ''}
        ${
          source.sha256
            ? `<span>SHA-256：<code title="${esc(source.sha256)}">${esc(source.sha256.slice(0, 18))}…</code></span>`
            : ''
        }
      </div>
    </div>
    ${
      verification
        ? `<div class="verification-summary" style="margin-top:10px">${icon(
            verification.status === 'failed' ? 'warning' : 'check-circle',
          )}<span><strong>${
            verification.status === 'failed'
              ? '结果校验未通过'
              : verification.status === 'passed_with_warnings'
                ? '结果一致性校验通过，含方法提示'
                : '结果一致性校验通过'
          }</strong> · ${esc(verification.summary ?? '')}</span></div>
          <div class="verification-grid">${verificationChecks
            .map(
              (check) =>
                `<span class="verification-item ${
                  check.status !== 'passed' ? 'is-warning' : ''
                }" title="${esc(check.detail ?? '')}">${esc(check.label)} · ${esc(
                  check.status === 'passed' ? '通过' : '提示',
                )}</span>`,
            )
            .join('')}</div>`
        : ''
    }`;
}

function renderEvidence(report) {
  const trace = report.trace ?? {};
  const steps = trace.steps ?? [];
  const calls = trace.toolCalls ?? [];
  const verification = report.verification;
  return `<details class="evidence-details">
    <summary>
      <span>${icon('file')}展开运行证据</span>
      <small>${steps.length} 个步骤 · ${calls.length} 次工具调用 · 原始输出可在上方执行轨迹查看</small>
    </summary>
    <div class="evidence-body">
      <div class="trace-summary-list">
        ${steps
          .map(
            (step) => `<div class="trace-summary-item">
              <span>${esc(step.label)}</span>
              <strong title="${esc(step.detail ?? '')}">${esc(
                STATUS_LABELS[step.status] ?? step.status,
              )} · ${esc(step.durationMs == null ? '—' : formatDuration(step.durationMs))}</strong>
            </div>`,
          )
          .join('')}
      </div>
      <div class="table-scroll">
        <table class="data-table evidence-tool-table">
          <colgroup>
            <col style="width: 10%" />
            <col style="width: 16%" />
            <col style="width: 28%" />
            <col style="width: 8%" />
            <col style="width: 8%" />
            <col style="width: 30%" />
          </colgroup>
          <thead><tr><th>证据 ID</th><th>工具</th><th>实际参数</th><th>状态</th><th>用时</th><th>输出摘要</th></tr></thead>
          <tbody>${calls
            .map(
              (call) => `<tr>
                <td>${esc(call.id)}</td>
                <td>${esc(call.tool)}</td>
                <td>${esc(JSON.stringify(call.params ?? {}))}</td>
                <td>${esc(call.status === 'success' ? '成功' : '失败')}</td>
                <td>${esc(formatDuration(call.durationMs))}</td>
                <td>${esc(call.summary ?? '')}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>
      </div>
      ${
        verification?.checks?.length
          ? `<div class="table-scroll" style="margin-top:10px">
              <table class="data-table">
                <thead><tr><th>校验项</th><th>结果</th><th>详情</th></tr></thead>
                <tbody>${verification.checks
                  .map(
                    (check) => `<tr>
                      <td>${esc(check.label)}</td>
                      <td>${esc(check.status === 'passed' ? '通过' : '提示')}</td>
                      <td>${esc(check.detail)}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table>
            </div>`
          : ''
      }
      ${
        report.privacy?.note
          ? `<p class="report-footer-note">${esc(report.privacy.note)}</p>`
          : ''
      }
    </div>
  </details>`;
}

function escapeReportText(value) {
  return esc(value);
}

function openAllReportDetails(open = true) {
  if (!state.report) return;
  for (const details of $$('#report-content details')) {
    if (open) details.open = true;
  }
}

/* ------------------------------------------------------------------ */
/* Dialog helpers                                                     */
/* ------------------------------------------------------------------ */

function openDialog(id) {
  const dialog = $(`#${id}`);
  if (!dialog || dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(id) {
  const dialog = $(`#${id}`);
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

/* ------------------------------------------------------------------ */
/* Toast                                                              */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function showToast(message, type = 'default', duration = 3200) {
  const toast = $('#toast');
  toast.className = 'toast';
  if (type === 'error') toast.classList.add('is-error');
  if (type === 'success') toast.classList.add('is-success');
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, duration);
}

init();
