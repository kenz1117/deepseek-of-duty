# 毒圈（zone）集成调研 —— 精确接法

> 状态：**只调研，未修改任何游戏代码。**
> 目标：为 `src/systems/zone.js`（纯逻辑状态机）+ main.js/hud.js/minimap.js 接线给出精确方案。
> 所有数值均为脚本实算，非估算。

---

## 0. 先纠正两个前提假设

### ⚠️ 纠正 1：60–120m 初始半径在几何上不可能

4 个 site 的 `rect` 宽度只有 **72 / 76 / 80 / 74m**。若以 `site.zone` 为圈心，可用内切圆半径为：

| site | site.zone | 左 | 右 | 后 | 前 | **rect 内最大 R** |
|---|---|---|---|---|---|---|
| street | (0, 14) | 28.0 | 44.0 | 42.0 | 68.0 | **28.0m** |
| souk | (-74, 12) | 42.0 | 34.0 | 54.0 | 60.0 | **34.0m** |
| rail | (4, -150) | 42.0 | 38.0 | 44.0 | 44.0 | **38.0m** |
| port | (98, -44) | 50.0 | 24.0 | 54.0 | 78.0 | **24.0m** |

**port 最惨，只有 24m。** 你设想的 R₀=120 会把整张图削掉 3 倍以上。

若改用全局 bounds（`level.js:6014`，242×324）作约束，`street` 可放到 114m —— 但那个圆会盖住 souk 和 port（site 间最近只隔 4m，street/port），等于同时把三张图塞进一个圈，且大半是空地。**不可取。**

### ⚠️ 纠正 2：小地图不需要加第三档

`minimap.js:26` `const W = canvas.width`，而 `index.html:76` 是 `width="320" height="320"`（CSS 缩放到约 150px）。
**画布是 320×320，不是 166px。** 各档尺度：

| range | scale (px/m) | R=36 圈直径 | 占画布 | R=120 圈直径 | 占画布 |
|---|---|---|---|---|---|
| 42m | 3.81 | 274px | 86% ✅ | 914px | 286% ❌ |
| 70m | 2.29 | 165px | 52% ✅ | 549px | 171% ❌ |
| 160m | 1.00 | 72px | 23% ✅ | 240px | 75% |

**R=36 在现有两档都能完整显示，不需要加档位。**
R=120 才需要 160m 档 —— 但既然 R=120 本来就不该用，加档位等于为一个不该存在的需求买单。

---

## 1. 地图几何 —— 数值演算（关键约束）

### 1.1 4 个 site 精确数据（`src/main.js:88-112`）

| site | id | 中心 (x,z) | yaw | rect (x0,x1,z0,z1) | 尺寸 | rect 中心 | rect内最大圆 |
|---|---|---|---|---|---|---|---|
| 街区 | street | (1.2, 33) | -0.03 | (-28, 44, -28, 82) | 72×110 | (8, 27) | **36.0m** |
| 老城集市 | souk | (-96, 46) | 1.7 | (-116, -40, -42, 72) | 76×114 | (-78, 15) | 38.0m |
| 北站货场 | rail | (0, -165) | π | (-38, 42, -194, -106) | 80×88 | (2, -150) | 40.0m |
| 东港 | port | (80, -80) | 3.7 | (48, 122, -98, 34) | 74×132 | (85, -32) | 37.0m |

### 1.2 关键决策：锚点用 **rect 中心**，不是 site.zone

`site.zone` 相对 rect 中心是偏的：

| site | zone 相对 rect 中心的偏移 | 后果 |
|---|---|---|
| street | (-8, -13) | 可用半径被左边界压到 28m |
| souk | (+4, -3) | 34m |
| rail | (+2, 0) | 38m |
| port | (+13, -12) | 被右边界压到 **24m** |

**只有 rect 中心到四边对称，可用半径 = min(宽,深)/2。**
若坚持用 site.zone 做锚点，全局 R₀ 会被 port 压到 24m，圈太小、压缩感过强。

### 1.3 全局安全半径 R₀ = 36m（取最窄的 street）

```
R₀ = min(street 36.0, souk 38.0, rail 40.0, port 37.0) = 36.0m
```

