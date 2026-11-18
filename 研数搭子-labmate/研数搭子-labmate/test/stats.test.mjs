/**
 * 研数搭子 · 统计核心单元测试
 *
 * 运行：node --test test/stats.test.mjs
 *
 * 参考值来源：
 * - 分布函数 / p 值 / t 临界值 / F 临界值：用与实现完全无关的数值积分
 *   （自适应 Simpson，直接对 t、F、正态密度核函数做比值积分）独立算出，作为测试基准；
 * - 部分结果另有闭式解可交叉验算（如 t 分布 df=1 的 Cauchy 闭式、F 分布 I_x(a,1)=x^a）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StatsError,
  summarize,
  welchTTest,
  oneWayAnova,
  pearson,
  spearman,
  normalCdf,
  studentTCdf,
  studentTTwoSidedP,
  studentTCritical,
  fRightTailP,
} from '../lib/stats.mjs';

/* -------------------------------------------------------------------------- */
/* 断言辅助                                                                    */
/* -------------------------------------------------------------------------- */

function assertClose(actual, expected, tolerance = 1e-12, label = '') {
  assert.ok(
    typeof actual === 'number' && Number.isFinite(actual),
    `${label}：期望有限数值，实际为 ${String(actual)}`,
  );
  const error = Math.abs(actual - expected);
  assert.ok(
    error <= tolerance,
    `${label}：期望 ${expected}，实际 ${actual}，误差 ${error} 超过容差 ${tolerance}`,
  );
}

function assertJsonSafe(value, label) {
  const roundTrip = JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(roundTrip, value, `${label}：结果不能无损 JSON 序列化`);
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'number') {
      assert.ok(Number.isFinite(current), `${label}：结果中出现非有限数 ${current}`);
    } else if (Array.isArray(current)) {
      stack.push(...current);
    } else if (current && typeof current === 'object') {
      stack.push(...Object.values(current));
    }
  }
}

function assertThrowsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error, `应抛出 Error，实际为 ${String(error)}`);
    assert.equal(error.code, code, `错误 code 应为 ${code}，实际为 ${String(error.code)}`);
    assert.ok(
      typeof error.message === 'string' && error.message.length > 0,
      '错误信息不能为空',
    );
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* summarize                                                                   */
/* -------------------------------------------------------------------------- */

// 独立参考：t_{0.975, df} 临界值（由数值积分反解得到）
const T_CRIT = {
  1: 12.706204736174705,
  2: 4.3026527297494628,
  3: 3.18244630528371,
  4: 2.7764451051977943,
  8: 2.3060041352041667,
  10: 2.2281388519862748,
  13: 2.1603686564627926,
  30: 2.0422724563012391,
  100: 1.983971518523552,
  '100/17': 2.4588237096991463,
};

test('summarize：基本描述统计与 t 置信区间', () => {
  const result = summarize([1, 2, 3, 4, 5]);
  assert.equal(result.n, 5);
  assert.equal(result.mean, 3);
  assertClose(result.sd, Math.sqrt(2.5), 1e-15, 'sd');
  assertClose(result.se, Math.sqrt(2.5) / Math.sqrt(5), 1e-15, 'se');
  assert.equal(result.min, 1);
  assert.equal(result.q1, 2);
  assert.equal(result.median, 3);
  assert.equal(result.q3, 4);
  assert.equal(result.max, 5);
  // 均值 95% t CI：mean ± t_{0.975,4} * se
  const halfWidth = T_CRIT[4] * (Math.sqrt(2.5) / Math.sqrt(5));
  assertClose(result.ci95[0], 3 - halfWidth, 1e-12, 'ci95 lower');
  assertClose(result.ci95[1], 3 + halfWidth, 1e-12, 'ci95 upper');
  assertJsonSafe(result, 'summarize');
});

