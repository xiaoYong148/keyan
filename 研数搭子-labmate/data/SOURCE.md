# Iris 公开示例数据：来源、许可与校验说明

本目录下 `iris.csv` 为科研数据分析 Agent（研数搭子）的公开示例数据。本文档记录其可追溯来源、许可、处理变换与校验结果，所有陈述均于 **2026-11-17** 实际联网核验。

## 1. 数据来源

| 项目 | 内容 |
| --- | --- |
| 数据集 | Iris（UCI Machine Learning Repository，Dataset ID **53**，1988-06-30 捐赠） |
| 原始出处 | Fisher, R. A. (1936). *The use of multiple measurements in taxonomic problems*. Annals of Eugenics, 7(2), 179–188. |
| 官方数据集页面 | https://archive.ics.uci.edu/dataset/53/iris （2026-11-17 实测 HTTP 200） |
| 官方下载文件 | https://archive.ics.uci.edu/static/public/53/iris.zip （数据集页面 "Download" 链接；HTTP 200，3738 字节；内含 `Index`、`bezdekIris.data`、`iris.data`、`iris.names`） |
| 旧官方路径（交叉核验） | https://archive.ics.uci.edu/ml/machine-learning-databases/iris/iris.data （HTTP 200，4551 字节） |
| 本文件实际取值来源 | 官方 zip 内的 `iris.data`（4551 字节），并与上述旧官方路径下载结果逐字节比对，**完全一致** |

## 2. 访问日期

2026-11-17（Asia/Shanghai）。

## 3. 许可

- UCI 数据集页面 *License* 段落明确声明：**Creative Commons Attribution 4.0 International（CC BY 4.0）**，原文：

  > This dataset is licensed under a Creative Commons Attribution 4.0 International (CC BY 4.0) license. This allows for the sharing and adaptation of the datasets for any purpose, provided that the appropriate credit is given.

- 许可 URL（已实际打开核验，HTTP 200，含 "Attribution 4.0 International"）：https://creativecommons.org/licenses/by/4.0/legalcode
- 使用要求：保留署名（见 §4），说明是否修改及修改内容（本文件仅添加列名与类别标签映射，见 §5）。
- 结论：**可自由共享与改编，须署名；本项目按 CC BY 4.0 合规使用。**

## 4. 引用建议

- 数据引用（UCI 官方 Citation 段落原文）：Fisher, R. (1936). Iris [Dataset]. UCI Machine Learning Repository. https://doi.org/10.24432/C56C76
- 原始论文：Fisher, R. A. (1936). The use of multiple measurements in taxonomic problems. Annals of Eugenics, 7(2), 179–188.
- DOI 核验：`https://doi.org/10.24432/C56C76` 实测 HTTP 200，重定向至 `https://archive.ics.uci.edu/dataset/53/iris`（即 Iris 官方页面），确认为官方 DOI。
- **重要更正**：任务书提到的 DOI `10.24432/C53G6X` 经实际解析（HTTP 200）指向 UCI **dataset 94 "Spambase"**，并非 Iris；本文档不采用该 DOI，以官方页面给出的 **10.24432/C56C76** 为准。

## 5. 数据处理变换（仅两项，未改动任何测量数值）

1. **添加表头**：`sepal_length,sepal_width,petal_length,petal_width,species`（前 4 列为 UCI Variables Table 的 4 个连续特征，单位均为 **cm**）。
2. **类别标签映射**：`Iris-setosa` → `setosa`，`Iris-versicolor` → `versicolor`，`Iris-virginica` → `virginica`。

其他约束（均遵守）：

- 4 个测量字段保持源文件中的原始文本表示，未做四舍五入、单位换算、排序、去重或插补；程序已逐 token 校验输出与源文件前 4 列字符串完全相同。
- 仅剔除文件末尾空行；无表头原文件共 150 条记录。
- CSV 编码 UTF-8、行尾 LF、文件末尾带换行。
- 官方 zip 与原始 `iris.data` 未保留在交付目录中（交付目录只保留 `iris.csv` 与本说明），原始文件哈希见 §6 以便复核。

## 6. 校验结果（实际命令输出）

