import { formatNumber, formatPShort, pStars, truncateText } from './format.mjs';
import { toNumeric } from './dataset.mjs';

const WIDTH = 920;
const FONT =
  "'Inter','PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif";
const INK = '#203047';
const MUTED = '#6b7c93';
const GRID = '#e7edf5';
const PALETTE = ['#2f6fed', '#0f9d8a', '#7c63d8', '#d97757', '#5b7c99', '#b2587a', '#688c3d', '#a4782a'];

const XML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

function safeText(value, maxLength = 40) {
  return escapeXml(truncateText(String(value ?? ''), maxLength));
}

function niceStep(span, targetTicks = 5) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const rough = span / Math.max(1, targetTicks);
  const power = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / power;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * power;
}

function axisInfo(min, max, targetTicks = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };
  }
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 0.5;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep(hi - lo, targetTicks);
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let value = niceMin; value <= niceMax + step * 0.001 && ticks.length < 12; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return { min: niceMin, max: niceMax, step, ticks };
}

function svgOpen({ width = WIDTH, height = 430, title, description }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeXml(
    title,
  )}" style="display:block;max-width:100%;height:auto;font-family:${FONT}">
<title>${escapeXml(title)}</title>
${description ? `<desc>${escapeXml(description)}</desc>` : ''}
<rect width="${width}" height="${height}" rx="18" fill="#ffffff"/>
`;
}

function titleBlock(title, subtitle, width = WIDTH, legend = '') {
  return `<text x="30" y="36" font-size="19" font-weight="650" fill="${INK}">${escapeXml(title)}</text>
