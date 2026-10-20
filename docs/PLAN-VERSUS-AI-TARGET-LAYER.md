# 双阵营改造方案（精确到行 · 最小侵入 · 行为可回退）

> **只调研，未修改任何代码。**
> 目标：把 PvE 改成双阵营对抗，同时保证**单阵营模式下行为逐帧不变**。
> 读过的文件：`src/systems/ai/perception.js`(327行)、`director.js`(397行)、
> `src/entities/enemy.js`(1817行)、`src/systems/ai/equipment.js`、
> `src/main.js` 的 AI 集成段、`cover.js`、`steering.js`、`tuning.js`。

---

## 0. 最重要的发现：架构已经有一半了

在给方案之前，必须先说一个改变设计走向的事实：

**`enemyCtx.playerPos` 已经是"每个敌人各自重定向"的。**

`src/main.js:4412-4419`（在 `for (const e of enemies)` 循环体内）：

```js
if (net.role === 'host' && net.remote.size) {
  const tgt = nearestLanTarget(e.root.position);   // ← 对每个 e 单独算
  enemyCtx.targetId = tgt.id;
  enemyCtx.playerPos.set(tgt.x, tgt.y, tgt.z);      // ← 覆写共享 ctx
  enemyCtx.playerAlive = tgt.alive;
  enemyCtx.playerSpeed = tgt.speed;
}
```

也就是说：**"当前目标"这个概念已经存在，只是目标集合是"所有人类玩家"且不分敌我。**

这带来一个远比预想小的改造面：
- `perception.js` **完全不需要**多目标扫描——它读的 `ctx.playerPos` 已经是"这个敌人的目标"了
- `enemy.js` 里 40+ 处 `playerPos` 引用**一行都不用改**，因为它们读的是 ctx 里的当前目标
- 真正要改的只有 **3 个"目标是怎么被挑出来的"的地方**

`nearestLanTarget`（`main.js:3810-3824`）目前的问题只有一个：**它不看阵营**，会挑到敌队玩家。
把它改成"只看敌对阵营"这一步，双阵营的骨架就成立了。

**结论**：不需要"重写 AI 目标层"。需要的是**在已有的一条单目标管道上，换掉目标选择器**。
这比上一轮审计的判断乐观得多，但仅限于"AI 能互相攻击"；
"AI 能互相配合完成任务"仍然是另一个量级（见第 6 节）。

---

## 1. `perception.js` — 结论：几乎不用改

### 现状
- `:129` `const player = ctx.playerPos;`
- `:134-137` 对 `player` 算距离/范围
- `:141` `if (ctx.playerAlive && dist < range)`
- `:155-165` `losTimer` 节流 + `e.canSeePlayer(player, dist)`
- `:262-263` `e.lastSeen = {x: player.x, z: player.z}`

### 改法
**不改。** 只需要保证调用方在 `sense()` 之前把 `ctx.playerPos` 设成正确目标。

理由：`perception` 是**纯被动的**：它不追问"目标是谁"，只回答"我当前 ctx 指向的那个点，看不看得见"。
把目标选择权上移到调用方，perception 就自动获得了多目标能力。

### 唯一的可选小改（为了调试可读性，非必需）
`:129` 可改名为 `const focus = ctx.playerPos;`，纯语义化，零行为变化。
**建议改**，因为双阵营下 `playerPos` 这个名字会误导后续维护者。
但这是 cosmetic，可以放到最后一个 commit。

### losTimer 节流（`:153-165`）—— 为什么不需要额外担心
```js
e.losTimer -= dt;
if (inCone && e.losTimer <= 0) {
  e.losTimer = (sniper ? 0.26 : 0.13) + random*0.1;   // ≈7.7 次/秒 (普通)
  visible = e.canSeePlayer(player, dist);              // 56 步 raycast
}
```
关键点：**raycast 次数由 `losTimer` 决定，与目标数量无关。**
因为目标已经在 ctx 里被替换掉了，AI 永远只对**一个**目标做 raycast。

> ⚠️ **性能关键**：如果按"扫描 ctx.targets 选最优"的方式改造，每个敌人每帧就要对 N 个候选做距离+锥体检测，
> 那才是性能爆炸的来源。**本方案刻意不做这件事**（见第 6 节的取舍说明）。

