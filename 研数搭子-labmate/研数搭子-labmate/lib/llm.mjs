import { schemaForPlanning } from './dataset.mjs';
import { SUPPORTED_SCOPE } from './planner.mjs';

/**
 * DeepSeek 官方 API 适配层。
 *
 * 硬边界：
 * - 端点固定为 DeepSeek 官方 Chat Completions API，不提供任意 base URL；
 * - 后端从环境变量读取 DEEPSEEK_API_KEY，密钥永不进入前端；
 * - 模型通过原生 function/tool calls 选择分析工具，不执行代码；
 * - 模型只接收研究问题、字段结构和聚合概况，不接收原始 CSV 行；
 * - 模型返回的每个 tool call 仍要在后端注册表中校验工具名与参数；
 * - 统计数值由本地工具执行结果生成，模型不生成结论或数字。
 */

export const DEEPSEEK_API_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_PROVIDER = 'DeepSeek';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';
export const DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_MODEL_TOOL_CALLS = 6;

const EXPOSED_TOOLS = new Set([
  'group_summary',
  'group_comparison',
  'one_way_anova',
  'correlation_analysis',
]);

const TOOL_REASONS = {
  group_summary: 'DeepSeek 通过工具调用选择分组汇总，用于展示各组样本量与分布。',
  group_comparison: 'DeepSeek 通过工具调用选择两组 Welch 比较。',
  one_way_anova: 'DeepSeek 通过工具调用选择多组单因素方差分析。',
  correlation_analysis: 'DeepSeek 通过工具调用选择数值字段相关性分析。',
};

function deepSeekTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'group_summary',
        description:
          '按一个分组字段汇总一个数值字段。返回每组样本量、均值、标准差、中位数、四分位距和范围。分组问题应首先调用此工具。',
        parameters: {
          type: 'object',
          properties: {
            groupBy: {
              type: 'string',
              description: '分组字段名，必须来自数据字段且 groupable=true。',
            },
            metric: {
              type: 'string',
              description: '数值指标字段名，必须来自数据字段且 type=number。',
            },
          },
          required: ['groupBy', 'metric'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'one_way_anova',
        description:
          '比较 2 个及以上分组的数值均值，执行单因素方差分析。分组数 >=3 时使用；返回 F、自由度、p 和 η²。',
        parameters: {
          type: 'object',
          properties: {
            groupBy: {
              type: 'string',
              description: '分组字段名，必须来自数据字段且 groupable=true。',
            },
            metric: {
              type: 'string',
              description: '数值指标字段名，必须来自数据字段且 type=number。',
            },
          },
          required: ['groupBy', 'metric'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'group_comparison',
        description:
          '对指定两个分组进行 Welch 双侧 t 检验，返回均值差、95% 置信区间、Cohen’s d 和 p。仅当分组数恰好为 2，或作为 3 组的补充两两比较时使用。',
        parameters: {
          type: 'object',
          properties: {
            groupBy: {
              type: 'string',
              description: '分组字段名，必须来自数据字段且 groupable=true。',
            },
            metric: {
              type: 'string',
              description: '数值指标字段名，必须来自数据字段且 type=number。',
            },
            groupA: {
              type: 'string',
              description: '第一组的真实取值，必须出现在该分组字段的高频取值中。',
            },
            groupB: {
              type: 'string',
              description: '第二组的真实取值，必须出现在该分组字段的高频取值中。',
            },
          },
          required: ['groupBy', 'metric', 'groupA', 'groupB'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'correlation_analysis',
        description:
          '对 2–8 个数值字段计算 Pearson 与 Spearman 相关，返回成对样本量、相关系数、p 值和 r 的置信区间。',
        parameters: {
          type: 'object',
          properties: {
            fields: {
              type: 'array',
              description: '要分析的数值字段名数组，至少 2 个、至多 8 个，必须来自数据字段。',
              items: { type: 'string' },
            },
          },
          required: ['fields'],
          additionalProperties: false,
        },
      },
    },
  ];
}

function isPlaceholderApiKey(key) {
  if (!key) return false;
  return [
    /^sk-your-key-here$/i,
    /^sk-\.\.\.$/i,
    /^<.*>$/,
    /^changeme$/i,
    /^sk-x+$/i,
    /your[-_\s]*key/i,
  ].some((pattern) => pattern.test(key));
}

export function getDeepSeekConfig(env = process.env) {
  const rawApiKey = (env[DEEPSEEK_API_KEY_ENV] ?? '').trim();
  const keyStatus = !rawApiKey
    ? 'missing'
    : isPlaceholderApiKey(rawApiKey)
      ? 'placeholder'
      : 'present';
  const model = (env.DEEPSEEK_MODEL ?? '').trim() || DEFAULT_DEEPSEEK_MODEL;
  const parsedTimeout = Number.parseInt(env.DEEPSEEK_TIMEOUT_MS ?? '', 10);
  return {
    enabled: keyStatus === 'present',
    // 占位值不保留在运行时配置里，避免任何路径误用。
    apiKey: keyStatus === 'present' ? rawApiKey : '',
    keyStatus,
    model,
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_API_ENDPOINT,
    timeoutMs:
      Number.isFinite(parsedTimeout) && parsedTimeout >= 5_000
        ? parsedTimeout
        : DEFAULT_TIMEOUT_MS,
    missing: keyStatus === 'present' ? [] : [DEEPSEEK_API_KEY_ENV],
    apiKeySet: keyStatus === 'present',
  };
}

export function publicDeepSeekStatus(config) {
  const reason =
    config.keyStatus === 'placeholder'
      ? '检测到 DEEPSEEK_API_KEY 仍是模板占位值，当前为演示模式，不调用任何模型。请在后端 .env 中替换为真实 DeepSeek API Key 后重启服务；不会自动生成或获取密钥。'
      : config.keyStatus === 'missing'
        ? '未配置 DEEPSEEK_API_KEY。当前为演示模式，不调用任何模型；统计工具仍真实执行。启用 DeepSeek：在后端 .env 中配置真实 DEEPSEEK_API_KEY 后重启服务。'
        : null;
  const setup = {
    envKey: DEEPSEEK_API_KEY_ENV,
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
    endpoint: DEEPSEEK_API_ENDPOINT,
    steps: [
      '在 DeepSeek 平台自行创建 API Key；本产品不会生成或索取密钥。',
      '在 labmate/.env 中把 DEEPSEEK_API_KEY 替换为真实值（也可通过进程环境变量注入）。',
      '可选设置 DEEPSEEK_MODEL，默认 deepseek-flash。',
      '重启 npm start，页面顶部会显示 DeepSeek 工具调用模式。',
    ],
    docs: 'https://api-docs.deepseek.com/guides/tool_calls',
  };
  return {
    mode: config.enabled ? 'model' : 'demo',
    modeLabel: config.enabled ? 'DeepSeek 工具调用模式' : '演示模式',
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_API_ENDPOINT,
    transport: config.enabled ? 'deepseek_tool_calls' : 'local_rules',
    model: config.enabled ? config.model : null,
    configured: config.enabled,
    keyStatus: config.keyStatus,
    reason,
    setup,
    privacy:
      '原始 CSV 行不会发送给 DeepSeek。只发送研究问题、字段结构和聚合后的字段概况；DeepSeek 通过官方 API 的 tool calls 选择工具，参数由后端校验后执行。',
  };
}

function buildMessages(dataset, question) {
  const schema = schemaForPlanning(dataset);
  const system = [
    '你是「研数搭子」的 DeepSeek 工具规划器。你的唯一任务是通过 function tool calls 选择受控分析工具。',
    '不要输出统计结论、p 值、均值或任何编造的数字；这些由后端工具执行后生成。',
    '一次回复可以包含多个 tool_calls。请选择完成研究问题所需的全部分析工具。',
    '只允许使用提供的 function tools。不能要求执行 shell、Python、JavaScript 或访问外部网络。',
    '字段名必须来自给定数据字段；不要编造字段、分组取值或数据行。',
    '分组问题：必须先调用 group_summary；若分组字段只有 2 个真实取值，调用 group_comparison；若 >=3 个取值，调用 one_way_anova，并最多再为 3 对组合调用 group_comparison。',
    '相关问题：调用 correlation_analysis，fields 至少包含 2 个数值字段，最多 8 个。',
    '如果研究问题超出受控工具范围（例如因果推断、预测、回归、时间序列），不要调用任何工具，用一句中文说明原因。',
    `当前支持范围：${SUPPORTED_SCOPE.join('；')}。`,
    '数据字段和聚合概况在用户消息的 JSON 中；其中没有原始数据行。',
  ].join('\n');
  const user = JSON.stringify(
    {
      researchQuestion: question,
      dataset: {
        name: dataset.name,
        rowCount: schema.rowCount,
        columnCount: schema.columnCount,
        fields: schema.fields,
        quality: schema.quality,
      },
      rules: [
        '只能通过 tool_calls 选择工具，不要用普通文本给出计划或分析。',
        '不要生成任何统计数值。',
        '最多 6 个工具调用。',
      ],
    },
    null,
    2,
  );
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export class DeepSeekError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    this.details = details;
  }
}

function parseToolArguments(rawArguments, functionName, index) {
  if (typeof rawArguments !== 'string') {
    throw new DeepSeekError(
      'BAD_TOOL_ARGUMENTS',
      `DeepSeek 返回的第 ${index + 1} 个工具调用缺少字符串参数。`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(rawArguments || '{}');
  } catch {
    throw new DeepSeekError(
      'BAD_TOOL_ARGUMENTS',
      `DeepSeek 返回的 ${functionName} 参数不是合法 JSON；后端未执行这个工具。`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeepSeekError(
      'BAD_TOOL_ARGUMENTS',
      `DeepSeek 返回的 ${functionName} 参数必须是 JSON 对象；后端未执行这个工具。`,
    );
  }
  return parsed;
}

function deriveIntent(steps) {
  const hasGroup = steps.some((step) =>
    ['group_summary', 'group_comparison', 'one_way_anova'].includes(step.tool),
  );
  const hasCorrelation = steps.some((step) => step.tool === 'correlation_analysis');
  if (hasGroup && hasCorrelation) return 'mixed';
  if (hasGroup) return 'group_difference';
  if (hasCorrelation) return 'correlation';
  return 'exploratory';
}

function deriveInterpretation(steps) {
  const hasGroup = steps.some((step) =>
    ['group_summary', 'group_comparison', 'one_way_anova'].includes(step.tool),
  );
  const hasCorrelation = steps.some((step) => step.tool === 'correlation_analysis');
  if (hasGroup && hasCorrelation) {
    return 'DeepSeek 通过工具调用选择了组间差异与相关性分析。具体字段与参数将在后端注册表中校验后再执行；统计值不会由模型生成。';
  }
  if (hasGroup) {
    return 'DeepSeek 通过工具调用选择了组间差异分析。具体分组字段、指标与检验参数将在后端校验后再执行；统计值不会由模型生成。';
  }
  if (hasCorrelation) {
    return 'DeepSeek 通过工具调用选择了相关性分析。具体数值字段将在后端校验后再执行；统计值不会由模型生成。';
  }
  return 'DeepSeek 返回了工具调用，后端将先校验工具名、字段与参数再执行。';
}

/**
 * 请求 DeepSeek 官方 API，只接受 function tool calls。
 * 不执行任何工具；返回的步骤必须先经过调用方的 validatePlanSteps()。
 */
export async function requestDeepSeekToolPlan({
  config,
  dataset,
  question,
  fetchImpl = fetch,
  signal,
}) {
  if (!config.enabled) {
    throw new DeepSeekError(
      'DEEPSEEK_NOT_CONFIGURED',
      '未配置 DEEPSEEK_API_KEY，当前为演示模式。',
    );
  }
  if (config.endpoint !== DEEPSEEK_API_ENDPOINT) {
    throw new DeepSeekError(
      'NON_OFFICIAL_ENDPOINT',
      '模型端点必须固定为 DeepSeek 官方 API，拒绝请求。',
    );
  }

  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const body = {
    model: config.model,
    messages: buildMessages(dataset, question),
    tools: deepSeekTools(),
    tool_choice: 'auto',
    thinking: { type: 'disabled' },
    temperature: 0,
    stream: false,
  };

  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new DeepSeekError(
      timedOut ? 'DEEPSEEK_TIMEOUT' : 'DEEPSEEK_NETWORK',
      timedOut
        ? `DeepSeek 请求超过 ${Math.round(config.timeoutMs / 1000)} 秒未返回。`
        : '无法连接 DeepSeek 官方 API，请检查本机网络。',
      { cause: error?.message },
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = '';
    }
    const authHint =
      response.status === 401 || response.status === 403
        ? '请检查后端环境变量 DEEPSEEK_API_KEY 是否有效。'
        : '请检查 DeepSeek 账户、模型名和网络状态。';
    throw new DeepSeekError(
      'DEEPSEEK_HTTP',
      `DeepSeek 官方 API 返回 HTTP ${response.status}。${authHint} 本次不会生成模型回答，可在修复后重试或继续使用演示模式。`,
      { status: response.status, detail },
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new DeepSeekError('DEEPSEEK_BAD_RESPONSE', 'DeepSeek 官方 API 返回的不是 JSON。');
  }
  const message = data?.choices?.[0]?.message;
  const toolCalls = message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new DeepSeekError(
      'NO_TOOL_CALLS',
      'DeepSeek 没有返回工具调用，系统不会把普通文本当作分析计划。已切换为本地受控规则。',
    );
  }
  if (toolCalls.length > MAX_MODEL_TOOL_CALLS) {
    throw new DeepSeekError(
      'TOO_MANY_TOOL_CALLS',
      `DeepSeek 返回了 ${toolCalls.length} 个工具调用，超过上限 ${MAX_MODEL_TOOL_CALLS}，拒绝执行。`,
    );
  }

  const steps = toolCalls.map((toolCall, index) => {
    if (!toolCall || toolCall.type !== 'function' || !toolCall.function) {
      throw new DeepSeekError(
        'BAD_TOOL_CALL',
        `DeepSeek 返回的第 ${index + 1} 个工具调用格式不正确，拒绝执行。`,
      );
    }
    const functionName = toolCall.function.name;
    if (typeof functionName !== 'string' || !EXPOSED_TOOLS.has(functionName)) {
      throw new DeepSeekError(
        'UNKNOWN_MODEL_TOOL',
        `DeepSeek 返回了未授权的工具「${String(functionName)}」，后端未执行。`,
      );
    }
    const params = parseToolArguments(toolCall.function.arguments, functionName, index);
    return {
      tool: functionName,
      params,
      reason: TOOL_REASONS[functionName] ?? 'DeepSeek 通过原生工具调用选择的分析工具。',
    };
  });

  const usage = {
    promptTokens: data?.usage?.prompt_tokens ?? null,
    completionTokens: data?.usage?.completion_tokens ?? null,
    totalTokens: data?.usage?.total_tokens ?? null,
  };

  return {
    intent: deriveIntent(steps),
    interpretation: deriveInterpretation(steps),
    steps,
    unsupported: null,
    caveats: [
      '工具选择来自 DeepSeek 官方 API 的原生 tool calls；CSV 原始行未发送，统计值由本地工具生成。',
    ],
    source: 'model',
    transport: 'deepseek_tool_calls',
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_API_ENDPOINT,
    model: config.model,
    requestId: data?.id ?? null,
    finishReason: data?.choices?.[0]?.finish_reason ?? null,
    usage,
  };
}
