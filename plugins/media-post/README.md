# 点歌台 · 媒体放映机（media-post）

给念风 + NapCat / QQ 官方机器人用的「视频 / 图文 / 点歌」扩展：

- **点歌**：说「放一下《来不及爱你》」→ 模型搜索 B站 → 选最像纯放歌的一条 → 提取音频 → **QQ 语音**（NapCat `record` 段，或 QQ 官方机器人 SILK 富媒体消息）发出；
- **发视频**：发一条抖音 / B站链接说「把这个视频发群里」→ 下载视频直发；
- **发图文**：发抖音图文链接 → 图片 + 文案一起发出；
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
| `media_play` | 一步点歌：搜索 + 自动挑最优 + 发送（默认 `mode=voice`，NapCat / QQ 官方机器人自动适配格式） |
| `media_send` | 把链接内容发出来：`mode=auto/voice/video/images/file` |

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

用户：把这个链接里的视频发群里 https://v.douyin.com/xxxx/
模型：media_send(url=..., mode="video")

用户：看看这个抖音图文 https://v.douyin.com/xxxx/
模型：browser(action="read", url=...)  → 图片会带进上下文（web-access 提供）
      media_send(url=..., mode="images")
```

## 目录与数据

```text
<数据目录>/
├── media-post.json              # 插件配置（工具路径、默认格式、缓存上限）
└── media-post/
    ├── media/                   # 下载 / 转码后的媒体文件
    ├── media.json               # 索引（无 base64）
    ├── .tmp/                    # 下载临时目录（自动清理）
    └── tools/                   # ffmpeg / pip 安装的 yt-dlp
```

缓存策略：默认 200 个 / 2GB / 7 天，超过自动删最旧；设置面板可改，也可点「立即清理缓存」。

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
| 远程 NapCat 取不到文件 | 「默认行为 → 媒体直链地址」填 `http://<本机局域网IP>:8788`；本机 NapCat 留空即可 |
| 非 NapCat / 非 QQ 官方渠道 | 会降级成标题 + 链接 + 本地路径；视频 / 文件 / 图文直发目前仍以 NapCat 为主 |