### 1.4 和平精英漂移规则在此**可证明安全**

规则：新圈心偏移量 `≤ R_old − R_new`。

设锚点为 rect 中心，四周余量 `M = (rect到边距离) − R_old`。
下一阶段：中心漂移 `d ≤ R_old − R_new`，半径降为 `R_new`，
需要 `d + R_new ≤ rect到边距离`，即 `d ≤ (rect到边距离) − R_new`。

**收缩量 `R_old − R_new` 与余量 `M = (rect到边) − R_old` 之和
= `(rect到边) − R_new`**，恰好是允许的最大漂移。所以 `d = R_old − R_new` 刚好用尽余量且不越界 —— 数学上恒成立。

**实测验证**：对 street 做 2000 次随机游走（每阶段 `d = sqrt(rand) × (R_old−R_new)`，随机方向）：

```
out-of-rect steps = 0
worst slack = 0.00m
=> 漂移规则保证圆始终在 rect 内
```

### 1.5 推荐阶段表

| 阶段 | 起始 | 结束 | R (m) | wait (s) | shrink (s) | dps | 圈心漂移预算 |
|---|---|---|---|---|---|---|---|
| 1 | 0s | 100s | 36 | 60 | 40 | 1 | 0m（固定于 rect 中心） |
| 2 | 100s | 185s | 28 | 50 | 35 | 2 | ≤ 8m |
| 3 | 185s | 255s | 21 | 40 | 30 | 4 | ≤ 7m |
| 4 | 255s | 310s | 15 | 30 | 25 | 7 | ≤ 6m |
| 5 | 310s | 355s | 10 | 25 | 20 | 11 | ≤ 5m |

**总时长 355s ≈ 5.9 分钟**，与和平精英单局量级一致。

圈外最大暴露时长 = 最长 wait + shrink = 100s（阶段1），
阶段 5 = 45s。dps 从 1 递增到 11，形成递进压力。

### 1.6 必须诚实说明的代价

R=36 只覆盖各 site rect 面积的：

| site | rect 面积 | 圆@36 面积 | 占比 |
|---|---|---|---|
| street | 7920 m² | 4072 m² | **51%** |
| souk | 8664 m² | 4072 m² | **47%** |
| rail | 7040 m² | 4072 m² | **58%** |
| port | 9768 m² | 4072 m² | **42%** |

**开局就有 42%–58% 的 rect 不可玩。** 这是小地图设计的必然结果（rect 本身就窄）。

**三个可选缓解方案（需你决策）**：
- **A. 接受**：圈外区域直接封闭不可进入。简洁，但开局割掉一半地图。
- **B. 软边界**：圈外只是持续扣血，**不阻止进入**。地图保持完整，压力来自 dps 而非几何。需要放弃"圈墙碰撞体"。
- **C. 椭圆圈**：用 `Math.hypot((x-cx)/rx, (z-cz)/rz) <= 1`，rx/rz 分别取 rect 半宽/半深。可覆盖 100% rect 面积，但视觉上不是"圆"，与和平精英观感不符。

**我倾向 B**：本项目的圈本来就没有物理墙（方案 B 见 §3.4），扣血式压力已经足够，
没必要再引入碰撞体带来的"AI 卡在圈外"问题（navgrid 不感知圈）。

### 1.7 site 之间互不重叠（已验证）

```
street/souk gap=12.0m   street/rail gap=78.0m   street/port gap=4.0m
souk/rail   gap=64.0m   souk/port   gap=88.0m   rail/port  gap=10.0m
```

**全部 disjoint，最小间隔 4m（street/port）。**
→ 一个圈**不可能**同时覆盖两个 site。每局绑定单一 site 是安全的。

---

## 2. zone.js 纯逻辑接口设计

### 2.1 状态字段

```js
state = {
  siteId:   'street',        // 绑定的 site
  phase:    3,               // 当前阶段索引，从 0 开始
  phaseTotal: 5,
  t:        12.3,            // 当前阶段已过秒数
  stage:    'wait',          // 'wait' | 'shrink' | 'final'
  cx:       8, cz: 27,       // 当前圈心
  r:        21,              // 当前半径（收缩中为插值半径）
  nextCx:   10.4,            // 下一阶段目标圈心（wait 阶段可见）
  nextCz:   25.2,
  nextR:    15,
  dps:      4,               // 当前圈外每秒伤害
  eta:      17.5,            // 距下一阶段开始（wait 时为 wait 剩余）
  shrinkEta: 12.0,           // 收缩剩余（shrink 时有效）
  started:  true,
  done:     false,
}
```

