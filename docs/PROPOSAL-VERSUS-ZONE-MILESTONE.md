# 对抗模式 + 毒圈 + 里程碑目标 —— 调研方案与实施记录

> **状态：阶段 1、阶段 2 已实施并验证。阶段 3–5 未实施。**
> 本文件既是方案，也是实施记录：末尾「实施结果」记录实际做了什么、验证到什么程度、
> 以及明确没做到的部分。
> 调研范围：`server/lan.mjs`、`src/net/*`、`src/entities/{enemy,soldierParts,netRemote}.js`、`src/systems/ai/*`、`src/world/level.js`、`src/ui/{hud,minimap,lanLobby}.js`、`src/main.js`、`index.html`
> 三个方向的独立审计已交叉验证，关键结论由我本人复核。

---

## 0. 最重要的发现：这个功能已经被设计过，并且被主动锁上了

`docs/MULTIPLAYER-DESIGN.md` 里已经有一节 **"VERSUS 4v4 — designed, locked"**，参数几乎就是你要的：

| 字段 | 设计值 |
| --- | --- |
| 人数 | **2–8 名真人**（每队最多 4） |
| 阵营 | TASK FORCE vs INSURGENT |
| AI 补位 | 每队补齐到 **4 名战斗单位**（如 2 真人 + 2 AI） |
| AI 形象 | 真人用军官（红贝雷帽/金徽章），**AI 用阵营通用士兵** |
| 目标 | 团队死斗，50 击杀或 6 分钟，**友伤关闭** |
| 状态 | **Not shipping** —— UI 标记为 `NEXT`，不做假匹配 |

锁定的理由（同文件原文）：
> "The current AI is a single-faction PvE director (perception/director/cover assume one player team). A credible 4v4 needs bot-vs-bot target selection, team spawn lanes, AI objective logic and its own balance pass. Shipping a broken versus mode would be worse than not shipping it."

`index.html:415` 确实写着 `DESIGNED / NEXT`，`:431` 写着"VERSUS 为设计稿，不可开始"。

**这意味着**：你提的三件事不是从零 brainstorm，而是**解锁一个已知被搁置的设计**。好消息是设计已经想清楚了；坏消息是当初锁它的技术理由今天依然成立。我建议把它拆成可独立验证的小步，而不是一次性全开（见第 5 节）。

---

## 1. 现状诊断：三个诉求各自的根因

### 1.1 为什么"不知道在干什么" —— 根因非常明确

联机开局走的是 `main.js:3972 startLanHostGame()`，里面硬编码：

```js
G.operation = null;      // ← 没有任何任务
G.settings.runMode = 'survival';
```

并且 `setupObjective()` 在 `survival` 模式下直接 `hideObjectiveUI()` 返回（`main.js:1092`）。

**单人战役有 14 个 OP 任务，联机模式一个都没有。** HUD 只能显示"清剿残敌 · 剩余 N"（`main.js:2323`）和波次数字。所以不是"打得不好"，是**联机模式客观上没有任何目标和进度**，玩家当然不知道在干什么。

**关键发现（好消息）**：目标系统本身已经存在且相当完整，不需要新建：
- `defend`（守点累计 60 秒）、`extract`（清场后进撤离区按住 8 秒）、`survival` 三种模式（`main.js:1088-1107`）
- `objectiveZones` / `cqbZones` 已经带 `center + radius`（`level.js:5892`）
- HUD 已有 `setMode` / `setModeProgress(pct,text)` / `setZoneDistance(m)`（`hud.js:574-624`），DOM 元素 `#mode-progress-fill`、`#zone-distance` **已经存在**
- 小地图已经会画圆圈 `ctx.arc`（`minimap.js:229-241`）

**所以"里程碑目标"的最优解是：把已有的 defend/extract 目标在联机模式启用，而不是另造一套系统。**

### 1.2 为什么联机只有 4 人 —— 三处硬编码

`LAN_MAX_PLAYERS = 4` 在 `lanProtocol.js:28`，全仓只有 7 处引用，**全部在 server 侧**：
```
lanProtocol.js:28（定义）、lan.mjs:38/201/208/240/345/385
```
所以改 server 只需改 1 行。**但 UI 侧完全不知道这个常量**，硬编码了 4：
- `lanLobby.js:294` `list.slice(0, 4)`
- `lanLobby.js:299` `` `${players.length}/4` ``
- `lanLobby.js:302` `for (let i = 0; i < 4; i++)`
- `index.html:483` 静态初值 `0/4`、`:211`「2–4 人 · 合作生存」、`:444`「2–4 人合作生存」

只改 server 会导致"服务器允许 8 人，大厅只显示 4 人"的诡异 bug。

### 1.3 为什么没有两阵营 —— 全项目零个 team 字段

grep 全仓：`src/` 下**不存在任何 `team` / `faction` / `side` 字段**。敌我关系不是数据，而是由"`ctx.playerPos` 是敌人唯一目标"这个**结构性事实**隐式定义的。

这意味着"加一个 team 字段"是不够的，真正要动的是 AI 的目标层。

---

