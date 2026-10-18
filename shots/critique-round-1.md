# DEEPSEEK OF DUTY — 视觉评审 Round 1

**评审人**：blind-critic（AAA FPS 视觉评审视角）
**评审标准**：与 2022–2023 年 3A FPS（CoD MWII 2022 / MWIII 2023）同框，1600×900，1:1 像素检查。
**结论先行**：**这不能冒充 CoD。** 藏掉 HUD 也一样，1 秒内可辨。整体真实感 **2.4 / 10**。
**纪律声明**：本文所有分数按 AAA 标尺给，不因"这是浏览器/程序化资产"而加分。占位级子系统会被直接点名。

---

## 0. 方法与构建状态（必须先读，影响结论可信度）

### 0.1 抓图清单（全部 1600×900，`tools/shoot.mjs`，同一 dev server）

| 文件 | 机位 | 构建状态 | 用途 |
|---|---|---|---|
| `critic-hero.png` | hero + HUD | ok | 主评分帧 |
| `critic-hero-nohud.png` | hero，`hidehud=1` | ok | 纯画面评分 |
| `critic-wide.png` | wide + HUD | ok | 纵深/天空 |
| `critic-gun.png` | gun（ADS）| ok | 瞄具/ADS 对位 |
| `critic-alley.png` | alley + HUD | ok | 近景材质压力测试 |
| `critic-enemy.png` | enemy | ok | 角色/特效 |
| `critic-combat2.png` | combat | ok | 战斗态 |
| `critic-fx-explosion.png` | hero + `fx.explosion()` | ok | 特效 |
| `critic-fx-muzzle.png` | hero + `fire()` | ok | 枪口光 |
| `critic-combat.png` | combat | **废帧（全黑）** | 仅证明构建当时崩了 |

### 0.2 评审期间构建两次断裂（这是流程问题，不是画面问题）

1. `ReferenceError: burlapSet is not defined` @ `src/core/materials.js:1233` → `boot()` 抛错、`window.__READY` 永不置位，`critic-combat.png` 抓成**全黑帧只有 HUD**（HUD 是 DOM，所以还能画）。
2. `ReferenceError: THIGH_SIZE is not defined`（`src/entities/enemy.js` 编辑中）→ 同一次循环里 combat 帧 `ready=false`。

**流程建议**：`tools/shoot.mjs` 目前在控制台有 error 时仍然照常保存 PNG 并 `exit 0`。建议加一条硬断言：若 `Runtime.exceptionThrown` 或 `ready===false`，则删除输出并 `exit 1`。否则任何子代理都会把黑帧当成功产物交出去（本轮已发生一次）。

### 0.3 移动靶声明

评审期间 `src/world/level.js`、`src/player/viewmodel.js`、`src/core/postfx.js`、`src/ui/hud.js` 均在变（mtime 08:47–08:53）。本文分数对应 **08:54 左右的构建**。若后续有美术改动，分数需重测。

---

## 1. 盲比（Blind test）

### 协议
1. `curl` 下载官方 **Call of Duty: MWII (2022)** 新闻截图（Gamereactor 图床，1600×900 / 1920×1080，官方宣传素材，非玩家截图）。
2. 双方各降到 960 宽，**同一裁剪窗口**（切掉底部 74px，因为 CoD 图角上有 `CALL OF DUTY MWII` logo + 水印，不清掉盲比无效；第一版没清，我判对了但**那次不算数**，已重做）。
3. 左右顺序随机（seed 随机，key 写进密封文件，我先看图、后开 key）。
4. 看图 **2 秒**内必须给出判断。

产物：`shots/blindtest-2.png`（有效版）、`shots/blindtest-1.png`（含 logo，作废）。

### 结果
- 我的判断：**右边是 CoD**。耗时 **< 1 秒**，零犹豫。
- 揭 key：`{"left":"DOD"}` → **右边 = COD，判断正确。**
- 判断依据（当时只看形状/光影，不看 logo）：右边有真实景深（前景草虚化、背景树 bokeh）、吉利服的独立草丝、皮肤次表面、头盔上的自然高光滚降、空气里的浮尘；左边（我方）枪是"黑色音箱盒 + 米色圆筒"、楼是"贴图墙纸"、天空是"白洞"。