<text x="30" y="59" font-size="12.5" fill="${MUTED}">${escapeXml(subtitle)}</text>
${legend ? `<g transform="translate(${width - 30},30)">${legend}</g>` : ''}`;
}

function legendItem(x, y, label, sample) {
  return `<g transform="translate(${x},${y})">${sample}<text x="26" y="4" text-anchor="start" font-size="11" fill="${MUTED}">${escapeXml(
    label,
  )}</text></g>`;
}

/**
 * 箱线图：箱体 Q1–Q3，中线中位数，菱形均值，须线最小/最大值。
 */
export function buildBoxplotChart(groupSummary, { title } = {}) {
  const allGroups = Array.isArray(groupSummary?.groups) ? groupSummary.groups : [];
  const groups = [...allGroups]
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)
    .sort((a, b) => allGroups.indexOf(a) - allGroups.indexOf(b));
  if (groups.length === 0) {
    return null;
  }
  const metricLabel = groupSummary.metric?.label ?? '数值指标';
  const metricUnit = groupSummary.metric?.unit ?? '';
  const groupLabel = groupSummary.groupBy?.label ?? '分组';
  const allValues = groups.flatMap((group) =>
    [group.min, group.q1, group.median, group.q3, group.max].filter((value) => Number.isFinite(value)),
  );
  const axis = axisInfo(Math.min(...allValues), Math.max(...allValues), 5);
  const chartTitle = title || `${metricLabel}在「${groupLabel}」各组间的分布`;
  const subtitle = `样本量 n=${groupSummary.totals?.n ?? '—'} · 箱体为四分位距（IQR），菱形为均值，须线为最小值/最大值`;
  const legend = [
    legendItem(-190, 8, '中位数', `<line x1="0" x2="20" y1="4" y2="4" stroke="#243448" stroke-width="2.2"/>`),
    legendItem(-112, 8, '均值', `<rect x="6" y="-2" width="9" height="9" transform="rotate(45 10.5 2.5)" fill="${INK}"/>`),
    legendItem(-42, 8, '范围', `<line x1="0" x2="20" y1="4" y2="4" stroke="#7f91a8" stroke-width="1.2" stroke-dasharray="3 3"/>`),
  ].join('');
  const left = 72;
  const right = 32;
  const top = 94;
  const bottom = 126;
  const plotWidth = WIDTH - left - right;
  const plotHeight = 430 - top - bottom;
  const y = (value) => top + ((axis.max - value) / (axis.max - axis.min || 1)) * plotHeight;
  const slot = plotWidth / groups.length;
  const boxWidth = Math.min(56, slot * 0.42);
  const parts = [
    svgOpen({
      title: chartTitle,
      height: 430,
      description: `${chartTitle}。${subtitle}`,
    }),
    titleBlock(chartTitle, subtitle, WIDTH, legend),
  ];

  for (const tick of axis.ticks) {
    const yy = y(tick);
    parts.push(
      `<line x1="${left}" x2="${WIDTH - right}" y1="${yy.toFixed(2)}" y2="${yy.toFixed(
        2,
      )}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${left - 12}" y="${(yy + 4).toFixed(2)}" text-anchor="end" font-size="11.5" fill="${MUTED}">${escapeXml(
        formatNumber(tick, 2),
      )}</text>`,
    );
  }
  parts.push(
    `<line x1="${left}" x2="${left}" y1="${top}" y2="${top + plotHeight}" stroke="#cfd9e5"/>`,
    `<line x1="${left}" x2="${WIDTH - right}" y1="${top + plotHeight}" y2="${
      top + plotHeight
    }" stroke="#cfd9e5"/>`,
    `<text x="18" y="${top + plotHeight / 2}" transform="rotate(-90 18 ${
      top + plotHeight / 2
    })" text-anchor="middle" font-size="12" fill="${MUTED}">${safeText(
      metricUnit ? `${metricLabel}（${metricUnit}）` : metricLabel,
      32,
    )}</text>`,
  );

  groups.forEach((group, index) => {
    const center = left + slot * (index + 0.5);
    const color = PALETTE[index % PALETTE.length];
    const q1 = group.q1;
    const q3 = group.q3;
    const median = group.median;
    const min = group.min;
    const max = group.max;
    const mean = group.mean;
    if ([q1, q3, median, min, max].every((value) => Number.isFinite(value))) {
      const yq1 = y(q1);
      const yq3 = y(q3);
      const boxTop = Math.min(yq1, yq3);
      const boxHeight = Math.max(2, Math.abs(yq1 - yq3));
      parts.push(
        `<line x1="${center}" y1="${y(max)}" x2="${center}" y2="${y(q3)}" stroke="${color}" stroke-width="1.6"/>`,
        `<line x1="${center}" y1="${y(q1)}" x2="${center}" y2="${y(min)}" stroke="${color}" stroke-width="1.6"/>`,
        `<line x1="${center - boxWidth * 0.28}" y1="${y(max)}" x2="${
          center + boxWidth * 0.28
        }" y2="${y(max)}" stroke="${color}" stroke-width="1.6"/>`,
        `<line x1="${center - boxWidth * 0.28}" y1="${y(min)}" x2="${
          center + boxWidth * 0.28
        }" y2="${y(min)}" stroke="${color}" stroke-width="1.6"/>`,
        `<rect x="${(center - boxWidth / 2).toFixed(2)}" y="${boxTop.toFixed(2)}" width="${boxWidth.toFixed(
          2,
        )}" height="${boxHeight.toFixed(2)}" rx="4" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="1.7"/>`,
        `<line x1="${center - boxWidth / 2}" x2="${center + boxWidth / 2}" y1="${y(
          median,
        )}" y2="${y(median)}" stroke="#243448" stroke-width="2.4"/>`,
      );
      if (Number.isFinite(mean)) {
        parts.push(
          `<path d="M ${center} ${y(mean) - 5} L ${center + 5} ${y(mean)} L ${center} ${
            y(mean) + 5
          } L ${center - 5} ${y(mean)} Z" fill="${INK}" stroke="#fff" stroke-width="1"/>`,
        );
      }
    }
    parts.push(
      `<text x="${center}" y="${top + plotHeight + 28}" text-anchor="middle" font-size="12.5" font-weight="600" fill="${INK}">${safeText(
        group.value,
        18,
      )}</text>`,
      `<text x="${center}" y="${top + plotHeight + 48}" text-anchor="middle" font-size="11" fill="${MUTED}">n=${group.n}</text>`,
    );
  });

  if (groups.length < allGroups.length) {
    parts.push(
      `<text x="${WIDTH - right}" y="${430 - 18}" text-anchor="end" font-size="11" fill="${MUTED}">图中显示前 ${groups.length} 组，共 ${allGroups.length} 组；完整统计见下表。</text>`,
    );
  } else {
    parts.push(
      `<text x="${left}" y="${430 - 18}" font-size="11" fill="${MUTED}">每组的点估计与样本量来自 group_summary 的真实输出。</text>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

function mixHex(a, b, t) {
  const parse = (hex) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const clamped = Math.max(0, Math.min(1, t));
  const channel = (x, y) => Math.round(x + (y - x) * clamped).toString(16).padStart(2, '0');
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

function correlationColor(r) {
  const neutral = '#f2f6fb';
  if (!Number.isFinite(r)) return '#edf1f6';
  if (r >= 0) return mixHex(neutral, '#245fdd', r);
  return mixHex(neutral, '#d97757', -r);
}

/**
 * Pearson 相关矩阵热图。
 */
export function buildCorrelationHeatmap(correlation, { title } = {}) {
  const fields = correlation?.fields ?? [];
  if (fields.length < 2) return null;
  const n = fields.length;
  const width = Math.max(660, Math.min(980, 210 + n * 110));
  const left = 176;
  const top = 146;
  const cell = Math.min(108, (width - left - 28) / n);
  const height = top + n * cell + 98;
  const chartTitle = title || '数值字段之间的 Pearson 相关矩阵';
  const map = new Map(
    (correlation.pairs ?? []).map((pair) => [`${pair.fieldA}|${pair.fieldB}`, pair]),
  );
  function pairFor(a, b) {
    return map.get(`${a}|${b}`) ?? map.get(`${b}|${a}`) ?? null;
  }
  const parts = [
    svgOpen({
      width,
      height,
      title: chartTitle,
      description: '矩阵单元格为 Pearson 相关系数，颜色从负相关到正相关。',
    }),
    titleBlock(
      chartTitle,
      `Pearson r · 颜色由负相关（橙）到正相关（蓝）· * 表示未校正 p < 0.05`,
      width,
    ),
  ];

  fields.forEach((field, index) => {
    const cx = left + cell * (index + 0.5);
    parts.push(
      `<text x="${(cx - 8).toFixed(1)}" y="${top - 16}" text-anchor="end" font-size="11.5" fill="${MUTED}" transform="rotate(-32 ${(
        cx - 8
      ).toFixed(1)} ${top - 16})">${safeText(field.label, 15)}</text>`,
      `<text x="${left - 14}" y="${(top + cell * (index + 0.5) + 4).toFixed(
        1,
      )}" text-anchor="end" font-size="12" font-weight="600" fill="${INK}">${safeText(
        field.label,
        14,
      )}</text>`,
    );
  });

  fields.forEach((rowField, rowIndex) => {
    fields.forEach((colField, colIndex) => {
      const pair = pairFor(rowField.name, colField.name);
      const isDiagonal = rowIndex === colIndex;
      const r = isDiagonal ? 1 : pair?.pearson?.r;
      const fill = isDiagonal ? '#e8effa' : correlationColor(r);
      const textColor = isDiagonal ? '#245fdd' : Math.abs(r ?? 0) > 0.55 ? '#ffffff' : INK;
      const stars = !isDiagonal && pair?.pearson?.p != null ? pStars(pair.pearson.p) : '';
      const x = left + cell * colIndex;
      const y = top + cell * rowIndex;
      parts.push(
        `<g><rect x="${x + 2}" y="${y + 2}" width="${cell - 4}" height="${cell - 4}" rx="10" fill="${fill}" stroke="#ffffff" stroke-width="2"/>`,
        `<text x="${(x + cell / 2).toFixed(1)}" y="${(y + cell / 2 + 5).toFixed(
          1,
        )}" text-anchor="middle" font-size="${Math.min(18, cell * 0.23)}" font-weight="650" fill="${textColor}">${
          Number.isFinite(r) ? formatNumber(r, 2) : '—'
        }</text>`,
        stars
          ? `<text x="${(x + cell / 2).toFixed(1)}" y="${(y + cell / 2 + 23).toFixed(
              1,
            )}" text-anchor="middle" font-size="10" fill="${textColor}" opacity="0.9">${escapeXml(stars)}</text>`
          : '',
        `</g>`,
      );
    });
  });

  const legendY = top + n * cell + 28;
  const legendX = left;
  const legendWidth = width - left - 40;
  parts.push(
    `<defs><linearGradient id="corr-gradient" x1="0" x2="1"><stop offset="0%" stop-color="#d97757"/><stop offset="50%" stop-color="#f2f6fb"/><stop offset="100%" stop-color="#245fdd"/></linearGradient></defs>`,
    `<rect x="${legendX}" y="${legendY}" width="${legendWidth}" height="8" rx="4" fill="url(#corr-gradient)"/>`,
    `<text x="${legendX}" y="${legendY + 24}" font-size="10.5" fill="${MUTED}">−1 负相关</text>`,
    `<text x="${legendX + legendWidth / 2}" y="${legendY + 24}" text-anchor="middle" font-size="10.5" fill="${MUTED}">0</text>`,
    `<text x="${legendX + legendWidth}" y="${legendY + 24}" text-anchor="end" font-size="10.5" fill="${MUTED}">+1 正相关</text>`,
    `<text x="${left}" y="${height - 20}" font-size="11" fill="${MUTED}">显著性星号为未校正结果；相关矩阵未进行多重比较校正。</text>`,
    '</svg>',
  );
  return parts.join('');
}

