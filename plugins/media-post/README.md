# 点歌台 · 媒体放映机（media-post）

给念风 + NapCat / QQ 官方机器人用的「视频 / 图文 / 点歌」扩展：

- **点歌**：说「放一下《来不及爱你》」→ 模型搜索 B站 → 选最像纯放歌的一条 → 提取音频 → **QQ 语音**（NapCat `record` 段，或 QQ 官方机器人 SILK 富媒体消息）发出；
- **发视频**：发一条抖音 / B站链接说「把这个视频发群里」→ 下载视频直发；
- **发图文**：发抖音图文链接 → 图片 + 文案一起发出；
- **原画质无水印（v2.3.0）**：
  - B站：直接请求**网页播放器同款 DASH**（`fnval=4048`，含 4K / HDR / 杜比标记），挑当前账号能拿到的最高清晰度，不再为了兼容主动降到 720P；
  - 抖音：只取详情接口的 `play_addr` 系列（**浏览器里正在播的那条无水印流**），`download_addr`（带水印）永远不会被使用；
  - 两者都会用 ffmpeg 探测编码：只有拿到 AV1 / HEVC 等 QQ 播放器不支持的流时才**按需转码 H.264 + AAC**，「视频能收到但打开 0:00 / 黑屏」不会再出现；
  - 注意：「无水印」指平台不会额外叠加水印（和浏览器里播的完全一致）；如果博主自己把水印压在画面里，那属于视频内容本身；
  - 想省流量可以在「设置 → 点歌台」把画质改成「最高 720P / 1080P」。
- **一次多条（v2.3.0）**：模型可以在一次调用里填入多条链接（`url` 里塞多条，或 `urls: [...]`，一次最多 5 条），插件会**先并发下载、再按顺序逐条发送**；点歌同理，`media_play` 支持 `queries: ["歌名1", "歌名2"]`；
- **非 NapCat / QQ 官方渠道**：自动降级为「标题 + 时长 + 原链接 + 本地缓存路径」的聊天消息（图文会附图片）。

## 安装

前置：先安装并启用 **联网访问（web-access v1.1.0+）**，它是搜索、Cookie 与抖音图文解析的来源。

```powershell
# 方式 A：脚本安装（复制到 <数据目录>/plugins/media-post）
powershell -ExecutionPolicy Bypass -File .\extensions\media-post\install.ps1
# 自定义数据目录 / 插件目录：
powershell -ExecutionPolicy Bypass -File .\extensions\media-post\install.ps1 -DataDir "D:\nianfeng-data" -Force

# 方式 B：手动复制整个 extensions\media-post 到 <数据目录>\plugins\media-post
```

安装后在「设置 → 插件 → 重新扫描」热加载；QQ / NapCat / 微信等服务端代聊渠道会自动拿到新工具。

## 首次配置（设置 → 点歌台）

1. **一键安装缺失工具**：
   - ffmpeg：从 npm 镜像（npmmirror）下载，解包到 `<数据目录>/media-post/tools/ffmpeg.exe`；
   - yt-dlp：优先用本机 Python + PyPI 镜像（清华源）`pip --target` 安装；没有 Python 时再尝试 GitHub 官方 exe（国内可能失败，日志会写明原因）。
   - 也可以手动在设置里填 `ffmpegPath` / `ytdlpPath` / `pythonPath`。
2. **登录抖音 / B站**：点按钮会弹出**独立 Edge 窗口**（独立 profile，不影响日常浏览器），扫码 / 验证码完成后回来点「同步 Cookie 并导出」。之后插件会自动把 Cookie 导出成 yt-dlp 用的 `cookies.txt`。
   - Cookie 过期后再点一次登录即可；抖音必须登录过至少一次（需要新鲜浏览器会话 Cookie）。
3. 可选：**媒体直链地址** 填 `http://<本机局域网IP>:8788` —— 仅当 NapCat 不在同一台机器、需要它通过 HTTP 拉媒体文件时使用；本机 NapCat 留空即可（直接读本地路径）。

## 模型工具

| 工具 | 作用 |
|---|---|
| `media_search` | 搜索 B站 / 抖音视频候选：标题 / UP主 / 时长 / 播放量 / 匹配分与理由 |
| `media_play` | 一步点歌：搜索 + 自动挑最优 + 发送（默认 `mode=voice`，NapCat / QQ 官方机器人自动适配格式）；`queries` 支持一次点 2~5 首 |
| `media_send` | 把链接内容发出来：`mode=auto/voice/video/images/file`；`url` / `urls` 支持一次发多条（最多 5 条） |

`media_send` 返回里会带上每条的实际结果：

- `delivered=voice/video/file/images`：直发成功，`quality` / `watermark_free` / `transcoded` 会说明这条是不是原画质无水印、有没有转码；
- `delivered=fallback`：目标渠道不支持媒体直发，已改发「标题 + 原链接 + 本地缓存路径」；
- `delivered=batch`：多条结果，`count` 成功数、`items` 每条明细、`failed` 失败明细（含原因），`truncated` 表示超出 5 条被截断；
- `ok=false`：一条都没成功，`code` / `error` 说明原因（`NEED_LOGIN` / `FFMPEG_UNAVAILABLE` / `UNSUPPORTED_URL` …）。

语音发送格式：

- NapCat：先发 mp3 `record`，被拒绝时自动转 amr 重试；
- QQ 官方机器人：用 ffmpeg 转 24k 单声道 PCM，再用内置的 `silk-wasm` 编码为 SILK，通过官方富媒体接口 `file_type=3` + `msg_type=7` 发送。

典型对话：

