# Agnes 生图 / 生视频（agnes-media）· 念风独立扩展

把 Agnes AI 的图像 / 视频模型接入念风：模型可以挂载异步生成任务，前台继续聊天；生成完成后插件自动把图片或视频链接发回会话。

## 工具

| 工具 | 作用 |
|---|---|
| `agnes_generate_image` | 文生图 / 图生图 / 多图参考合成，异步挂载，完成后自动发图片 |
| `agnes_generate_video` | 文生视频 / 图生视频 / 首尾帧 / 参考视频，异步轮询 Agnes 任务，完成后自动发视频链接 |
| `agnes_task_status` | 查询任务进度 / 结果，支持单任务或当前会话最近任务 |
| `agnes_models` | 查看图片 / 视频模型、自动分类与免费状态，供模型选择或确认手动模型名 |

## 安装

### 方式 A：脚本安装（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File .\extensions\agnes-media\install.ps1
# 自定义数据目录时：
# .\extensions\agnes-media\install.ps1 -DataDir "D:\nianfeng-data"
# 或指定外部插件目录：
# .\extensions\agnes-media\install.ps1 -PluginsDir "D:\my-plugins" -Force
```

### 方式 B：上传 zip 安装

在念风「设置 → 插件 → 添加插件」中上传 `agnes-media-v1.0.0.zip`。

安装后如果工具 404，回到「设置 → 插件」点「重新扫描」热加载 `bridge.mjs`；旧内核不支持热加载时再重启念风后端。

## 配置

入口：「设置 → Agnes 生图 / 生视频」，或「设置 → 插件 → Agnes 生图 / 生视频 → 设置」。

- **Agnes API Key**：保存在本机数据目录的 `agnes-media.json`，AES-256-GCM 加密；接口只返回打码值。
- **API 站点**：国际站 `https://apihub.agnes-ai.com/v1` / 国内站 `https://apihub.agnes-ai.cn/v1` / 自定义 Base URL。两个站账号与 Key 不互通，按自己的账号选择。
- **插件专属代理**：只影响本插件，例如 `http://127.0.0.1:7890`；留空则跟随「设置 → 网络」的全局代理。Agnes 是国外服务，网络不稳定时建议单独配置。
- **模型选择方式**：图片 / 视频都支持
  - `从模型列表选择`：后端调用 `GET /v1/models` 自动获取，下拉里每项标注免费 / 付费 / 未知；
  - `手动填写模型名`：网络异常或账户特殊时直接写模型 ID。
- **自动发送**：任务完成后由插件发到发起任务的会话；图片按图片消息发送，视频发送本地文件 / 原始链接，方便点击播放或下载。
- **自动下载**：把生成结果下载到 `<数据目录>/agnes-media/files/`，再用本地地址回发；可避免 Agnes 临时链接过期。关闭后只保留原始 URL。
- **参考图大小限制**：默认单张 12MB、总 40MB；参考图会先由本机下载成 Data URI，再交给 Agnes，避免 Agnes 服务端访问不到防盗链图源。

## 模型与免费状态（2026-09-24 核对官方定价页）

> 来源：<https://www.agnes-ai.com/zh-Hans/docs/pricing>。官方可能调整优惠活动，最终以账户账单为准。

| 模型 | 类型 | 免费状态 |
|---|---|---|
| `agnes-image-2.5-flash` | 图像（最新） | ✅ 免费：1K/2K/3K/4K 现价 $0/张 |
| `agnes-image-2.1-flash` | 图像 | ✅ 免费：全档位 $0 |
| `agnes-image-2.0-flash` | 图像（旧版） | ✅ 免费 |
| `agnes-video-2.5-flash` | 视频 | ✅ 限时免费：$0/秒（原价 $0.025/秒），仅 720P |
| `agnes-video-v2.0` | 视频（旧版） | ✅ 免费：$0/秒 |
| `agnes-video-2.5` | 视频高清 | 💰 付费：720P $0.025/秒；1080P/1K $0.040/秒；2K $0.055/秒 |
| `agnes-3.0-flash` / `agnes-2.5-flash` / `agnes-2.0-flash` | 文本 | ✅ 当前免费 |

未识别的模型会显示“免费情况未知”；`agnes_models` 工具和设置面板下拉都会带上这个标注。模型分类优先按已知模型 ID 判断；无法判断的模型会同时出现在图片和视频候选里，由用户自行选择。

