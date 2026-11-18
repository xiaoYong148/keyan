import test from 'node:test';
import assert from 'node:assert/strict';
import { CsvError, parseCsv } from '../lib/csv.mjs';

test('CSV：解析引号、逗号、换行、CRLF 与 BOM', () => {
  const text =
    '\uFEFFid,name,note,value\r\n' +
    '1,"Alice, A.","He said ""hello""",3.5\r\n' +
    '2,Bob,"line one\nline two",NA\r\n';
  const parsed = parseCsv(text);
  assert.deepEqual(parsed.headers, ['id', 'name', 'note', 'value']);
  assert.equal(parsed.rowCount, 2);
  assert.equal(parsed.rows[0][2], 'He said "hello"');
  assert.equal(parsed.rows[1][2], 'line one\nline two');
  assert.equal(parsed.rows[1][3], 'NA');
});

test('CSV：跳过空白行并提示全空列与非法短行', () => {
  const parsed = parseCsv('a,b,c\n1,2,3\n\n4,5\n,,\n');
  assert.equal(parsed.rowCount, 2);
  assert.equal(parsed.rows[1].length, 3);
  assert.ok(parsed.warnings.some((warning) => warning.code === 'W_SHORT_ROWS'));
  assert.ok(parsed.warnings.some((warning) => warning.code === 'W_BLANK_ROWS'));
});

test('CSV：空文件、仅表头与全空表头给出可理解错误', () => {
  assert.throws(() => parseCsv(''), (error) => error instanceof CsvError && error.code === 'E_EMPTY');
  assert.throws(
    () => parseCsv('a,b\n'),
    (error) => error instanceof CsvError && error.code === 'E_HEADER_ONLY',
  );
  assert.throws(
    () => parseCsv('a,\n1,2\n'),
    (error) => error instanceof CsvError && error.code === 'E_EMPTY_HEADER',
  );
});

test('CSV：重复列名、控制字符、过宽行与未闭合引号被拒绝', () => {
  assert.throws(
    () => parseCsv('a,A\n1,2\n'),
    (error) => error.code === 'E_DUPLICATE_HEADER',
  );
  assert.throws(
    () => parseCsv('a\u0001,b\n1,2\n'),
    (error) => error.code === 'E_INVALID_HEADER',
  );
  assert.throws(
    () => parseCsv('a,b\n1,2,3\n'),
    (error) => error.code === 'E_ROW_WIDTH',
  );
  assert.throws(
    () => parseCsv('a,b\n1,"oops\n2,3\n'),
    (error) => error.code === 'E_UNCLOSED_QUOTE',
  );
});

test('CSV：行数上限与全空数据', () => {
  assert.throws(
    () => parseCsv('a,b\n1,2\n3,4\n5,6\n', { maxRows: 2 }),
    (error) => error.code === 'E_TOO_MANY_ROWS',
  );
  assert.throws(
    () => parseCsv('a,b\n,,\n'),
    (error) => error.code === 'E_NO_ROWS' || error.code === 'E_HEADER_ONLY',
  );
});
