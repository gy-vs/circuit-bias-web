# circuit-bias-web

浏览器里的电路编辑 / 直流工作点 / 频响工作台。支持电阻、电容、独立电压源和
带模型参数（反向饱和电流 Is、热电压 Vt）的二极管。打开页面即是一个可操作的
1 V / 1 kΩ / 接地二极管 + 1 μF 旁路电容电路，节点电压、器件电流和 Bode 曲线
全部由后端实时求解，没有内置演示数值。

## 核心设计

- **电气与图形分离**。工程文档里坐标/走线属于布局，求解器只接收由并查集从
  显式导线编译出的纯电气网表（`frontend/src/compiler.ts`）。在图上移动器件
  只改坐标，电气指纹逐字节不变；真正拖动器件端子改接、或在属性面板改端子
  连接，才会产生新的电气输入。
- **一次输入，一次一致结果**。后端 `POST /api/analyze` 是无状态的：同一次
  请求里完成二极管 Newton-Raphson（源步进 + 结电压限幅）工作点求解，并在
  **该工作点**上线性化（gd = Is/Vt·exp(Vj/Vt)）做复数 MNA 频响。返回的节点
  电位、器件电流、频率点和失败诊断必然来自同一份输入，不存在跨请求拼凑。
- **结果归属可验证**。请求的电气内容经规范化 JSON（键排序、Python 风格浮点
  文本、剔除空值）取 SHA-256 前 16 位。后端返回 `request_hash`，前端用同一
  算法本地复算当前文档的指纹；两者相等才显示“结果与电路一致”。改了二极管或
  偏置后旧曲线不会被当作新电路结果；移动图元则不会让结果过期。
- **失败不造假**。电路缺少到地的直流通路、端子悬空、电压源环等情况返回结构化
  诊断（关联真实 device/node/probe id），`operating_point` 与 `ac` 为 null，
  绝不用平坦曲线顶替。界面把上一次成功结果保留为明显标紫的对照，同时红条明确
  “当前电路计算失败”，两者不会混淆，更不会显示“计算完成”。
- **探针显示真实节点**。每个探针保存正、负两个电气节点，图上显示
  `V(n_plus) − V(n_minus)`。在曲线上移动鼠标选频，画布高亮对应探针，右侧
  数值栏显示该频率点及**这次计算**的工作点。

## 目录

```
backend/            FastAPI + NumPy（MNA、Newton 迭代、AC 扫频）
  app/models.py     请求/响应模型（单位：Ω, F, V, A）
  app/engine.py     校验、结构诊断、DC、AC
  app/main.py       /api/health, /api/analyze；存在 frontend/dist 时同时托管
  tests/            锚定独立参考数值的测试
frontend/           React + TypeScript + Vite（SVG 自绘编辑器，无仿真产品嵌入）
  src/compiler.ts   工程文档 -> 电气网表（并查集，只认显式导线）
  src/importer.ts   网表 -> 可编辑工程（自动布局，连接逐一还原）
  src/store.ts      编辑动作、去抖求解、陈旧结果隔离、基线对照
  src/components/   Canvas / Inspector / ResultsPanel / Toolbar / TopBar
```

## 启动

```bash
# 后端（Python 3.11，依赖见 backend/requirements.txt）
pip install -r backend/requirements.txt
./run-backend.sh                 # http://localhost:8000

# 前端开发模式（/api 代理到 8000）
cd frontend && npm install && cd ..
./run-frontend.sh                # http://localhost:5173

# 或者构建后由后端单端口托管
cd frontend && npm run build     # 产物 frontend/dist
./run-backend.sh                 # http://localhost:8000 直接打开工作台
```

## 接口（页面不是唯一知道电路状态的地方）

`POST /api/analyze`，请求体即网表，例如：

```json
{
  "version": 1, "ground": "gnd",
  "nodes": [{"id": "gnd"}, {"id": "n1"}, {"id": "n2"}],
  "devices": [
    {"id": "V1", "type": "voltage_source", "n1": "n1", "n2": "gnd", "dc": 1.0, "ac": 1.0},
    {"id": "R1", "type": "resistor", "n1": "n1", "n2": "n2", "r": 1000},
    {"id": "D1", "type": "diode", "n1": "n2", "n2": "gnd", "model": {"is": 1e-12, "vt": 0.02585}},
    {"id": "C1", "type": "capacitor", "n1": "n2", "n2": "gnd", "c": 1e-6}
  ],
  "probes": [{"id": "P1", "n_plus": "n2", "n_minus": "gnd"}],
  "input_source": "V1",
  "sweep": {"type": "log", "start": 1, "stop": 1000000, "points_per_decade": 40, "extra": [10]}
}
```

电流方向约定：正值表示电流流入器件的 n1 端（二极管 n1=阳、电压源 n1=+）。
成功返回 `operating_point`（node_voltages / device_currents / diode_vj /
diode_gd）与 `ac`（frequencies 及每个探针的 v_real/v_imag/magnitude_db/
phase_deg，增益按输入源 AC 幅度归一化）；失败时两部分为 null 并给 diagnostics。

## 参考数值（测试锚点）

| Vsrc | 电阻后直流电压 | 10 Hz 增益 |
| --- | --- | --- |
| 1.0 V | 0.516890 V | −25.8845 dB |
| 0.6 V | 0.480730 V | −14.9859 dB |

Is=1e-12 A，Vt=25.85 mV，R=1 kΩ，C=1 μF。`pytest backend/tests` 与
`npx tsx frontend/src/tests/store.test.mjs` 会复算这些值以及编辑语义。

## 操作

- 左键拖器件/节点移动（不改变连接）；在选择工具下拖器件**端子圆点**才改接，
  会把该端子上所有导线一起移走；属性面板的端子下拉也能改接/悬空。
- 工具：选择 V、画导线 W、放节点 N、放电压探针 P，以及 R/C/电压源/二极管。
- 选中器件后 R 旋转，Delete 删除；探针先点正端再点负端。
- 顶栏可导入/导出：**导出工程**含布局可继续编辑，**导出网表**只有电气语义，
  可直接 POST 给 `/api/analyze` 独立复算；导入网表会自动布局且电气往返一致。