### 诚实边界
- 我拿不到带 HUD 的**第一人称实机**截图（Steam CDN / IGN / PCGamer / imgur / Wikipedia 在本机 shell 被墙，仅 gamereactor / picsum / cdn.mos 可达；能拿到的是官方 campaign still）。所以严格说这是"我方 FPS 实机 vs 官方电影化 still"，对 CoD 有利、对我方不利。
- **但结论不依赖这个偏差**：我方被认出的三个理由（viewmodel、墙纸化立面、天空/光照）都是**结构性**的，换成 MWII 的实机 HUD 截图只会更快被认出。见 §3。

---

## 2. 逐项打分

标尺：**0–2 占位级 / 3–4 明显业余 / 5–6 独立游戏可接受 / 7–8 3A 合格 / 9–10 3A 顶级**。
目标线是 **≥7**。本轮没有一项过 5。

| 图 | 建筑场景 | 材质纹理 | 光照阴影 | 大气天空 | 武器 | 双手 | 特效 | UI | 构图 | 整体真实感 |
|---|---|---|---|---|---|---|---|---|---|---|
| `critic-hero` | 4.0 | 3.0 | 3.5 | 3.0 | 2.0 | **1.5** | 2.5 | 4.5 | 4.0 | **2.5** |
| `critic-hero-nohud` | 4.0 | 3.0 | 3.5 | 3.0 | 2.0 | **1.5** | 2.5 | — | 4.0 | **2.5** |
| `critic-wide` | 4.5 | 3.0 | 3.5 | 3.5 | 2.0 | **1.5** | 2.5 | 4.5 | 4.5 | **3.0** |
| `critic-combat2` | 4.5 | 3.0 | 3.0 | 3.5 | 2.0 | **1.5** | **1.5** | 4.5 | 4.0 | **2.0** |
| `critic-gun` (ADS) | 4.0 | 3.0 | 3.5 | 3.0 | **1.5** | **1.5** | 2.5 | 3.5 | **3.0** | **2.0** |
| `critic-alley` | **3.0** | **2.0** | 3.0 | 3.0 | 2.0 | **1.5** | 2.5 | 4.5 | **3.0** | **2.0** |
| `critic-enemy` | 4.0 | 3.0 | 3.0 | 3.0 | 2.0 | **1.5** | **1.0** | 4.5 | 3.5 | **2.0** |
| `critic-fx-muzzle` | 4.0 | 3.0 | 3.0 | 3.0 | 2.0 | **1.5** | **1.0** | 4.5 | 4.0 | **2.0** |

**加权（整体真实感均值）2.4 / 10。** 最弱子系统：**双手 1.5（占位级）**，其次 **特效 1.0–1.5**、**武器 1.5–2.0**。

---

## 3. 逐项像素级证据

### 3.1 建筑与场景 — 4.0（wide 4.5 / alley 3.0）

**窗是画的，不是建的。**
`src/core/materials.js#facadeSet` 用 512×512 canvas 把窗、窗台、过梁、栏杆、空调全部**画进贴图**（`floors=2, cols=3` 一个贴图只有 6 扇窗），再由 `src/world/level.js#buildBuilding` 一墙一次铺上去。证据（`shots/r1b-facadeL.png`，3×）：
- 窗洞是**平面渐变四边形**，"窗套"是 7px 的 2D 描边（代码里那圈 `rgba(24,20,16,.62)` 的 reveal band），**没有任何厚度**；掠射角下必然穿帮。
- 同一窗型在左楼 **4 层 × 3 列完全一致**（竖梃位置、窗台高度、画的窗帘褶皱都一样），右楼再重复一次；整条街的窗是同一个 module。
- 玻璃里有**肉眼可见的贴图棋盘格**——左窗玻璃能数出 3×3 的亮度方块，那是 512 贴图 tile 的缝。
- 窗框是画的白线，转角处**不相接**（左上角框线断在玻璃边缘内）。