### 破坏单模式行为的改动
**无。** perception.js 在本方案下零改动或仅改局部变量名。

---

## 2. `director.js` — 需要 4 处改动

### 2.1 `tick(dt, enemies, playerPos, tier)`（`:54`）

**现状**：单个 `playerPos` 用于 `:118 distTo`、`:147/:157 signSide`、`:189/:211 intel 散布点`、`:222 updateBreach`、`:284 playerNear`。

**改法（最小侵入）**：**签名不变**，改为传一个"焦点点集合的质心"，但**保留 `playerPos` 作为 fallback**：

```js
// main.js 调用侧（4394）：
aiDirector.tick(dt, enemies, controller.pos, G.diff);
```
改为传 `focusPoint`（敌方阵营单位的质心或最近敌对单位的代表点）。

**关键：不要给 director 传 targets 数组并让它自己选。** director 的 job 是"分配角色"，
它只需要知道"我们的目标大致在哪"。质心即可，避免它变成第二个目标选择器。

> **破坏性判断**：单阵营下 `focusPoint === controller.pos`，**逐帧完全一致**。安全。

### 2.2 `coverReserve` 全局单张 Map（`:46-47, :362-380`）按 team 隔离

**现状**：
```js
this.coverReserve = new Map();     // "x,z" -> enemy
this.coverPointByKey = new Map();  // "x,z" -> {x,z}
```
`requestCover(e, playerPos)`（`:362`）用全局 key `"x,z"`。

**问题**：双阵营下，**红方和蓝方会互相抢同一个掩体点**——一方占了，另一方 `cover.find` 拿不到，
表现为"一方躲掩体、另一方莫名其妙站着挨打"。这是**功能性 bug，不是性能问题**。

**改法（推荐：key 加 team 前缀）**：
```js
// :374 现状
const key = `${pt.x.toFixed(1)},${pt.z.toFixed(1)}`;
// 改为
const key = `${e.team || 0}:${pt.x.toFixed(1)},${pt.z.toFixed(1)}`;
```
**只需改 `:374` 这一行**。`coverPointByKey` / `coverReserve` / `:66-72` 的清理循环
/ `:365-370` / `:384` 全部自动按新 key 工作，**无需改动**。

**副作用评估**：同阵营仍然互斥（保持原语义），不同阵营互不干扰。这正是想要的。

> **破坏性判断**：`e.team` 为 `undefined` 时 `|| 0` → key 变成 `"0:x,z"`，
> 前后一致（所有敌人都是 0），**单模式行为完全不变**。

> **但注意**：如果单模式运行期间有 `team` 为空/为 0 混用的情况会出错。
> 必须保证 `team` 要么统一有值、要么统一 undefined，不能混。

### 2.3 `updateBreach()`（`:266-359`）在双阵营下会怎样

**你的判断是对的：双阵营直接禁用破门。** 我复核并确认这是必须的，理由比"语义不对"更硬：

破门的核心判定 `:284-296`：
```js
const playerNear = Math.hypot(playerPos.x - cx, playerPos.z - cz) < 15;   // 门附近有人？
...
const sideP = (playerPos.z - cz);
if (Math.sign(sideE) === Math.sign(sideP)) continue;   // 敌我必须在门两侧
```
它做的是**"把门打看来够到那个人"**。双阵营下 `playerPos` 是"敌方阵营质心"，
而 `sideE` 是本方士兵位置——**质心根本不在门的那一侧**，`Math.sign` 判断会随机翻转。

后果不是"破门打不开"，而是：
1. 士兵站到门两侧的判定随机化 → 反复改 assigned stacker → 角色抖动
2. `door._aiBreachT` 累积到 2.5s 就开门的机制仍然触发 → **双方 AI 会互相破门**（把己方通道炸开给对面）
3. `breachSupport` 角色（`:316-336`）的"掩护"语义完全错乱

**改法（推荐你的方案）**：在 `tick` 入口加**早退**，而不是在循环里加条件：
```js
// :222 现状
this.updateBreach(step, ground, playerPos);
// 改为
if (!this.breachDisabled) this.updateBreach(step, ground, focusPoint);
```
`this.breachDisabled` 由 main.js 在双阵营开局时置 `true`。