## 2. 三个硬约束（必须先解决，否则后面全白做）

### 🔴 H1. 限流会把 host 直接踢下线 —— 8 人的第一个死结

`lanProtocol.js:32-33` 设的是 60 msg/s、burst 60。客户端 `main.js:4050` 每 0.05s（20Hz）发一次 input。

- 7 个客户端 × 20Hz = **host 入站 140 msg/s**
- `lan.mjs:269` 的 `allowMessage()` 检查在**入站**方向
- 140 > 60 → host 被 `sendAndClose(..., RATE_LIMITED)`

我已复核 `main.js:4049-4052` 确认确实是 20Hz 定频发送，限流只作用于 `ws.on('message')`。**这是 8 人模式必须第一个修的东西**，否则连 5 人都跑不起来。

### 🔴 H2. 快照体积不是问题（已实测，可以放心）

我实际跑了一次体积模拟：

| 玩家 | 敌人 | 字节数 | 16KB 上限 | 20Hz 带宽 |
|---|---|---|---|---|
| 8 | 10 | 2080 | 余 14KB | 41 KB/s |
| 8 | 30 | 3920 | 余 12KB | 77 KB/s |
| 8 | 40 | 4840 | 余 11.5KB | 95 KB/s |

**结论：16KB 硬上限完全不是瓶颈，不必改。** 但要注意 `encodeMessage` 超限是**静默失败**（`lan.mjs:96` 和 `lanClient.js:267` 都不检查 null），将来字段变多要加告警。

### 🔴 H3. AI 是单阵营 PvE 导演 —— 这是真正的工程量所在

`src/systems/ai/` 下四个文件都假设"只有一个玩家目标"：

| 文件 | 改造点 | 难度 |
|---|---|---|
| `perception.js:129` | `const player = ctx.playerPos` 写死；`sense()` 需要扫多个候选目标 | **最集中的改动点**，改这里收益最高 |
| `director.js:54` | `tick(dt, enemies, playerPos, tier)` 两个参数都是单数；`:362` 掩体预约表是**全局单张 Map**，双阵营会互抢掩体 | 高 |
| `enemy.js:767` | `canSeePlayer(playerPos, dist)` 函数名和语义都写死 | 高（跨文件 API 变更） |
| `enemy.js:1159-1181` | A* 寻路目标写死 `playerPos` | 高 |
| `cover.js` | **几乎不用改**，参数语义化即可 | 低 |
| `tuning.js` | **零改动**，纯数据 | 无 |
| `steering.js:45` | `avoidBody` 只避玩家，否则 AI 会从玩家身上穿过去 | 中 |

**难度不均**：听觉层（`perception.js:176-196`）和压制层（`:305-318`）天然阵营中立，可直接共用；`cover.js`/`tuning.js` 几乎白送。真正难的是目标选择和寻路。

**最高性价比的切入点**：把 `playerPos` 从"唯一目标"抽象成"当前目标的代表点（focusPoint）"。单阵营时 `focusPoint = playerPos`，**行为零变化**；双阵营时才切。

### 🔴 H4. 伤害结算完全没有阵营概念

`enemy.js:663` `takeDamage(amount, point, normal, part)` —— **签名里没有攻击者**，它只知道"被打"，不知道"被谁打"。所以友伤判定在数学上就不可能。

调用点有 4 处要同步改：`main.js:2507`（玩家射击）、`:2839`（手雷）、`:2975`（炮击）、`:3878`（LAN）。

另外 `takeDamage` 后半段（`enemy.js:704-729`）有一堆 AI 反应逻辑（`awareness=0.9`、`wantCover`、`panicT`），**友伤不能触发这些**，否则 AI 友军会互相警戒找掩体，看起来很蠢。

### 🟡 H5. 联机道具系统对多人是关闭的

`main.js:4213`：`!(net.role === 'host' && net.remote.size > 0)` → 一旦有其他玩家，`equipment`（敌方投掷物/道具）**被完全禁用**。8 人时 AI 补给为零。
另外 `main.js:3810 nearestLanTarget()` 会让敌人攻击**最近的人类玩家，不分敌我** —— 对抗模式下这是致命缺陷。

### 🟡 H6. 现存 bug：联机远端玩家高度恒为 0

`lanProtocol.js:166-178` 的 `makeInput()` **丢弃了 `y` 字段**，但 `main.js:4054` 发送时带了 `y`，`applyLanRemoteDamage` 侧读 `msg.y` 得到 undefined → 回退 0。
→ 4 人模式下所有远端玩家的垂直插值都是错的（贴地飘）。8 人会放大这个问题。**顺手修掉。**

### 🟡 H7. host 迁移不重建 P2P

`lanClient.js:240-244` 收到 `host_change` 只改 `hostId`，**不重建 P2P 连接**。新 host 变成纯 relay。8 人掉线概率是 4 人的 2 倍，这个问题会被放大。

### 🟡 H8. 房主迁移会丢掉一切"过程状态"

`main.js:3937-3970 promoteToLanHost()` 目前只恢复 `site / wave / kills / score / enemies`，
且代码注释自陈：**"弹道与 AI micro-state 不转移"**。