### 2.2 函数签名（照抄 milestones.js 的形态）

```js
export function createZone({
  site,                    // { rect, zone } 或 MAP_SITES 条目
  phases = DEFAULT_PHASES,  // 上表 5 阶段
  rng = Math.random,
  mirror = false,           // LAN 客户端只读镜像（必须！）
  onPhaseStart,             // (nextState, phaseIndex) 阶段切换
  onPhaseEnd,               // (state) 本阶段收束
  onFinal,                  // (state) 最终圈
} = {}) { ... }

返回 {
  update(dt),               // 推进计时；返回 snapshot()
  start(),
  reset(),
  serialize(),              // 扁平可序列化（进 snapshot）
  applyRemote(data),        // 客户端镜像
  get state(), get isDone(),
}
```

### 2.3 关键实现要点

- **锚定**：`cx0 = (rect.x0+rect.x1)/2`, `cz0 = (rect.z0+rect.z1)/2`。第 1 阶段固定于此。
- **下一圈生成**（`wait` 阶段开始时算一次）：
  ```
  driftMax = R_prev - R_next
  angle = rng() * 2π
  dist  = sqrt(rng()) * driftMax      // sqrt 保证圆盘内均匀分布
  cx' = cx + cos(angle)*dist
  cz' = cz + sin(angle)*dist
  ```
- **半径插值**：用 `weather.js:318-353` 的 `cur/tgt` 双缓冲插值思路，`shrink` 阶段 `r = lerp(R_prev, R_next, ease(t/shrink))`。建议用 `smoothstep` 或 `easeInOutQuad`，线性收缩手感太机械。
- **mirror 必须支持**：与 `milestones.js` 的 `mirror: true` 同理 —— 否则客户端 `update(dt)` 会自己推进圈，与房主快照不同步（客户端看到收缩但实际没缩）。
- **对外纯函数**：建议导出 `isOutside(zone, x, z)` 和 `distanceToEdge(zone, x, z)`（负值=圈内），便于测试与 HUD。

### 2.4 序列化与 LAN 预算（实测）

```js
serialize() → { phase, phaseTotal, t, stage, cx, cz, r, nextCx, nextCz, nextR, dps, eta, shrinkEta, done }
```

实测体积：

| 配置 | 字节 | 占 16KB | 20Hz 带宽 |
|---|---|---|---|
| zone 字段单独 | **120 B** | **0.73%** | 2.3 KB/s |
| 8 玩家 + 10 敌人 + zone + milestones | 2340 B | 14.3% | 45.7 KB/s |
| 8 玩家 + 30 敌人 + zone + milestones | 4180 B | 25.5% | 81.6 KB/s |
| 8 玩家 + 40 敌人 + zone + milestones | 5100 B | 31.1% | 99.6 KB/s |

**结论：16KB 上限毫无压力。** `lanProtocol.js:200 makeSnapshot` 是 `{...payload}` 透传，
**协议层零改动**，和 milestones 一样。

---

## 3. 视觉复用（已读源码确认）

### 3.1 atmosphere.js haze 壳 — 完整实现要点

**位置**：`src/fx/atmosphere.js:129-189`

```js
const HAZE_R = 46, HAZE_H = 30;
const hazeGeo = new THREE.CylinderGeometry(HAZE_R, HAZE_R, HAZE_H, 64, 1, true);  // openEnded
hazeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);  // 防剔除
```

**材质关键设置**（`:180-184`）——毒圈墙照抄这几行：
```js
transparent: true,
depthWrite: false,
depthTest: true,
side: THREE.BackSide,        // ← 关键：从内侧看
blending: THREE.AdditiveBlending,
```
**Mesh 设置**（`:187-188`）：`frustumCulled = false; renderOrder = 1;`