**天际线是一块没加载完的灰板。**
`critic-enemy.png` / `critic-combat2.png` 灭点处（约 x=700–820, y=120–280）是一块**完全无贴图、无窗、边缘笔直的灰色方块**，顶边还有一条更暗的横带。这是本轮最刺眼的一处"资源没做完"。

**消防梯有真几何（加分），但悬空。**
`r1b-facadeL.png` 右侧梯子顶端**结束在半空**，没有与墙面/女儿墙相接；两级梯子以奇怪角度插进阳台。

**alley 的左墙是灾难。**
`shots/r1b-alleywall.png`：约 500px 宽的一整面纯米色平面，上面只有 3 个喷漆涂鸦 decal（绿/黄波浪线）和一块黑色矩形；1:1 下**没有任何砂浆缝、砖缝、污渍层次**；几根黑色圆柱从墙面垂直伸出然后断掉（本应是管线/支架）。

**屋顶零杂物**：所有屋檐是笔直的平顶，没有女儿墙压顶、水箱、天线、空调外机（`level.js` 有 AC unit，但只挂在一面墙的下部）。

### 3.2 材质与纹理 — 3.0（alley 2.0）

**texel 密度全线失控**（这是最"业余"的一项）：
- 近处立面：512px 覆盖 4 层楼 ≈ 1 texel 换 1.5–2 屏幕像素 → 糊。
- 枪身：大量**零法线、零 albedo 变化**的纯色平面（见 3.5）。
- 路面：512 铺满整条街 → 1:1 下像砂纸。
- 天空：无贴图但被 post 噪声占据。

量化（`shots/critic-hero-nohud.png`，取 mean |dx| 作细节能量代理）：
| 区域 | 细节能量 |
|---|---|
| 近处立面 y80–300 | 6.04 |
| 天空带（含电线/屋檐）| 5.50 |
| 路面近处 | 3.35 |
| **主角武器（近景 0.5–1.5m）** | **3.25** |

**离相机最近的英雄物件，细节量低于空天空。** 这就是"不像 3A"的数学定义。

**路面三种材质硬切**：`r1b-ground.png` 里棕色沥青、一块**平涂蓝灰补丁**、浅灰人行道三者之间是**笔直的硬接缝**；补丁无贴图、无法线、无法线方向，是一块浮在路上的色块。
**斑马线是撕边矩形**：白漆是 alpha 侵蚀过的贴片，边缘像撕纸，无磨损、无厚度、无 bump，且不随路缘转折。
**消防栓/井盖**：井盖是 1 个圆形 decal，无凹陷、无边缘 AO。
**沙袋 = 花生**：alley 右下与 hero 右侧的沙袋，1:1 下是一排**光滑的褐色椭圆**，无麻布织纹、无褶皱、无接缝、无接触 AO。
**金属不自洽**：枪口装置是高光电镀（见 3.5），机匣是哑光黑，两者同属 `metal` 家族 —— 材质响应矛盾。

### 3.3 光照与阴影 — 3.0–3.5

**量化（hero-nohud，全帧 1600×900）**
| 指标 | 数值 | 含义 |
|---|---|---|
| 亮度 ≤5/255 | **20.3%** | 五分之一画面是死黑 |
| 亮度 ≤13/255 | **31.8%** | 三分之一画面基本无信息 |
| 天空带 ≥242/255 | **19.2%** | 近五分之一的天空**过曝成纯白** |
| 天空带 ≥230/255 | 24.6% | |
| 天空平均亮度 | 120.7/255 | |

**没有环境光遮蔽（AO）。** 一眼可见的缺失：
- 沙袋堆、木箱底、油桶底、道具与地面的接触处**全无暗部**，物体像"贴纸"浮在地上；
- 枪与手的交界无 AO，手套与枪身之间是硬切；
- 店面雨棚根部无暗角。

**没有玩家武器投影。** 全帧找不到枪/手臂在地面的投影 —— CoD 靠这层投影把 viewmodel"钉"在世界里。

**火焰不发光。** `critic-enemy.png`（x≈990–1010, y≈395–445）燃烧桶距沙袋约 30cm，**沙袋亮度完全不变**。它是一个 emissive 精灵，不是一个 light。
**店面暖光不落地。** `shots/r1b-fxspot-muzzle.png`（6×）：发光门洞是**画在墙上的橙色矩形**，没有 light pool 洒到人行道，没有照亮门侧壁，光不参与场景 —— 整条街的"亮着的店"都是发光贴纸。