对照可知：阶段 4 的阵营记账、毒圈阶段进度、里程碑链位置**全都不在 resume 快照里**。
host 中途掉线 → 新 host 的世界会"时间倒流"，毒圈阶段和任务链进度归零。
这是所有"host 权威"设计的固有代价，8 人时掉线概率翻倍，问题会明显放大。

### 🟡 H9. AI 不认毒圈 → 会卡在圈外

`navgrid.js` 的导航网格不感知毒圈。收缩把玩家和敌人分隔在不同圈时，
AI 会持续朝圈外目标走、或在圈边来回抖动（`steering.js` 无墙体约束）。
缓解手段：给 AI 加一条"向圈心移动"的 steering 偏置；或让圈外 AI 也持续掉血（自然淘汰）。

### 🟢 H10. 顺带一提：`fx.js` 的两个特效未导出

`fx.spawnRing`（`:730`）和 `spawnShell`（`:801`）已实现但**不在导出清单**（`:1327-1333`）。
如果要用爆炸冲击波做"圈收缩瞬间"的特效，需要补导出。属于零风险的小改动。

---

## 3. 毒圈方案（结合和平精英玩法）

### 可复用资产盘点（好消息）

| 资产 | 位置 | 复用方式 |
|---|---|---|
| 地图边界 | `level.js:6014` `bounds: {x0:-118,x1:124,z0:-196,z1:128}` | 242×324m 有限矩形，四处已在消费 |
| 20 个命名区域 | `level.js:5981-6001` + `regionAt()` | 可做圈外区域的区域名提示 |
| 圆形区域系统 | `cqbZones`/`objectiveZones` 已有 `center+radius` | `Math.hypot(...) <= r` 判定模式全仓 106 处 |
| 小地图画圆 | `minimap.js:229-241` `ctx.arc` + `toX/toY` | **画毒圈几乎零成本** |
| HUD 阶段进度条 | `hud.js:574-624`，DOM 已存在 | 阶段倒计时直接接上 |
| HUD 圈外距离 | `hud.js:612 setZoneDistance(m)`，已在 defend 模式用 | **现成的 API** |
| 后期处理 | `postfx.js:16-37` 已有 `uDamage`/`uLowHealth`/`uSaturation` | 加一个毒气 uniform 即可 |
| 毒雾外壳 | `atmosphere.js:130-189` 跟随相机的霾壳 shader | 同款写法 |
| 阶段里程碑状态机 | `streaks.js:12-15` 已有 `MILESTONE_SUPPLY/UAV/ARTILLERY` | **照抄这个模式** |

### ⚠️ 一个必须先解决的几何问题

**地图是 242×324 的长方形，不是正方形。** 直接套一个同心圆毒圈会切掉 souk(x=-116) 或 rail(z=-194) 两端的可玩区域。

三种解法：
- **A. 椭圆圈**：`Math.hypot((x-cx)/rx, (z-cz)/rz) <= 1` —— 最简单，但边界手感是"椭圆"而非"圆"，不太像和平精英
- **B. 按 site 分区设圆**（推荐）—— 地图本来就是多个 site（street/souk/rail...），每个 site 一个圆心
- **C. 正多边形**（6/8 边形）逼近 —— 视觉最接近真实毒圈，判定仍用 `Math.hypot`

### 毒圈三套方案

| | A. 静态安全区 | B. 阶段收缩圈（推荐） | C. 毒圈+任务耦合+LAN |
|---|---|---|---|
| 形态 | 每个 site 一个固定圈，不收缩 | 6-8 阶段，每阶段 wait（预告）→ shrink（收缩），新圈完全落在旧圈内 | B + 圈外目标是唯一推进方式 |
| 阶段 | 无 | 6-8，最终半径压到 ~15m 决战 | 同 B |
| 圈外伤害 | 1.5 HP/s | 分阶段递增（1.5 → 10 HP/s） | 同 B，圈外目标双倍分 |
| 视觉 | 小地图画圆 + 屏幕青边 | + 圈墙、地面环、下一圈预告、阶段横幅 | 同 B |
| 新增文件 | `zone.js` ~150 行 | `zone.js` ~350 行 | `zone.js` ~600 行 |
| 改动文件 | 4 | 6 | 7 + 文档 |
| **工作量** | **小** | **中** | **大** |
| **主要风险** | 低（最坏结果是白做） | **中**：AI 不认圈会卡在圈外；毒墙若做成实体碰撞会改变现有走位节奏 | **高**：房主迁移会丢 zone 状态；容易形成"刷圈外目标"的分数 meta |
| 解决"不知干嘛" | 弱 | 中 | 强 |