**顶点着色器**（`:142-156`）—— 核心是把顶点平移到相机位置：
```glsl
vec3 p = position;
vec3 cam = cameraPosition;
vec3 world = vec3(cam.x + p.x,
                  (cam.y - 1.7) + (p.y + 15.0),      // HAZE_H*0.5 = 15
                  cam.z + p.z);
world.y += sin(uTime * 0.05) * 0.35;                 // 轻微浮动
vWorld = world;
vH   = p.y + 15.0;
vAng = atan(p.x, p.z);
gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
```

**片元着色器**（`:157-179`）：
```glsl
float h = max(vH, 0.0);
float band = 0.58 + 0.42 * sin(h * 0.52 + vAng * 1.4 - uTime * 0.05);
band *= 0.88 + 0.12 * sin(h * 2.1 + vAng * 4.0 + uTime * 0.9);
float low = exp(-h * 0.30);                                     // 贴地更浓
float vertical = smoothstep(0.0, 2.0, vH) * (1.0 - smoothstep(8.0, 23.0, vH));
float a = uDensity * (0.30 + 1.05 * low) * band * vertical;
vec3 dir = normalize(vWorld - cameraPosition);
float sun = max(0.0, dot(dir, uSunDir));
vec3 col = mix(uFogColor * 0.85, uSunColor * 1.35, pow(sun, 2.2));
col += uSunColor * pow(sun, 10.0) * 0.5;
gl_FragColor = vec4(col, a);
```

**setIntensity**（`:200-202`）：`hazeMat.uniforms.uDensity.value = 0.085 * k`

**毒圈墙接法**：不能直接用 haze —— haze 半径固定 46m 且**跟随相机**（世界坐标恒在玩家周围），
毒圈需要固定在世界原点、半径随阶段变。做法是**照抄结构、去掉相机偏移**：
```glsl
vec3 world = p;                    // ← 不加 cam，直接用世界坐标
gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
```
并在 `update` 里 `wall.scale.set(r, 1, r)`（几何用 R=1 建，靠 scale 调半径，
避免每阶段重建 geometry 造成 GC）。
需要 **两个壳**：外层青紫实体墙 + 内层半透"下一圈"预告壳（白色，虚线感可用 alpha 脉动模拟）。

**导出注意**：`atmosphere.js:204` 返回 `{ update, setIntensity, group, motes, haze }`，
没有导出 `hazeMat`。毒圈要独立建材质，不能复用 haze 实例。

### 3.2 postfx.js uToxic

**uniform 声明位置**：`src/core/postfx.js:16-37` 的 `uniforms`，建议加在 `:36 uOpacity` 之后：
```js
uToxic: { value: 0 },
```

**需改 3 处**（否则 shader 编译失败）：

1. `uniforms` 对象加 `uToxic: { value: 0 }`（`:36` 后）
2. **声明行** `:50` —— 目前是单行 float 列表：
   ```glsl
   uniform float uContrast, uSaturation, uSprint, uDamage, uHitFlash, uSharpness, uLowHealth, uOpacity;
   ```
   加 `uToxic` 进去（否则 GLSL 编译报 undeclared identifier）
3. **shader 分支** —— 照抄 `uDamage`（`:146-152`）结构，改成青紫色：
   ```glsl
   // ---------- damage vignette ----------
   if (uDamage > 0.001) {
     float edge = smoothstep(0.06, 0.62, r2 * 2.0);
     c.r = mix(c.r, min(1.25, c.r * 1.9 + 0.10), edge * uDamage * 0.85);
     c.g *= 1.0 - edge * uDamage * 0.42;
     c.b *= 1.0 - edge * uDamage * 0.48;
   }
   ```
   **注意**：`r2` 是 `uDamage` 分支用的径向距离变量，`:147` 已算过 `edge`。
   uToxic 分支可复用同一个 `edge`，但要放在 `uDamage` 之后并独立算一次（避免耦合）：
   ```glsl
   // ---------- toxic (zone) ----------
   if (uToxic > 0.001) {
     float tEdge = smoothstep(0.10, 0.70, r2 * 2.0);
     c.r *= 1.0 - tEdge * uToxic * 0.55;      // 压红
     c.g = mix(c.g, min(1.2, c.g * 1.3 + 0.06), tEdge * uToxic * 0.55);  // 提绿
     c.b = mix(c.b, min(1.2, c.b * 1.35 + 0.10), tEdge * uToxic * 0.70); // 提蓝紫
   }
   ```