**阴影自相矛盾**：建筑投影边缘锐利，而 `critic-combat2.png` 里皮卡底下是**一个柔和灰椭圆**（blob shadow），两套阴影模型并存。
**阴影 acne**：`r1b-forearm.png` / `r1b-ground.png` 右下人行道上有一片**黑色星形污块**（8–20px 锯齿状），是 shadow map 走样/z-fighting 的典型产物。

### 3.4 大气 / 雾 / 天空 — 3.0

- **天空没有云。** `r1b-sky.png`（2×）里 `src/core/sky.js` 的 6 octave fbm 云在最终曝光下**完全不可见**，只有一层奶油色渐变 + 一个看不到日面的过曝核心。19.2% 天空纯白 = 高光完全无滚降（`uSunColor * (disk*18.0 + halo)` 直接把 radiance 拉爆）。
- **雾是单色 lerp**：远处楼群融进一块**平的奶油色墙**，无层次、无高度雾、无方向性散射。配合过曝天空，读作"雾卡片"而不是空气透视。
- **无体积光**：街道里没有任何光柱/丁达尔；`postfx.js` 的 god ray 只是很淡的梯度。
- **无近景浮尘/火星**（除了那个贴图火焰），空气是"干净"的 —— 与一个尘土飞扬的战区街景矛盾。

### 3.5 武器模型 — 1.5–2.0（ADS 帧 1.5）

`shots/r1b-viewmodel.png` / `r1b-ground.png`（1:1–2×）：
1. **轮廓是"盒子的堆叠"**：机匣、导轨座、瞄具座、弹匣、枪托全是轴对齐长方体，**边是数学直线**，无倒角、无倒角高光、无 R 角（`viewmodel.js` 已经 import 了 `RoundedBoxGeometry`，但主轮廓仍在用 `BoxGeometry`）。
2. **瞄具装反了 90°**：`r1b-optic.png`（6×）里红点分划板是一块**朝向 +X（玩家右侧）的平面贴片**，不是朝向 −Z（射手）。分划本身是"红环 + 硬中心点"的**扁平 sprite**，贴在黑盒侧面，贴片矩形边缘外露。后果在 ADS 帧可量化：
   - `critic-gun.png`：红点在 **(≈1040, ≈545)**，屏幕中心是 (800,450) → **偏右 240px、偏下 95px**。CoD 的 ADS 分划必然钉在屏幕中心（误差 < 4px）。
   - 结论：ADS 状态下**瞄具与相机光轴不对齐**，这不只是难看，是功能 bug。
3. **悬浮的灰色小球**：`r1b-optic.png` 下方 3–5 颗、`r1b-ground.png` 机匣上方 2–3 颗均匀灰球，**不接触任何物体**（疑似导轨螺丝/抛壳被放在错误空间）。看起来像弹珠浮空。
4. **枪口是电镀铬**：`r1b-ground.png` 的枪口制退器有一道**过曝白色高光**，与哑光机匣冲突；材质 family 混用。
5. **"导气箍"是一团有机物**：`r1b-ground.png` 右侧、手前方的深棕色多边形团块，轮廓不规则、带噪声法线，读作"烧焦的棉花糖/树皮"，不像机械件。
6. **尺寸溢出**：枪 + 手占画面 **约 48% 宽 × 48% 高**（x≈820→1600，y≈470→900）。MWII 的 16:9 viewmodel 通常 ≤ 34% 宽。
7. 缺失：背带、抛壳窗细节、快慢机、枪机面、磨损/油污梯度、指纹。

### 3.6 双手 — 1.5（**占位级，本轮最差**）