/**
 * 最强相关字段对的真实散点图（仅展示，不添加回归线）。
 */
export function buildScatterChart(dataset, pair, { title } = {}) {
  if (!pair) return null;
  const fieldA = dataset.columns.find((column) => column.name === pair.fieldA);
  const fieldB = dataset.columns.find((column) => column.name === pair.fieldB);
  if (!fieldA || !fieldB) return null;
  const allPoints = [];
  for (const row of dataset.rows) {
    const x = toNumeric(row[fieldA.index]);
    const y = toNumeric(row[fieldB.index]);
    if (x !== null && y !== null) allPoints.push({ x, y });
  }
  if (allPoints.length < 3) return null;
  const stride = Math.max(1, Math.ceil(allPoints.length / 700));
  const points = allPoints.filter((_, index) => index % stride === 0);
  const xAxis = axisInfo(
    Math.min(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.x)),
    5,
  );
  const yAxis = axisInfo(
    Math.min(...points.map((point) => point.y)),
    Math.max(...points.map((point) => point.y)),
    5,
  );
  const width = WIDTH;
  const height = 460;
  const left = 78;
  const right = 32;
  const top = 104;
  const bottom = 94;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const chartTitle =
    title || `${fieldA.label} 与 ${fieldB.label} 的散点分布（Pearson r=${formatNumber(pair.pearson.r, 3)}）`;
  const subtitle = `n=${pair.n} · 每个点是一行真实观测${
    stride > 1 ? `（为保持可读性，按行序均匀显示 ${points.length}/${allPoints.length} 个点）` : ''
  }`;
  const x = (value) => left + ((value - xAxis.min) / (xAxis.max - xAxis.min || 1)) * plotW;
  const y = (value) => top + ((yAxis.max - value) / (yAxis.max - yAxis.min || 1)) * plotH;
  const parts = [
    svgOpen({
      width,
      height,
      title: chartTitle,
      description: `${fieldA.label} 与 ${fieldB.label} 的散点图，共 ${pair.n} 个成对有效样本。`,
    }),
    titleBlock(chartTitle, subtitle, width),
  ];
  for (const tick of yAxis.ticks) {
    parts.push(
      `<line x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}" stroke="${GRID}"/>`,
      `<text x="${left - 10}" y="${y(tick) + 4}" text-anchor="end" font-size="11" fill="${MUTED}">${escapeXml(
        formatNumber(tick, 2),
      )}</text>`,
    );
  }
  for (const tick of xAxis.ticks) {
    parts.push(
      `<text x="${x(tick)}" y="${top + plotH + 22}" text-anchor="middle" font-size="11" fill="${MUTED}">${escapeXml(
        formatNumber(tick, 2),
      )}</text>`,
    );
  }
  parts.push(
    `<line x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}" stroke="#cfd9e5"/>`,
    `<line x1="${left}" x2="${left}" y1="${top}" y2="${top + plotH}" stroke="#cfd9e5"/>`,
    `<text x="${left + plotW / 2}" y="${height - 32}" text-anchor="middle" font-size="12" fill="${MUTED}">${safeText(
      fieldA.unit ? `${fieldA.label}（${fieldA.unit}）` : fieldA.label,
      32,
    )}</text>`,
    `<text x="20" y="${top + plotH / 2}" text-anchor="middle" font-size="12" fill="${MUTED}" transform="rotate(-90 20 ${
      top + plotH / 2
    })">${safeText(fieldB.unit ? `${fieldB.label}（${fieldB.unit}）` : fieldB.label, 32)}</text>`,
  );
  for (const point of points) {
    parts.push(
      `<circle cx="${x(point.x).toFixed(2)}" cy="${y(point.y).toFixed(
        2,
      )}" r="4.1" fill="#2f6fed" fill-opacity="0.46" stroke="#ffffff" stroke-width="0.8"/>`,
    );
  }
  parts.push(
    `<g transform="translate(${width - right - 165},${top + 8})">
      <rect x="0" y="0" width="165" height="30" rx="8" fill="#f7f9fd" stroke="#e7edf5"/>
      <text x="12" y="19" font-size="10.5" fill="${MUTED}">Pearson r = </text>
      <text x="82" y="19" font-size="11.5" font-weight="650" fill="${INK}">${formatNumber(pair.pearson.r, 3)}</text>
      <text x="130" y="19" font-size="10.5" fill="${MUTED}">${escapeXml(formatPShort(pair.pearson.p))}</text>
    </g>`,
    `<text x="${left}" y="${height - 12}" font-size="11" fill="${MUTED}">散点来自数据行本身；未绘制回归线，相关结论以 correlation_analysis 输出为准。</text>`,
    '</svg>',
  );
  return parts.join('');
}