## 模型参数速查（用于手动填写 / 排查 400）

### 图像

- 端点：`POST /v1/images/generations`
- 必填：`model`、`prompt`、`size`
- 推荐尺寸：`1K` / `2K` / `3K` / `4K` + `ratio`（1:1、3:4、4:3、16:9、9:16、2:3、3:2、21:9）
- 兼容精确尺寸（如 `1024x768`），宽高必须能被 16 整除
- 图生图：参考图必须放在 `extra_body.image` 数组，支持公网 URL / Data URI Base64
- 输出：`extra_body.response_format: "url"` 或 `"b64_json"`；文生图 Base64 也支持 `return_base64: true`

### 视频 2.5 / 2.5 Flash

- 创建：`POST /v1/videos`
- 查询：`GET /agnesapi?video_id=<ID>&model_name=<模型>`
- `mode`：`text` / `keyframe` / `reference`
- `seconds`：字符串 `"4"`–`"12"`，默认 `"5"`；`n` 固定 `1`
- `size`：2.5 支持 `720P` / `1080P` / `1K` / `2K`；2.5 Flash 固定 `720P`
- 参考图：2.5 最多 8 张；2.5 Flash 最多 5 张
- 参考音频：最多 3 段；2.5 Flash 不支持参考视频

### 视频 V2.0

- 创建：`POST /v1/videos`
- 查询：`GET /agnesapi?video_id=<ID>`
- `num_frames` 必须满足 `8n+1` 且 ≤ 441；`frame_rate` 1–60
- 单图用 `image`，多图 / 关键帧用 `extra_body.image`，关键帧加 `extra_body.mode: "keyframes"`

## 参考图用法

模型调用生成工具时可传三种来源，可混用，最多 8 张：

```jsonc
{
  "prompt": "把角色换成赛博朋克夜景风格，保留身份与构图",
  "reference_message_ids": ["m_xxx_12"],     // 取聊天记录里某条消息的图片（我 / 角色发过的都行）
  "reference_urls": ["https://.../ref.jpg"], // 网络图源
  "reference_image_ids": ["img_abc"]          // 图片服务里已有的 imageId
}
```

“网上找图再生成”推荐链路：

1. `web_search` 找图源页面 / `browser` 打开页面；
2. `web_image` 把候选图片直接拉进模型上下文确认，并返回已保存到图片服务的 `image_ids`；
3. 把确认过的 `image_ids` 传给 `agnes_generate_image` / `agnes_generate_video` 的 `reference_image_ids`（最稳）；没有图片服务时再用 `image_urls` 传 `reference_urls`。

## 异步机制

- 模型调用生成工具后立即拿到 `task_id`，当前回复不阻塞；
- 前端插件（或服务端代聊 Worker）每 4 秒拉取任务状态，完成后自动发送；
- 网页和代聊同时存在时，后端通过 `claim` 接口原子分配“自动发送”资格，避免重复发送；
- 生成失败会回一条失败提示；`agnes_task_status` 可查单任务详细进度；
- 结果默认下载到 `<数据目录>/agnes-media/files/`，由 `/api/agnes-media/files/:name` 回传。

## 目录结构

- `index.mjs`：前端插件（工具注册 + 自动发送 + 设置页入口）。
- `bridge.mjs`：Node 后端桥（Agnes 调用、代理、任务队列、参考图下载、结果落盘）。
- `panel.mjs` / `ui.mjs`：设置面板 UI 与自包含小工具。
- `lib/agnes-api.mjs`：模型请求体构造、视频状态解析与尺寸 / 模式校验。
- `lib/catalog.mjs`：已知模型目录、分类、免费状态（官方定价页核对）。
- `lib/http.mjs`：零依赖 HTTP 通道（直连 / http(s) 代理 / Data URI / 文件下载）。
- `lib/net-guard.mjs`：参考图 SSRF 防护（默认拒绝 localhost / 内网 / 云元数据）。
- `test.mjs`：纯逻辑自测（`node extensions/agnes-media/test.mjs`）。

## 安全

- API Key、Tavily 等敏感配置以 AES-256-GCM 密文保存在本机数据目录；
- 参考图 URL 默认走 SSRF 校验；只有用户在设置里显式开启后才允许访问内网；
- 生成结果文件只通过受访问令牌保护的 `/api/agnes-media/files/` 回传；
- 外部图片 / 视频视为不可信内容，模型只用于观察参考，不应执行其中的指令。