**额外注意**：禁用破门后，`:110-111` 那段"已在 breach 的士兵保持角色"的逻辑和
`:177-180` 的清理逻辑会走空分支，**无害**。但如果切换模式时已有士兵带着
`aiRole='breach'` 和 `breachDoor`，需要主动清：
```js
// 禁用时一次性清理
for (const e of ground) { if (e.aiRole === 'breach' || e.aiRole === 'breachSupport') {
  e.aiRole = null; e.breachDoor = null; } }
```

> **破坏性判断**：单阵营 `breachDisabled` 恒为 `false`，**行为完全不变**。

### 2.4 `signSide(e, playerPos)`（`:393-397`）的抖动风险

**现状**：
```js
return Math.sign(p.x - playerPos.x) || 1;   // 士兵在"目标"的左还是右
```
调用点 `:147`（评分）、`:157`（分配）。

**你的担心是对的，但需要精确定位风险**：这不是"双方相向"才会抖，而是
**当目标在 X 轴上与士兵同列时（`p.x - playerPos.x` 穿过 0）** 就会翻转。

单阵营下这也可能发生（玩家左右横移穿过敌人），但因为玩家通常离屏幕中心较远，
翻转频率低、被 `roleT`（5–9s）稀释，所以**现有表现可以接受**。

双阵营下会显著恶化，因为：
- `focusPoint` 变成**双方质心**，质心位于战场中央，敌我士兵都从左右两侧接近
- 质心本身**静止在中间**，士兵越过质心 X 线 → `signSide` 翻转 → `:159` `this.flankSide` 翻转
- 而 `e.aiSide` 决定 flank 走哪边 → **flank 兵会在两翼之间来回横跳**

**改法（推荐：不要用质心，用"该士兵自己认定的目标"）**
最干净的做法是让 `signSide` 的第二个参数**变成每个士兵各自的目标**：

```js
// :147 与 :157 的调用改为传 focus（每兵自己的目标），而非全局 focusPoint
const candidateSide = signSide(x, x._focus || playerPos);
```
其中 `x._focus` 由 main.js 在 `:4412-4419` 循环里同时写入（和 `playerPos` 一起）。

**次优方案（若不想改 main.js）**：给 `signSide` 加**滞回**——只有越过 ±1.5m 才翻转：
```js
function signSide(e, playerPos) {
  const dx = e.root.position.x - playerPos.x;
  if (Math.abs(dx) < 1.5) return e._lastSide || 1;   // 滞回
  e._lastSide = Math.sign(dx) || 1;
  return e._lastSide;
}
```
滞回能消除抖动，但质心静止的根本问题还在。

> **破坏性判断**：滞回方案会**轻微改变**单阵营 flank 的边分配（只在 |dx|<1.5m 时）。
> 属于可接受但非零的行为变化。若追求"逐帧完全一致"，走 `_focus` 方案。

### 2.5 破坏单模式行为的改动汇总
| 改动 | 行号 | 单模式影响 |
|---|---|---|
| `tick` 焦点改质心 | `:54` 调用侧 | 无（focusPoint === playerPos） |
| cover key 加 team | `:374` | 无（统一 `\|\| 0`） |
| breach 早退 | `:222` | 无（`breachDisabled=false`） |
| `signSide` 滞回 | `:396` | **轻微**（flank 边分配） |
| `signSide` 用 `_focus` | `:147/:157` | 无 |

---

## 3. `enemy.js`

### 3.1 `canSeePlayer` 改名（`:767`）的影响面

**全仓只有 2 个真实调用点**（我 grep 过）：
- `perception.js:157` `e.canSeePlayer(player, dist)`
- `enemy.js:863`（**fallback 分支**，`ai.perception` 不存在时才走，见 `:856-874`）

外加 `cover.js:19` 注释里提到（无代码引用）。

**影响面极小。** 建议**重命名为 `canSeeTarget`**（更准确），并在旧名保留一个 alias：
```js
canSeeTarget(target, dist) { ...原实现... }
canSeePlayer(p, d) { return this.canSeeTarget(p, d); }   // 向后兼容
```
这样 `enemy.js:863` 和 `perception.js:157` **都不用改**，零破坏性。
（如果嫌两个名字冗余，直接改这 2 处也行，我倾向保留 alias 因为成本几乎为零。）

> **参数名注意**：`:771` `const by = playerPos.y != null ? playerPos.y : CHEST_Y;`
> 目标 AI 单位的高度可能不同（如站在集装箱上），`y` 传入方式保持不变即可。