export function buildCharts({ dataset, groupSummary, correlation, intent }) {
  const charts = [];
  if (groupSummary) {
    const svg = buildBoxplotChart(groupSummary, {
      title: `${groupSummary.metric?.label ?? '指标'}在「${
        groupSummary.groupBy?.label ?? '分组'
      }」各组间的分布`,
    });
    if (svg) {
      charts.push({
        kind: 'boxplot',
        title: `${groupSummary.metric?.label ?? '指标'}在「${
          groupSummary.groupBy?.label ?? '分组'
        }」各组间的分布`,
        caption:
          '箱体表示四分位距（Q1–Q3），中线为中位数，菱形为均值，须线延伸到最小值与最大值。',
        evidenceTools: ['group_summary'],
        svg,
      });
    }
  }
  if (correlation) {
    if (correlation.fields?.length >= 3) {
      const svg = buildCorrelationHeatmap(correlation, {
        title: '数值字段之间的 Pearson 相关矩阵',
      });
      if (svg) {
        charts.push({
          kind: 'correlation-heatmap',
          title: '数值字段之间的 Pearson 相关矩阵',
          caption:
            '单元格为 Pearson r；显著性星号为未校正 p 值，相关矩阵未做多重比较校正。',
          evidenceTools: ['correlation_analysis'],
          svg,
        });
      }
    }
    if (correlation.strongest) {
      const svg = buildScatterChart(dataset, correlation.strongest, {
        title: `${correlation.strongest.labelA} 与 ${correlation.strongest.labelB} 的散点分布`,
      });
      if (svg) {
        charts.push({
          kind: 'scatter',
          title: `${correlation.strongest.labelA} 与 ${correlation.strongest.labelB} 的散点分布`,
          caption:
            '每个点是一行真实观测。图中未绘制回归线；相关系数与 p 值来自 correlation_analysis。',
          evidenceTools: ['correlation_analysis'],
          svg,
        });
      }
    }
  }
  return charts;
}
