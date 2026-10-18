# deepseek-of-duty 联网排行榜服务

零依赖 Node 服务：`server/leaderboard.mjs` + 单 JSON 文件存储。
配套前端客户端：`src/net/leaderboard.js`；本地冒烟测试：`tools/lb-smoke.mjs`。

> **先说清楚：这不是反作弊。**
> 客户端是浏览器游戏，玩家可以改内存、改请求。本服务能做的只有：
> 一次性 HMAC ticket（挡住手搓请求、限制提交节奏）、数值上限与一致性检查
> （挡住明显离谱的记录）、按 IP 限流（挡住脚本乱刷）。
> 一个改过的客户端仍然可以提交“数值自洽的假成绩”，本服务无法分辨。
> 真正要防刷分，必须把判定搬到服务端（服务端权威模拟 / 回放校验），本项目没有做，
> 也不要在任何对外的文案里宣称“防作弊”。

---

## 1. 部署边界：静态站和 API 是两件事

- `npm run build` 只把 `index.html`、`src/`、`public/` 打成静态 `dist/`。
  **`dist/` 不包含 `server/`**；排行榜服务必须单独部署并由进程管理器守护。
- `src/net/leaderboard.js` 是浏览器模块，会被 Vite 打包进 `dist/`，但它只是客户端，
  真正决定榜单内容的是服务端。
- `server/data/leaderboard.json` 是运行时数据，不应提交进仓库。

当前站点（`https://dod.goodpoint.top`）是 nginx 反代静态容器。给榜单加 API 时，
**不改现有 server 块结构，只加一个 `location /api/`** 指向本服务即可（见第 7 节）。

---

## 2. 快速启动

要求 Node.js ≥ 18（服务端只使用 `node:http`、`node:crypto`、`node:fs`、`node:path`、
`node:url` 等内置模块；实际验证环境为 v24.20.0）。
不需要 `npm install`，服务端只用 Node 内置模块。

```bash
# 最简：使用默认值（127.0.0.1 之外的网卡也会监听，见“已知局限”）
node server/leaderboard.mjs

# 推荐：显式给 secret 和数据目录
PORT=8787 \
LB_SECRET="$(openssl rand -hex 32)" \
LB_DATA_DIR=/var/lib/dod-leaderboard \
LB_ORIGINS=https://dod.goodpoint.top \
node server/leaderboard.mjs
```

健康检查：

```bash
curl -s http://127.0.0.1:8787/api/health
# {"ok":true,"version":"1.0.0","uptimeSec":3,"modes":["rotation","survival","defend","extract"]}
```

`server/.env.example` 只是配置参考。服务端**不会自动读取 `.env`**（零依赖、无 dotenv），
请用 systemd 的 `EnvironmentFile=` 或 shell 导出环境变量。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `LB_SECRET` | 随机生成 | ticket 的 HMAC 密钥。缺失时启动随机生成并打警告；重启后旧 ticket 全部失效 |
| `LB_ORIGINS` | `https://dod.goodpoint.top,http://127.0.0.1:5173,http://localhost:5173` | 逗号分隔的浏览器 Origin 白名单（必须含协议和端口，不含路径） |
| `LB_DATA_DIR` | `server/data` | 数据目录。相对路径按进程工作目录解析；生产建议绝对路径 |
| `LB_ALLOW_UNSIGNED` | 未设置 | `1` 时允许无 ticket 提交，**仅开发用** |

服务启动后监听所有网卡（Node 默认行为）。生产环境请用防火墙/安全组只放行 80/443，
8787 只让本机 nginx 访问。

---

## 3. 接口契约

所有 API 都在 `/api` 下。JSON 字段名一律英文。

通用约定：

- 成功响应包含 `ok: true`（`/api/ticket` 例外，保持 `{ticket, issuedAt, sig}`）；
- 失败响应统一为 `{ "ok": false, "error": "<code>", "message": "<中文说明>" }`；
- `Cache-Control: no-store`；
- `ts` 是服务端入库时间，Unix 毫秒；`updatedAt` 是 ISO 字符串；
- `runId` 为 8–64 位 `[A-Za-z0-9_-]`；
- 所有提交都带 `X-Client-Id` 请求头（服务端只当**去重键**，不是鉴权）。

### 3.1 `GET /api/health`