### 3.2 `update(dt,ctx)` 里所有 `playerPos` 引用（完整清单）

`:837` 局部变量绑定 `const playerPos = ctx.playerPos;`

| 行号 | 用途 | 改法 |
|---|---|---|
| `:863` | fallback LOS | 不变 |
| `:867-868` | `e.lastSeen` 写入 | 不变 |
| `:897-898` | `tox/toz` 距离向量 | 不变 |
| `:918` | `requestCover(this, playerPos)` | **建议改为传 `_focus`**（director 里会加 team key，双阵营下 cover 应按各自目标算） |
| `:1009` | `search` 兜底目标 | 不变 |
| `:1047` | 追击目标兜底 | 不变 |
| `:1169` | `search` 寻路目标 | 不变 |
| `:1172` | `advance` 寻路目标 | 不变 |
| `:1191` | `avoidBody(this, playerPos, mv, 1.05)` | 不变（见下方风险） |
| `:1254` | `playerEye` 瞄准高度 | 不变 |
| `:1285-1287` | 三个 fire 更新函数传参 | 不变 |
| `:1289` | `updateSniperWarning(playerPos)` | 不变 |

**关键结论：这 40+ 处一行都不用改。** 因为它们读的 `ctx.playerPos` 已经是"当前目标"。

#### ⚠️ `:1191` `avoidBody` 的真实风险（比预想的具体）
现状：**只避玩家一个人**。这是为了防止 AI 撞死玩家（玩家在 AI 里没有碰撞体）。

双阵营下的问题：如果 AI 的目标是**敌队 AI**，它会从**玩家身上直接穿过去**，
视觉上是"队友从我身体里走出来"，非常出戏。

**改法（最小）**：改成避"所有敌对单位中最近的 1 个"：
```js
// :1191 现状
if (dist > 0.25 && ...) avoidBody(this, playerPos, mv, 1.05);
// 改为：让 main.js 在 ctx 上给一个"最近需要避让的敌对单位"
if (dist > 0.25 && ...) avoidBody(this, ctx.nearestHostilePos || playerPos, mv, 1.05);
```
`ctx.nearestHostilePos` 由 main.js 在 `:4412` 那段循环里一并算出。
**这比遍历所有敌人便宜得多**（本来就是 O(1)），且不会引入 N²。

> **破坏性判断**：`nearestHostilePos` 在单模式/未设置时为 undefined，
> `|| playerPos` 兜底 → **行为完全不变**。

### 3.3 `shoot()` 的 `ctx.damagePlayer` 出口（`:1705 / :1729 / :1760`）

**现状**：3 处同构调用，都传 `this.root.position`：
```js
ctx.damagePlayer(dmg, this.root.position);
```

**改法：新增 `damageActor`，保留 `damagePlayer` 作为 fallback**

不要直接改这 3 行的函数名（会同时影响 main.js 之外的所有调用约定）。
改为加一层：

```js
// 三个 shoot 路径统一改为（helper，放在 enemy.js 内）：
_damageVictim(ctx, dmg) {
  if (ctx.damageActor) ctx.damageActor(ctx.targetEntity || null, dmg, this);
  else ctx.damagePlayer(dmg, this.root.position);   // 向后兼容
}
```

然后把 `:1705 / :1729 / :1760` 三处替换为 `this._damageVictim(ctx, dmg)`。

**为什么保留 fallback 而不是直接改**：单阵营下 `ctx.damageActor` 不存在时
自动走原路径，**单模式行为可证明完全不变**。

**`ctx.targetEntity` 是什么**：main.js 需要在 `:4412` 那段循环里额外写
`enemyCtx.targetEntity = <该目标的引用或描述>`。单阵营下可以传 `null`
（表示"就是本地玩家"），双阵营下传远端玩家的 `net.remote.get(id)`。

**注意 `shoot()` 内部还有大量 `playerPos` 引用**（`:1656, 1691, 1693, 1723, 1725, 1752, 1754`）——
这些是**弹道计算**（往目标点打），只要 `playerPos` 已经是目标位置就**全部正确**，不用改。

> **破坏性判断**：单模式 `damageActor` undefined → 走 `damagePlayer` → **完全不变**。