**三个方案的可复用度都很高**，因为基础零件全在：
- 圈心数据 → `objectiveZones` 的 `{x,z,r}` 格式，`Math.hypot` 判定全仓 106 处
- 圈墙 → `atmosphere.js:130-189` 的跟随相机霾壳（`CylinderGeometry(46,46,30,64,1,true)` + `BackSide` + 顶点偏移到相机），照抄改颜色即可
- 屏幕滤镜 → `postfx.js:16-37` 已有 `uDamage` 的红色 vignette 分支（`:146-152`），加一个同形的 `uToxic` 绿/青紫分支
- 小地图 → `minimap.js:229-241` 的 `ctx.arc` + 世界→像素变换 + 出屏钳制箭头
- 收缩插值 → `weather.js:318-353` 的 `cur/tgt` 双缓冲插值（TRANSITION = 1/6 秒）
- 圈外轰炸 → `artillery.strike()`（`artillery.js:178-210`）已经支持半径随机撒弹，几乎零成本
- 状态机模板 → `streaks.js`（纯逻辑、无 three、无 DOM，owner 喂数据 + 轮询 state）

**⚠️ 小地图的尺度陷阱（重要）**：`minimap.js:11` 的 `RANGES = [42, 70]`。
70m 档下画布 166px ≈ 1.19 px/m，一个 120m 半径的毒圈 = 142px 直径，**远超画布**。
→ 必须加第三档更大的 range（150m/200m）或独立的"全图模式"，否则玩家根本看不到圈边界在哪。

**⚠️ 毒圈扣血必须走独立路径**，不能复用 `applyPlayerDamage`（`main.js:2879-2907`）——
它会同时闪红 + 震屏 + 播受伤音效，玩家会误判为"被人打了"。应直接改 `G.hp` + `hud.setHealth` + 独立青紫 HUD 元素。

**注意**：毒圈扣血**必须走独立路径**，不能复用 `applyPlayerDamage`（`main.js:2879`），因为后者会强制闪红+震屏 —— 玩家会分不清是被人打还是在圈外。

---

## 4. 里程碑目标方案

**核心原则：里程碑必须能在"打人之外"推进**（搜集、到达、护送、守点），否则解决不了你反馈的问题。

### 里程碑三套方案

**核心原则：里程碑必须能在"打人之外"推进**（到达/搜集/守点），否则解决不了你反馈的问题。

| | A. 波次计数 | B. 任务链四类混合（推荐） | C. LAN 共享 + 分工 |
|---|---|---|---|
| 类型 | 主要 `kill` | `reach` / `hold` / `collect` / `kill` 轮换 | 同 B + 个人/队伍双层目标 |
| 不杀敌可推进 | ❌ **不满足** | ✅ | ✅ |
| 新增文件 | `milestones.js` ~200 行 | ~350 行 | ~600 行（含 host/client 双态） |
| **工作量** | **小** | **中** | **大** |
| 网络改动 | 无 | 无 | 快照 + resume + 名牌 + 结算 |
| **主要风险** | **中**——纯 kill 型等于没解决问题 | **低-中**——任务链与战斗抢戏（目标点太远时玩家一直赶路） | **高**——房主迁移丢状态；可能出现"1 人做完 3 人挂机" |
| 建议 | ✗ 不建议单独做 | **推荐起点** | 后续迭代 |

**方案 B 为什么可行（关键）**：`src/systems/interact.js` 整个文件就是为此设计的通用目标系统（我已复核），
`reach`/`collect`/`hold` 三类**全部可以零成本接入**，不需要新建输入处理或 UI 框架。
`kill` 类只是往计数器里 `notify('kill')`。

**必须注意的一点**：方案 A 看着最省事，但它是**纯 kill 型**，做出来仍然是"一群人在打架"，
只是换了个计数方式。**不要从 A 开始。**

### 里程碑 UI 落点（已有）

- `hud.setMode(label, sub)` —— 当前阶段名
- `hud.setModeProgress(pct, text, active)` —— 进度条 `#mode-progress-fill`
- `hud.setZoneDistance(m)` —— 目标区距离 `#zone-distance`
- `hud.toast(text)` —— 阶段达成横幅

### ⚠️ 里程碑的权威归属

多人下"任务进度"必须由 **host 权威模拟**（和现有 `G.wave`/`G.objective` 一样），写进 snapshot 广播。客户端不能各自算。

**我已亲自复核的一个关键事实**：`main.js:3924` **已经在广播 `objective:{type,done}` 字段**，
但 `applyLanSnapshot`（`:3757-3809`）只读了 `wave`/`kills`/`score`，**objective 字段被静默丢弃**。
即：字段发了没人收。加里程碑进度只需：
1. `main.js:3924` 广播里补 `milestones` 字段
2. `applyLanSnapshot` 里读它
3. `lanProtocol.js:200 makeSnapshot` 是 `{...payload}` 透传，**协议层零改动**

### 里程碑的最佳底座：`src/systems/interact.js`（我已复核）

整个文件只有 76 行，但它的目标格式是**完全通用**的：

```
目标 = { x, z, r, label, hold?, onUse, done }
      无 hold → 按 E 触发；有 hold → 按住累积
```

HUD 提示由 `update()` 自动驱动（`hud.setInteract(label, progress)`），且保证"任意时刻只有一个最近目标"。