**接入路径**：`engine.js:338` 已导出 `post`，所以 main.js 里用
`engine.post.uniforms.uToxic.value = k`。
（`postfx.js:213` 也直接返回了 `uniforms: finalPass.uniforms`，等价。）

**画质档位**：`postfx.js:254-261` 有 4 档 presets。`low` 档（`:254`）关了 godrays/grain/ca，
毒圈壳若性能吃紧，可在 low 档把圈墙 alpha 降级或直接隐藏（只留小地图圈 + 屏幕滤镜）。

### 3.3 minimap.js 画圈

**位置**：`src/ui/minimap.js:173-330` 的 `draw(s, time)`

**世界→像素变换**（`:178-179`）：
```js
const toX = (x) => W / 2 + (x - px) * scale;
const toY = (z) => H / 2 + (z - pz) * scale;
```
`W=canvas.width=320`, `H=320`（`index.html:76`）, `scale` 见 `:170`。

**现有 ctx.arc 用法**（`:222-241`，objective 圈）：
```js
const zx = toX(obj.zone.x);
const zy = toY(obj.zone.z);
const wide = range >= 70;
const zr = Math.max(wide ? 5 : 3, obj.zone.r * scale);
const inView = zx > -zr && zx < W + zr && zy > -zr && zy < H + zr;
if (inView) {
  ctx.beginPath();
  ctx.arc(zx, zy, zr, 0, Math.PI * 2);
  ctx.strokeStyle = obj.done ? 'rgba(157,255,168,0.9)' : 'rgba(255,178,94,0.9)';
  ctx.lineWidth = wide ? 3 : 2;
  ctx.stroke();
  ctx.fillStyle = obj.done ? 'rgba(157,255,168,0.14)' : 'rgba(255,178,94,0.14)';
  ctx.fill();
  if (wide) { /* 中心点小圆 */ }
} else {
  // 出屏：钳制到边缘并画箭头（:243-253）
}
```

**毒圈接法**（在 objective 圈之后、敌人之前插入）：
```js
// 当前圈：青紫实线 + 半透明填充
if (s.zone) {
  const zx = toX(s.zone.cx), zy = toY(s.zone.cz);
  const zr = Math.max(4, s.zone.r * scale);     // ← 必须钳制下界
  ctx.beginPath();
  ctx.arc(zx, zy, zr, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(140,110,255,0.95)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // 只画圈外区域（clip 反转），比全填充更直观
  ctx.fillStyle = 'rgba(120,90,230,0.12)';
  ctx.fill();

  // 下一圈预告：白色虚线
  if (s.zone.stage === 'wait' && s.zone.nextR > 0) {
    const nx = toX(s.zone.nextCx), ny = toY(s.zone.nextCz);
    const nr = Math.max(4, s.zone.nextR * scale);
    ctx.beginPath();
    ctx.arc(nx, ny, nr, 0, Math.PI * 2);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
```

**数据来源**：main.js 里 `minimap.update(dt, {...})` 的 state 对象加 `zone` 字段即可
（`minimap.js:323-330` 的 `update(dt, s)` 直接把 `s` 传给 `draw`）。

**注意**：R=36 在 42m 档直径 274px，能完整显示但很贴边（86%）。
若觉得挤，可考虑毒圈激活时**自动切到 70m 档**（写 `localStorage` 的 `RANGE_KEY`），
而不是新增档位。

### 3.4 圈墙 vs showBeacon —— **不能复用**

**showBeacon**（`main.js:1455-1469`）：
```js
function showBeacon(zone, mode) {
  ensureBeacon();
  beacon.group.visible = true;
  beacon.group.position.set(zone.x, 0, zone.z);
  beacon.ring.scale.set(zone.r, zone.r, 1);      // ← 地面单圈，可缩放
  beacon.ringMat.color.setHex(mode === 'extract' ? 0x55d6e0 : 0xffb25e);
  ...
}
```
**结构**：单个 `RingGeometry` 地面圈 + 光柱（col）+ 悬浮菱形（marker）。
`updateBeacon`（`:1479-1493`）按距离淡出光柱、脉动透明度。