### 3.4 `takeDamage()`（`:663`）加 `attackerTeam` + 友伤不触发 AI 反应

**现状签名**：`takeDamage(amount, point, normal, part = 'torso')`
**问题**：**签名里没有攻击者**。它只知道"被打"，不知道"被谁打"，所以友伤判定在数学上不可能。

**4 个调用点必须同步改**（我 grep 过）：
- `main.js:2507` 玩家射击
- `main.js:2839` 玩家手雷
- `main.js:2975` 炮击
- `main.js:3878` LAN 远程射击

#### 改法：加第 5 参数 + 早退分支
```js
takeDamage(amount, point, normal, part = 'torso', attackerTeam = undefined) {
  if (!this.alive) return false;

  // ---- 友伤处理（新增）----
  if (attackerTeam != null && attackerTeam === this.team) {
    return this._takeFriendlyFire(amount, point, part);   // 见下
  }
  ...原有逻辑完全不动...
}
```

#### 友伤如何避免触发 `:704-729` 的 AI 反应（这是你问题的核心）

`:704-733` 是"被打后的 AI 反应"，包含 5 组状态：
```js
:707  this.awareness = Math.max(this.awareness, 0.9);   // 立刻锁定射手
:708  this.suppression += 0.14;
:709  this.aimSettle *= 0.45;                            // 瞄准崩溃
:710  this.investigate = {x,z};                          // 去追
:711-715  this.contact = true; acquireT = 0; reactionDelay = ...
:716  this.wantCover = ...;                              // 找掩体
:723-729  if (rifleman && hp<36%) { panicT = 4.2; ... }     // 恐慌
:730-733  this.state = this.canSee ? 'engage' : 'search';
```

**为什么友伤绝不能触发这些**：
1. AI 友军互殴时，`awareness=0.9` + `contact=true` + `investigate=射手位置`
   → **友军会转身去打自己的队友**
2. `wantCover=true` + `panicT` → 友军会莫名找掩体、动作僵硬
3. `state` 被改成 `engage/search` → 友军会脱离当前战术目标
4. 连锁反应：友军互相"警戒"→ `comradeLostT` 上升 → 整个小队士气下降 → 玩家看到 AI 一片混乱

**这比"AI 打不准"严重得多——是"AI 看起来蠢"**。

**推荐策略：友伤 = 掉血 + 轻微硬直，零 AI 反应**

```js
_takeFriendlyFire(amount, point, part) {
  const dmg = amount * (FRIENDLY_MULT || 0.35);   // 友伤减伤
  this.hp -= dmg;
  this.flinch = Math.min(1, this.flinch + 0.25);  // 只有轻微硬直
  this.lastDamage = 0.4;
  // ↓↓↓ 关键：以下全部不碰
  // awareness / suppression / aimSettle / investigate /
  // contact / acquireT / reactionDelay / wantCover / panicT / state
  
  if (this.hp <= 0) { this.die(point, null); return true; }
  return false;
}
```

**只保留 3 个无害的视觉/手感字段**：`hp`、`flinch`、`lastDamage`。
连 `lastHitSide`（`:692-698`）都建议不动——它是"子弹从哪边来"的纯表现。

> **破坏性判断**：`attackerTeam` 为 `undefined` 时友伤分支**完全不进入**，
> 原逻辑 100% 不变。这是安全的。

#### 还需要一个"友伤反馈"
玩家误伤 AI 友军时，如果**完全无反馈**，玩家会困惑"为什么打不中人/为什么血不掉"。
建议：`main.js:2507` 调用处，若判定为友伤，HUD 弹一个轻提示
（"友军 · 停止射击"），复用现有的 `hud.toast()` 或 `barks` 机制。

---

## 4. `equipment.js` — 你的判断成立，改动点如下

### 现状
- `:47-51` 构造参数含 `damagePlayer`（注入的玩家伤害回调）
- `:280` `if (dmg > 1) damagePlayer(dmg, pos);` —— **手雷只对玩家生效**
- `:211` `tryThrow(dt, ctx)`，`ctx` 里含 `playerPos` / `enemies` / `tier`
- `:428` `tryThrow(dt, ctx)` 是 `update()` 内部唯一调用点
- `:130-136` `friendlyNear(live, x, z, r)` —— **已存在的"友军"概念**，但只用于"别往自己人脚下扔"