这意味着 `reach`（到达）、`collect`（搜集）、`hold`（守点）三类里程碑**全部可以零成本接进现有交互系统**，不需要新建 UI 或输入处理。现有 `intel.targetList()`（`intel.js:65-70`）已经在用这个格式产出 12 个情报点，可以直接当里程碑点位数据源。

### 可复用的现成点位数据（做里程碑不用自己摆点）

| 数据源 | 位置 | 数量 | 适合的里程碑类型 |
|---|---|---|---|
| `OBJECTIVE_SPOTS` | `main.js:1020-1069` | 25 个 `{x,z,r}`（4 site × defend/extract） | 到达 |
| `intel.SPOTS` | `intel.js:7-21` | 12 个，分布 4 个区 | 搜集 |
| `cqbZones` | `level.js:5871-5888` | 3 个室内房间（带 radius） | 守点 / 清房 |
| `EXPANSION_DISTRICTS` | `level.js:1338-1354` | 3 个大区，各带目标点 | 章节推进（先清 A 再去 B） |
| `worldLabels.POIS` | `worldLabels.js:15-31` | 15 个地标 | 占领/激活 |
| `MAP_SITES` | `main.js:88-112` | 4 个站点 | 天然章节 |

**建议**：里程碑点位优先从 `pickZoneSpawn` 的 **7–30m 环带**内选（`main.js:1204-1211` 已有此逻辑），
否则目标点离刷怪点太远，玩家会一直在赶路，任务链和波次战斗抢戏。

---

## 5. 建议的推进顺序（分阶段，每阶段可独立验证）

我把它们拆成 4 个里程碑，每一步都能单独测、能停下来：

### 🟢 阶段 1：先把 8 人跑通（无阵营，纯扩容）—— 最小风险
1. **修限流**（H1，必做第一步）：`lanProtocol.js:32-33` 提到 ≥200，或按人数动态 `40 + 25*(n-1)`
2. `lanProtocol.js:28` `LAN_MAX_PLAYERS = 4 → 8`
3. `lanLobby.js:294/299/302` 改为从协议常量读，消除硬编码
4. `index.html:211/444/483` 文案
5. `style.css:1809` 玩家列表加 `max-height/overflow-y`（8 行会撑爆面板）
6. **修 `y` 字段丢失 bug**（H6）
7. `main.js:3712` 出生点分散（现在 `x: 1.2 + 2.2*(n+1)`，8 人会挤成一条直线）

**验收标准**：8 人联机不掉线，大厅正确显示 8 槽位。

### 🟡 阶段 2：里程碑目标（收益最大，先于对抗模式）
8. **复用 `startLanHostGame` 里被硬关掉的目标系统**（`main.js:3972-3991` 的 `G.operation = null`），先启用 defend/extract
9. 新建 `src/systems/milestones.js` —— **照抄 `src/systems/streaks.js` 的模式**（纯逻辑、无 three、无 DOM、owner 喂数据 + 轮询 state）
10. 四类目标接线：`reach`/`hold`/`collect` 走 `interact.js`（零新增 UI）；`kill` 走计数
11. HUD：checklist 显示当前环 + 未来 2 环，进度接 `hud.setModeProgress`（量化写入避免掉帧）
12. `applyLanSnapshot` 读取已广播的 `objective` 字段 + 新增 `milestones` 字段

**验收标准**：联机玩家能看到"当前阶段 / 下一步做什么 / 进度条"，且**存在不靠杀人就能推进的里程碑**。
**这一步单独就能解决你说的"不知道在干什么"。**

⚠️ 阶段 2 建议**先在单人验证手感**（完全不碰网络），确认目标点选取和节奏合理后再接 LAN 广播。
快照字段扩展是纯透传（`makeSnapshot` 不校验 payload），风险很低，但阶段完成时机和波次结算的耦合需要实测。

### 🟠 阶段 3：阵营字段贯通（先不做玩法）
11. `enemy.js:144` 构造函数加 `this.team`
12. `enemy.js:663` `takeDamage` 加 `attackerTeam` 参数 + 友伤分支（同步改 4 处调用）
13. `lanProtocol.js:206-221` `normalizePlayers` **加 `team` 透传**（它现在会静默丢弃未知字段 —— 这是最容易漏的一处）
14. `server/lan.mjs:139-146 lobbyPlayers()` 下发 `team`；`:216-222` player 加 `team`
15. `netRemote.js` 加阵营配色（真人两套军官配色）
16. **协议版本握手**（H3：`LAN_PROTOCOL_VERSION` 是死代码，加字段属破坏性变更）
17. 新 close code 务必同步加进 `LAN_FATAL_CLOSE_CODES`，否则会触发**无限重连风暴**

### 🔴 阶段 4：真正的对抗玩法（重头）
18. `enemy.js:767` `canSeePlayer` → `canSeeTarget`；`:1159-1181` 寻路目标改为 `this.targetPos`
19. `perception.js:129` `ctx.playerPos` → `ctx.focus` + 多目标扫描
20. `director.js:54` 按 team 分实例；`:362` 掩体预约表按 team 隔离
21. `main.js:3810 nearestLanTarget` → 敌队目标选择
22. AI 补位：`main.js:2016-2020` 改双预算 `友军AI = max(0, 4 - 本队真人数)`
23. 刷点按阵营分区（地图南北天然对称：`main.js:3712` 附近）
24. `main.js:4213` 重新评估多人下关闭 `equipment` 的逻辑
25. AI 军官形象（`soldierParts.js` 加 officer accent + 红贝雷帽）