**为什么不适用**：
1. `beacon.ring.scale.set(r, r, 1)` 是**平面** RingGeometry，只能画地面一条线。
   毒圈需要**垂直的墙**，玩家要能看到"墙"的存在。
2. beacon 是**单点目标标记**（半径 6–8.5m），毒圈是 R=10–36m 的大范围边界，
   同屏出现会视觉打架（里程碑 beacon + 毒圈圈线 + 目标信标三层叠加）。
3. `beacon.group.position` 是硬编码单一位置，无法表达"圈心 + 半径"。

**结论**：毒圈**必须独立实现**（照抄 §3.1 的 cylinder 壳写法）。
但可以**复用 beacon 的渲染手法**（脉动 alpha 思路）作为视觉参考。

**层级冲突提醒**：里程碑的 reach/hold 步骤会调 `showBeacon`（见 main.js 的 `mountMilestoneStep`），
若毒圈圈心恰好和里程碑目标点重叠，会出现两套圈。建议毒圈墙用**半透材质 + 低 alpha**，
让 beacon 的橙色实线仍可辨认。

---

## 4. 小地图尺度结论

见 §0 纠正 2。补充：

**R=36 各档可视比例**：

| range | scale | 直径 px | 占画布 | 结论 |
|---|---|---|---|---|
| 42m | 3.81 | 274 | 86% | 可用，但贴边 |
| 70m | 2.29 | 165 | 52% | **推荐**，留足边距 |

**建议**：不加第三档。改为**毒圈启用时若当前是 42m 档，自动提示/切到 70m 档**
（`RANGE_KEY = 'dod.minimapRange'`，`cycleZoom` 在 `minimap.js:163-171`）。
这样 `RANGES = [42, 70]` 保持不变，零风险。

若未来真要做全图大圈（方案 C 椭圆），才需要 `RANGES = [42, 70, 160]`，
且要注意 `drawGrid`（`:187-206`）的 `range >= 70` 分支对新档位的网格密度。

---

## 5. 伤害接入

### 5.1 applyPlayerDamage 现状（`src/main.js:3013-3039`）

```js
function applyPlayerDamage(amount, fromPos) {
  if (G.state !== 'playing' || G.hp <= 0) return;
  if (SHOT_MODE) return;
  if (G.stats) G.stats.damagedThisWave = true;
  G.sinceDamage = 0;                      // ← 重置回血计时
  G.hurtTimer = 0.3;
  let dmg = amount;
  if (G.armor > 0) {                      // 护甲吸 75%
    const absorbed = Math.min(G.armor, dmg * 0.75);
    G.armor -= absorbed;
    dmg -= absorbed;
  }
  G.hp -= dmg;
  hud.setHealth(G.hp, pipsFor(G.armor));
  hud.flashDamage(Math.min(0.85, 0.35 + amount / 60));   // ← 闪红
  controller.addShake(Math.min(0.7, 0.18 + amount / 45)); // ← 震屏
  audio.hurt();                                              // ← 受伤音效
  if (fromPos) { /* hud.setDamage(bearing) 方向指示 */ }
  if (G.hp <= 0) playerDie();
  else if (G.hp < 40) audio.setLowHealth(true);
}
```

**这 4 个副作用毒圈都不能要**：
`flashDamage`（闪红，会和"被人打"混淆）、`addShake`（震屏）、`audio.hurt`（受伤音效）、
`hud.setDamage`（方向指示 —— 毒圈没有"来自"）。

### 5.2 建议的独立扣血函数

```js
function applyZoneDamage(amount, dt) {
  if (G.state !== 'playing' || G.hp <= 0) return;
  G.sinceDamage = 0;                      // 关键：阻断回血
  G.hp = Math.max(0, G.hp - amount);
  hud.setHealth(G.hp, pipsFor(G.armor));  // 复用
  // 不调 flashDamage / addShake / audio.hurt / setDamage
  // 屏幕反馈交给 uToxic uniform（每帧按 dps 插值，不按单次伤害量）
  if (G.hp <= 0) playerDie();
}
```