### 结论：**双阵营下友军 AI 不投掷物，改动只需 1 处**

**为什么这个方案是对的**：
1. `tryThrow` 是**全队级**（一个 ctx，一次决策选一个 thrower），不是每兵独立
2. `damagePlayer` 是**闭包注入**的，改造它需要重新设计整个伤害出口
3. 手雷友伤会立刻引爆 3.4 节的友伤处理 + 手雷 AOE 的敌我判定，是复杂度最高的坑
4. **AI 不扔雷对玩家几乎不可察觉**（玩家忙着打人，不会数对面扔了几个雷）

**最干净的加判断位置**：`main.js:4395`（调用侧），而不是动 `equipment.js`：

```js
// main.js:4395 现状
if (equipment && !SHOT_MODE && !(net.role === 'host' && net.remote.size > 0)) {
  equipment.update(dt, {...});
}
// 改为（新增一个与既有条件同级、且可回退的条件）
if (equipment && !SHOT_MODE
    && !G.versusMode                       // ← 新增：双阵营下不投掷物
    && !(net.role === 'host' && net.remote.size > 0)) {
```

**为什么不改 `equipment.js` 内部**：
- 改内部需要在 `tryThrow`/`throwUtility`/`explode` 三层都加 team 判断
- 改内部会让 `equipment.js` 在**任何模式**下都多一层判断（即使单模式也是无用开销）
- 调用侧一个 flag 就能**完全跳过整个子系统**，性能也更好

**注意 `friendlyNear`（`:130-136`）不需要改**：它遍历的 `live` 是同侧士兵列表，
在"只用敌方阵营的 `enemies`"的前提下语义自然正确。

> **破坏性判断**：`G.versusMode` 单模式恒为 `false/undefined` → **行为完全不变**。

---

## 5. `main.js` 的 `enemyCtx` 与 `nearestLanTarget`

### 5.1 `nearestLanTarget()`（`:3810-3824`）—— 核心改动点

**现状**：从"自己 + 所有 `net.remote`"里挑最近的存活者，**不看阵营**。

**改法**：加 team 过滤 + 返回 team 信息。

```js
// 现状签名
function nearestLanTarget(pos) { ... }

// 改为
function nearestLanTarget(pos, selfTeam) {
  // 只在 selfTeam 的**敌对**阵营里挑
  for (const r of net.remote.values()) {
    if (!r.alive || r.hp <= 0) continue;
    if (r.team === selfTeam) continue;          // ← 新增：跳过友军
    ...
  }
}
```

**`selfTeam` 从哪来**：本地玩家在 `net` 对象上加一个 `net.team`（由 host 分配）。
**AI 士兵的 team 从哪来**：`e.team`（`enemy.js` 构造时写入，见 3.4）。

**返回值建议增加 `team` 和 `isRemote` 字段**，供 `:4412` 那段循环写入 ctx。

> ⚠️ **回退保护**：如果 `r.team === undefined`（老快照/单人），上面的 `===` 比较为 false，
> **会被当成敌对**。这在单人 LAN（所有人同阵营）下是**错的**——会互相打自己人。
> 必须处理：`if (selfTeam != null && r.team != null && r.team === selfTeam) continue;`
> 即**只有双方都有 team 时才过滤**。这条非常重要，务必实现。

### 5.2 `enemyCtx` 构造（`:3423` 附近）+ `:4412-4419` 循环

**现状**：
- `:3423` `playerPos: new THREE.Vector3()` —— 一个**共享的 Vector3**
- `:4382-4383` 每帧算 `playerDirX/Z`（射击提前量）
- `:4412-4419` 在 per-enemy 循环里覆写共享 ctx

**改法**：在同一段循环里**多写 2 个字段**（不新增循环、不改结构）：

```js
// :4412-4419 现状已重定向 playerPos，新增同样 2 行
if (net.role === 'host' && net.remote.size) {
  const tgt = nearestLanTarget(e.root.position, e.team);
  enemyCtx.targetId = tgt.id;
  enemyCtx.playerPos.set(tgt.x, tgt.y, tgt.z);
  enemyCtx.playerGroundY = tgt.y;
  enemyCtx.playerAlive = tgt.alive;
  enemyCtx.playerSpeed = tgt.speed;
  // ↓↓↓ 新增
  enemyCtx.targetTeam = tgt.team;              // 给 shoot/damage 用
  enemyCtx.targetEntity = tgt.ref || null;     // 给 damageActor 用
}
```

