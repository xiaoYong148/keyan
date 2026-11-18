export function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatNumber(value, digits = 3) {
  if (!finiteNumber(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1_000_000 || abs < 0.0001)) {
    return value.toExponential(2);
  }
  const rounded = Number(value.toFixed(digits));
  return rounded.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function formatSigned(value, digits = 3) {
  if (!finiteNumber(value)) return '—';
  const formatted = formatNumber(Math.abs(value), digits);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

export function formatP(value, { digits = 3, asThreshold = true } = {}) {
  if (!finiteNumber(value)) return '—';
  if (asThreshold && value < 0.001) return 'p < 0.001';
  if (value >= 0.9995) return 'p = 1.000';
  return `p = ${value.toFixed(digits)}`;
}

export function formatPercent(rate, digits = 1) {
  if (!finiteNumber(rate)) return '—';
  return `${(rate * 100).toFixed(digits)}%`;
}

export function formatPShort(value) {
  if (!finiteNumber(value)) return '—';
  if (value < 0.001) return '< 0.001';
  return value.toFixed(3);
}

export function formatCI(interval, digits = 3, unit = '') {
  if (!Array.isArray(interval) || interval.length !== 2) return '—';
  const [low, high] = interval;
  if (!finiteNumber(low) || !finiteNumber(high)) return '—';
  return `[${formatNumber(low, digits)}, ${formatNumber(high, digits)}]${unit ? ` ${unit}` : ''}`;
}

export function formatDate(iso, timeZone = 'Asia/Shanghai') {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatDuration(ms) {
  if (!finiteNumber(ms)) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function truncateText(text, maxLength = 24) {
  if (typeof text !== 'string') return '';
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength).join('')}…`;
}

export function pStars(p) {
  if (!finiteNumber(p)) return '';
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return 'n.s.';
}

export function summarizeDirection(diff, metricLabel = '指标') {
  if (!finiteNumber(diff) || diff === 0) return `${metricLabel}两组均值相同`;
  return diff > 0 ? `${metricLabel}在前一组更高` : `${metricLabel}在前一组更低`;
}
