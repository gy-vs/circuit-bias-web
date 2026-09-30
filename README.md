# Circuit Bias Web

浏览器内的电路偏置工作台：直接在图上编辑电路（电阻、电容、独立电压源、给定模型参数的二极管），检查**直流工作点**与随工作点变化的**小信号频率响应**。

工作点和频响由后端 Python（NumPy 实现的改进节点法 + 牛顿-拉夫逊）实时计算，页面里没有任何预置演示曲线。图形布局只在浏览器处理，移动器件**不会**改变电气连接或计算结果；只有改接端子、修改器件参数、改变接地/探针引用才会触发重新求解。

## 参考电路（首次打开即是）

1 V 独立电压源 → 1 kΩ 电阻 → 节点 `n_x`，`n_x` 与地之间并联接地二极管（Is = 1e-12 A，Vt = 25.85 mV）与 1 µF 电容。

| 电源 DC | n_x 直流电压 | 10 Hz 小信号增益 |
|---|---|---|
| 1.0 V | 0.516890 V | −25.8845 dB |
| 0.6 V | 0.480730 V | −14.9859 dB |

两组数字都由后端求解器现场算出（见 `backend/tests/test_solver.py`），不是写死的。

## 快速启动

需要 Python 3.10+ 和 Node 18+。

```bash
# 后端（构建前端后会自动托管 frontend/dist）
pip install -r requirements.txt
cd backend
PYTHONPATH=. uvicorn app.main:app --host 127.0.0.1 --port 8000

# 前端开发服务器（热更新，/api 代理到 8000）
cd frontend
npm install
npm run dev        # http://127.0.0.1:5173
```

生产方式：`npm run build` 后，后端直接托管 `frontend/dist`，访问 http://127.0.0.1:8000/ 即可。

## 界面操作

- **移动器件/节点**：拖动器件本体或节点圆点 —— 纯图形操作，顶部哈希与右侧结果不变。
- **改接端子（电气）**：把端子小方块拖到另一个节点圆点；或在检查器“端子连接”下拉里改。
- **改参数（电气）**：点选器件后在检查器编辑，支持 `1k`、`2.2nF`、`1Meg` 等单位后缀。
- **新建电压探针**：双击一个节点作为 + 端，再双击另一个节点作为 − 端；探针标注实际引用的两个节点，而不是曲线编号。
- **看频响**：在右上选择输入源、扫频范围与要显示的探针；点击曲线上任意频率点，下方卡片显示该点幅度/相位、对应探针以及**这次计算**的工作点，并可点回电路中的探针。
- **导入/导出**：顶栏按钮，导出标准 JSON；改完再导入，电气含义（端子与参数）不变。
- **改偏置后**：旧曲线不会继续冒充当前结果。顶部状态先变为“正在计算”，新结果出来后才标注“计算完成”；上一次成功结果折叠在下方黄色卡片里，明确标注为旧哈希，仅供比较。
- **不可计算的电路**：诊断面板给出原因并关联到真实器件/节点（点击可选中），绝不补一条平坦曲线。

## 电路描述格式

```json
{
  "format": "circuit-bias-web/1",
  "ground": "gnd",
  "nodes": [{ "id": "n_x", "name": "电阻后节点", "position": {"x": 407, "y": 220} }],
  "components": [
    { "id": "R1", "type": "resistor", "nodes": ["n_src", "n_x"],
      "params": {"resistance": 1000.0}, "position": {"x": 340, "y": 220},
      "orientation": "horizontal" }
  ],
  "probes": [{ "id": "P1", "plus": "n_x", "minus": "gnd" }]
}
```

- 器件类型：`resistor` / `capacitor` / `voltage_source`（参数 `dc`、`ac_mag`、`ac_phase`）/ `diode`（参数 `saturation_current`、`thermal_voltage`，端子 0→1 为阳极→阴极）。
- `nodes`、`components[].nodes`、`probes[].plus/minus` 用节点 id 描述电气连接；接地点是 `ground`。连接取决于 id 引用，与图上线段位置无关。
- `position`、`orientation`、`name` 是纯图形/展示字段，**不进入**电气指纹；移动布局不会让结果失效。

## HTTP 接口（页面不是唯一持有电路状态的地方）

无状态：每次请求带完整电路，任何客户端都能复现同样的工作点与频响。

- `GET /api/default-circuit` —— 首屏电路。
- `POST /api/solve` —— 请求体 `{"circuit": <电路>, "sweep": {"type":"log","start":1,"stop":100000,"num":120}, "input_source": "V1"}`
  - `sweep.type` 支持 `log` / `linear` / `list`（`points`）。
  - 返回中 `ok` 表示直流工作点成功，`ac_ok` 表示频响成功；失败时 `diagnostics[]` 关联 `nodes`/`components`/`probes`，且 `operating_point`/`frequency_response` 为 `null`（直流可解但无输入源时只给工作点）。
  - `hash` 是该次一致电路输入的电气指纹；同一次响应里的电压、电流、频率点与诊断全部来自这一次求解，不会用多次计算拼凑。

```bash
curl -s http://127.0.0.1:8000/api/default-circuit > c.json
curl -s -X POST http://127.0.0.1:8000/api/solve \
  -H 'content-type: application/json' \
  -d "{\"circuit\": $(cat c.json), \"sweep\": {\"type\":\"list\",\"points\":[10]}}"
```

## 求解模型

- **直流**：MNA（电压源引入支路电流未知量），二极管 `I = Is·(exp(Vd/Vt)−1)` 用带结电压限幅、结旁 gmin、回退与 source stepping 的牛顿法；电容直流开路。
- **交流**：在收敛工作点处把二极管线性化为 gd = Is/Vt·exp(Vd/Vt)，电容导纳 jωC；以所选电压源相量为唯一激励，探针电压除以激励相量得到增益（dB）与展开后的相位（度）。
- **拓扑诊断**：直流下到地无导流通路（含只经电容耦合）的节点、纯理想电压源回路、缺地、悬空端子、零/非法参数等都定位到具体对象。

## 目录与测试

```
backend/app/   models.py(校验/诊断) solver.py(DC+AC) analysis.py(一次一致求解) main.py(API)
backend/tests/ pytest（含两组参考值、布局无关性、失败不出曲线）
frontend/src/  React+TS：CircuitCanvas(图形/接线) Inspector(参数/端子) BodeChart(频响) App(求解状态机)
```

```bash
cd backend && PYTHONPATH=. python -m pytest -q
cd frontend && npm run build      # tsc 类型检查 + vite 构建
```
