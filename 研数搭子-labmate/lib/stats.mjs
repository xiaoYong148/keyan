/**
 * 研数搭子 · 统计计算核心（纯函数、零第三方依赖）
 *
 * 设计约束：
 * - 只做确定性的数学计算：不执行外部代码、不访问网络/文件系统、不引入第三方库。
 * - 返回对象只包含 number / number[]，可直接 JSON.stringify 传输。
 * - 退化输入（样本不足、零方差、全部缺失）抛出带稳定 error.code 的 StatsError，
 *   绝不把 NaN / Infinity 当作正常结果返回。
 * - 缺失值处理：NaN、±Infinity、null/undefined、空字符串、非数值文本视为缺失并在计算前丢弃；
 *   CSV 常见的数值字符串（如 "3.5"）会被安全转换为数字。
 *   成对分析（pearson / spearman）按“成对完整”原则丢弃任一侧缺失的观测对。
 *
 * 对外 API（任务契约）：
 *   summarize(values)            -> { n, mean, sd, se, min, q1, median, q3, max, ci95 }
 *   welchTTest(a, b)             -> { nA, nB, meanA, meanB, sdA, sdB, meanDiff, df, t, p, cohenD, ci95 }
 *   oneWayAnova(groups)          -> { k, n, F, dfBetween, dfWithin, p, etaSquared, groupMeans }
 *   pearson(x, y)                -> { n, r, p, ci95 }
 *   spearman(x, y)               -> { n, rho, p }
 *
 * 另外导出分布工具函数（供测试与其他模块复用）：
 *   normalCdf(z)、studentTCdf(t, df)、studentTTwoSidedP(t, df)、
 *   studentTCritical(df, tailProbability)、fRightTailP(F, df1, df2)
 *
 * 统计约定：
 * - 标准差一律使用样本标准差（ddof = 1），因此描述统计至少需要 2 个有效观测。
 * - 四分位数采用 type-7 线性插值：h = (n - 1) * p，在相邻次序统计量之间线性插值。
 * - Welch t 检验：meanDiff = meanA - meanB；自由度用 Welch–Satterthwaite 公式；
 *   CI 为该均值差的双侧 95% t 置信区间；Cohen's d 使用合并标准差（pooled SD）。
 * - 单因素方差分析：组内平方和为零时 F 无定义（抛 ZERO_VARIANCE）。
 * - Pearson：Fisher z 变换计算 r 的 95% CI；|r| = 1 时 CI 收敛为 [±1, ±1]。
 *   Fisher CI 需要 n > 3；契约允许 n = 3，此时 CI 取极限 [-1, 1]（见 README 报告中的边界说明）。
 * - Spearman：平均秩处理并列，p 值使用 t 近似（df = n - 2）。
 * - 所有 p 值夹在 [0, 1] 内。
 */

const SQRT2 = Math.SQRT2;
const INV_SQRT_PI = 1 / Math.sqrt(Math.PI);
const FPMIN = 1e-300;
// qnorm(0.975)：标准正态双侧 95% 分位点，用于 Fisher z 置信区间。
const Z_975 = 1.959963984540054;
const BETA_EPS = 1e-15;
const BETA_MAX_ITERATIONS = 500;
const DEFAULT_TAIL_PROBABILITY = 0.025;

/** 统计核心抛出的错误：带稳定的 code，便于上层（工具层）分类处理。 */
export class StatsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatsError';
    this.code = code;
  }
}

function fail(code, message) {
  return new StatsError(code, message);
}

/* -------------------------------------------------------------------------- */
/* 基础数值工具                                                                */
/* -------------------------------------------------------------------------- */