**还要新增 `ctx.nearestHostilePos`**（供 3.2 的 `avoidBody`）：
在同一循环里，若 `tgt.id === 'local'`（目标是本地玩家）→ 不变；
若目标是远端 → `enemyCtx.nearestHostilePos` 取一个"除当前目标外最近的敌对单位"。
> **成本提示**：如果只想做最小版本，这一行可以先不加，让 AI 继续只避 `playerPos`。
> 代价是"AI 会从玩家身体里穿过去"，视觉出戏但不影响对局正确性。**建议先不做，等核心跑通再补。**

### 5.3 `:4382-4383` 的 `playerDirX/Z`（射击提前量）—— 双阵营下是错的

**现状**：
```js
enemyCtx.playerDirX = (enemyCtx.playerDirX||0)*0.5 + (dx/dl)*0.5;   // 玩家的移动方向
```
`shoot()`（`enemy.js:1657-1658`）用它算**提前量**：AI 射击时按目标运动方向补偿。

**问题**：双阵营下目标是远端玩家，但 `playerDirX/Z` **永远是本地玩家的方向**。
→ **AI 对远端目标的提前量完全错误**，命中率会明显下降。

**改法**：在 `:4412` 循环里，如果 `tgt` 是远端，用**上一帧该远端的位置差**算方向：
```js
// 远端目标的方向来自 snapshot 的历史差分，而不是本地玩家
if (tgt.ref) {
  const dxr = tgt.x - (tgt.prevX ?? tgt.x);
  const dzr = tgt.z - (tgt.prevZ ?? tgt.z);
  const dl = Math.hypot(dxr, dzr);
  if (dl > 0.1) { enemyCtx.playerDirX = dxr/dl; enemyCtx.playerDirZ = dzr/dl; }
}
```
`prevX/prevZ` 在 `applyLanInput`（`main.js:3736`）里顺手存一份即可。

> **不做会怎样**：AI 仍能打到远端玩家（`hitChance` 里 `dist` 项还在），
> 只是**远距离命中率下降**，近距离无影响。属于"能玩但手感差"，**可以延后**。

---

## 6. 总体改造顺序与风险

### 建议的 6 步（每步可独立验证、可回退）

| 步 | 内容 | 触及文件 | 单模式风险 | 可回退性 |
|---|---|---|---|---|
| 1 | `e.team` 字段 + `net.team` + `nearestLanTarget` 加 team 过滤 | enemy.js, main.js | **无**（老快照 team=undefined 时不过滤） | 单 flag 关闭 |
| 2 | `takeDamage` 加 `attackerTeam` + 友伤分支（零 AI 反应） | enemy.js, main.js×4 调用点 | **无**（undefined 不进分支） | `FRIENDLY_MULT=0` 即完全免疫 |
| 3 | `canSeeTarget` 改名 + 保留 alias | enemy.js, perception.js | **无**（alias 保留） | 纯重命名 |
| 4 | director：cover key 加 team + breach 禁用 | director.js | **无**（team 统一 `||0`，flag 默认关） | `breachDisabled` flag |
| 5 | equipment 双阵营跳过 | main.js 一行 | **无**（flag 默认关） | `G.versusMode` flag |
| 6 | `signSide` 修法 + `avoidBody` 扩展 + 提前量修正 | enemy.js, director.js, main.js | **轻微**（step 6a 的 flank 分配） | 各有 fallback |

### 回退总开关建议
在 `G` 上放一个 `G.versusMode`（默认 `false`），步骤 1/4/5 的所有新行为都挂在它下面。
**关掉它 = 精确回到今天的单阵营行为**。这比逐处 `if` 更好维护。

---

## 7. 本方案**没有**解决的问题（重要）

### 7.1 AI 不能互相"配合"
本方案让 AI **能互相攻击**（bot-vs-bot），但它们**不共享战术意图**：
- `director` 是**单实例**（`main.js:167, 3450`），按阵营切成两实例是另一件事
- 目标选择是"最近的敌对单位"，没有"集火"、"优先击杀残血"、"保护某人"的概念

