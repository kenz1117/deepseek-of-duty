# 片头 / 片尾视频生成（Hailuo 2.3）— 一次性执行清单

> 状态：参考帧与提示词已就绪，**等额度**（2026-10-19 的 3 条额度已被两次模型探测消耗，接口返回 2056 Token Plan 上限）。
> 额度恢复后按本文档执行，两条一次发完，不再做任何探测性调用。

## 1. 接口

```
POST https://api.minimax.chat/v1/video_generation
Authorization: Bearer $MINIMAX_CN_API_KEY
Content-Type: application/json

{
  "model": "MiniMax-Hailuo-2.3",
  "first_frame_image": "data:image/jpeg;base64,<参考帧>",
  "prompt": "<见下>",
  "duration": 6,
  "resolution": "1080P",
  "prompt_optimizer": false
}
```

- 模型：`MiniMax-Hailuo-2.3`（I2V 必填 first_frame_image）
- 6s / 1080P（10s 只支持 768P，不用）
- `prompt_optimizer:false`：保留手工写的镜头指令，避免模型把提示词改写成泛化场景
- 查询：`GET /v1/query/video_generation?task_id=...`
- 下载：`GET /v1/files/retrieve?file_id=...` → `file.download_url`

## 2. 参考帧

| 用途 | 文件 | 内容 |
| --- | --- | --- |
| 开场 | `docs/refs/opening.jpg`（1920×1080，605 KB） | 街区纵深、低角度、落日眩光、燃烧车辆、浮尘 |
| 结局 | `docs/refs/ending.jpg`（1920×1080，499 KB） | 蓝调时刻、空街、远处火点、冷色阴影 |

参考帧由游戏内相机直接截取（隐藏 HUD / 手部模型，FOV 58–60），保证视频与游戏同一场景、同一光照。

## 3. 提示词（可直接用）

### 开场（6s）

```
[Push in] Slow, steady dolly forward at walking pace through a deserted, war-damaged Middle Eastern street at golden dusk. Fine dust drifts through low sunbeams, thin smoke curls from a burning car ahead, heat shimmer in the distance. Subtle handheld sway, low camera height. Natural motion only: dust, smoke, cloth awnings swaying, light shifting. Cinematic 35 mm anamorphic look, warm amber highlights and cool teal shadows, fine film grain, shallow depth of field. No cuts, no zoom, no people, no text, no logos, no watermark.
```

### 结局（6s）

```
[Pull out] Slow, smooth pull-back from a silent street at blue hour, seconds after the fighting stopped. Thin smoke and embers drift across the asphalt, a distant fire flickers orange against cold blue shadows, loose paper and dust skitter over the ground. Subtle handheld sway, low camera height. Natural motion only: smoke, embers, drifting debris, slow light change. Cinematic 35 mm anamorphic look, deep teal shadows with a single warm fire accent, fine film grain, shallow depth of field. No cuts, no zoom, no people, no text, no logos, no watermark.
```

## 4. 生成后

1. 下载到 `public/media/opening.mp4`、`public/media/ending.mp4`（H.264，16:9）。
2. 播放入口已经留好：
   - 开场：`startGame` → OP01 的 in-engine 过场之前先播 `opening.mp4`（可跳过，播完接 VEGA 的 3D 过场）。
   - 结局：OP07 完成 → 先播 `ending.mp4`，再接 in-engine 结局与结算面板。
3. 如果文件缺失，播放器自动跳过（404 不报错），不影响原有流程。

## 5. 成本纪律

- 每次生成前先确认当天剩余条数；**不要**再用生成接口探测模型名（模型名只接受：`MiniMax-Hailuo-2.3` / `MiniMax-Hailuo-2.3-Fast` / `MiniMax-Hailuo-02` / `I2V-01-Director` / `I2V-01-live` / `I2V-01`）。
- 参数错误（2013）不会消耗；额度不足（2056）直接返回，不产生任务。
- 两条一次发，串行等待，不并发（避免限流 1002）。