### 🔵 阶段 5：毒圈
建议在阶段 2 之后、阶段 4 期间做 —— 毒圈本身就依赖阵营和里程碑，单独做意义不大。
推荐从**方案 B（分区圈）**起步，因为它能复用已有的 `objectiveZones` 数据结构。

---

## 6. 需要你决策的三个问题

1. **是否接受分阶段？** 我建议先做阶段 1+2（8人扩容 + 里程碑目标），这两步风险低、收益直接，能立刻解决"不知道在干什么"，而且**不碰 AI 目标层**。阶段 4 的对抗玩法才是真正的重头。

2. **毒圈要不要在对抗模式之前做？** 毒圈本质上是 PvP 玩法的一部分，单独放在 co-op 里意义不大（会变成"必须待在安全区刷怪"）。但如果你的目的是**先让联机有目标感**，那"阶段化倒计时 + 强制转移"其实可以做成里程碑的一种，而不必是真正的伤害毒圈。

3. **AI 补位是"战斗力"还是"气氛"？** 设计稿写的是每队补到 4 人。但如果你觉得 8 个 AI 士兵的性能和维护成本太高，可以退一步：**每队只补到 4 人总数，其中 AI 只做"跟随 + 有限攻击"**，不做完整的目标选择。这样能避开 `perception/director` 的深度改造，但 AI 会显得笨。

---

## 7. 诚实的能力边界

- 本文件**只做了静态代码调研，我没有实际运行游戏验证性能数字**。限流推算（H1）基于代码逻辑和 20Hz 定频发送的事实，但没有实测。
- 阶段 1/2/3 是"配置 + UI + 协议字段 + 目标系统复用"级别的工作量，可控。
- **阶段 4 不是"加个阵营"**。`perception/director/enemy` 三层都写死了单一目标，`docs/MULTIPLAYER-DESIGN.md` 里项目自己已经把这个标为 `locked / not shipping`，理由是充分的。**8 人 co-op 扩容是工程任务；8 人双阵营对抗是重写 AI 目标层。**
- 8 人联机的实际性能（P2P 7 条 PeerConnection、host CPU、relay 带宽）我无法在没有显示环境的情况下实测。建议阶段 1 做完先实测，再决定要不要开阶段 4。
- 我不会说这套东西做完能"击败和平精英"或"达到 CoD 水平"。它是一个浏览器 FPS demo 的功能扩展。

---

## 8. 实施结果（阶段 1 + 阶段 2 已完成）

### 阶段 1：8 人联机扩容 — 提交 `fb313b7`

| 项 | 结果 |
|---|---|
| 限流 60 → **240/s** | **已修**。这不是"调个参数"，8 人时房主入站最坏 140/s，旧值会在满员前就把房主踢下线 |
| `LAN_MAX_PLAYERS` 4 → **8** | 已改 |
| 大厅硬编码 4（3 处） | 已改为 `import { LAN_MAX_PLAYERS }`，从协议常量读，杜绝"服务器收 8、大厅只显示 4" |
| 文案 4 → 8（含首屏静态 `0/8`） | 已改 |
| 8 行撑爆面板 | 已改：行高压缩 + 列表 `max-height` + 滚动（含响应式断点） |
| `y` 字段丢失 bug | 已修。**这个 bug 比预想严重**：`applyLanInput` 用 `msg.y` 做走路面合法性校验，之前恒为 `undefined→0`，等于所有远端玩家都按地面高度校验 |
| 出生点挤一条线 | 已改为两行错开分布 |
| 冒烟测试 | 从"第 5 人被拒"改为按常量断言，并同步修好我改坏的 host 迁移用例 |

**验证方式**：构建通过；`lan-smoke` 14 项全过（含"第 9 人被拒绝"）；
另写了一个 **8 人真实压测**：7 个客户端按 20Hz 向房主灌 4 秒，实测房主收到 **138 msg/s 且未掉线**，
并用脚本对比确认旧 60/s 限制在此场景下必然触发 4029。这条是阶段 1 的核心证据。

### 阶段 2：里程碑任务链 — 提交 `faddcf2`

**做了什么**
- 新增 `src/systems/milestones.js`：纯逻辑（无 three/DOM），照抄 `streaks.js` 的模式
- 四类目标 `reach / hold / collect / kill`；**保证至少 1/3 非致命步骤**（纯 kill 链等于没解决问题）
- 点位取自关卡已有数据（`OBJECTIVE_SPOTS` / `objectiveZones` / `cqbZones` / `intel.targetList`），不凭空造坐标
- `collect` 复用现有 E 交互系统（自带 HUD 提示），**没有新增输入或 UI 框架**
- HUD 清单渲染进现有 `mode-hud` 条内，只在结构变化时重建 DOM，避免每帧写 DOM
- 联机：房主权威，快照带 `milestones` 字段（`makeSnapshot` 是透传，**协议零改动**）；客户端用 `mirror: true` 只读镜像