function clamp01(value) {
  if (!(value > 0)) return 0;
  if (value > 1) return 1;
  return value;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 把单个值解析为有限数字；无法解析或非有限值返回 null（视为缺失）。 */
function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseNumericList(values, name) {
  if (!Array.isArray(values)) {
    throw fail('INVALID_INPUT', `参数「${name}」必须是数值数组。`);
  }
  const numbers = [];
  for (const value of values) {
    const parsed = toFiniteNumber(value);
    if (parsed !== null) numbers.push(parsed);
  }
  return numbers;
}

/**
 * 成对解析：仅保留两侧都是有限数值的观测对。
 * 长度不一致属于数据对齐错误，直接抛 LENGTH_MISMATCH。
 */
function parseNumericPairs(x, y, xName, yName) {
  if (!Array.isArray(x)) throw fail('INVALID_INPUT', `参数「${xName}」必须是数值数组。`);
  if (!Array.isArray(y)) throw fail('INVALID_INPUT', `参数「${yName}」必须是数值数组。`);
  if (x.length !== y.length) {
    throw fail(
      'LENGTH_MISMATCH',
      `成对分析要求两个数组长度一致：${xName}.length=${x.length}，${yName}.length=${y.length}。`,
    );
  }
  const xs = [];
  const ys = [];
  for (let i = 0; i < x.length; i += 1) {
    const xi = toFiniteNumber(x[i]);
    const yi = toFiniteNumber(y[i]);
    if (xi === null || yi === null) continue;
    xs.push(xi);
    ys.push(yi);
  }
  return { xs, ys };
}

/** 一次性均值 / 离差平方和（两遍法，数值稳定性好于 Σx² 公式）。 */
function meanAndSumSquares(values) {
  const n = values.length;
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / n;
  let sumSquaredDeviations = 0;
  for (const value of values) {
    const deviation = value - mean;
    sumSquaredDeviations += deviation * deviation;
  }
  return { mean, sumSquaredDeviations };
}

function pearsonCorrelation(xs, ys, meanX, meanY, sumSquaresX, sumSquaresY) {
  const n = xs.length;
  let cross = 0;
  for (let i = 0; i < n; i += 1) {
    cross += (xs[i] - meanX) * (ys[i] - meanY);
  }
  return cross / Math.sqrt(sumSquaresX * sumSquaresY);
}

function averageRanks(values) {
  const n = values.length;
  const order = Array.from({ length: n }, (_, index) => index).sort(
    (a, b) => values[a] - values[b] || a - b,
  );
  const ranks = new Array(n);
  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && values[order[end + 1]] === values[order[start]]) end += 1;
    // 平均秩：并列观测共享 (start + end) / 2 + 1
    const rank = (start + end) / 2 + 1;
    for (let k = start; k <= end; k += 1) ranks[order[k]] = rank;
    start = end + 1;
  }
  return ranks;
}

/** type-7 分位数：h = (n - 1) * p 处线性插值。调用方保证输入已升序且非空。 */
function quantileSorted(sorted, probability) {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const position = (n - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

/** 结果守门：确保返回对象里没有 NaN / Infinity（契约要求绝不返回非有限数）。 */
function finalizeResult(label, result) {
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw fail('NON_FINITE_RESULT', `${label} 内部计算异常：字段「${key}」不是有限数。`);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'number' && !Number.isFinite(item)) {
          throw fail('NON_FINITE_RESULT', `${label} 内部计算异常：数组字段「${key}」含非有限数。`);
        }
      }
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* 特殊函数：Gamma / 不完全 Beta / 误差函数                                     */
/* -------------------------------------------------------------------------- */

// Lanczos 近似（g = 7，n = 9），相对误差约 1e-15。
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log Γ(x)，x > 0。 */
function logGamma(x) {
  if (!(typeof x === 'number' && Number.isFinite(x) && x > 0)) {
    throw fail('INVALID_INPUT', 'logGamma 需要正有限数。');
  }
  let y = x;
  if (y < 0.5) {
    // 反射公式；本模块的调用参数均 >= 0.5，保留以获得完整数值定义。
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * y))) - logGamma(1 - y);
  }
  y -= 1;
  let series = LANCZOS_COEFFICIENTS[0];
  const t = y + 7.5;
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    series += LANCZOS_COEFFICIENTS[i] / (y + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(series);
}

/** 不完全 Beta 函数的连分式部分（Numerical Recipes 的 betacf 结构）。 */
function betaContinuedFraction(a, b, x) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= BETA_MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let coefficient = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + coefficient * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + coefficient / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    coefficient = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + coefficient * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + coefficient / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= BETA_EPS) break;
  }
  return h;
}

