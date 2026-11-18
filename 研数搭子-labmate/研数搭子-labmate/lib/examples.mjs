import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createDataset } from './dataset.mjs';
import { parseCsv } from './csv.mjs';

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

export const IRIS_META = Object.freeze({
  id: 'iris-fisher-1936',
  title: 'Iris 鸢尾花数据集',
  shortTitle: 'Iris 鸢尾花',
  description:
    'Fisher (1936) 发表的经典形态测量数据，包含 3 个鸢尾花品种、各 50 个样本，以及花萼和花瓣的长宽测量值。',
  fileName: 'iris.csv',
  rowLabel: '150 行 · 5 字段 · 3 个品种',
  tags: ['UCI', 'CC BY 4.0', '经典公开数据'],
  source: {
    type: 'sample',
    title: 'Iris 鸢尾花数据集',
    provider: 'UCI Machine Learning Repository',
    url: 'https://archive.ics.uci.edu/dataset/53/iris',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    citation:
      'Fisher, R. (1936). Iris [Dataset]. UCI Machine Learning Repository. https://doi.org/10.24432/C56C76',
    paperCitation:
      'Fisher, R. A. (1936). The use of multiple measurements in taxonomic problems. Annals of Eugenics, 7(2), 179–188.',
    doi: '10.24432/C56C76',
    accessed: '2026-11-17',
    note:
      '来源为 UCI 官方 Iris 数据集（CC BY 4.0）；本项目仅添加英文列名并将类别标签映射为 setosa/versicolor/virginica，未修改任何测量值。',
    dataCaveat:
      'UCI 页面指出其 iris.data 与 Fisher (1936) 论文有 2 条记录差异；本项目保留 UCI 原值（未改用 bezdekIris 修正版）以保证可复现，详见数据来源说明。',
  },
  fieldMeta: {
    sepal_length: {
      label: '花萼长度',
      unit: 'cm',
      description: '花萼（sepal）长度，单位 cm',
      aliases: ['花萼长度', '萼片长度', '花萼长', 'sepal length', 'sepal_length', 'sepal'],
    },
    sepal_width: {
      label: '花萼宽度',
      unit: 'cm',
      description: '花萼（sepal）宽度，单位 cm',
      aliases: ['花萼宽度', '萼片宽度', '花萼宽', 'sepal width', 'sepal_width'],
    },
    petal_length: {
      label: '花瓣长度',
      unit: 'cm',
      description: '花瓣（petal）长度，单位 cm',
      aliases: ['花瓣长度', '花瓣长', 'petal length', 'petal_length', 'petal'],
    },
    petal_width: {
      label: '花瓣宽度',
      unit: 'cm',
      description: '花瓣（petal）宽度，单位 cm',
      aliases: ['花瓣宽度', '花瓣宽', 'petal width', 'petal_width'],
    },
    species: {
      label: '品种',
      description: '鸢尾花品种：setosa / versicolor / virginica',
      aliases: ['品种', '物种', '种类', '类别', 'species', 'class'],
    },
  },
  suggestedQuestions: [
    '不同品种的花瓣长度有差异吗？',
    '花萼长度和花瓣长度是否相关？',
    '不同品种的花萼宽度是否有显著差异？',
  ],
});

let sampleCache = null;

export async function loadIrisDataset() {
  if (sampleCache) return sampleCache;
  const csvPath = join(DATA_DIR, IRIS_META.fileName);
  const [buffer, fileInfo] = await Promise.all([readFile(csvPath), stat(csvPath)]);
  const parsed = parseCsv(buffer.toString('utf8'));
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const dataset = createDataset({
    id: IRIS_META.id,
    name: IRIS_META.title,
    headers: parsed.headers,
    rows: parsed.rows,
    source: {
      ...IRIS_META.source,
      fileName: IRIS_META.fileName,
      byteSize: fileInfo.size,
      sha256,
    },
    fieldMeta: IRIS_META.fieldMeta,
    parserWarnings: parsed.warnings,
    kind: 'sample',
    createdAt: fileInfo.mtime.toISOString(),
  });
  sampleCache = dataset;
  return dataset;
}

export function publicExampleMeta(dataset) {
  return {
    id: IRIS_META.id,
    title: IRIS_META.title,
    shortTitle: IRIS_META.shortTitle,
    description: IRIS_META.description,
    rowLabel: IRIS_META.rowLabel,
    tags: IRIS_META.tags,
    source: dataset?.source ?? IRIS_META.source,
    suggestedQuestions: IRIS_META.suggestedQuestions,
    rowCount: dataset?.rowCount ?? 150,
    columnCount: dataset?.columnCount ?? 5,
    loaded: Boolean(dataset),
  };
}