```json
{
  "ok": true,
  "version": "1.0.0",
  "uptimeSec": 123,
  "modes": ["rotation", "survival", "defend", "extract"]
}
```

`uptimeSec` 是整数秒。`modes` 是当前支持的模式名数组。

### 3.2 `GET /api/ticket`

```json
{
  "ticket": "5nM...32-char-nonce",
  "issuedAt": 1760000000000,
  "sig": "64-hex-hmac-sha256"
}
```

- `sig = HMAC-SHA256(LB_SECRET, ticket + "." + issuedAt)`，十六进制小写。
- 有效期 **150 秒**，**一次性**。内存保存上限 5000 条，超出淘汰最旧。
- 服务重启（或使用临时 secret）后，之前发出的 ticket 全部失效。
- ticket 只证明“请求来自刚调用过 ticket 接口的客户端”，**不证明成绩真实**。

### 3.3 `POST /api/runs`

请求头：

```http
Content-Type: application/json
X-Client-Id: <1-64 位 [A-Za-z0-9_.:-]>
```

请求体：

```json
{
  "ticket": "5nM...",
  "issuedAt": 1760000000000,
  "sig": "64-hex-hmac-sha256",
  "name": "KEN",
  "run": {
    "runId": "smoke-run-0001",
    "mode": "rotation",
    "score": 1250,
    "kills": 10,
    "wave": 2,
    "durationMs": 20000,
    "headshots": 4,
    "shots": 100,
    "hits": 40,
    "challengesDone": 1
  }
}
```

成功响应：

```json
{
  "ok": true,
  "rank": 1,
  "best": {
    "name": "KEN", "score": 1250, "kills": 10, "wave": 2,
    "ts": 1760000000123, "runId": "smoke-run-0001"
  },
  "top": [
    { "name": "KEN", "score": 1250, "kills": 10, "wave": 2, "ts": 1760000000123, "runId": "smoke-run-0001", "rank": 1 }
  ]
}
```

- `rank`：这条记录在当前模式榜上的名次（1 起）；跌出 top 100 时为 `null`。
- `best`：**该 `X-Client-Id` 在当前模式的个人最佳**（仍在 top 100 内）；没有则为 `null`。
  注意它与 `GET /api/board` 的 `best`（全榜第一）含义不同。
- `top`：当前模式前 10 条（每项带 `rank`），字段固定为
  `name/score/kills/wave/ts/runId/rank`，不暴露 `cid`。
- **幂等**：同一 `(cid, runId)` 重复提交只更新原记录，不重复计数（跨模式同 runId 也按重放处理）。
  客户端重试/离线补交复用同一个 `runId` 即可安全重试。

### 3.4 `GET /api/board?mode=rotation&limit=20&offset=0[&cid=...]`

- `mode` 缺省 `rotation`；非法值返回 400 `bad_mode`。
- `limit` 夹在 **1–50**，缺省/非法为 **20**（单页最多 50）。
- `offset` 解析为整数，有效范围 **0–500**；非法/缺省按 **0**。它是 0 基偏移量，
  服务端对排序后的完整榜单执行 `slice(offset, offset + limit)`。
- `cid` 可选：优先用 query 里的 `cid`，否则用请求头 `X-Client-Id`，用于返回“该 cid 的最佳名次”。
  它只影响个人 `rank` 字段，不鉴权，也不返回任何人的隐私数据。

示例（`limit=2&offset=0`，为节省篇幅只展示 2 条）：

```json
{
  "ok": true,
  "mode": "rotation",
  "updatedAt": "2026-10-18T12:00:00.000Z",
  "total": 25,
  "top": [
    { "name": "KEN", "score": 3500, "kills": 5, "wave": 1, "ts": 1760000000123, "runId": "page-run-0025", "rank": 1 },
    { "name": "PAGE", "score": 3400, "kills": 5, "wave": 1, "ts": 1760000000122, "runId": "page-run-0024", "rank": 2 }
  ],
  "nextOffset": 2,
  "hasMore": true,
  "best": { "name": "KEN", "score": 3500, "kills": 5, "wave": 1, "ts": 1760000000123, "runId": "page-run-0025" },
  "rank": 1
}
```

第二页示例：`GET /api/board?mode=rotation&limit=20&offset=20`