**测试过程中发现并修掉的 3 个真 bug**
1. **首个步骤从未被播报** —— `onChainAdvance` 只在后续步骤触发，第一个里程碑的信标/交互点根本不会挂载
2. **`hold` 计时浮点累积** —— `100 × 0.1 == 9.999999999999998`，进度条满却永不完成，玩家会被卡住
3. **`collect` 无点位时未降级** —— 只有 reach/hold 做了降级，`collect` 会崩

### 验证到什么程度

| 验证 | 结果 |
|---|---|
| 单元测试 `tools/milestones-test.mjs` | **38 项全过** |
| 集成测试 `tools/milestones-integration-test.mjs` | **17 项全过**（含"整条链可被玩家走完"、快照 <16KB、客户端只读镜像） |
| LAN 冒烟 `tools/lan-smoke.mjs` | 14 项全过 |
| `vite build` | 通过，无报错 |
| headless Chrome | 确认 `0/8` 标签、列表可滚动且有 `max-height`、`#ms-list` 存在、**无页面错误** |
| `npm test` | 一次性跑完上述三套 |

### 没做到的部分（诚实说明）

1. **没有真人多机实测**。我的 8 人压测是脚本模拟 WebSocket 消息流，验证的是"房主不会被限流踢掉"，
   **不等于** 8 个真实浏览器 + WebGL 同屏的帧率表现。host CPU、P2P 7 条 PeerConnection 的实际开销仍未实测。

2. **里程碑的节奏没有真人调过**。点位距离阈值（8–46m）、`hold` 时长（12s）、`kill` 数量（3–6）是
   按代码里既有目标数值取的合理默认值，**不是玩出来的手感**。很可能需要你实际打几局再调。

3. **`collect` 的物资点用的是情报点坐标**，语义上是"搜集情报"而非"拾取弹药/武器"。
   想要真正的装备搜集维度，需要另接 `pickups` 系统。

4. **阶段 3–5 完全没动**：阵营字段、`takeDamage` 友伤判定、AI 目标选择、毒圈。
   **联机对抗模式（2–8 人两阵营）目前仍然是不可玩状态**，UI 上仍是 `DESIGNED / NEXT`。
   原因见 `docs/MULTIPLAYER-DESIGN.md` 的锁定说明：AI 是单阵营 PvE 导演，
   做可信的 bot-vs-bot 需要重写 `perception/director/enemy` 三层的目标层，不是加个字段的事。

5. **一个已存在的现象（非本次引入）**：headless 环境下 `lanLobby` 模块的初始化代码没有执行
   （`dataset.lanBound` 为 undefined、大厅列表 0 行）。我对比了改动前的基线，**改动前行为完全相同**，
   所以这不是本次改动引入的回归。推测是 boot 流程等待模型/音频加载在 headless 下未完成所致，
   我没有深挖。需要你正常打开浏览器点一下大厅确认实际体验。

---

## 9. 实施结果（阶段 3–5：对抗模式 + 毒圈）

### 交付内容

**毒圈（阶段 5）— `src/systems/zone.js` + 全链路接线**
- 纯逻辑状态机（无 three/DOM）：7 阶段 wait→shrink，开局圈覆盖整个 site 矩形（对角线一半 ×1.03，角落出生不踩毒），终圈 ~10m 决战，圈外伤害 1→14 HP/s 阶梯递增，单局约 4.5 分钟
- 关键几何保证（20 个 site×seed 组合实测）：已适配（fitted）的圈永不切出可玩矩形——收缩插值每一帧都按当前半径重新钳制圆心
- 和平精英嵌套规则：下一圈圆心偏移 ≤ R_old − R_new，新圈永远完全在旧圈内
- host 权威，快照携带 ~200B 序列化状态；客户端只读镜像（不会自己推进）
- 视觉：跟随收缩的毒圈墙（圆柱）+ 地面当前圈 + 白色下一圈预告（收缩时变淡）；HUD 显示圈外距离与"蓝 X : Y 红 · 缩圈倒计时"
- 毒圈伤害走独立路径：不闪红、不震屏、无受伤音效（玩家能分清是毒还是人打的），且阻断自动回血
- 圈外 AI 也会掉血（减半），但 **AI 不会主动跑进圈** ——已知局限