`shots/r1b-forearm.png`（4×）与 `r1b-viewmodel.png`：
1. **小臂是一个没封口的圆筒**：屏幕底部能看到**管子的空心截面**（内侧有受光的一圈亮边），即 sleeve 的 `cylGeo(..., open=false)` 端面缺失 / 或者根本没接手掌。它读作**硬纸筒**，不是手臂。
2. **筒身 UV 是可见的交叉网格**，周期约 40px，像麻布/铁丝网，不像布料；无褶皱、无袖口收缩。
3. **手是 4 根平行胶囊**：`r1b-ground.png` 里支撑手的四指是**平铺在导轨上的 4 根米色胶囊**，不环绕、无指节、无指缝暗部、无指甲、无污渍；拇指是一块光滑楔形。整只手像**塑料玩具手/鸟爪**。
4. **袖口是一个纯圆柱环**，无布料堆叠。
5. **肤色裸露**：全副武装的士兵露出肉色手掌 —— CoD 的持枪手是手套，且有材质专门的磨损；这里的手套材质与皮肤几乎同色（`M.glove` 偏米黄）。
6. 右手同样是"弹匣井旁一块米色团块"（`critic-hero.png`）。

### 3.7 特效 — 1.0–1.5

**开火无枪口焰、无环境光。** 用 `__game.fire()` 后 70ms 抓帧（`critic-fx-muzzle.png`），与爆炸帧做像素差（`shots/r1b-diff-fx-crop.png`，6× 增益）：
- 差异**只出现在武器本体轮廓**（后坐/摆动）→ 画面唯一的改变是枪在动。
- **枪口位置没有任何亮块**；地面、沙袋、墙面的亮度变化为 **0**（diff 全黑）。
- 即：开火既不发光，也不照亮世界。若枪口焰寿命 < 70ms，等于 60fps 下 2 帧，玩家根本看不见；CoD 的枪口焰持续 3–5 帧并伴随一次环境闪光。
- `fx.explosion()` 调用后同样**在画面上不可见**（无火球、无烟、无碎片、无光）。

**燃烧桶是一个垂直橙色涂抹**（`r1b-crop-barrel.png` 3×）：单一径向渐变被纵向拉伸，**顶部硬切**，无火舌、无火星、无烟柱、无热扰动、**不发光**。这是最典型的"程序化占位特效"。

### 3.8 UI — 3.5–4.5

`shots/r1b-hud-tl.png` / `r1b-hud-ammo.png` / `r1b-hud-compass.png`：
1. **颗粒叠在 UI 上面**：`src/style.css` 的 `.hud-grain`（`opacity:.045; mix-blend-mode:overlay`）与 `.hud-vignette` 是覆盖在 HUD 之上的 DOM 层 → 文字被噪点侵蚀。真实游戏里 UI 在 post 之后合成，**不会吃胶片颗粒**。这是文字发虚、发脏的直接原因。
2. **字重/字号层级反常**：使命名 `OPERATION BLACKOUT // ACTIVE` 是 ~8–9px 大间距小字（在 1600×900 下几乎不可读），而中文目标行 `清剿残敌 · 剩余 4` 字重是它的 2 倍。中文用 fallback 字体，**笔画粗细与拉丁文不一致** —— 一眼"网页 UI"。
3. **三个左边缘**：使命名 x≈118、中文 x≈110、`WAVE 1` x≈100，左对齐是毛的。
4. `WAVE 1 / ∞` 的斜体 `1` 与 `/ ∞` 挤在一起，右侧那条"刻度进度条"是 1px 虚线，读不出含义。
5. **罗盘是一条硬边半透明黑带**（`r1b-hud-compass.png`）：左右两端是**可见的直角切边**，横跨天空，并与左上使命块重叠；`N` 与另一个错位的 `N` 同时出现。
6. **弹药块光学轴呈 Z 字**：`PRIMARY — AR`(8px) / `M4A1`(琥珀，右缘超出"180"约 2px) / `30`(≈60px 巨型) / `/ 180` / `AUTO | ◇2 LETHAL`（居中于 30 而不是左对齐）/ 底部 **≈30 根等宽等距竖条** —— 弹量条读起来像**钢琴键盘**。
7. **安全区不对称**：右下块距右边缘约 24px，左下 VITALS 距左边缘约 40px。
8. 缺失：击杀播报、目标点标记、命中反馈排版（无法评估，但锚点网格与 MW 不一致）。

### 3.9 构图 — 3.0–4.5