```json
{
  "ok": true,
  "mode": "rotation",
  "updatedAt": "2026-10-18T12:00:00.000Z",
  "total": 25,
  "top": [
    { "name": "PAGE", "score": 1500, "kills": 5, "wave": 1, "ts": 1760000000098, "runId": "page-run-0005", "rank": 21 }
  ],
  "nextOffset": null,
  "hasMore": false,
  "best": { "name": "KEN", "score": 3500, "kills": 5, "wave": 1, "ts": 1760000000123, "runId": "page-run-0025" },
  "rank": 1
}
```

（上面第二页的实际 `top` 会返回 5 条，这里只展示第一条；`rank` 为全榜名次 21。）

- `total`：该模式当前保存的记录数（0–100，每模式最多 100）。
- `top[]`：当前页记录，每项 `rank` 是 **1-based 全榜名次**（不是页内序号）。
- `nextOffset`：还有下一页时等于 `offset + 当前页实际条数`，否则为 `null`。
- `hasMore`：是否还有下一页，等价于 `nextOffset !== null`。
- `best`：全榜第一条（全榜最高分），空榜为 `null`。
- 个人 `rank`：可选查询身份对应的最佳名次，无身份/未上榜为 `null`（逻辑与分页无关）。

### 3.5 错误、方法与 CORS

| 情况 | 状态码 | `error` |
| --- | --- | --- |
| 请求体不是合法 JSON | 400 | `bad_json` |
| 请求体不是对象 | 400 | `invalid_body` |
| 缺 ticket（未开 `LB_ALLOW_UNSIGNED`） | 400 | `missing_ticket` |
| ticket 不存在/格式错/已用 | 400 | `bad_ticket` |
| ticket 过期 | 400 | `ticket_expired` |
| 签名错误 | 400 | `bad_signature` |
| 模式非法 | 400 | `bad_mode` |
| runId 非法 | 400 | `bad_run_id` |
| 某字段越界 | 400 | `bad_score` / `bad_kills` / `bad_wave` / `bad_duration` / `bad_headshots` / `bad_shots` / `bad_hits` / `bad_challenges` |
| 数值一致性不通过 | 400 | `inconsistent_run` |
| 请求体超过 8KB | 413 | `body_too_large` |
| 限流 | 429 | `rate_limited`（带 `Retry-After`） |
| 来源不在白名单 | 403 | `origin_not_allowed` |
| 路径不存在 | 404 | `not_found` |
| 方法不匹配 | 405 | `method_not_allowed`（带 `Allow`） |
| 服务内部异常 | 500 | `internal` |

- `OPTIONS` 一律走 CORS 预检：允许来源返回 204 + `Access-Control-Allow-*`；
  不在白名单的来源返回 403。
- 只对浏览器生效的 `Origin` 做白名单校验；curl / 服务间请求没有 `Origin`，不因此获得信任。

---

## 4. 校验规则

一次提交必须同时满足以下条件，否则 400 拒绝：

1. `mode ∈ rotation|survival|defend|extract`；
2. 所有数值都是**有限非负整数**：
   - `score ≤ 2,000,000`
   - `kills ≤ 5,000`
   - `wave ∈ 1..200`
   - `durationMs ∈ 5,000..21,600,000`
   - `headshots ≤ kills`
   - `hits ≤ shots ≤ 20,000`
   - `challengesDone ∈ 0..10,000`
3. 一致性（挡明显造假，不是真实性证明）：
   - `kills ≤ score/50 + 5`
   - `score ≤ kills*300 + wave*250 + 5000`
   - `wave ≤ kills + 3`
   - `durationMs ≥ max(5000, (wave-1)*6000)`
     （每多一波至少约 6 秒；wave 1 只需 5 秒，允许速死）
4. `runId` 8–64 位 `[A-Za-z0-9_-]`；
5. `name`：去控制字符、trim、1–12 个字符，去掉 `<>{}[]\"'\\` 等注入字符；
   非法/空则使用 `OPERATOR`；
6. body 上限 8KB；
7. 限流：每 IP 每分钟 6 次提交、120 次读取（内存 token bucket，
   `X-Forwarded-For` 第一段优先，其次 `X-Real-IP`，最后 socket 地址）。

> 这些规则只能提高乱刷成本。改客户端内存后提交一组满足上述不等式的假数据，仍然会入库。