**对抗模式（阶段 3+4）— 两阵营 TDM 4v4**
- `G.versusMode` 总开关，关闭即精确回到 PvE 行为
- 阵营分配：大厅加入顺序交替分入蓝/红（host=蓝 0 号），每队至多 4 人
- AI 补足：每队补齐到 4 人，在本队半场出生；为让 bot 真正交火，用 veteran 难度档 + hp80 + 伤害 ×1.8（战役交易数值会让 bot 对枪拖太久）
- 击倒计数：阵营击杀（40 杀获胜，v1 只播报不切结算）、5 秒重生（人 和 bot 都重生在本队半场）
- 友伤：同队伤害 ×0.35，且**不触发任何 AI 报警反应**（否则友军会转身打队友）
- 目标选择：`nearestLanTarget` 加阵营过滤——**只有双方都有 team 时才过滤**（老快照/单人 team=undefined 时不过滤，避免 undefined===undefined 全员互殴）
- bot 互殴：bot 也能选敌方 bot 为目标，伤害经 `bot:` 前缀路由回 `takeDamage`
- 单目标假设不成立的子系统在 versus 下关闭：破门 AI（两阵营会互炸己方门）、投掷物（假设唯一玩家目标）、PvE 波次生成
- 掩体预约表按阵营命名空间隔离（双方不抢同一批掩体点）
- 协议零破坏：team/versus/vscores/zone 全部走 snapshot 透传字段

### 实现说明（透明披露）

实现中途，一个并行子代理把该功能朝"FFA 8 人混战、一命、最后存活"方向改写。这与既定需求（两阵营、每队 4 人）不符，已全部改回阵营语义；FFA 版本中确实有价值的调参（bot 交火节奏）被保留吸收。

### 验证到什么程度

| 项 | 结果 |
|---|---|
| zone 单元测试 | 41 项全过（含 20 组几何包含性证明、嵌套规则、序列化、镜像） |
| versus 守卫测试 | 17 项全过（双空值检查、友伤先于 AI 反应、子系统门、分队数学） |
| milestones 55 项 + lan-smoke 14 项 | 全过（无回归） |
| vite build | 通过 |
| headless Chrome | 卡片/复选框文案正确、无页面错误 |

### 没做到的（诚实说明）

1. **没有真人多机实测**。所有多端行为（比分同步、镜像毒圈、人打人）由代码审查 + 快照协议推理保证，未用两台真机对打验证。
2. **平衡数值全部未调**：40 杀目标、bot hp80/伤害×1.8/5s 重生、毒圈 dps 阶梯，都是第一版拍脑袋值。
3. **AI 不会配合**（无集火/保枪/卡点概念），也不会主动进圈——它们会就近交火，被毒圈逼着移动纯粹因为圈外掉血。
4. **人打人的命中判定在客户端**（LAN 信任模型），改客户端可作弊；这与既有 co-op 的信任边界一致，没有变差也没有变好。
5. 破门与投掷物在 versus 下整体关闭，而非改造适配。

---

## 10. 追加实施：AI 小队协同（Team Brain）

### 问题
对抗模式的 AI 是八个各自为战的决斗者：每个兵独立选最近目标，没有集火、没有共享情报、没有推进方向，混战热闹但没有"配合感"。

### 方案：按阵营的小队大脑（`src/systems/ai/teamBrain.js`）

纯逻辑模块，host 独占，每 0.3s 一次。三层配合，按价值递增：

1. **共享情报（共享 lastKnown）**：任一成员"看到"敌人就向全队播报位置，8 秒无刷新则情报过期。这是基础层——没有人单打独斗，接敌后全队向接触点收敛。
2. **集火（priorityTarget）**：阵营层面选**一个**当前有成员可见的目标，全员优先攻击它。评分：残血 +40 > 人类目标 +6 > 距离小队质心近。被集火击杀"感觉是被一支小队打死的"，而不是被八个路人轮流蹭死。
3. **战术焦点（focus）**：小队的公共行动点 = 最后已知的敌方位置；情报过期后退化为毒圈圈心——收缩圈之下敌人必然进圈，朝圈心走是**合理推断而非透视**。

### 防作弊规则（承重墙）
host 能看见一切实体，但 brain 不许用：情报只由成员自己的 `canSee` 刷新；集火目标必须**当前**有成员可见；人类成员的视野用诚实的近似（45m 射程 + 2D 可行走线检测），因为 host 读不到远端玩家真实的视锥。

### 注入方式（最小侵入，三处）
- **per-enemy 目标选择**：`nearestHostileActor(pos, team, brain.priorityTargetId)` ——有集火目标就全队打它，否则各自就近
- **per-faction director**：versus 下 PvE 单实例 director 关闭，每阵营一个实例，评分围绕该阵营的 focus——flank 包抄/情报搜索/掩体评分自动围绕共享计划工作
- **游戏循环**：host 每 0.3s 喂 observe + tick

### 已知局限
1. **没有阵型保持**：兵沿各自路径奔向焦点，可能扎堆——director 的左右翼交替有一定散布效果，但不保证
2. **人类视野是近似**：45m + 直线可行走，比真实视锥宽，等于给 AI 队友的情报略偏乐观
3. **没有保枪/救援/复活配合**：重生制下价值有限，未做
4. **平衡完全未实测**：集火可能让 AI 显得"过准"——如果实测太强，第一个要调的是 WOUNDED_BONUS 和集火的触发概率（当前是 100% 集火，可改为概率性以保留单兵个性）

### 验证
teambrain 单元测试 14 项全过（含防作弊：canSee 为真但 sees 集合为空时不得产生情报/集火）；versus 守卫 20 项全过；全套 6 个测试文件通过；构建通过。