- **最严重：小臂圆筒把灭点劈成两半。** `critic-hero-nohud.png` 中米色圆筒从屏幕底部中央斜插到画面中部，**正好遮挡街道的视觉焦点**。这是"未经取景"的直接证据。
- 地平线正中、兴趣中心是那团过曝白洞 —— 视线落在"没有信息的地方"。
- 无景深：近景武器与 40m 外街景同等清晰，没有空间分离（CoD 在 ADS 下有轻度 DOF，腰射靠 viewmodel 专属光把枪"拉"出来）。
- 中景 40 米内空无一物（除道具），缺乏节奏。

### 3.10 整体真实感 — 2.0–3.0

不是"某一处不够好"，而是**多个子系统同时停在占位级**：viewmodel、手、特效、立面窗、AO、天空曝光。任何一个达标都会显著抬分；现在它们互相暴露。

---

## 4. "这张图能不能混进 CoD MWII/III 截图？"

**不能。明确回答：不能，全部 8 帧都不能。**

不是"仔细看能发现"，是**一眼假**。藏掉 HUD（`hidehud=1`）后依然如此，所以问题不在 UI。

**识别顺序（普通玩家视角，< 1 秒）**
1. **枪**：黑色音箱盒 + 米色空心圆筒小臂 + 装反的红点 → "这是 demo"。
2. **楼**：窗是贴图网格，整条街同一扇窗 → "墙纸"。
3. **天/光**：天空是白的，阴影是黑的，物体没有接触阴影 → "没做后期"。

**最致命的一点**：CoD 的截图里，即使是最普通的街角，**近景武器有 AO、有专属补光、有磨损贴图、有真实手指**；这三样在本项目里分别是"无 / 无 / 无 / 胶囊"。这不是 fidelity 差距，是**流程缺失**（没有美术 pass）。

**给 3A 从业者的一句话**：如果这张图出现在某工作室的内部 milestone 里，它会被判定为 "first playable / blockout + 临时材质"，而不是 "alpha art"。`wide` 机位的地平线光晕和电线是唯一接近 3A 的成分（我给它 4.5 / 10），也是唯一值得保留的方向。

---

## 5. Top 5 最伤真实感的问题（证据 → 根因 → 修复 → 预期收益）

### #1 viewmodel 整个系统重建（枪 + 手 + ADS 对位）
- **证据**：空心圆筒小臂（`r1b-forearm.png`）；4 根平行胶囊手指（`r1b-ground.png`）；瞄具分划朝 +X、ADS 下红点偏离屏幕中心 (240, 95)px（`r1b-optic.png` / `critic-gun.png`）；武器占屏 48%×48%；机匣死黑、枪口电镀、悬浮灰球。
- **根因**：`src/player/viewmodel.js` —— sleeve 用未封口 `cylGeo`、arm pivot 离相机太近且被放大；瞄具程序在装配时把分划平面绕枪管轴转了 90°，且 ADS 只做"位移插值"、没有把瞄具光轴绑定到相机中心；整把枪只用少量 `MeshStandardMaterial` 纯色材质，无 normal/AO/roughness 贴图；viewmodel 无专属灯光 rig（因此背光即死黑）。
- **修复**：
  1. 封口 + 袖口环 + 2 处布料褶皱（顶点位移或 normal），删掉可见 UV 网格（换 1k 织物法线）。
  2. arm 根节点后移/下移，整机 scale ≈0.62×，把占屏压到 **≤34% 宽**。
  3. 瞄具绕 Z 轴旋转 90°（窗面法线 = −Z）；ADS 时把 reticle 屏幕坐标钉到中心，并加回归断言 `|reticle−center| < 4px`。
  4. 主轮廓全换 `RoundedBoxGeometry(r≈0.0015)`；机匣/护木/枪托分 3 个材质族（阳极铝 roughness 0.42、聚合物 0.62、钢 0.35），一张 1k 三通道 atlas（albedo/normal/rough）+ 曲率磨损。
  5. 加一盏只照 layer=2 的相机跟随补光（key 0.6 / fill 0.25 / rim 0.3），保证背光时枪仍有可读剪影。