---

## 5. 存储与故障恢复

- 单文件：`$LB_DATA_DIR/leaderboard.json`。
- 内存索引 + **200ms 防抖**写盘；写入先写 `leaderboard.json.tmp` 再 `rename`，避免半截文件。
- 每模式只保留 **top 100**（按 `score` 降序，`kills` 降序，`ts` 升序）。
- 启动时读盘：
  - 文件不存在：空榜启动；
  - JSON 损坏 / 结构不对：把原文件重命名为
    `leaderboard.json.corrupt.<毫秒时间戳>`，然后空榜重建（不会静默覆盖坏数据）；
  - 单条记录非法：跳过该条，其余照常加载。
- `SIGINT`/`SIGTERM` 会先 flush 再退出。

文件结构示意（不要手改，恢复时整文件替换）：

```json
{
  "version": 1,
  "updatedAt": "2026-10-18T12:00:00.000Z",
  "modes": {
    "rotation": {
      "updatedAt": "2026-10-18T12:00:00.000Z",
      "entries": [
        { "runId": "...", "cid": "...", "name": "KEN", "score": 1250, "kills": 10, "wave": 2, "ts": 1760000000123 }
      ]
    }
  }
}
```

`cid` 是客户端生成的随机 ID（UUID 形式），只用于 `(cid, runId)` 去重和可选个人名次；
它**不是账号**，也不参与任何鉴权。

---

## 6. 前端客户端 `src/net/leaderboard.js`

```js
import {
  LB_VERSION, LB_MODES, createLeaderboard
} from './net/leaderboard.js';

const lb = createLeaderboard({
  // 生产同源：'/api'。本地跨端口开发：'http://127.0.0.1:8787/api'
  baseUrl: import.meta.env.VITE_LEADERBOARD_URL || '/api',
  // clientId 可省略；省略时从 localStorage['dod.cid.v1'] 取或生成
  timeoutMs: 2500,
});

const firstPage = await lb.fetchBoard('rotation', 20, lb.clientId, 0);
// firstPage: { ok, source: 'online'|'local'|'cache', entries, rank,
//              updatedAt, total, nextOffset, hasMore, error }
// entries[].rank 是 1-based 全榜名次

if (firstPage.hasMore) {
  const secondPage = await lb.fetchBoard('rotation', 20, lb.clientId, firstPage.nextOffset);
  // 追加 secondPage.entries ...
}

const result = await lb.submitRun({
  runId: crypto.randomUUID(),
  mode: 'rotation',
  score: 1250,
  kills: 10,
  wave: 2,
  durationMs: 20000,
  headshots: 4,
  shots: 100,
  hits: 40,
  challengesDone: 1,
}, 'KEN');
// result: { ok, source, rank, best, top, error }

await lb.flushOutbox();       // 启动 / 网络恢复时补交，返回 { sent, dropped }
lb.getLocalBoard('rotation'); // 本地镜像（离线兜底，最多 100 条）
lb.status;                    // 'online' | 'offline' | 'unknown'
lb.clientId;
```

行为约定：

- 纯浏览器 ESM、无依赖；所有方法**永不 throw**，失败返回 `{ ok: false }`。
- 所有请求有 `AbortController` 超时；`navigator.onLine === false` 时直接走本地。
- 分页签名：`fetchBoard(mode, limit = 20, cid = null, offset = 0)`；
  `limit` 上限 50，`offset` 有效范围 0–500。URL 会带
  `&limit=...&offset=...`，返回值包含 `total / nextOffset / hasMore`。
- 本地镜像：`localStorage['dod.board.v1:<mode>']` 最多保存 **100 条**。
  - `offset === 0`：用第一页**替换**镜像；
  - `offset > 0`：把新页**合并**进镜像（按 `runId` 去重、按 `score` 降序、截 100），
    这样离线时 `getLocalBoard()` 仍能看到已经加载过的多页。
- 补交队列：`localStorage['dod.outbox.v1']`，最多 20 条，FIFO 丢最旧，
  同一 `runId` 不重复入队；提交成功后移除。
- `fetchBoard` 的 `cid` 参数会作为 `?cid=` 透传，用于拿“我的名次”；
  不传时服务端用 `X-Client-Id`。它只影响个人 `rank`，不是鉴权。