```text
用户：放一下“来不及爱你”
模型：media_search(query="来不及爱你", site="bilibili")
      → 选 score 最高、3:26、Hi-Res 那条
      → media_send(url=..., mode="voice")
结果：QQ 群里出现一条 3:26 的语音 + 「来啦～」

用户：放一下 晴天、七里香、稻香
模型：media_play(queries=["晴天", "七里香", "稻香"], mode="voice")
结果：按顺序发出 3 条语音（不确定的那首会在 skipped 里返回，让用户确认）

用户：把这几个视频都发群里 https://v.douyin.com/aaaa/ https://b23.tv/bbbb https://www.bilibili.com/video/BV1xxxx
模型：media_send(urls=["https://v.douyin.com/aaaa/", "https://b23.tv/bbbb", "https://www.bilibili.com/video/BV1xxxx"], mode="video")
结果：3 条原画质无水印视频按顺序发出（个别失败会在 failed 里列出）

用户：把这个链接里的视频发群里 https://v.douyin.com/xxxx/
模型：media_send(url=..., mode="video")

用户：看看这个抖音图文 https://v.douyin.com/xxxx/
模型：browser(action="read", url=...)  → 图片会带进上下文（web-access 提供）
      media_send(url=..., mode="images")
```

## 目录与数据

```text
<数据目录>/
├── media-post.json              # 插件配置（工具路径、画质、默认格式、缓存上限）
└── media-post/
    ├── media/                   # 下载 / 转码后的媒体文件
    ├── media.json               # 索引（无 base64）
    ├── .tmp/                    # 下载临时目录（自动清理）
    └── tools/                   # ffmpeg / pip 安装的 yt-dlp
```

缓存策略：默认 200 个 / 2GB / 7 天，超过自动删最旧；设置面板可改，也可点「立即清理缓存」。
视频画质默认「原画质」，单视频上限默认 300MB；原画质视频更大，超上限时会在返回里说明原因（可在设置里调画质或上限）。

## 安全与边界

- 媒体文件回传路由带每个文件独立的随机 token，且只读取 `<数据目录>/media-post/media/` 下的文件；
- Cookie 只保存在「联网访问」的加密库里，导出文件写在数据目录、仅本机可用，不返回给模型；
- 只支持白名单平台链接（B站 / 抖音）；不支持任意 URL 直链下载，避免被当成 SSRF 跳板。

## 排错

| 现象 | 处理 |
|---|---|
| 返回 `NEED_WEB_ACCESS` | 没装 / 没启用「联网访问」插件 |
| 返回 `NEED_LOGIN` | 去「设置 → 点歌台」点「登录抖音 / B站」，登录后点「同步 Cookie 并导出」 |
| `FFMPEG_UNAVAILABLE` | 点「一键安装缺失工具」，或手动填 ffmpeg 路径 |
| 抖音详情报「验证页 / 需要新鲜 Cookie」 | Cookie 过期，重新登录一次 |
| 群里发出来是链接 / 没有语音 | NapCat 渠道会**优先使用会话 meta 里的 `napcatInstanceId / napcatTargetType / napcatTargetId` 直发**；QQ 官方渠道使用会话 meta 里的 `qqbotChannelId` 调 qqbot 后端服务。meta 缺失时会回退到渠道表匹配。改完记得重新扫描 / 重启后端 |
| NapCat 收不到语音 | 插件会先按 mp3 发 `record`，被 NapCat 拒绝时**自动转 amr 重试一次**（需要 ffmpeg）；仍失败时降级消息里会带 `未直发原因：<code> <error>`，把这段和 NapCat 日志发我即可继续定位 |
| QQ 官方机器人收不到语音 | QQ 官方语音只接受 SILK；插件会用 ffmpeg 转 PCM → 内置 silk-wasm 编码。若返回 `FFMPEG_UNAVAILABLE` 就先去「设置 → 点歌台」安装 ffmpeg；若返回 `VOICE_FORMAT_INVALID` / `850019`，把 `media-post` 目录下的日志和 QQ 返回原文发来 |
| QQ 里视频能收到但打开 0:00 / 黑屏 | 下载到的流是 QQ 播放器不支持的 **AV1 / H.265**。v2.3.0 起：B站会请求网页播放器同款 DASH（`fnval=4048`，原画质），下载后用 ffmpeg 探测编码，非 H.264 + AAC 就自动转码；如果这条视频仍黑屏，把「设置 → 点歌台」的解析测试结果（含 `transcoded` 字段）发来 |
| 视频很大、下载很慢 | 现在默认「原画质」（4K / 高码率会比以前大好几倍）。想快 / 想省流量就把「默认行为 → 视频画质」改成「最高 1080P / 720P」，或调小「单视频上限(MB)」 |
| 多条链接只发了前 5 条 | 一次调用最多 5 条（`truncated=true` 会写在返回里）；让模型分两次调用即可 |
| 更新插件后视频仍是旧效果 | v2.2.2 起 bridge 会带着热更新 revision 重载整个 lib / vendor 依赖链，避免「新 bridge + 旧 lib」。若你的内核版本仍缓存了旧后端桥，更新插件后在插件页点一次「重新扫描插件」；仍无效就重启一次念风后端，确保 `bridge.mjs` 重新加载 |
| 远程 NapCat 取不到文件 | 「默认行为 → 媒体直链地址」填 `http://<本机局域网IP>:8788`；本机 NapCat 留空即可 |
| 非 NapCat / 非 QQ 官方渠道 | 会降级成标题 + 链接 + 本地路径；视频 / 文件 / 图文直发目前仍以 NapCat 为主 |