- **预期收益**：单一改动最大。这一项从 1.5 → 6.5 可期，整体真实感 +1.5～2.0；同时解决构图遮挡（见 #5）。

### #2 立面系统：真窗洞 + 变化 + 天际线
- **证据**：窗洞是 2D 渐变 + 7px 描边、无厚度（`r1b-facadeL.png`）；同一 module 在 4 层×3 列及相邻楼完全重复；玻璃里有 512 tile 棋盘格；灭点处一块无贴图灰板（`critic-enemy.png`）。
- **根因**：`src/core/materials.js#facadeSet` 把窗、台、梁、栏杆全部画进 512² 图（`floors=2, cols=3`）；`src/world/level.js#buildBuilding` 一墙一铺，无 instanced 窗模块，无逐楼变化。
- **修复**：
  1. 做 2–3 个 **instanced 窗模块**（凹进 12–18cm 的洞口 + 窗台 + 过梁 + 窗框 + 玻璃面），按网格摆放；逐窗状态（亮/暗/封板/破碎）由 seed 驱动。
  2. facade 贴图降级为"墙面材质 + 装饰线脚"，窗不再画进贴图。
  3. 加女儿墙压顶、屋顶水箱/空调/天线（instanced，8–12 种）。
  4. 远处天际线换 3 层剪影（8–12 个不同轮廓块 + 高度雾衰减），删掉灰板。
- **预期收益**：建筑 4.0 → 7.0；"墙纸感"是最容易被玩家指认的破绽之一。

### #3 光照：AO pass + 天光补 + 曝光滚降 + 局部光源
- **证据**：20.3% 全帧 ≤5/255、31.8% ≤13/255；天空 19.2% ≥242/255；沙袋/箱底/武器接触处零 AO；燃烧桶不照亮 30cm 外沙袋；发光门洞无 light pool；路面黑色星形 shadow acne；blob shadow 与硬阴影并存。
- **根因**：`src/core/engine.js` 灯光 rig 无天光/SH 补光；`src/core/postfx.js` 无 AO pass；`src/core/sky.js` 里 `disk*18.0 + halo` 未做 filmic 肩部；火焰是 emissive sprite 而非 PointLight；shadow bias/normalBias 未调、viewmodel 层未分 shadow map。
- **修复**：
  1. bloom 前加 **SSAO/GTAO**（或 depth 重建的廉价 AO），只会暗 0.5–2px 接触缝，收益极高。
  2. 用已有 `sky.envTexture` 作半球补光，把阴影区从 0–5/255 抬到 **8–14% 亮度**（保留对比、但不死黑）。
  3. 天空 radiance 加 filmic 肩部，或 `uSunIntensity` / `disk 18.0` 降到 ~4，目标：**纯白像素 ≤2%**。
  4. 燃烧桶/店面门口换真 PointLight（距离衰减 + 火焰闪烁），并让光池落到地面。
  5. 调 `shadow.bias/normalBias`、viewmodel 单独 shadow map，消掉星形 acne；统一阴影模型（去掉 blob）。
- **预期收益**：光照 3.0 → 6.5；接触阴影一项就能让所有道具"落地"。

### #4 武器/手 材质与微细节
- **证据**：机匣大面积零法线纯色；枪口镜面过曝；导轨/护木是硬边盒子；袖筒 UV 网格；手套/皮肤同色、无织纹无污渍。
- **根因**：`viewmodel.js` 材质只有颜色 + 统一 roughness；手用 `bone()` 胶囊拼装，无手套材质。
- **修复**：一张 1k 武器 atlas（albedo+normal+rough+AO）；按材质族拆 roughness/metalness 变体；曲率遮罩做棱边磨白；手套换皮革材质（缝线法线 + 油污渐变）；手指加 3 段指节并绕导轨轴向内包（不要平铺）。
- **预期收益**：近景 1:1 检查时不再"塑料"。与 #1 同批做，避免重复改同一文件。

