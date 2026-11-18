/**
 * 受控 CSV 解析器。
 *
 * 设计目标：
 * - 只接受 RFC 4180 风格的逗号分隔文本；
 * - 给出可理解、带行号的中文错误；
 * - 不执行任何单元格内容，不推断额外格式；
 * - 对常见的 Excel / 中文数据导出保持宽容，但把宽容之处记录为 warning。
 */

export const CSV_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxRows: 20_000,
  maxColumns: 80,
  maxHeaderLength: 80,
});

export class CsvError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CsvError';
    this.code = code;
    this.details = details;
  }
}

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function decodeBuffer(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new CsvError(
      'E_ENCODING',
      '文件不是有效的 UTF-8 文本。请用 Excel 或 Numbers 以「CSV UTF-8」格式重新导出。',
    );
  }
}

/**
 * @param {string} text
 * @param {{maxRows?: number, maxColumns?: number}} [options]
 */
export function parseCsv(text, options = {}) {
  if (typeof text !== 'string') {
    throw new CsvError('E_INPUT', '没有收到可解析的 CSV 文本。');
  }
  const maxRows = options.maxRows ?? CSV_LIMITS.maxRows;
  const maxColumns = options.maxColumns ?? CSV_LIMITS.maxColumns;
  let source = text.replace(/^\uFEFF/, '');

  if (!source.trim()) {
    throw new CsvError('E_EMPTY', 'CSV 文件是空的，请检查是否选择了正确文件。');
  }

  /** @type {string[][]} */
  const rawRows = [];
  const warnings = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let quoteClosed = false;
  let line = 1;
  let rowStartLine = 1;
  let blankRowsSkipped = 0;

  const finishRow = () => {
    row.push(field);
    const isBlank = row.every((cell) => cell.trim() === '');
    if (!isBlank) {
      rawRows.push(row);
      if (rawRows.length > maxRows + 1) {
        throw new CsvError(
          'E_TOO_MANY_ROWS',
          `数据超过 ${maxRows.toLocaleString('zh-CN')} 行。当前版本为演示版，请先抽样或拆分数据。`,
          { maxRows },
        );
      }
    } else {
      blankRowsSkipped += 1;
    }
    row = [];
    field = '';
    quoteClosed = false;
    rowStartLine = line;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        field += ch;
        if (ch === '\n') line += 1;
      }
      continue;
    }

    if (ch === '"') {
      if (field.trim() !== '') {
        throw new CsvError(
          'E_QUOTE_POSITION',
          `第 ${line} 行的引号位置不合法。带逗号的单元格需要整体用英文双引号包裹。`,
          { line },
        );
      }
      inQuotes = true;
      field = '';
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      quoteClosed = false;
      if (row.length > maxColumns) {
        throw new CsvError(
          'E_TOO_MANY_COLUMNS',
          `数据超过 ${maxColumns} 列。当前版本最多支持 ${maxColumns} 列。`,
          { maxColumns },
        );
      }
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      finishRow();
      line += 1;
      rowStartLine = line;
      continue;
    }

    if (quoteClosed && !/\s/.test(ch)) {
      throw new CsvError(
        'E_QUOTE_TRAILING',
        `第 ${line} 行的引号后出现了额外字符，请检查 CSV 格式。`,
        { line },
      );
    }

    field += ch;
  }

  if (inQuotes) {
    throw new CsvError(
      'E_UNCLOSED_QUOTE',
      `从第 ${rowStartLine} 行开始的引号没有闭合。请检查字段中的英文双引号。`,
      { line: rowStartLine },
    );
  }
  if (row.length > 0 || field !== '') {
    finishRow();
  }

  if (rawRows.length === 0) {
    throw new CsvError('E_NO_ROWS', '文件里没有数据行，只有空行或表头。');
  }

  if (rawRows.length === 1) {
    throw new CsvError(
      'E_HEADER_ONLY',
      '文件只有表头，没有可分析的数据行。请确认数据是否导出完整。',
    );
  }

  if (blankRowsSkipped > 0) {
    warnings.push({
      code: 'W_BLANK_ROWS',
      message: `已跳过 ${blankRowsSkipped} 个空白行。`,
    });
  }

  const rawHeader = rawRows[0];
  if (rawHeader.length > maxColumns) {
    throw new CsvError(
      'E_TOO_MANY_COLUMNS',
      `数据超过 ${maxColumns} 列。当前版本最多支持 ${maxColumns} 列。`,
      { maxColumns },
    );
  }

  let trimmedHeaders = 0;
  const seen = new Map();
  const headers = rawHeader.map((value, index) => {
    const original = value;
    let name = value.trim().normalize('NFC');
    if (name !== original) trimmedHeaders += 1;
    if (!name) {
      throw new CsvError(
        'E_EMPTY_HEADER',
        `第 ${index + 1} 列的列名为空。请为每一列填写唯一、可识别的列名。`,
        { columnIndex: index + 1 },
      );
    }
    if (CONTROL_CHAR.test(name)) {
      throw new CsvError(
        'E_INVALID_HEADER',
        `列名「${name.replace(CONTROL_CHAR, '�')}」包含不可见控制字符，请清理后重试。`,
        { columnIndex: index + 1 },
      );
    }
    if (name.length > CSV_LIMITS.maxHeaderLength) {
      throw new CsvError(
        'E_HEADER_TOO_LONG',
        `列名「${name.slice(0, 24)}…」超过 ${CSV_LIMITS.maxHeaderLength} 个字符，请缩短后重试。`,
        { columnIndex: index + 1 },
      );
    }
    const key = name.toLocaleLowerCase('zh-CN');
    if (seen.has(key)) {
      throw new CsvError(
        'E_DUPLICATE_HEADER',
        `列名「${name}」重复（第 ${seen.get(key) + 1} 列和第 ${index + 1} 列）。请给每列设置唯一列名。`,
        { columnIndex: index + 1, duplicateOf: seen.get(key) + 1 },
      );
    }
    seen.set(key, index);
    return name;
  });

  if (trimmedHeaders > 0) {
    warnings.push({
      code: 'W_HEADER_TRIMMED',
      message: `已清理 ${trimmedHeaders} 个列名首尾的空格。`,
    });
  }

  const columnCount = headers.length;
  let shortRows = 0;
  let skippedEmptyDataRows = 0;
  /** @type {string[][]} */
  const rows = [];

  for (let r = 1; r < rawRows.length; r += 1) {
    const cells = rawRows[r];
    if (cells.length > columnCount) {
      throw new CsvError(
        'E_ROW_WIDTH',
        `第 ${r + 1} 条数据有 ${cells.length} 个字段，但表头只有 ${columnCount} 列。请检查是否有多余逗号或未转义的逗号。`,
        { rowNumber: r + 1, expected: columnCount, actual: cells.length },
      );
    }
    if (cells.every((cell) => cell.trim() === '')) {
      skippedEmptyDataRows += 1;
      continue;
    }
    if (cells.length < columnCount) {
      shortRows += 1;
      while (cells.length < columnCount) cells.push('');
    }
    rows.push(cells.map((cell) => cell.trim().normalize('NFC')));
  }

  if (shortRows > 0) {
    warnings.push({
      code: 'W_SHORT_ROWS',
      message: `${shortRows} 行数据的字段数少于表头，缺少的字段已按空值处理。建议检查原始导出。`,
    });
  }
  if (skippedEmptyDataRows > 0) {
    warnings.push({
      code: 'W_EMPTY_DATA_ROWS',
      message: `已跳过 ${skippedEmptyDataRows} 个全空数据行。`,
    });
  }
  if (rows.length === 0) {
    throw new CsvError('E_NO_ROWS', '表头之后没有非空数据行。');
  }

  const allEmptyColumns = headers
    .map((name, index) => ({ name, empty: rows.every((row) => row[index] === '') }))
    .filter((column) => column.empty);
  if (allEmptyColumns.length === headers.length) {
    throw new CsvError('E_ALL_EMPTY', '每一列都是空的，没有可分析的数据。');
  }
  if (allEmptyColumns.length > 0) {
    warnings.push({
      code: 'W_EMPTY_COLUMNS',
      message: `发现 ${allEmptyColumns.length} 个全空列（${allEmptyColumns
        .map((column) => `「${column.name}」`)
        .join('、')}）。这些字段会保留展示，但不能用于分析。`,
    });
  }

  return { headers, rows, warnings, rowCount: rows.length, columnCount };
}

export function parseCsvBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new CsvError('E_INPUT', 'CSV 读取失败：不是可识别的文件内容。');
  }
  if (buffer.byteLength > (options.maxBytes ?? CSV_LIMITS.maxBytes)) {
    throw new CsvError(
      'E_TOO_LARGE',
      `文件超过 ${Math.round(CSV_LIMITS.maxBytes / 1024 / 1024)} MB。当前版本限制单文件大小，请先抽样。`,
    );
  }
  return parseCsv(decodeBuffer(buffer), options);
}

/**
 * 给前端使用的小型预览，刻意不返回完整数据。
 */
export function previewOf(rows, limit = 8) {
  return {
    headers: [],
    rows: rows.slice(0, limit),
    shown: Math.min(rows.length, limit),
    total: rows.length,
  };
}