- `fetchBoard` 返回的 `source`：
  - `online`：服务端成功；
  - `cache`：网络失败，从本地镜像按 `offset/limit` 切出对应页；
  - `local`：网络失败且无镜像（空数组）。
  `ok` 只表示“服务端调用是否成功”，离线回退时 `ok:false`，但 `entries` 可能有缓存数据；
  失败时固定 `nextOffset: null`、`hasMore: false`，`total` 为镜像条数，
  调用方应优先看 `entries` / `source`。
- 服务端明确判定为非法的 400（`bad_score`、`inconsistent_run` 等）不会进补交队列；
  网络错误、超时、429、5xx、404（API 还没部署）会入队，等网络恢复后由 `flushOutbox()` 补交。

### 本地开发

在项目根目录 `.env.local` 写：

```bash
VITE_LEADERBOARD_URL=http://127.0.0.1:8787/api
```

然后 `npm run dev`。调用方必须显式把该变量传给 `createLeaderboard({ baseUrl })`；
服务端默认 `LB_ORIGINS` 已包含 `http://127.0.0.1:5173` 和 `http://localhost:5173`。
`VITE_` 变量是构建期注入的，改完要重启 dev server。

### 生产同源

静态站和 API 同域时，前端用默认 `baseUrl = '/api'`，不涉及跨域；
nginx 只加一个 `location /api/` 即可。

---

## 7. nginx + systemd 部署

### 7.1 nginx：现有 443 server 内加一个 location

不要为 API 新建 server 块，也不要改静态站逻辑。在现有
`/etc/nginx/conf.d/dod-goodpoint.conf` 的 443 server 里加：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8787;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    # 用 $remote_addr 覆盖，而不是 $proxy_add_x_forwarded_for：
    # 后者会保留客户端自带的 XFF，客户端可伪造第一段绕过限流。
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    client_max_body_size 16k;   # 服务端自身限制 8KB，这里给一点余量
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
}
```

- `proxy_pass` 末尾**不要**加 `/`，否则 `/api/xxx` 会被改写。
- 前端用同源 `/api`，不需要额外 CORS 头。
- 当前 `dod-goodpoint.conf` 是宿主机 nginx，`127.0.0.1:8787` 可直连宿主机 systemd 服务；
  如果 nginx 跑在容器里，`127.0.0.1` 指向容器自身，需要改成宿主机地址或 Docker 网络别名。
- 如果以后前面再套 CDN，要重新设计真实 IP 的信任链，并同步修改服务端取 IP 的优先级。

检查并生效：

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -s https://dod.goodpoint.top/api/health
```

### 7.2 systemd

把仓库里的 `server/` 目录（不含运行时 `data/`）部署到 `/opt/dod-leaderboard/server`：

```bash
sudo useradd --system --home /opt/dod-leaderboard --shell /usr/sbin/nologin dod
sudo mkdir -p /opt/dod-leaderboard
sudo cp -a server /opt/dod-leaderboard/
sudo rm -rf /opt/dod-leaderboard/server/data
sudo chown -R root:root /opt/dod-leaderboard
```

配置 `/etc/dod-leaderboard.env`（权限 600，root 所有）：

```bash
PORT=8787
LB_SECRET=<openssl rand -hex 32 的输出>
LB_ORIGINS=https://dod.goodpoint.top
LB_DATA_DIR=/var/lib/dod-leaderboard
```

`/etc/systemd/system/dod-leaderboard.service`：

```ini
[Unit]
Description=deepseek-of-duty leaderboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dod
Group=dod
WorkingDirectory=/opt/dod-leaderboard
EnvironmentFile=/etc/dod-leaderboard.env
ExecStart=/usr/bin/node /opt/dod-leaderboard/server/leaderboard.mjs
Restart=on-failure
RestartSec=2

# 数据目录由 systemd 创建并授权；与 LB_DATA_DIR 保持一致
StateDirectory=dod-leaderboard
StateDirectoryMode=0750

# 基本加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dod-leaderboard
sudo systemctl status dod-leaderboard --no-pager
curl -s http://127.0.0.1:8787/api/health
journalctl -u dod-leaderboard -f
```

`ExecStart` 里的 node 路径以服务器 `command -v node` 为准。该 unit 使用
`StateDirectory=dod-leaderboard`，会自动创建 `/var/lib/dod-leaderboard` 并允许服务用户写入。