/** 正则化不完全 Beta 函数 I_x(a, b) = B_x(a, b) / B(a, b)，x ∈ [0, 1]。 */
function regularizedBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBetaTerm =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const betaTerm = Math.exp(logBetaTerm);
  if (x < (a + 1) / (a + b + 2)) {
    return (betaTerm * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (betaTerm * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** erf(x) 的幂级数（|x| < 1.5 时无严重相消，精度接近机器精度）。 */
function erfPowerSeries(x) {
  const xSquared = x * x;
  let term = x;
  let sum = x;
  for (let k = 1; k < 200; k += 1) {
    term *= -xSquared / k;
    const contribution = term / (2 * k + 1);
    sum += contribution;
    if (Math.abs(contribution) <= 1e-17 * Math.abs(sum)) break;
  }
  return (2 * INV_SQRT_PI) * sum;
}

/**
 * erfc(y)，y >= 0：小参数用幂级数，大参数用不完全 Gamma 连分式，
 * 避免 tail 概率在相消中丢失精度。
 */
function erfcNonNegative(y) {
  if (y < 1.5) return 1 - erfPowerSeries(y);
  if (y > 27.5) return 0; // exp(-y^2) 下溢，返回 0 是合法的 CDF 极限
  const x = y * y;
  const a = 0.5;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 1000; i += 1) {
    const coefficient = -i * (i - a);
    b += 2;
    d = coefficient * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + coefficient / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= 1e-16) break;
  }
  return Math.exp(-x) * Math.sqrt(x) * h * INV_SQRT_PI;
}

/* -------------------------------------------------------------------------- */
/* 分布函数                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 标准正态分布 CDF，Φ(z)。
 * 实现方式：Φ(z) = 0.5 * erfc(-z / √2)，并按符号分支保证双侧尾部精度。
 */
export function normalCdf(z) {
  if (typeof z !== 'number' || Number.isNaN(z)) {
    throw fail('INVALID_INPUT', 'normalCdf 需要一个数值参数（不能是 NaN）。');
  }
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  if (z >= 0) return 1 - 0.5 * erfcNonNegative(z / SQRT2);
  return 0.5 * erfcNonNegative(-z / SQRT2);
}

/**
 * Student t 双侧 p 值：P(|T_df| >= |t|)。
 * 恒等式：P(|T_df| >= |t|) = I_{df/(df+t²)}(df/2, 1/2)。
 */
export function studentTTwoSidedP(t, df) {
  if (typeof t !== 'number' || Number.isNaN(t)) {
    throw fail('INVALID_INPUT', 't 检验统计量必须是数值（不能是 NaN）。');
  }
  if (!(typeof df === 'number' && Number.isFinite(df) && df > 0)) {
    throw fail('INVALID_INPUT', 't 分布自由度必须是正有限数。');
  }
  if (!Number.isFinite(t)) return 0; // |t| = ∞ 的极限 p 值为 0
  if (t === 0) return 1;
  const x = df / (df + t * t);
  return clamp01(regularizedBeta(df / 2, 0.5, x));
}

/** Student t 分布 CDF，P(T_df <= t)。 */
export function studentTCdf(t, df) {
  const tail = studentTTwoSidedP(t, df) / 2;
  if (t === 0) return 0.5;
  return t > 0 ? 1 - tail : tail;
}

/**
 * Student t 上侧临界值：返回 t 使得 P(T_df > t) = tailProbability。
 * 默认 tailProbability = 0.025，即双侧 95% 临界值 t_{0.975, df}。
 * 用二分法反解 CDF（CDF 单调、无需初值），结果精度约 1e-15 相对误差。
 */
export function studentTCritical(df, tailProbability = DEFAULT_TAIL_PROBABILITY) {
  if (!(typeof df === 'number' && Number.isFinite(df) && df > 0)) {
    throw fail('INVALID_INPUT', 't 分布自由度必须是正有限数。');
  }
  if (!(typeof tailProbability === 'number' && tailProbability > 0 && tailProbability < 0.5)) {
    throw fail('INVALID_INPUT', 'tailProbability 必须在 (0, 0.5) 区间内。');
  }
  const upperTail = (candidate) => studentTTwoSidedP(candidate, df) / 2;
  let low = 0;
  let high = 1;
  while (upperTail(high) > tailProbability) {
    low = high;
    high *= 2;
    if (high > 1e300) {
      throw fail('NUMERIC_FAILURE', 't 临界值求解失败：上界发散。');
    }
  }
  for (let i = 0; i < 200; i += 1) {
    const middle = (low + high) / 2;
    if (upperTail(middle) > tailProbability) {
      low = middle;
    } else {
      high = middle;
    }
    if (high - low <= 1e-16 * Math.max(1, high)) break;
  }
  return (low + high) / 2;
}

/**
 * F 分布右尾概率：P(F_{df1, df2} >= F)。
 * 恒等式：P(F >= f) = I_{df2/(df2 + df1 f)}(df2/2, df1/2)。
 */
export function fRightTailP(F, df1, df2) {
  if (typeof F !== 'number' || Number.isNaN(F)) {
    throw fail('INVALID_INPUT', 'F 统计量必须是数值（不能是 NaN）。');
  }
  if (!(typeof df1 === 'number' && Number.isFinite(df1) && df1 > 0)) {
    throw fail('INVALID_INPUT', 'F 分布分子自由度必须是正有限数。');
  }
  if (!(typeof df2 === 'number' && Number.isFinite(df2) && df2 > 0)) {
    throw fail('INVALID_INPUT', 'F 分布分母自由度必须是正有限数。');
  }
  if (F <= 0) return 1;
  if (!Number.isFinite(F)) return 0;
  const x = df2 / (df2 + df1 * F);
  return clamp01(regularizedBeta(df2 / 2, df1 / 2, x));
}

/* -------------------------------------------------------------------------- */
/* 契约 API                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 描述统计 + 均值的双侧 95% t 置信区间。
 *
 * @param {Array<number|string|null>} values 观测值；缺失值会被丢弃。
 * @returns {{n:number, mean:number, sd:number, se:number, min:number,
 *            q1:number, median:number, q3:number, max:number, ci95:[number, number]}}
 */
export function summarize(values) {
  const sample = parseNumericList(values, 'values');
  const n = sample.length;
  if (n < 2) {
    throw fail(
      'INSUFFICIENT_DATA',
      `描述统计至少需要 2 个有效数值（样本标准差与 t 置信区间需要 ddof = 1），当前只有 ${n} 个。`,
    );
  }
  const { mean, sumSquaredDeviations } = meanAndSumSquares(sample);
  const variance = sumSquaredDeviations / (n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  const sorted = [...sample].sort((a, b) => a - b);
  const critical = studentTCritical(n - 1);
  return finalizeResult('summarize', {
    n,
    mean,
    sd,
    se,
    min: sorted[0],
    q1: quantileSorted(sorted, 0.25),
    median: quantileSorted(sorted, 0.5),
    q3: quantileSorted(sorted, 0.75),
    max: sorted[n - 1],
    ci95: [mean - critical * se, mean + critical * se],
  });
}

/**
 * Welch 双侧 t 检验（不假设方差齐性）。
 *
 * 自由度（Welch–Satterthwaite）：
 *   df = (sA²/nA + sB²/nB)² / [(sA²/nA)²/(nA-1) + (sB²/nB)²/(nB-1)]
 * Cohen's d 使用合并标准差 pooled SD = sqrt(((nA-1)sA² + (nB-1)sB²) / (nA+nB-2))。
 *
 * @param {Array<number|string|null>} a 第一组观测（缺失丢弃）
 * @param {Array<number|string|null>} b 第二组观测（缺失丢弃）
 * @returns {{nA:number, nB:number, meanA:number, meanB:number, sdA:number, sdB:number,
 *            meanDiff:number, df:number, t:number, p:number, cohenD:number,
 *            ci95:[number, number]}}
 */
export function welchTTest(a, b) {
  const sampleA = parseNumericList(a, 'a');
  const sampleB = parseNumericList(b, 'b');
  const nA = sampleA.length;
  const nB = sampleB.length;
  if (nA < 2 || nB < 2) {
    throw fail(
      'INSUFFICIENT_DATA',
      `Welch t 检验每组至少需要 2 个有效数值（需要样本方差），当前 nA=${nA}，nB=${nB}。`,
    );
  }
  const statsA = meanAndSumSquares(sampleA);
  const statsB = meanAndSumSquares(sampleB);
  const varianceA = statsA.sumSquaredDeviations / (nA - 1);
  const varianceB = statsB.sumSquaredDeviations / (nB - 1);
  const meanDiff = statsA.mean - statsB.mean;
  const termA = varianceA / nA;
  const termB = varianceB / nB;
  const varianceOfDifference = termA + termB;
  if (!(varianceOfDifference > 0)) {
    throw fail(
      'ZERO_VARIANCE',
      'Welch t 检验无法定义：两组数据的样本方差都为零（均值差的标准误为 0）。',
    );
  }
  const denominator = (termA * termA) / (nA - 1) + (termB * termB) / (nB - 1);
  if (!(denominator > 0)) {
    throw fail('ZERO_VARIANCE', 'Welch t 检验无法定义：Welch 自由度公式的分母为零。');
  }
  const df = (varianceOfDifference * varianceOfDifference) / denominator;
  const standardError = Math.sqrt(varianceOfDifference);
  const t = meanDiff / standardError;
  const p = studentTTwoSidedP(t, df);
  const pooledVariance = ((nA - 1) * varianceA + (nB - 1) * varianceB) / (nA + nB - 2);
  const pooledSd = Math.sqrt(pooledVariance);
  if (!(pooledSd > 0)) {
    throw fail('ZERO_VARIANCE', 'Welch t 检验无法定义：合并标准差为零。');
  }
  const cohenD = meanDiff / pooledSd;
  const critical = studentTCritical(df);
  return finalizeResult('welchTTest', {
    nA,
    nB,
    meanA: statsA.mean,
    meanB: statsB.mean,
    sdA: Math.sqrt(varianceA),
    sdB: Math.sqrt(varianceB),
    meanDiff,
    df,
    t,
    p,
    cohenD,
    ci95: [meanDiff - critical * standardError, meanDiff + critical * standardError],
  });
}

/**
 * 单因素方差分析（one-way ANOVA）。
 *
 * 约定：每个分组至少 2 个有效观测（组内样本方差需要 ddof = 1；与工具层的
 * “样本不足分组被排除”行为一致）。组内平方和为 0 时 F 统计量无定义，抛 ZERO_VARIANCE。
 *
 * @param {Array<Array<number|string|null>>} groups 分组观测值
 * @returns {{k:number, n:number, F:number, dfBetween:number, dfWithin:number,
 *            p:number, etaSquared:number, groupMeans:number[]}}
 */
export function oneWayAnova(groups) {
  if (!Array.isArray(groups)) {
    throw fail('INVALID_INPUT', 'oneWayAnova 需要一个“数组的数组”（每个元素是一组观测）。');
  }
  if (groups.length < 2) {
    throw fail('INSUFFICIENT_DATA', `单因素方差分析至少需要 2 个分组，当前只有 ${groups.length} 个。`);
  }
  const samples = groups.map((group, index) => parseNumericList(group, `groups[${index}]`));
  samples.forEach((sample, index) => {
    if (sample.length < 2) {
      throw fail(
        'INSUFFICIENT_DATA',
        `第 ${index + 1} 组至少需要 2 个有效数值，当前只有 ${sample.length} 个。`,
      );
    }
  });
  const k = samples.length;
  const n = samples.reduce((total, sample) => total + sample.length, 0);
  const dfBetween = k - 1;
  const dfWithin = n - k;
  if (dfWithin < 1) {
    throw fail('INSUFFICIENT_DATA', '单因素方差分析的组内自由度不足（需要 n - k >= 1）。');
  }
  const means = samples.map((sample) => {
    let sum = 0;
    for (const value of sample) sum += value;
    return sum / sample.length;
  });
  let sumSquaresWithin = 0;
  for (let i = 0; i < k; i += 1) {
    const sample = samples[i];
    const mean = means[i];
    for (const value of sample) {
      const deviation = value - mean;
      sumSquaresWithin += deviation * deviation;
    }
  }
  let grandMean = 0;
  for (let i = 0; i < k; i += 1) grandMean += samples[i].length * means[i];
  grandMean /= n;
  let sumSquaresBetween = 0;
  for (let i = 0; i < k; i += 1) {
    const deviation = means[i] - grandMean;
    sumSquaresBetween += samples[i].length * deviation * deviation;
  }
  if (!(sumSquaresWithin > 0)) {
    throw fail(
      'ZERO_VARIANCE',
      '单因素方差分析无法定义：所有分组内的数值都没有变异（组内平方和为 0，F 为无穷大）。',
    );
  }
  const sumSquaresTotal = sumSquaresBetween + sumSquaresWithin;
  if (!(sumSquaresTotal > 0)) {
    throw fail('ZERO_VARIANCE', '单因素方差分析无法定义：总平方和为 0（所有观测完全相同）。');
  }
  const F = sumSquaresBetween / dfBetween / (sumSquaresWithin / dfWithin);
  const p = fRightTailP(F, dfBetween, dfWithin);
  return finalizeResult('oneWayAnova', {
    k,
    n,
    F,
    dfBetween,
    dfWithin,
    p,
    etaSquared: sumSquaresBetween / sumSquaresTotal,
    groupMeans: means,
  });
}

/**
 * Pearson 相关系数（成对完整观测）。
 * r 的 95% CI 使用 Fisher z 变换：z = atanh(r)，se = 1/√(n-3)，再取 tanh 反变换。
 *
 * 边界：|r| = 1 时 CI 收敛为 [±1, ±1]；n = 3 时 Fisher 标准误为无穷大，
 * CI 取极限 [-1, 1]（契约允许 n >= 3）。
 *
 * @returns {{n:number, r:number, p:number, ci95:[number, number]}}
 */
export function pearson(x, y) {
  const { xs, ys } = parseNumericPairs(x, y, 'x', 'y');
  const n = xs.length;
  if (n < 3) {
    throw fail('INSUFFICIENT_DATA', `Pearson 相关至少需要 3 对有效观测（契约 n >= 3），当前 ${n} 对。`);
  }
  const statsX = meanAndSumSquares(xs);
  const statsY = meanAndSumSquares(ys);
  if (!(statsX.sumSquaredDeviations > 0)) {
    throw fail('ZERO_VARIANCE', 'Pearson 相关无法定义：x 没有变异（样本方差为 0）。');
  }
  if (!(statsY.sumSquaredDeviations > 0)) {
    throw fail('ZERO_VARIANCE', 'Pearson 相关无法定义：y 没有变异（样本方差为 0）。');
  }
  const rawR = pearsonCorrelation(xs, ys, statsX.mean, statsY.mean, statsX.sumSquaredDeviations, statsY.sumSquaredDeviations);
  const r = clamp(rawR, -1, 1);
  let p;
  let ci95;
  if (Math.abs(r) >= 1) {
    // 完全线性相关：p 的极限为 0，Fisher CI 收缩为单点。
    p = 0;
    ci95 = [r, r];
  } else {
    const t = r * Math.sqrt((n - 2) / (1 - r * r));
    p = studentTTwoSidedP(t, n - 2);
    if (n <= 3) {
      // Fisher 标准误 1/√(n-3) 在 n = 3 时发散，CI 收敛到整个取值区间。
      ci95 = [-1, 1];
    } else {
      const z = Math.atanh(r);
      const standardError = 1 / Math.sqrt(n - 3);
      ci95 = [
        Math.tanh(z - Z_975 * standardError),
        Math.tanh(z + Z_975 * standardError),
      ];
    }
  }
  return finalizeResult('pearson', { n, r, p, ci95 });
}

/**
 * Spearman 等级相关（平均秩处理并列，p 值用 t 近似 df = n - 2）。
 *
 * @returns {{n:number, rho:number, p:number}}
 */
export function spearman(x, y) {
  const { xs, ys } = parseNumericPairs(x, y, 'x', 'y');
  const n = xs.length;
  if (n < 3) {
    throw fail('INSUFFICIENT_DATA', `Spearman 相关至少需要 3 对有效观测（契约 n >= 3），当前 ${n} 对。`);
  }
  const ranksX = averageRanks(xs);
  const ranksY = averageRanks(ys);
  const statsX = meanAndSumSquares(ranksX);
  const statsY = meanAndSumSquares(ranksY);
  if (!(statsX.sumSquaredDeviations > 0)) {
    throw fail('ZERO_VARIANCE', 'Spearman 相关无法定义：x 的秩没有变异（全部取值相同）。');
  }
  if (!(statsY.sumSquaredDeviations > 0)) {
    throw fail('ZERO_VARIANCE', 'Spearman 相关无法定义：y 的秩没有变异（全部取值相同）。');
  }
  const rawRho = pearsonCorrelation(ranksX, ranksY, statsX.mean, statsY.mean, statsX.sumSquaredDeviations, statsY.sumSquaredDeviations);
  const rho = clamp(rawRho, -1, 1);
  let p;
  if (Math.abs(rho) >= 1) {
    p = 0;
  } else {
    const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
    p = studentTTwoSidedP(t, n - 2);
  }
  return finalizeResult('spearman', { n, rho, p });
}