**逐帧调用方式**（避免浮点误差累积）：
```js
// 在主循环 updateMilestones(dt) 附近
if (zone && zone.state.started && !zone.state.done) {
  const s = zone.state;
  const d = Math.hypot(controller.pos.x - s.cx, controller.pos.z - s.cz);
  const outside = d > s.r;
  // 反馈强度：贴边最弱，深入最浓
  const k = outside ? Math.min(1, (d - s.r) / 15 + 0.35) : 0;
  engine.post.uniforms.uToxic.value += (k - engine.post.uniforms.uToxic.value) * Math.min(1, dt * 4);
  if (outside) applyZoneDamage(s.dps * dt, dt);
}
```

**⚠️ 必须处理的交互 —— 回血冲突**：
`main.js:4322-4327` 有自动回血：
```js
G.sinceDamage += dt;
if (G.sinceDamage > 3.2 && G.hp < G.maxHp) {
  G.hp = Math.min(G.maxHp, G.hp + G.regenRate * dt);   // regenRate = 26/s
}
```
`applyZoneDamage` 里重置 `G.sinceDamage = 0` 是**必需的**，
否则玩家站在圈外不动，血会被 26/s 回满 —— **1.5 HP/s 的圈伤根本打不过 26/s 的回血**。
这条不做，毒圈完全无效。

### 5.3 HUD 提示挂载点

**现有 DOM**（`index.html`）：
- `:16` `<div id="damage-flash">` — 全屏红闪
- `:18` `<div id="lowhp">` — 低血暗角
- `:98` `<div class="hp-bar"><i id="hp-fill"></i></div>`

**建议**：新建 `#toxic`（青紫版低血暗角），紧邻 `#lowhp`（`:18` 后）。

```html
<div id="toxic"></div>
```

CSS 参考 `#lowhp` 的写法（`style.css` 内搜 `#lowhp`），改为青紫色 + 与 `uToxic` 同步。

**不要挂到 `#damage-flash`** —— 那个是红闪，会和"被人打"混淆，正是要避免的。

**次要提示**：圈外距离/方向。已有 `hud.setZoneDistance(m)`（`hud.js:612-622`）
显示 `ZONE xx m`，但目前被里程碑 reach/hold 步骤占用。
建议新增 `hud.setToxicHint({ distance, phase, eta })` 走独立 DOM，
显示如 `圈外 · 阶段3 · 收缩 12s`。

**阶段倒计时**：可复用 `mode-hud` 条（`index.html:45-61`）的
`#mode-progress-text`（`:54`），但它已被里程碑占用。
建议毒圈用 toast（`hud.toast(text, ms)`，`hud.js:551`）播报阶段切换，
常驻信息只留 `#toxic` + 小地图圈。

---

## 6. 明确的局限

1. **没有运行游戏验证渲染效果。** 以上全是静态代码阅读 + 几何脚本演算。
   毒圈墙的实际观感（透明度、脉动频率、是否刺眼）必须你亲自看。

2. **§1.6 的覆盖代价是设计取舍，不是 bug。** R=36 只覆盖 42%–58% rect。
   我给了三个缓解方案，但**没替你选** —— 这需要你决定。

3. **R=10m 的最终圈可能过小。** 5.9 分钟对局，最后圈直径 20m，
   8 人挤在里面可能瞬秒。这需要实测调参，本文数值是合理起点不是最终值。

4. **AI 不感知毒圈。** `navgrid.js` 的导航网格不知道圈的存在，
   AI 会朝圈外目标走或在圈边抖动（`steering.js` 无墙体约束）。
   若采纳方案 B（软边界，圈外只扣血不阻挡），这个问题会**减轻但仍存在** ——
   AI 会主动往外冲然后掉血。需要给 AI 加"向圈心移动"的 steering 偏置。

5. **host 迁移会丢圈状态。** `main.js:4066+` 的 `promoteToLanHost()` 目前只恢复
   `site/wave/kills/score/enemies`，**不含 zone**。
   host 中途掉线 → 新 host 的毒圈会回退到初始状态。必须把 zone 加进 resume 快照。
   （这是我在调研阶段 1 就标记过的 H8 问题，毒圈会放大它。）