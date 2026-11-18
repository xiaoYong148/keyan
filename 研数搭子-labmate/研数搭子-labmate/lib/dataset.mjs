import { summarize } from './stats.mjs';

/**
 * 数据概况与类型推断。
 *
 * 这里只做“可解释的轻量类型识别”：
 * - 全部非空值都能被严格解析为数字 → number；
 * - 低基数文本 → category；
 * - 高基数文本 → text；
 * - 明确 ISO 日期 → date（仅供展示，当前推断工具不使用）。
 * 不做自动单位推断，避免伪造科研语义。
 */

export const MISSING_TOKENS = new Set([
  '',
  'na',
  'n/a',
  'null',
  'nan',
  'none',
  'missing',
  '缺失',
  '无数据',
]);

const NUMERIC_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;

export function isMissingValue(value) {
  return value === null || value === undefined || MISSING_TOKENS.has(String(value).trim().toLowerCase());
}

export function toNumeric(value) {
  if (isMissingValue(value)) return null;
  const text = String(value).trim();
  if (!NUMERIC_PATTERN.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function columnByRef(dataset, ref) {
  if (typeof ref !== 'string') return null;
  return (
    dataset.columns.find((column) => column.name === ref) ??
    dataset.columns.find((column) => column.label === ref) ??
    null
  );
}

export function inferColumnType(values) {
  const nonMissing = values.filter((value) => !isMissingValue(value));
  const unique = new Set(nonMissing.map((value) => String(value)));
  const numericValues = nonMissing.map(toNumeric);
  const numeric = nonMissing.length > 0 && numericValues.every((value) => value !== null);
  const integer = numeric && numericValues.every((value) => Number.isInteger(value));
  const dateLike =
    !numeric &&
    nonMissing.length > 0 &&
    unique.size >= 2 &&
    nonMissing.filter((value) => ISO_DATE_PATTERN.test(String(value))).length /
      nonMissing.length >=
      0.8;

  let type;
  if (numeric) type = 'number';
  else if (dateLike) type = 'date';
  else if (
    unique.size >= 2 &&
    unique.size <= 30 &&
    unique.size <= Math.max(2, nonMissing.length * 0.5)
  ) {
    type = 'category';
  } else {
    type = 'text';
  }

  return {
    type,
    integer,
    nonMissing: nonMissing.length,
    numericValues: numeric ? numericValues.filter((value) => value !== null) : [],
    unique,
  };
}

function topValues(values, limit = 30) {
  const counts = new Map();
  for (const value of values) {
    if (isMissingValue(value)) continue;
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function numericSummary(numbers) {
  if (numbers.length === 0) return null;
  try {
    return summarize(numbers);
  } catch {
    return null;
  }
}

function publicColumn(column) {
  const base = {
    name: column.name,
    label: column.label,
    type: column.type,
    typeLabel: column.typeLabel,
    integer: column.integer,
    missing: column.missing,
    missingRate: column.missingRate,
    unique: column.unique,
    nonMissing: column.nonMissing,
    groupable: column.groupable,
    numeric: column.type === 'number',
  };
  if (column.summary) base.summary = column.summary;
  if (column.topValues) base.topValues = column.topValues.slice(0, 8);
  if (column.unit) base.unit = column.unit;
  if (column.description) base.description = column.description;
  return base;
}

const TYPE_LABELS = {
  number: '数值',
  category: '分类',
  text: '文本',
  date: '日期',
};

export function buildColumns({ headers, rows, fieldMeta = {} }) {
  return headers.map((name, index) => {
    const meta = fieldMeta[name] ?? {};
    const label = typeof meta.label === 'string' && meta.label.trim() ? meta.label.trim() : name;
    const values = rows.map((row) => row[index] ?? '');
    const inferred = inferColumnType(values);
    const missing = values.filter((value) => isMissingValue(value)).length;
    const missingRate = rows.length === 0 ? 0 : missing / rows.length;
    const distinct = inferred.unique.size;
    // 数值列只有在“整数编码 + 至少重复两轮”时才作为分组候选，
    // 避免把 n 行里几乎全不同的连续测量值误当成组别（例如 6 行 / 6 个不同读数）。
    const numericGroupableOk =
      inferred.type !== 'number' ||
      (inferred.integer && inferred.nonMissing >= distinct * 2);
    const column = {
      index,
      name,
      label,
      type: inferred.type,
      typeLabel: TYPE_LABELS[inferred.type],
      integer: inferred.integer,
      missing,
      missingRate,
      unique: distinct,
      nonMissing: inferred.nonMissing,
      groupable:
        inferred.nonMissing >= 2 &&
        distinct >= 2 &&
        distinct <= 12 &&
        ['category', 'number'].includes(inferred.type) &&
        numericGroupableOk,
      summary: null,
      topValues: null,
      unit: typeof meta.unit === 'string' ? meta.unit : '',
      description: typeof meta.description === 'string' ? meta.description : '',
      aliases: Array.isArray(meta.aliases) ? meta.aliases.filter((alias) => typeof alias === 'string') : [],
    };
    if (inferred.type === 'number') {
      column.summary = numericSummary(inferred.numericValues);
    }
    // 只保留真正可分组字段的取值/频数；高基数文本不把单元格值写入 profile、
    // 报告或运行记录。对外展示时再限制为前 8 个。
    column.topValues = column.groupable ? topValues(values) : null;
    return column;
  });
}

function countDuplicateRows(rows) {
  const seen = new Set();
  let duplicates = 0;
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

function qualityReport({ rows, columns, parserWarnings }) {
  const rowCount = rows.length;
  const totalCells = rowCount * columns.length;
  const missingCells = columns.reduce((total, column) => total + column.missing, 0);
  const duplicateRowCount = countDuplicateRows(rows);
  const completeRows = rows.filter((row) =>
    row.every((value) => !isMissingValue(value)),
  ).length;
  const emptyColumns = columns.filter((column) => column.nonMissing === 0);
  const constantColumns = columns.filter(
    (column) => column.nonMissing > 0 && column.unique === 1,
  );
  const highMissingColumns = columns.filter((column) => column.missingRate >= 0.3);
  const numericColumns = columns.filter((column) => column.type === 'number');
  const groupCandidates = columns.filter((column) => column.groupable);
  const warnings = [...parserWarnings];

  if (duplicateRowCount > 0) {
    warnings.push({
      code: 'W_DUPLICATE_ROWS',
      level: 'warning',
      message: `检测到 ${duplicateRowCount} 行完全重复。统计按原始记录执行，未自动去重；请在解释时说明。`,
    });
  }
  if (highMissingColumns.length > 0) {
    warnings.push({
      code: 'W_HIGH_MISSING',
      level: 'warning',
      message: `${highMissingColumns
        .map((column) => `「${column.label}」`)
        .join('、')} 的缺失率达到或超过 30%。使用这些字段的结论需要谨慎。`,
    });
  }
  if (emptyColumns.length > 0) {
    warnings.push({
      code: 'W_EMPTY_COLUMN',
      level: 'warning',
      message: `${emptyColumns
        .map((column) => `「${column.label}」`)
        .join('、')} 全为空，已保留展示但不能参与分析。`,
    });
  }
  if (constantColumns.length > 0) {
    warnings.push({
      code: 'W_CONSTANT_COLUMN',
      level: 'info',
      message: `${constantColumns
        .map((column) => `「${column.label}」`)
        .join('、')} 只有 1 个取值，无法用于分组或相关分析。`,
    });
  }
  if (numericColumns.length === 0) {
    warnings.push({
      code: 'W_NO_NUMERIC',
      level: 'warning',
      message: '没有识别到数值字段，当前版本无法执行组间比较或相关分析。',
    });
  }
  if (groupCandidates.length === 0) {
    warnings.push({
      code: 'W_NO_GROUP',
      level: 'info',
      message: '没有识别到 2–12 个取值的分组字段；组间差异分析不可用。',
    });
  }
  if (columns.length < 2) {
    warnings.push({
      code: 'W_ONE_COLUMN',
      level: 'warning',
      message: '数据只有 1 列；可以进行字段概况，但差异比较或相关分析至少需要 2 列。',
    });
  }

  const missingRate = totalCells === 0 ? 0 : missingCells / totalCells;
  return {
    rowCount,
    columnCount: columns.length,
    totalCells,
    missingCells,
    missingRate,
    completeRows,
    incompleteRows: rowCount - completeRows,
    duplicateRowCount,
    duplicateRowRate: rowCount === 0 ? 0 : duplicateRowCount / rowCount,
    emptyColumns: emptyColumns.map((column) => column.name),
    constantColumns: constantColumns.map((column) => column.name),
    highMissingColumns: highMissingColumns.map((column) => column.name),
    numericCount: numericColumns.length,
    groupCandidateCount: groupCandidates.length,
    warnings,
  };
}

/**
 * 创建内存数据集。rows 只在服务端保存；对外的 API 不返回完整行。
 */
export function createDataset({
  id,
  name,
  headers,
  rows,
  source,
  fieldMeta = {},
  parserWarnings = [],
  kind = 'upload',
  createdAt = new Date().toISOString(),
}) {
  const columns = buildColumns({ headers, rows, fieldMeta });
  const quality = qualityReport({ rows, columns, parserWarnings });
  return {
    id,
    name,
    kind,
    createdAt,
    source,
    headers,
    rows,
    columns,
    rowCount: rows.length,
    columnCount: columns.length,
    quality,
  };
}

export function publicDataset(dataset, previewLimit = 8) {
  return {
    id: dataset.id,
    name: dataset.name,
    kind: dataset.kind,
    createdAt: dataset.createdAt,
    source: dataset.source,
    rowCount: dataset.rowCount,
    columnCount: dataset.columnCount,
    columns: dataset.columns.map(publicColumn),
    quality: dataset.quality,
    preview: {
      headers: dataset.headers,
      rows: dataset.rows.slice(0, previewLimit),
      shown: Math.min(dataset.rowCount, previewLimit),
      total: dataset.rowCount,
    },
  };
}

export function schemaForPlanning(dataset) {
  return {
    rowCount: dataset.rowCount,
    columnCount: dataset.columnCount,
    fields: dataset.columns.map((column) => ({
      name: column.name,
      label: column.label,
      type: column.type,
      missingRate: Number(column.missingRate.toFixed(4)),
      unique: column.unique,
      groupable: column.groupable,
      ...(column.type === 'number' && column.unit ? { unit: column.unit } : {}),
      ...(column.groupable ? { topValues: column.topValues?.slice(0, 12) ?? [] } : {}),
    })),
    quality: {
      missingRate: Number(dataset.quality.missingRate.toFixed(4)),
      duplicateRowCount: dataset.quality.duplicateRowCount,
      warningCount: dataset.quality.warnings.length,
    },
  };
}

export function columnIndex(dataset, reference) {
  const column = columnByRef(dataset, reference);
  return column ? column.index : -1;
}

export function publicProfile(dataset) {
  return {
    dataset: {
      name: dataset.name,
      kind: dataset.kind,
      rowCount: dataset.rowCount,
      columnCount: dataset.columnCount,
      source: dataset.source,
    },
    fields: dataset.columns.map(publicColumn),
    numericFields: dataset.columns.filter((column) => column.type === 'number').map((column) => column.name),
    groupCandidates: dataset.columns
      .filter((column) => column.groupable)
      .map((column) => ({
        name: column.name,
        label: column.label,
        unique: column.unique,
        values: column.topValues?.slice(0, 12) ?? [],
      })),
    quality: dataset.quality,
  };
}

export function publicMissingness(dataset) {
  const columns = dataset.columns.map((column) => ({
    name: column.name,
    label: column.label,
    missing: column.missing,
    missingRate: column.missingRate,
    nonMissing: column.nonMissing,
    status:
      column.nonMissing === 0
        ? 'empty'
        : column.missingRate >= 0.3
          ? 'high'
          : column.missingRate > 0
            ? 'partial'
            : 'complete',
  }));
  return {
    rowCount: dataset.rowCount,
    completeRows: dataset.quality.completeRows,
    incompleteRows: dataset.quality.incompleteRows,
    missingCells: dataset.quality.missingCells,
    missingRate: dataset.quality.missingRate,
    duplicateRowCount: dataset.quality.duplicateRowCount,
    duplicateRowRate: dataset.quality.duplicateRowRate,
    columns,
    zeroVarianceColumns: dataset.columns
      .filter((column) => column.nonMissing > 0 && column.unique === 1)
      .map((column) => column.name),
    notes: dataset.quality.warnings.map((warning) => warning.message),
  };
}

export function numericValues(dataset, column) {
  return dataset.rows
    .map((row) => toNumeric(row[column.index]))
    .filter((value) => value !== null);
}

export function groupSeries(dataset, groupColumn, metricColumn) {
  /** @type {{group: string, value: number}[]} */
  const pairs = [];
  let excluded = 0;
  for (const row of dataset.rows) {
    const rawGroup = row[groupColumn.index];
    const value = toNumeric(row[metricColumn.index]);
    if (isMissingValue(rawGroup) || value === null) {
      excluded += 1;
      continue;
    }
    pairs.push({ group: String(rawGroup), value });
  }
  return { pairs, excluded };
}

export function allNumericFieldNames(dataset) {
  return dataset.columns.filter((column) => column.type === 'number').map((column) => column.name);
}