→ **实际表现会是**：两边各自就近攻击，混战热闹但**缺乏配合感**。
这和"两支队伍对抗"有差距，但**已经比"一群人打人"有明确敌我**。

### 7.2 里程碑链（我上一轮做的）在对抗模式下会失效
`src/systems/milestones.js` 的 `kill` 型步骤统计的是**敌人死亡数**，
`onEnemyKilled` 里被调用。双阵营下"杀敌"变成了"杀对面玩家"，
但**AI 击杀不会触发玩家的里程碑**（`notifyKill` 只在玩家击杀时调用）。

→ 对抗模式下里程碑要么**只保留非致命步骤**，要么需要改成阵营目标。
**这是一个已知的集成缺口**，不是本方案的 bug。

### 7.3 性能没有实测
我**没有运行游戏**测量。以下都是静态推断：
- 8 AI 士兵 × 2 阵营，`director.tick` 每 0.3s 跑一次，量级仍是个位数
- `separate()`（`steering.js:17`）遍历 `ai.neighbors`（= 全部 `enemies`，`main.js:3452`）
  → 友敌混合时是 O(N²)，N=16 时 256 次/帧，**可接受但值得实测**
- `canSeeTarget` 的 raycast 次数**不受目标数量影响**（见第 1 节），这点是确定的

### 7.4 平衡数值全部缺失
AI 难度参数 `tuning.js` 的 `AI_BEHAVIOR`（D1–D5）是**按"打玩家"调出来的**。
用同一套参数让 AI 互殴，胜率/节奏完全未知，需要独立的平衡测试。

### 7.5 网络同步的连带影响
- `sendLanSnapshot` 的 `players` 需要带 `team`（`main.js:3900-3913`）
- 房主迁移 `promoteToLanHost`（`:3937-3970`）需要恢复 team 记账，
  **否则换房主后全员同队 → 友伤判定失效 → 变成友军互殴**
- `LAN_PROTOCOL_VERSION`（`lanProtocol.js:23`）是**死代码，无版本协商**，
  加 team 字段属破坏性变更，建议顺手实现版本握手

---

## 8. 关键判断依据（为什么这样建议）

1. **不重写感知层** —— 因为 `main.js:4412-4419` 已经在 per-enemy 重定向 ctx，
   感知层天然支持"一人一目标"。改成"扫描 targets 选最优"看似通用，实则会把
   raycast 成本从 O(1)/兵 变成 O(N)/兵，是**主动制造性能问题**。

2. **友伤必须零 AI 反应** —— `takeDamage:704-733` 的 5 组状态（awareness/contact/
   investigate/wantCover/panicT）本质是"我被敌人打了"，
   友伤触发它们会让 AI 互相警戒，看起来极蠢。这是**表现层 bug，不是数值 bug**，
   所以用"早退 + 只保留 hp/flinch"而不是"加标志位跳过部分"——后者容易漏。

3. **破门直接禁用而非改造** —— `updateBreach:284-296` 的判据是"目标在门的另一侧"，
   在"目标=质心"的前提下这个几何前提不成立。改造它需要重写门的语义，
   收益（AI 破门）远低于风险（双方互破门）。

4. **`canSeePlayer` 影响面只有 2 处** —— 所以保留 alias 几乎零成本，
   没必要为了"改名干净"而去改 2 个调用点并承担漏改风险。

5. **equipment 在调用侧禁用而非内部改造** —— `tryThrow` 是全队级单点，
   `damagePlayer` 是闭包注入；改内部需要三层 team 判断，
   而调用侧一个 flag 能**完全跳过子系统**，单模式零影响。

---

## 9. 诚实的总结

- **能让 AI 互相攻击**：可以，改动面比预想小（因为 ctx 重定向架构已存在）
- **能让两队有战术配合**：本方案做不到，需要 per-team director + 共享目标语义
- **能让里程碑在对抗模式下正常工作**：需要额外处理（见 7.2）
- **能保证单模式逐帧不变**：可以，靠 `undefined` 兜底 + `G.versusMode` 总开关
- **性能**：静态推断可接受，但**必须实测**
- **平衡**：完全没有，需要独立的调参轮次

我不会说做完这套就"有完整的双阵营对抗玩法"。它是**从 PvE 跨到 PvP 的必要地基**，
不是终点。地基之上还需要：per-team director、AI 目标优先级、平衡、里程碑重设计。