### #5 后期与大气完整性（含构图）
- **证据**：太阳"横向光斑"画在**遮挡物之上**（`r1b-ground.png`：亮带横穿人行道与枪影）；god ray 极弱；无 DOF；雾是单色 lerp；胶片颗粒是逐像素白噪声；小臂圆筒遮挡灭点。
- **根因**：`src/core/postfx.js` FinalShader 101–109 行的 `streak`/`glow` 纯屏幕空间、无深度测试（没绑 depth texture）；`uGrain` 用 `hash(gl_FragCoord)` 生成（读作数字抖动而非胶片）；无 depth-of-field pass。
- **修复**：
  1. 用 depth 门控 streak/glow（或删 streak，改 sprite-space flare 并做遮挡淡出）。
  2. ADS 加轻 DOF（viewmodel 合焦，2m 外虚化）—— 廉价 bilateral 即可。
  3. 颗粒换成 256² 平铺动画纹理，按分辨率缩放；**把 `.hud-grain` 从 HUD 之上移到 3D 之下**（`src/style.css`），顺带解决文字发脏。
  4. 街道加 2–3 片深度排序的尘柱 quad。
  5. 按 #1 缩小 viewmodel 后，构图遮挡自动消失；如需保留，把手臂改为"从左下角进入"而非穿屏中央。
- **预期收益**：去掉一个显眼的"shader demo"破绽；盲比里给我方加分的正是这类电影感成分。

---

## 6. 附：可复现命令与产物

```bash
node tools/shoot.mjs "http://127.0.0.1:5173/?shot=1&pose=hero"        shots/critic-hero.png 1800 1600 900
node tools/shoot.mjs "http://127.0.0.1:5173/?shot=1&pose=hero&hidehud=1" shots/critic-hero-nohud.png 1800 1600 900
node tools/shoot.mjs "http://127.0.0.1:5173/?shot=1&pose=wide"         shots/critic-wide.png 1800 1600 900
node tools/shoot.mjs "http://127.0.0.1:5173/?shot=1&pose=combat"       shots/critic-combat2.png 2000 1600 900
node tools/shoot.mjs "http://127.0.0.1:5173/?shot=1&pose=gun"          shots/critic-gun.png 1800 1600 900
node tools/shoot.mjs "http://127.0.0.1:5173/?shot=1&pose=alley"        shots/critic-alley.png 1800 1600 900
node tools/shoot.mjs "http://127.0.0.1:5173/?shot=1&pose=enemy"        shots/critic-enemy.png 2000 1600 900
EVAL='new Promise(r=>{window.__game.fire(); setTimeout(r,70);})' \
  node tools/shoot.mjs "http://127.0.0.1:5173/?shot=1&pose=hero" shots/critic-fx-muzzle.png 1600 1600 900
```

**产物**：
- 评分帧：`shots/critic-{hero,hero-nohud,wide,combat2,gun,alley,enemy,fx-muzzle,fx-explosion}.png`
- 证据裁切：`shots/r1b-{viewmodel,forearm,optic,sky,facadeL,ground,alleywall,hud-tl,hud-compass,hud-ammo,diff-fx-crop,fxspot-muzzle}.png`
- 盲比：`shots/blindtest-2.png`（有效）、`shots/blindtest-1.png`（含 logo，作废）
- CoD 参照原图：`/tmp/codref/cod_3845363_1920x1080.jpg`（MWII 2022 官方素材，Gamereactor 图床）

**参照来源**：
- 官方 MWII 新闻截图：[Gamereactor — Call of Duty: Modern Warfare II looks great in seven new screenshots](https://www.gamereactor.eu/call-of-duty-modern-warfare-ii-looks-great-in-seven-new-screenshots-1167043/)（2022-08-18）

---

## 7. 下一轮希望看到什么（最低验收线）

1. viewmodel 占屏 ≤34% 宽，且 ADS 红点距屏幕中心 <4px（可用截图自动断言）。
2. 天空纯白像素 ≤2%，全帧 ≤5/255 像素 ≤10%。
3. 有 AO 后，沙袋/箱底/武器-手接触处出现可见暗部。
4. 开火后 1 帧内枪口有亮块 **且** 地面亮度有可测变化。
5. 立面窗洞有真实厚度（掠射角截图检验），同一楼内相邻窗至少 3 种状态。

达到这 5 条之前，本文的任何分数都不该被当成"接近 3A"。