test('summarize：四分位数采用 type-7 线性插值', () => {
  const even = summarize([1, 2, 3, 4]);
  assert.equal(even.n, 4);
  assert.equal(even.mean, 2.5);
  // (n-1)*p：q1 = 1 + 0.75*(2-1) = 1.75；median = 1.5 位置 => 2.5；q3 = 2 + 0.25*(4-3)? => 3.25
  assertClose(even.q1, 1.75, 1e-15, 'q1');
  assertClose(even.median, 2.5, 1e-15, 'median');
  assertClose(even.q3, 3.25, 1e-15, 'q3');
  assertClose(even.sd, Math.sqrt(5 / 3), 1e-15, 'sd');
  assertClose(even.se, Math.sqrt(5 / 3) / 2, 1e-15, 'se');
  const halfWidth = T_CRIT[3] * (Math.sqrt(5 / 3) / 2);
  assertClose(even.ci95[0], 2.5 - halfWidth, 1e-12, 'n=4 ci lo');
  assertClose(even.ci95[1], 2.5 + halfWidth, 1e-12, 'n=4 ci hi');

  const odd = summarize([10, -2, 7, 3, 7]);
  // sorted = [-2, 3, 7, 7, 10]；q1 位置 1 => 3；median 位置 2 => 7；q3 位置 3 => 7
  assert.equal(odd.q1, 3);
  assert.equal(odd.median, 7);
  assert.equal(odd.q3, 7);
});

test('summarize：n=2 时使用 df=1 的 t 临界值', () => {
  const result = summarize([0, 10]);
  assert.equal(result.n, 2);
  assert.equal(result.mean, 5);
  assertClose(result.sd, Math.sqrt(50), 1e-14, 'sd');
  assertClose(result.se, 5, 1e-14, 'se');
  assertClose(result.ci95[0], 5 - T_CRIT[1] * 5, 1e-12, 'ci lo');
  assertClose(result.ci95[1], 5 + T_CRIT[1] * 5, 1e-12, 'ci hi');
  // 常数样本是合法的描述统计（sd = 0），不应抛错
  const constant = summarize([4, 4, 4]);
  assert.equal(constant.sd, 0);
  assert.equal(constant.se, 0);
  assert.deepEqual(constant.ci95, [4, 4]);
});

test('summarize：缺失值丢弃、数值字符串兼容与边界错误', () => {
  const withMissing = summarize([1, NaN, '2', null, 3, undefined, 4, Infinity, '', 'x']);
  assert.equal(withMissing.n, 4);
  assert.equal(withMissing.mean, 2.5);
  assert.equal(withMissing.min, 1);
  assert.equal(withMissing.max, 4);

  assertThrowsCode(() => summarize([]), 'INSUFFICIENT_DATA');
  assertThrowsCode(() => summarize([NaN, null, Infinity, 'x', '']), 'INSUFFICIENT_DATA');
  assertThrowsCode(() => summarize([5]), 'INSUFFICIENT_DATA');
  assertThrowsCode(() => summarize(null), 'INVALID_INPUT');
  assertThrowsCode(() => summarize('1,2,3'), 'INVALID_INPUT');
  assert.throws(() => summarize([]), (error) => error instanceof StatsError);
});

/* -------------------------------------------------------------------------- */
/* welchTTest                                                                  */
/* -------------------------------------------------------------------------- */

test('welchTTest：方差相等案例（t=-3, df=8）', () => {
  const result = welchTTest([10, 12, 14, 16, 18], [16, 18, 20, 22, 24]);
  assert.equal(result.nA, 5);
  assert.equal(result.nB, 5);
  assert.equal(result.meanA, 14);
  assert.equal(result.meanB, 20);
  assertClose(result.sdA, Math.sqrt(10), 1e-14, 'sdA');
  assertClose(result.sdB, Math.sqrt(10), 1e-14, 'sdB');
  assert.equal(result.meanDiff, -6);
  assert.equal(result.df, 8);
  assertClose(result.t, -3, 1e-14, 't');
  // 独立数值积分参考值
  assertClose(result.p, 0.017071681233782651, 1e-12, 'p');
  assertClose(result.cohenD, -6 / Math.sqrt(10), 1e-12, 'cohenD');
  assertClose(result.ci95[0], -10.612008270408333, 1e-12, 'ci lo');
  assertClose(result.ci95[1], -1.3879917295916666, 1e-12, 'ci hi');
  assertJsonSafe(result, 'welchTTest');
});