---

## 8. 运维

- **健康检查**：`GET /api/health`，返回 200 即进程存活（不代表数据一定正确）。
- **备份**：直接复制 `$LB_DATA_DIR/leaderboard.json`（文件很小）；
  建议定时 `cp` 到备份目录。停机备份可避免和 200ms 防抖写盘抢时序，热备通常也可接受。
- **恢复**：停服务 → 用备份替换 `leaderboard.json` → 启服务。启动时会重新读盘。
- **坏文件**：服务会自动改名为 `leaderboard.json.corrupt.<ts>` 并重建空榜；
  确认后可从备份恢复，坏文件留作排查。
- **换 secret**：改环境变量并重启。只会让未使用的 ticket 失效，不影响已有榜单数据。
- **单实例**：这是单进程 + 单 JSON 文件的服务。**不要同时起两个进程指向同一个
  `LB_DATA_DIR`**，否则会互相覆盖。
- **限流是内存态**：重启清零；多实例也不共享。
- **日志**：stdout/stderr 交给 journald；不要打印 secret 或完整请求体。

---

## 9. 本地冒烟测试

```bash
node tools/lb-smoke.mjs
```

脚本会：

1. 在 `127.0.0.1:8788` 起服务（不占用 5173/4173），数据目录用 `os.tmpdir()` 下的临时目录；
2. 等 `/api/health`；
3. 取 ticket，提交一条合法 run，断言 `rank=1`；
4. 用新的 ticket 重复提交同一 `runId`，断言榜单不重复计数；
5. 提交 `score=2000001`，断言 400；
6. 用篡改的签名提交，断言 400；
7. 拉 `/api/board`，断言 1 条且字段正确；
8. 验证软时长规则：`wave=1 / durationMs=5000` 可提交，`durationMs=1000` 返回 400；
9. 验证 `?cid=`：本人 `rank=1`，未上榜为 `null`；
10. 在 `defend` 模式用不同 `X-Forwarded-For` 造 25 条数据，断言
    `limit=20&offset=0` 返回 20 条 / `nextOffset=20` / `hasMore=true` / 首条 `rank=1`，
    `offset=20` 返回 5 条 / `nextOffset=null` / `hasMore=false` / 首条 `rank=21`，两页 `total=25`；
11. 杀进程、删除临时目录；任一断言失败退出码为 1。

单独做语法检查：

```bash
node --check server/leaderboard.mjs
node --check src/net/leaderboard.js
node --check tools/lb-smoke.mjs
```

---

## 10. 已知局限（请如实转达）

1. **没有反作弊**。ticket 只证明“刚拿过票”，一致性规则只挡明显造假；改客户端内存后
   提交一组自洽的假数字仍会入榜。要真正解决需要服务端权威判定/回放，本项目没有。
2. **`X-Client-Id` 不是身份**。任何人可伪造；`(cid, runId)` 幂等只防重复计数，不防冒用。
3. **限流可被绕过或误伤**。服务端信任 `X-Forwarded-For` 第一段；只有部署在可信反向代理后
   且代理覆盖 XFF 时才有意义。直接暴露 8787 时客户端可伪造 IP；NAT 后的多个玩家也可能共享额度。
4. **单进程单文件**。不支持多实例水平扩展；进程崩溃时最多丢 200ms 内未落盘的变更。
5. **每模式只保留 top 100**。跌出 top 100 的记录会被删除，个人最佳/名次也只在这 100 条内计算。
6. **无账号、无 cookie、无删除/申诉接口**。名字只做字符过滤，不做内容审核。
7. **上限是写死的常量**。`score ≤ 2,000,000`、`kills ≤ 5,000`、`wave ≤ 200` 等对正常玩家足够，
   但如果以后玩法变化（例如无尽模式分数爆炸），需要同步改服务端常量并重新部署。
8. **服务本身不处理 TLS**。HTTPS 由 nginx 终止；8787 不应直接对公网开放。
9. **ticket 重启即失效**。未设置 `LB_SECRET` 时服务使用临时随机密钥，重启后所有旧 ticket 失效。
10. **`LB_ALLOW_UNSIGNED=1` 只适合本地开发**，生产开启等于取消 ticket 门槛。
