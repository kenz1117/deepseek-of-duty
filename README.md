<div align="center">

<img src="docs/cover.jpg" width="100%" alt="DEEPSEEK OF DUTY">

**在浏览器里运行的第一人称射击垂直切片** — Three.js 渲染 · 全程序化资产 · 打开网页即玩

[![Three.js](https://img.shields.io/badge/Three.js-r169-049EF4?style=flat-square&labelColor=1a1a2e)](https://threejs.org/)
[![WebGL2](https://img.shields.io/badge/WebGL-2-990099?style=flat-square&labelColor=1a1a2e)](https://www.khronos.org/webgl/)
[![零外部资产](https://img.shields.io/badge/资产-100%25程序化生成-orange?style=flat-square&labelColor=1a1a2e)](##-技术栈与特性)

**[![在线试玩](https://img.shields.io/badge/🎮_在线试玩-dod.goodpoint.top-success?style=for-the-badge&labelColor=1a1a2e)](https://dod.goodpoint.top/)** · 无需下载注册，桌面浏览器打开即玩

</div>

---

<div align="center">

## 🎬 实机演示

*波次推进 · 街区攻坚*

![实机演示](docs/dod-gameplay-preview.gif)

**[▶ 观看 55 秒完整演示视频](https://github.com/kenz1117/deepseek-of-duty/blob/main/docs/dod-gameplay-720p.mp4)**（720p · 13MB，打开即是播放器）

<br>

<img src="docs/screenshot-street.jpg" width="49%" alt="黄昏街区的推进路线"><img src="docs/screenshot-overview.jpg" width="49%" alt="关卡全景">

*黄昏街区的推进路线 · 关卡全景（AL-MAZRAH CROSSING）*

</div>

> **诚实的边界**：这不是、也不可能是《使命召唤》的替代品。真正的 3A FPS 由数百人团队、自研引擎、数亿美元预算、实拍扫描资产、动作捕捉、烘焙全局光照与主机级 GPU 管线支撑。本项目是在浏览器 WebGL2 + 单文件程序化资产的约束下，把能做的部分做到尽量好。它不会在盲测中"打败"CoD；它是一份可运行、可交互、可继续迭代的工程与美术样本。

---

## 🎮 在线试玩

**地址：[https://dod.goodpoint.top/](https://dod.goodpoint.top/)**

- 推荐 **Chrome / Edge** 桌面版，性能预算面向桌面独显 / Apple Silicon
- 点击页面 → 进入指针锁定 → WASD 移动、鼠标射击；`Esc` 暂停释放鼠标
- 低端设备请在菜单 SETTINGS 或暂停菜单切换画质（LOW / MED / HIGH / ULTRA）

## 操作

> 主菜单点击 **START** 会先打开「战前教学」弹窗，确认后再进入战区；操作键位也在该弹窗内。弹窗内勾选「不再自动提示」后，下次 START 直接进入；菜单 **BRIEFING / 教学** 可重新打开并取消勾选。

| 键位 | 功能 | 键位 | 功能 |
| --- | --- | --- | --- |
| `WASD` | 移动 | 鼠标左键 | 射击 |
| `Shift` | 冲刺 | 鼠标右键 | 瞄准（ADS） |
| `Ctrl` / `C` | 蹲伏 | `R` | 换弹 |
| `Space` | 跳跃 | `1` / `2` | 切换武器（M4A1 / MK18） |
| `G` | 投掷手雷 | `F` | 检视武器 |
| `Esc` | 暂停 | | |

## 🗺️ 游戏模式

主菜单自选，START 前的「战前教学」弹窗里也有每个模式的详细简报：

| 模式 | 玩法 |
| --- | --- |
| **ROTATION · 标准轮换** | 每 3 波进入防守（目标区累计守住 60 秒），每 5 波进入撤离（清空后按住撤离区 8 秒），其余为生存波次；目标区在街区、后院与市场之间轮换 |
| **SURVIVAL · 无尽生存** | 没有目标点，只有不断加码的波次，活多久打多久 |
| **DEFEND · 区域防守** | 每一波都要进黄色目标区累计守 60 秒，离开区域会衰减，清空区域时敌军补充增援 |
| **EXTRACT · 清场撤离** | 先清空当前区域，再进撤离区按住 8 秒；撤离区可能出现在左巷、工坊或市场内部 |

## 🎯 战术循环（战地拾取 / 连杀奖励 / 每日挑战 / 排行榜）

一局之内现在有完整的「击杀 → 补给 → 奖励 → 结算 → 留名」闭环：

| 系统 | 说明 |
| --- | --- |
| **战地拾取** | 敌人有概率掉落弹药箱（+90 发）、护甲（+25）、手雷（+1）；连杀奖励会空投补给箱（弹药 +60 / 护甲 +20 / 手雷 +1）。靠近自动拾取，屏幕下方给出提示 |
| **武器掉落** | 被击杀的敌人有 55% 概率把步枪掉在地上（带初速度、落地弹跳、25 秒后回收），同屏最多 8 把；只是视觉与氛围，不可拾取、不供弹 |
| **连杀奖励** | 4 杀 → 补给空投，7 杀 → UAV（12 秒罗盘红色菱形标记所有活敌），11 杀 → 炮火覆盖（7 发错峰炮弹，落点为你视线前方的地面）；炮火击杀不再回馈连杀，避免级联 |
| **每日挑战** | 按本地日期从 7 个目标里确定性抽 3 个（爆头 / 手雷击杀 / 无伤清波 / 累计击杀 / 单局高分 / 目标模式 / 摧毁掩体），进度累计并存本地；1/2/3 项完成分别给「开局 +1 手雷 / +20 护甲 / 当日得分 ×1.1」 |
| **排行榜** | 主菜单底部 **RANKING** 终端展示当前模式 Top 100（滚到底自动加载下一页），结算页展示本局 Top 8，带来源徽章（ONLINE / LOCAL / CACHE）与「你的最佳 · 当前名次」，自己那行高亮；提交后可改呼号（幂等重提，不会重复计数）。**默认走同源 `/api`，服务端未部署时自动降级为本地榜** |

### 首页作战终端（Sprint D 改版）

主菜单现在的结构：左上 logo → 模式选择 → **动态模式简报**（标题 / 描述 / THREAT / AO / CONTACT，切换模式时淡入）；底部一行横跨页面：**RANKING 终端**在左，**START + SETTINGS / TUTORIAL / GITHUB**在右（靠页面右缘、与终端底边对齐，各 356px），操作区落在人物下方的暗部，不再压住人物。终端默认停在 RANKING，让排行榜在第一屏就能看到：

| 标签 | 内容 |
| --- | --- |
| **BRIEFING · 简报** | 当前模式的威胁 / 区域 / 接触强度 + 一句话战术提示（原 brief-panel） |
| **RANKING · 排行榜** | 当前模式 Top 100（窗口内 6 行，每页 20 条，滚轮 / PageDown 到底自动拉下一页；名次 / 呼号 / 得分 / 波次 / 击杀），底部「你的最佳：3,800 · W7 · 当前 #3」，自己那行琥珀高亮；右上角徽章标出 ONLINE / LOCAL / CACHE |
| **模式简报（常驻）** | 原 START 的位置改为当前模式的标题、一句话描述与 THREAT / AO / CONTACT，随模式切换淡入；BRIEFING 标签保留同一份信息的完整版 |
| **DAILY · 挑战** | 今日 3 个挑战与进度条（从 START 下方移入终端，给主按钮让出空间） |

START 按钮带 `READY` 状态与扫描线/角标动效，菜单整体使用 26px 琥珀十字准星光标（输入框保留文本光标）。终端右侧是 **CALLSIGN**：点击即可改名，回车保存、Esc 取消；非法输入会提示规则并保留原值。

### 榜单是异步快照，不要求服务端与游戏同时在线

- 打开菜单或切换模式时，先画本地镜像，再后台拉取；**45 秒内复用缓存**，点来源徽章可强制刷新。
- 分页：每页 20 条，滚到底自动请求下一页，最多 100 条；到底显示「已到底 · 共 N 名」，加载中显示「加载中…」。已加载的页会合并进本地镜像（按 runId 去重、最多 100 条），断网也能翻。
- 徽章含义：`ONLINE` = 本次拉取成功；`CACHE` = 显示的是上次成功快照；`LOCAL` = 没有远端数据。
- 脚注始终标出数据新鲜度：`同步 21:30` 或 `未同步`；离线提交会显示 `待补交 N`（outbox 最多 20 条，联网后自动补交）。
- 榜单是**历史最好成绩**，不是在线玩家列表；服务端离线不影响游戏，也不会把已有榜单清空。

### 呼号（用户名）怎么存

- 首次进入自动生成 `OPERATOR-XXX`（取本机随机 `client id` 的后 3 位，共 12 字符上限）。
- 保存在 `localStorage['dod.callsign.v1']`；点 CALLSIGN 改名即时写入。提交成绩时随 run 一起发给服务端，服务端按 1–12 位清洗后写进榜单条目。
- **没有账号、密码或登录**：同一个浏览器 + 同一份 localStorage 就是同一个身份；换设备、清缓存、无痕窗口都会得到新的 client id 与呼号。
- 改名只影响之后的提交；已入榜的旧记录不会回溯改名。结算页改名会用同一 `runId` 幂等重提，只更新这一条。
- 只收集随机 client id 与呼号，不采集邮箱、手机号或设备指纹。

## ✨ 技术栈与特性

- **渲染**：Three.js r169，WebGL2，PBR + IBL（PMREM 程序化天空）、ACES Filmic 色调映射、4×MSAA；半分辨率 SSAO 接触阴影（高/超高画质，贴花/天空/玻璃/积水不参与）。
- **后期**：UnrealBloom → ACES/sRGB → 自定义终级 Pass（对比/分离色调/去饱和、暗角、色差、胶片颗粒、USM 锐化、屏幕空间体积光、镜头光晕/横向光条、冲刺径向模糊、受伤/低血量/命中闪屏）。
- **天空**：解析太阳 + 多层 FBM 云 + 地平线尘霾；同一着色器生成 PMREM 环境贴图，PBR 材质获得一致 IBL。
- **材质**：全部 Canvas 程序化生成（混凝土/沥青/灰泥/砖/立面窗格/卷帘门/金属/锈/沙袋/帆布/木材/遮阳篷/招牌/涂鸦/污渍/纸张/杂草/棕榈叶…），并派生法线/粗糙度贴图；世界空间 UV 投影保证纹理密度一致。
- **关卡**：街区「AL-MAZRAH CROSSING」+ 可进入的后院与室内——低角度逆光、沿街建筑、窗洞进深、阳台/空调/消防梯/电缆/商铺、破车、沙袋、路障、瓦砾、积水、火焰桶；**后院**（世界边界 x±30）带 7×8m 市场棚屋（第三处 CQB，双入口）、**屋顶闭环路线**（坡道 → 3.2m 甲板 → 猫道 → 跳回后院）；**可破坏掩体**（木箱/沙袋堆/路障，打碎出碎片）。
- **武器**：程序化 M4A1 / MK18；1k 程序化武器/手部图集（氧化金属/聚合物/皮革手套/织物袖口 2×2 分区，含划痕/掉漆/缝线/磨损细节）；瞄具为中空框 + 红点分划；呼吸、行走摆动、冲刺收枪、ADS、后坐弹簧、换弹（弹匣掉落/上推/拉机柄）、检视；克制冷色 rim 光。武器在独立场景渲染，永不穿墙。
- **敌人**：分层战术装具士兵、双段腿/手臂、行走/奔跑/瞄准/蹲伏/受击/**ragdoll 倒地**；AI 具备视线判定（含屋顶甲板遮挡）、推进、掩体、侧移、点射、压制与手雷伤害反应；**Wave 3 起出现屋顶狙击手**（激光提示、锁定掩体后站位）。
- **特效**：GPU 火花/浮尘、实例化曳光/弹孔/血渍、枪口焰三层、爆炸火球/烟柱/冲击波/碎片、大气雾壳。
- **音频**：Web Audio 全合成（分层枪声、换弹 foley、脚步、弹着、跳弹、爆炸、心跳、环境风/远处交火），程序化卷积混响。
- **UI**：CoD 风格 HUD（罗盘、动态准星、命中/爆头、击杀播报、弹药刻度、护甲/血量、受击方向、波次/目标、连杀计数、UAV 倒计时、拾取提示）、程序化主菜单（logo 与人物立绘均为生成资产、底部 BRIEFING/RANKING/DAILY 作战终端与呼号编辑）、**战前教学简报**（按模式给目标/威胁/提示）、**结算页**（个人数据 + 排行榜 + 今日挑战 + 呼号）、部署/暂停/阵亡界面。
- **数据与联网**：本局统计（击杀/爆头/命中率/无伤波次/可破坏物）→ 生涯档案与每日挑战存 `localStorage`；排行榜客户端 `src/net/leaderboard.js` 走同源 `/api`，带超时、离线队列（outbox）与本地镜像，服务端 `server/leaderboard.mjs` 为零依赖 Node 服务（ticket/HMAC + 数值一致性校验 + 每 IP 限流 + 单 JSON 原子落盘）。**它不是反作弊**，见「已知局限」。

## 🚀 本地运行

```bash
npm install          # 首次
npm run dev          # http://127.0.0.1:5173
```

生产构建：`npm run build` → `dist/`（任意静态服务器可托管）。

### 排行榜服务（可选）

不启动也能玩：前端会自动降级成本地榜（LOCAL）。要跑通联网榜：

```bash
# 终端 1：服务端（默认 8787，数据落到 server/data/）
LB_SECRET=dev-secret LB_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:5174 \
  node server/leaderboard.mjs

# 终端 2：前端指向本地 API
VITE_LEADERBOARD_URL=http://127.0.0.1:8787/api npm run dev
```

服务端契约、systemd / nginx 配置与运维说明见 [`server/README.md`](server/README.md)，冒烟测试 `node tools/lb-smoke.mjs`。

### 部署（仅本地手动）

线上地址 [dod.goodpoint.top](https://dod.goodpoint.top) **只接受维护者本机发起的部署**

```bash
scripts/deploy.sh              # 构建 → 推送 GitHub → 同步服务器 → 健康检查（失败自动回滚）
SKIP_GIT=1 scripts/deploy.sh   # 只同步服务器，不动 git
```

服务器侧架构与脚本见 `deploy/`（Dockerfile、Nginx 配置）与 `scripts/server-deploy.sh`（原子切换 + 自动回滚）。服务器拉不动 Docker Hub，Dockerfile 基于本机已有 alpine 基础镜像构建，勿改回 `FROM nginx:...`。

**排行榜是独立进程，不在 `dist/` 里。** 静态站只加一个反向代理即可（`proxy_pass` 末尾不要带 `/`）：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
}
```

完整 unit 文件、权限、回滚与排障见 [`server/README.md`](server/README.md)。

## 🤝 欢迎共创

这是一个开放的水平切片项目，欢迎各种形式的参与：

- **试玩反馈** → [提 Issue](https://github.com/kenz1117/deepseek-of-duty/issues/new)：手感、性能、Bug、兼容性（附浏览器与显卡信息更好）
- **代码贡献** → Fork + PR。热门方向：敌人 AI 寻路（navmesh）、更多武器/关卡、GTAO 与 TSR/FSR、角色骨骼蒙皮与动画状态机、程序化贴花分层、移动端适配、排行榜的服务端权威判定/账号体系
- **美术 / 音频** → 本项目全部资产都是程序化生成的，欢迎来挑战新的生成算法（材质、天空、音效合成……）
- **开发工具** → `tools/shoot.mjs`（headless Chrome 确定性截图）、`tools/record.mjs`（实机录制）均可复用

> 📌 **部署安全边界**：服务器不接入任何 CI/CD 自动部署。所有 PR 合并后仅存在于仓库中，由维护者本地验证后手动发布——你的贡献不会在未经人工验证的情况下上线。

## 📁 目录结构

```
index.html                 入口 + HUD/菜单 DOM
src/main.js                游戏循环、状态机、射击/波次/伤害/手雷
src/style.css              HUD / 菜单 / 覆盖层样式
src/core/engine.js         渲染器、场景、相机、太阳/阴影、IBL、overlay pass
src/core/sky.js            程序化天空着色器 + PMREM 环境
src/core/postfx.js         后期链（bloom / grade / grain / god rays / flare）
src/core/materials.js      程序化 PBR 纹理库
src/core/geo.js            UV 投影 / 静态合批工具
src/core/input.js          指针锁定 / 键鼠
src/core/audio.js          程序化音频引擎
src/core/profile.js        生涯统计、每日挑战、呼号与每局计数
src/world/level.js         街区、建筑、道具、碰撞、火焰、尘埃
src/world/pickups.js       战地拾取物 + 掉落武器（池化、限数量）
src/player/controller.js   移动/碰撞/镜头/后坐/震屏
src/player/viewmodel.js    武器模型、双手、程序化动画、独立渲染场景
src/entities/enemy.js      士兵模型、动画、AI、命中盒、ragdoll
src/systems/streaks.js     连杀计数与 4/7/11 奖励逻辑（纯状态）
src/systems/artillery.js   炮火覆盖：错峰炮弹、落点 FX、伤害回调
src/net/leaderboard.js     排行榜客户端（在线 + 本地镜像 + 离线队列）
src/fx/fx.js               火花/烟/曳光/弹孔/血/爆炸
src/fx/atmosphere.js       浮尘与大气雾壳
src/ui/hud.js              HUD 逻辑与 Canvas 绘制（含连杀/UAV/提示）
src/ui/results.js          结算页：个人数据、排行榜、今日挑战、呼号
server/leaderboard.mjs     零依赖排行榜服务（ticket/校验/限流/JSON 落盘）
server/README.md           服务端契约与 systemd / nginx 部署说明
tools/shoot.mjs            headless Chrome + CDP 确定性截图工具
tools/record.mjs           实机录制工具（视频演示用它生成）
tools/lb-smoke.mjs         排行榜接口冒烟测试（17 项断言）
scripts/deploy.sh          一键部署（构建 → 推 GitHub → 同步服务器 → 健康检查）
scripts/server-deploy.sh   服务器端原子部署（时间戳镜像 + 自动回滚）
REPORT.md                  开发报告：各 Sprint 交付清单与实测数据
```

## 已知局限 / 下一步

**画面与内容**

- 无真实扫描资产与动作捕捉；角色与武器仍是手工程序化几何，近景细节有限。
- 无全局光照/SSR/真实软阴影；接触阴影为半分辨率 SSAO，光照为单方向光 + IBL + 少量点光。
- 无动画状态机资源、无配音/配乐；无网络多人（排行榜只是单人成绩榜）。
- 敌人寻路为转向 + AABB 推挤，无 navmesh；复杂地形会卡角。
- 性能预算面向桌面独显/Apple Silicon；低端设备请切画质（SETTINGS 或暂停菜单内 LOW/MED/HIGH/ULTRA）。

**Sprint D 新增系统的边界**

- **排行榜不是反作弊。** ticket/HMAC、数值一致性、限流只能挡脚本乱刷与明显造假；改客户端内存后提交一组「自洽的假数字」仍会入榜。真正防护需要服务端权威模拟或回放，本项目没有。
- 服务端是**单进程 + 单 JSON 文件**，不支持多实例；每模式只保留 Top 50，跌出后查不到个人最佳；`X-Client-Id` 可伪造，不是账号体系，也没有跨设备同步。
- 呼号只存在本机 `localStorage`，没有账号/登录/找回：换设备或清缓存即换身份；改名不会回溯已入榜的旧记录。要真正跨设备，需要账号体系与服务端身份绑定（未实现）。
- 榜单是异步快照：断网时显示 `CACHE` / `LOCAL` 与上次同步时间，离线成绩进 outbox 等待补交；页面不会因为服务端不可达而卡住或空白。
- 拾取物不会自动重生；掉落武器**不可拾取、不供弹、不参与碰撞**（落地只做边界夹取）。10 个拾取 + 8 把掉落最坏约 +62 主 pass draw call（实测 10 个补给箱 +50 calls），所以有硬上限与 25 秒回收。
- 每日挑战按**本地日期**生成，改系统时间可以重刷；进度只存在本机浏览器。
- 炮火覆盖不做真实弹道与建筑遮挡：炮弹从高空垂直落下，屋檐边缘可能穿模；非屋顶区的高处结构不会被识别为落点。
- 若继续推进：角色骨骼层级与蒙皮、武器动画曲线、程序化贴花分层、GTAO、TSR/FSR、更多关卡与模式；排行榜的服务端权威判定与账号体系。

> 📝 完整的开发迭代记录（Sprint 2 / B / B2 / C / D 的交付与实测数据）见 [REPORT.md](REPORT.md)。

---

<div align="center">

**[🎮 立即在线试玩](https://dod.goodpoint.top/)** · 觉得有意思就点个 ⭐ 吧

</div>