| 校验项 | 结果 |
| --- | --- |
| 数据行 × 列 | **150 × 5**（加上表头共 151 行） |
| 缺失值 | **0** |
| 类别计数 | setosa **50** / versicolor **50** / virginica **50** |
| 数值列可解析 | 4 列全部可解析（Python `csv` 逐字段 `float` 校验 0 个失败；pandas dtype 均为 `float64`） |
| 量程 min–max（cm） | sepal_length 4.3–7.9；sepal_width 2.0–4.4；petal_length 1.0–6.9；petal_width 0.1–2.5 |
| 首行 / 末行 | `5.1,3.5,1.4,0.2,setosa` / `5.9,3.0,5.1,1.8,virginica` |
| `iris.csv` 大小 | 3858 字节 |

**SHA-256（小写十六进制）**

| 文件 | SHA-256 |
| --- | --- |
| 官方下载 zip（https://archive.ics.uci.edu/static/public/53/iris.zip） | `d11fe30213d36434a0879aab7cb00ce3c812eb7ba2495874438abff7b7b762e9` |
| 官方 `iris.data`（zip 内 / 旧官方路径） | `6f608b71a7317216319b4d27b4d9bc84e6abd734eda7872b71a458569e2656c0` |
| 交付文件 `iris.csv` | `c52742e50315a99f956a383faedf7575552675f6409ef0f9a47076dd08479930` |

独立工具复核：`Get-FileHash -Algorithm SHA256 .\iris.csv` 输出 `C52742E50315A99F956A383FAEDF7575552675F6409EF0F9A47076DD08479930`，与上表一致。

## 7. 已知数据注意事项（官方页面披露）

UCI 官方页面说明：本数据集的 `iris.data` 与 Fisher (1936) 论文数值存在差异，并给出官方更正说明——第 35 条样本应为 `4.9,3.1,1.5,0.2`（错在第 4 个特征），第 38 条样本应为 `4.9,3.6,1.4,0.1`（错在第 2、3 个特征）。zip 内 `bezdekIris.data` 为修正版；经逐行 diff，两个文件仅在这 2 条记录上不同：

- 第 35 条：`iris.data` = `4.9,3.1,1.5,0.1,Iris-setosa`；`bezdekIris.data` = `4.9,3.1,1.5,0.2,Iris-setosa`
- 第 38 条：`iris.data` = `4.9,3.1,1.5,0.1,Iris-setosa`；`bezdekIris.data` = `4.9,3.6,1.4,0.1,Iris-setosa`

本交付**使用官方 zip 内 `iris.data` 原始值，未自行修正**，以保证与官方旧路径文件逐字节对应、可复现。若下游分析需要修正版，请改用官方 `bezdekIris.data` 并重新溯源。

## 8. 隐私与安全

- Iris 为 1936 年公开的植物形态测量数据（每行一株植物，150 条），**不含任何个人身份信息或个人数据**，不涉及隐私。
- 处理全程在本机完成，仅从 UCI 官方站点下载数据；**未向任何第三方发送/上传原始数据**。

## 9. 可复现处理与校验命令

下载官方向量并与旧官方路径交叉核验（Python 3.12）：

```python
import hashlib, io, urllib.request, zipfile
UA = {'User-Agent': 'labmate-data-steward/1.0'}
def get(url):
    r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90)
    return r.status, r.read()
st, blob = get('https://archive.ics.uci.edu/static/public/53/iris.zip')       # 3738 B
raw = zipfile.ZipFile(io.BytesIO(blob)).read('iris.data')                     # 4551 B
st2, legacy = get('https://archive.ics.uci.edu/ml/machine-learning-databases/iris/iris.data')
assert st == st2 == 200 and raw == legacy
assert hashlib.sha256(raw).hexdigest() == '6f608b71a7317216319b4d27b4d9bc84e6abd734eda7872b71a458569e2656c0'
```

转换（仅表头 + 标签映射）：

```python
import csv
MAP = {'Iris-setosa': 'setosa', 'Iris-versicolor': 'versicolor', 'Iris-virginica': 'virginica'}
records = [l.split(',') for l in raw.decode('utf-8').splitlines() if l.strip()]
rows = [r[:4] + [MAP[r[4]]] for r in records]
with open('iris.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['sepal_length','sepal_width','petal_length','petal_width','species'])
    w.writerows(rows)
```

校验（pandas）：`df.shape == (150, 5)`、无缺失、`value_counts() == {'setosa': 50, 'versicolor': 50, 'virginica': 50}`、4 列数值 dtype 均 `float64`，并与源文件逐 token 对照确认测量值未变。