test('welchTTest：方差不等的 Welch–Satterthwaite 自由度', () => {
  const result = welchTTest([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  // sA² = 2.5, sB² = 10, nA = nB = 5
  // df = (2.5/5 + 10/5)² / [(2.5/5)²/4 + (10/5)²/4] = 6.25 / 1.0625 = 100/17
  assert.equal(result.meanA, 3);
  assert.equal(result.meanB, 6);
  assertClose(result.df, 100 / 17, 1e-14, 'df');
  assertClose(result.t, -3 / Math.sqrt(2.5), 1e-14, 't');
  // 独立数值积分参考值
  assertClose(result.p, 0.10753119493062725, 1e-12, 'p');
  assertClose(result.cohenD, -1.2, 1e-12, 'cohenD'); // pooled SD = sqrt(((4*2.5)+(4*10))/8) = 2.5
  assertClose(result.ci95[0], -6.8877416437369758, 1e-12, 'ci lo');
  assertClose(result.ci95[1], 0.88774164373697584, 1e-12, 'ci hi');
  // 基本性质：CI 覆盖均值差，t 与均值差同号，p 在 [0,1]
  assert.ok(result.ci95[0] <= result.meanDiff && result.meanDiff <= result.ci95[1]);
  assert.equal(Math.sign(result.t), Math.sign(result.meanDiff));
  assert.ok(result.p >= 0 && result.p <= 1);
});

test('welchTTest：交换组别只翻转符号，不影响 p 与 df', () => {
  const a = [3, 5, 7, 9, 11];
  const b = [4, 6, 9, 11, 13, 15];
  const forward = welchTTest(a, b);
  const backward = welchTTest(b, a);
  assertClose(backward.meanDiff, -forward.meanDiff, 1e-15, 'meanDiff');
  assertClose(backward.t, -forward.t, 1e-15, 't');
  assertClose(backward.p, forward.p, 1e-15, 'p');
  assertClose(backward.df, forward.df, 1e-15, 'df');
  assertClose(backward.ci95[0], -forward.ci95[1], 1e-15, 'ci lo');
  assertClose(backward.ci95[1], -forward.ci95[0], 1e-15, 'ci hi');
});

test('welchTTest：零方差、小样本与缺失值边界', () => {
  assertThrowsCode(() => welchTTest([1, 1, 1], [2, 2, 2]), 'ZERO_VARIANCE');
  assertThrowsCode(() => welchTTest([5, 5], [5, 5]), 'ZERO_VARIANCE');
  assertThrowsCode(() => welchTTest([1], [2, 3, 4]), 'INSUFFICIENT_DATA');
  assertThrowsCode(() => welchTTest([1, NaN], [2, 3]), 'INSUFFICIENT_DATA');
  assertThrowsCode(() => welchTTest([1, 2, 3], null), 'INVALID_INPUT');
  // 一组无变异、另一组有变异仍是可计算的 Welch 检验
  const oneConstantGroup = welchTTest([2, 2, 2, 2], [1, 2, 3, 4]);
  assert.equal(oneConstantGroup.sdA, 0);
  assertClose(oneConstantGroup.df, 3, 1e-14, 'df'); // df = (sB²/nB)² / [(sB²/nB)²/(nB-1)] = nB-1
  assertJsonSafe(oneConstantGroup, 'welchTTest(one constant group)');
});

/* -------------------------------------------------------------------------- */
/* oneWayAnova                                                                 */
/* -------------------------------------------------------------------------- */

test('oneWayAnova：经典三组案例', () => {
  const result = oneWayAnova([
    [6, 8, 4, 5, 3, 4],
    [8, 12, 9, 11, 6, 8],
    [5, 4, 7, 3],
  ]);
  assert.equal(result.k, 3);
  assert.equal(result.n, 16);
  assert.equal(result.dfBetween, 2);
  assert.equal(result.dfWithin, 13);
  // SSB = 63.1875, SSW = 48.75 => F = (63.1875/2)/(48.75/13) = 8.425
  assertClose(result.F, 8.425, 1e-14, 'F');
  // F 分布 I_x(a, 1) = x^a 的闭式解 + 独立数值积分：p = (13/(13+2*8.425))^6.5
  const analyticP = Math.pow(13 / (13 + 2 * 8.425), 6.5);
  assertClose(result.p, analyticP, 1e-15, 'p（闭式解）');
  assertClose(result.p, 0.0045029135531891662, 1e-12, 'p（数值积分）');
  assertClose(result.etaSquared, 337 / 597, 1e-15, 'etaSquared');
  assert.deepEqual(result.groupMeans, [5, 9, 4.75]);
  assert.ok(result.etaSquared > 0 && result.etaSquared < 1);
  assertJsonSafe(result, 'oneWayAnova');
});

test('oneWayAnova：两组时与合并方差 t 检验一致（F = t²）', () => {
  const groups = [
    [1, 2, 3],
    [4, 5, 6],
  ];
  const result = oneWayAnova(groups);
  assert.equal(result.dfBetween, 1);
  assert.equal(result.dfWithin, 4);
  // 合并方差 sp² = 1，均值差 3，se = sqrt(1*(1/3+1/3)) => t = -3/sqrt(2/3) => F = t² = 13.5
  const pooledT = (2 - 5) / Math.sqrt(1 * (1 / 3 + 1 / 3));
  assertClose(result.F, pooledT * pooledT, 1e-14, 'F = t²');
  assertClose(result.F, 13.5, 1e-14, 'F');
  assertClose(result.p, 0.021311641128899071, 1e-12, 'p（数值积分）');
  assertClose(result.etaSquared, 13.5 / 17.5, 1e-15, 'etaSquared');
});

test('oneWayAnova：零方差、小分组与参数错误', () => {
  // 所有组内都是常数 => 组内平方和为 0，F 无定义
  assertThrowsCode(() => oneWayAnova([[1, 1, 1], [2, 2, 2]]), 'ZERO_VARIANCE');
  assertThrowsCode(() => oneWayAnova([[5, 5], [5, 5]]), 'ZERO_VARIANCE');
  assertThrowsCode(() => oneWayAnova([[1, 2, 3]]), 'INSUFFICIENT_DATA');
  assertThrowsCode(() => oneWayAnova([[1, 2], [3]]), 'INSUFFICIENT_DATA');
  assertThrowsCode(() => oneWayAnova([[1, 2], [NaN, NaN]]), 'INSUFFICIENT_DATA');
  assertThrowsCode(() => oneWayAnova('not-an-array'), 'INVALID_INPUT');
  assertThrowsCode(() => oneWayAnova([[1, 2], 'oops']), 'INVALID_INPUT');
  // 组内变异存在、组间均值为常数时 F = 0 是合法结果
  const noEffect = oneWayAnova([[1, 3], [0, 4], [2, 2]]);
  assertClose(noEffect.F, 0, 1e-15, 'F=0');
  assert.equal(noEffect.p, 1);
  assert.equal(noEffect.etaSquared, 0);
});

/* -------------------------------------------------------------------------- */
/* pearson                                                                     */
/* -------------------------------------------------------------------------- */

test('pearson：完美相关与 CI 收缩为单点', () => {
  const positive = pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.equal(positive.n, 5);
  assert.equal(positive.r, 1);
  assert.equal(positive.p, 0);
  assert.deepEqual(positive.ci95, [1, 1]);

  const negative = pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
  assert.equal(negative.r, -1);
  assert.equal(negative.p, 0);
  assert.deepEqual(negative.ci95, [-1, -1]);
});

test('pearson：一般案例、Fisher z 置信区间方向与 p 值', () => {
  const result = pearson([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]);
  assertClose(result.r, 0.8, 1e-15, 'r');
  // t = r * sqrt((n-2)/(1-r²)) = 0.8 * sqrt(3/0.36)；p 由独立数值积分得到
  assertClose(result.p, 0.10408803866182782, 1e-12, 'p');
  // Fisher z CI：非对称，且包含 r
  const expectedLower = -0.27964004196935477;
  const expectedUpper = 0.9861961933012714;
  assertClose(result.ci95[0], expectedLower, 1e-12, 'CI lower');
  assertClose(result.ci95[1], expectedUpper, 1e-12, 'CI upper');
  assert.ok(result.ci95[0] < result.ci95[1]);
  assert.ok(result.ci95[0] < result.r && result.r < result.ci95[1], 'CI 必须包含 r');
  // tanh 反变换在 z 空间对称，因此 r 空间应体现方向性：正向 r 的 CI 不是关于 r 对称的
  assert.ok(result.r - result.ci95[0] > result.ci95[1] - result.r);
  assert.ok(result.ci95[0] > -1 && result.ci95[1] < 1);
  assertJsonSafe(result, 'pearson');
});

test('pearson：成对完整、n=3 的 Fisher CI 极限与边界错误', () => {
  // 只保留两侧都完整的观测对：有效对 (1,2), (3,6), (4,8), (5,10) => 完全共线
  const pairwise = pearson([1, 2, 3, 4, 5], [2, NaN, 6, 8, 10]);
  assert.equal(pairwise.n, 4);
  assert.equal(pairwise.r, 1);
  assert.equal(pairwise.p, 0);

  // n = 3 时 Fisher 标准误为无穷大，CI 取极限 [-1, 1]（契约允许 n >= 3）
  const three = pearson([1, 2, 3], [2, 4, 7]);
  assert.equal(three.n, 3);
  assertClose(three.r, Math.sqrt(75 / 76), 1e-14, 'r');
  assert.deepEqual(three.ci95, [-1, 1]);
  // df = 1 的 t 分布即 Cauchy 分布，双侧 p 有闭式解：1 - (2/π)·atan(t)
  const t = three.r * Math.sqrt(1 / (1 - three.r * three.r));
  const cauchyP = 1 - (2 / Math.PI) * Math.atan(t);
  assertClose(three.p, cauchyP, 1e-14, 'n=3 p（Cauchy 闭式解）');

  assertThrowsCode(() => pearson([1, 1, 1, 1], [1, 2, 3, 4]), 'ZERO_VARIANCE');
  assertThrowsCode(() => pearson([1, 2, 3, 4], [5, 5, 5, 5]), 'ZERO_VARIANCE');
  assertThrowsCode(() => pearson([1, 2], [3, 4]), 'INSUFFICIENT_DATA');
  assertThrowsCode(() => pearson([1, 2, 3], [1, 2]), 'LENGTH_MISMATCH');
  assertThrowsCode(() => pearson(null, [1, 2, 3]), 'INVALID_INPUT');
  // 缺失导致有效对不足：仅剩 2 对完整观测 < 3
  assertThrowsCode(() => pearson([1, 2, NaN, NaN], [1, 2, 3, 4]), 'INSUFFICIENT_DATA');
});

/* -------------------------------------------------------------------------- */
/* spearman                                                                    */
/* -------------------------------------------------------------------------- */

test('spearman：单调非线性下等级相关为 1，而 Pearson 明显小于 1', () => {
  const xs = [1, 2, 3, 4, 5];
  const ys = [1, 4, 9, 16, 25]; // y = x²：严格单调递增但非线性
  const result = spearman(xs, ys);
  assert.equal(result.n, 5);
  assert.equal(result.rho, 1);
  assert.equal(result.p, 0);

  const linear = pearson(xs, ys);
  assert.ok(linear.r > 0.9 && linear.r < 0.99, `Pearson 应小于 1，实际 ${linear.r}`);
  assert.ok(result.rho > linear.r);

  const decreasing = spearman(xs, [25, 16, 9, 4, 1]);
  assert.equal(decreasing.rho, -1);
  assert.equal(decreasing.p, 0);
});

test('spearman：平均秩处理并列（t 近似 p 值）', () => {
  // x 的并列秩：[1, 2.5, 2.5, 4]；y 的秩：[1, 2, 3, 4]
  const result = spearman([1, 2, 2, 3], [1, 2, 3, 4]);
  assert.equal(result.n, 4);
  const expectedRho = 3 / Math.sqrt(10); // = 0.9486832980505138
  assertClose(result.rho, expectedRho, 1e-14, '平均秩 rho');
  // t = rho*sqrt((n-2)/(1-rho²)) = 3√2；p 由独立数值积分得到
  assertClose(result.p, 0.05131670194948619, 1e-12, 'p');
  assertJsonSafe(result, 'spearman');

  // 若错误地把并列秩当作不同秩，结果会不同；用闭式秩配对验证不是简单用原值 Pearson
  const rankPearson = pearson([1, 2.5, 2.5, 4], [1, 2, 3, 4]);
  assertClose(result.rho, rankPearson.r, 1e-15, 'rho 应等于平均秩的 Pearson 相关');
});

test('spearman：小样本、零变异与参数错误', () => {
  assertThrowsCode(() => spearman([1, 2], [3, 4]), 'INSUFFICIENT_DATA');
  assertThrowsCode(() => spearman([3, 3, 3, 3], [1, 2, 3, 4]), 'ZERO_VARIANCE');
  assertThrowsCode(() => spearman([1, 2, 3, 4], [7, 7, 7, 7]), 'ZERO_VARIANCE');
  assertThrowsCode(() => spearman([1, 2, 3], [1, 2]), 'LENGTH_MISMATCH');
  // 缺失值丢弃后仅剩 3 对且 x 完全相同 => 秩零方差
  assertThrowsCode(() => spearman([5, 5, 5, NaN], [1, 2, 3, 4]), 'ZERO_VARIANCE');
});

/* -------------------------------------------------------------------------- */
/* 分布函数工具                                                                */
/* -------------------------------------------------------------------------- */

test('normalCdf：与标准正态参考值一致', () => {
  assert.equal(normalCdf(0), 0.5);
  // 参考值来自独立数值积分（与实现无共享代码）
  assertClose(normalCdf(1.96), 0.97500210485177963, 1e-13, 'Phi(1.96)');
  assertClose(normalCdf(-1.96), 0.024997895148220428, 1e-13, 'Phi(-1.96)');
  assertClose(normalCdf(0.5), 0.69146246127401312, 1e-13, 'Phi(0.5)');
  assert.equal(normalCdf(Infinity), 1);
  assert.equal(normalCdf(-Infinity), 0);
  for (const z of [-3, -1.2, 0.3, 2.2]) {
    assertClose(normalCdf(z) + normalCdf(-z), 1, 1e-15, `对称性 z=${z}`);
  }
  assertThrowsCode(() => normalCdf(NaN), 'INVALID_INPUT');
});

test('studentT / F 分布函数：临界值与右侧尾部概率（数值积分参考值）', () => {
  // t 双侧 p 值
  assertClose(studentTTwoSidedP(-3, 8), 0.017071681233782651, 1e-13, 'p(t=-3, df=8)');
  assertClose(studentTTwoSidedP(2.2281388519862748, 10), 0.05, 1e-12, 'p(t crit, df=10)');
  assert.equal(studentTTwoSidedP(0, 5), 1);
  assert.equal(studentTTwoSidedP(Infinity, 5), 0);
  // t 临界值
  for (const [df, expected] of Object.entries(T_CRIT)) {
    const numericDf = df === '100/17' ? 100 / 17 : Number(df);
    assertClose(studentTCritical(numericDf), expected, 1e-12, `tcrit(df=${df})`);
  }
  // t CDF 与临界值互逆
  assertClose(studentTCdf(T_CRIT[13], 13), 0.975, 1e-12, 'tCdf(tcrit)');
  assertClose(studentTCdf(-T_CRIT[13], 13), 0.025, 1e-12, 'tCdf(-tcrit)');
  assert.equal(studentTCdf(0, 7), 0.5);
  // F 右尾：ANOVA 案例 + F 临界值
  assertClose(fRightTailP(8.425, 2, 13), 0.0045029135531891662, 1e-13, 'F tail 8.425');
  assertClose(fRightTailP(3.8055652529780568, 2, 13), 0.05, 1e-12, 'Fcrit(0.95;2,13)');
  assert.equal(fRightTailP(0, 2, 13), 1);
  assert.equal(fRightTailP(Infinity, 2, 13), 0);
  // 恒等式：F(1, df) 的右尾概率 = t(df) 双侧 p 值
  for (const [t, df] of [[2.5, 7], [-1.3, 20], [3.1, 4]]) {
    assertClose(fRightTailP(t * t, 1, df), studentTTwoSidedP(t, df), 1e-14, `F/t 恒等式 t=${t}`);
  }
  assertThrowsCode(() => studentTTwoSidedP(NaN, 5), 'INVALID_INPUT');
  assertThrowsCode(() => studentTTwoSidedP(1, 0), 'INVALID_INPUT');
  assertThrowsCode(() => fRightTailP(1, 1, -2), 'INVALID_INPUT');
  assertThrowsCode(() => studentTCritical(5, 0.6), 'INVALID_INPUT');
});

/* -------------------------------------------------------------------------- */
/* 结果安全性与错误码                                                          */
/* -------------------------------------------------------------------------- */

test('所有 API 的 p 值夹在 [0,1] 内，输出 JSON 可序列化', () => {
  const outputs = [
    summarize([3, 1, 4, 1, 5, 9, 2, 6]),
    welchTTest([1, 3, 5, 7], [2, 4, 6, 8, 10]),
    oneWayAnova([[1, 2, 3], [4, 5, 6], [7, 8, 9]]),
    pearson([1, 2, 3, 4, 5, 6], [2, 1, 4, 3, 6, 5]),
    spearman([1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1]),
  ];
  for (const output of outputs) {
    assertJsonSafe(output, 'API 输出');
    if (typeof output.p === 'number') {
      assert.ok(output.p >= 0 && output.p <= 1, `p 值越界：${output.p}`);
    }
  }
  // 极端但非退化数据：p 仍被夹在 [0,1]，且不会出现 NaN/Infinity
  const extreme = welchTTest([0, 0.0001], [1000, 1000.0001]);
  assert.ok(extreme.p >= 0 && extreme.p <= 1);
  const strong = pearson([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6.0000001]);
  assert.ok(strong.p >= 0 && strong.p <= 1);
  assertJsonSafe(extreme, 'extreme welch');
  assertJsonSafe(strong, 'strong pearson');
});

test('错误对象带稳定 code，绝不把 NaN/Infinity 当正常结果返回', () => {
  const cases = [
    [() => summarize([]), 'INSUFFICIENT_DATA'],
    [() => welchTTest([1], [2]), 'INSUFFICIENT_DATA'],
    [() => oneWayAnova([[1, 2]]), 'INSUFFICIENT_DATA'],
    [() => pearson([1, 2], [3, 4]), 'INSUFFICIENT_DATA'],
    [() => spearman([1, 2], [3, 4]), 'INSUFFICIENT_DATA'],
    [() => welchTTest([1, 1], [2, 2]), 'ZERO_VARIANCE'],
    [() => oneWayAnova([[1, 1], [2, 2]]), 'ZERO_VARIANCE'],
    [() => pearson([1, 1, 1], [1, 2, 3]), 'ZERO_VARIANCE'],
    [() => spearman([1, 1, 1], [1, 2, 3]), 'ZERO_VARIANCE'],
    [() => pearson([1, 2, 3], [1, 2]), 'LENGTH_MISMATCH'],
    [() => summarize(42), 'INVALID_INPUT'],
  ];
  for (const [fn, code] of cases) assertThrowsCode(fn, code);
});
