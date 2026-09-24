# 联网访问（web-access）· 念风独立扩展

给模型三个 function-calling 工具，并提供可视化设置面板：

| 工具 | 作用 |
|---|---|
| `web_search` | Tavily 联网搜索：标题 / 链接 / 摘要 / 可选整合答案 |
| `browser` | 高自由度网站访问与浏览器自动化：读取网页、B站视频、抖音视频与**图文（图片+文案）**、站内搜索、页内关键词检索、点击 / 输入 / 下拉 / 滚动 / 截图 / 下载 / 登录 / Cookie 管理 |
| `web_image` | 直接拉取公网图片 / 网页图源并送进模型上下文查看确认，返回图片原始 URL 供生图 / 生视频插件当参考图 |

## 安装

### 方式 A：脚本安装（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File .\extensions\web-access\install.ps1
# 自定义数据目录时：
# .\extensions\web-access\install.ps1 -DataDir "D:\nianfeng-data"
# 或指定外部插件目录：
# .\extensions\web-access\install.ps1 -PluginsDir "D:\my-plugins" -Force
```

脚本会把 `index.mjs / panel.mjs / ui.mjs / bridge.mjs / manifest.json / README.md / lib/*` 复制到
`<数据目录>/plugins/web-access/`。

### 方式 B：上传 zip 安装

在念风「设置 → 插件 → 添加插件」中上传本目录下的 `web-access-v2.0.0.zip`，安装到外部插件目录。

### 安装后怎么生效（已支持热插拔）

当前念风内核已支持**外部插件后端桥热加载**，所以正常情况下不需要重启：

- **上传 zip 安装**：上传成功后会自动重载外部 `bridge.mjs`，页面刷新即可用。
- **install.ps1 / 手动复制安装**：回到「设置 → 插件」点一次「重新扫描」即可同时热加载前端插件与后端桥。
- **QQ / NapCat / 微信等由服务端代聊处理的渠道**：安装 / 删除外部插件时服务端代聊会自动重启，新工具会直接进入下一轮对话，同样不需要重启本体。
- 如果当前内核版本较旧（没有热加载能力）或热加载失败：面板会提供「重新扫描插件」和「重启念风后端」两个按钮；
  也可以手动 `stop.cmd` 后重新 `start.cmd`（或 `npm run stop && npm start`）。
- 安装后打开「设置 → 联网访问」填写 Tavily API Key 即可。

### 为什么需要后端桥？

- **前端插件本身一直是热插拔的**：外部插件目录变化后，「重新扫描」即可加载 / 卸载。
- **本插件需要后端桥**：Tavily Key 安全存储与代理、Cookie 加密落盘、本机浏览器 CDP 控制、SSRF 防护下的网页抓取都必须在 Node 后端完成，纯前端做不到。
- 项目启动器现在只对**外部插件目录**的 `bridge.mjs` 建立热加载跟踪（内置渠道桥仍在启动阶段加载一次）；安装 / 删除 / 重新扫描 / 切换插件目录时会自动 dispose 旧 fiber 并加载新的桥，因此外部插件可以前后端一起热插拔。

## 配置入口

「设置 → 联网访问」，或「设置 → 插件 → 联网访问 → 设置」：

- **Tavily API Key**：保存在后端数据目录的 `web-access.json` 中，AES-256-GCM 加密；接口只返回打码值，Key 不进入模型上下文。需要代理时先在「设置 → 网络」配置全局代理。
- **浏览器**：自动探测 Edge / Chrome / Brave；首次使用会创建独立的 `web-access/browser-profile`，与日常浏览器隔离且登录态持久化。
- **Cookie 库**：查看 / 删除已保存域，从本机 Edge / Chrome / Firefox 导入，或粘贴 Cookie 头 / `document.cookie` / JSON / `cookies.txt` / cURL。

## 模型侧典型用法

```jsonc
// 公网资料搜索
{ "query": "念风 Chat 最新版本", "max_results": 8 }

// 直接看图：确认某个图源是不是想要的图片
{ "url": "https://example.com/character.png" }
// 网页图源：自动提取 og:image / img 候选并拉取前 2 张
{ "url": "https://example.com/gallery", "max_images": 2 }

// 读取用户发来的 B 站视频（自动返回标题、UP主、播放/点赞/投币/收藏与评论）
{ "action": "read", "url": "https://www.bilibili.com/video/BV1xx411c7mD" }

// B站 / 抖音站内搜索
{ "action": "search", "site": "bilibili", "query": "本地 AI 聊天" }
{ "action": "search", "site": "douyin", "query": "美食" }

// 在已打开页面（含评论）里像 Ctrl+F 一样找关键词
{ "action": "open", "url": "https://www.bilibili.com/video/BV..." }
{ "action": "find", "query": "价格" }

// 需要登录：弹窗让用户自己登录，用户确认后保存登录态
{ "action": "login", "url": "https://www.bilibili.com", "interactive": true }
{ "action": "cookies", "sync": true }

// 用户提供了 Cookie：保存后自动复用
{ "action": "cookies", "url": "https://www.bilibili.com", "cookie": "SESSDATA=...; bili_jct=..." }

// 交互与截图
{ "action": "click", "text": "展开更多" }
{ "action": "type", "selector": "input[name=q]", "text": "关键词", "submit": true }
{ "action": "select", "selector": "select[name=order]", "option_text": "最新" }
{ "action": "screenshot", "full_page": true }
```

## 目录结构

- `index.mjs`：前端插件（工具注册 + 设置页 / 插件设置面板入口）。
- `panel.mjs` / `ui.mjs`：设置面板 UI 与自包含的小工具。
- `bridge.mjs`：Node 后端桥，注册 `/api/web-access/*`，负责 Tavily 调用、状态加密持久化与动作分发。
- `lib/browser.mjs`：零依赖 CDP（`--remote-debugging-pipe`）浏览器控制器。
- `lib/sites.mjs`：B站（buvid + WBI 签名 API → 浏览器 DOM → 页面内嵌 JSON）、抖音（浏览器渲染 → `_ROUTER_DATA` / `RENDER_DATA`）、通用网页读取与站内搜索。
- `lib/cookies.mjs`：Cookie 库、输入解析、本机浏览器导入与 Chromium v10/v11 解密。
- `lib/http.mjs` + `lib/net-guard.mjs`：SSRF 防护的 HTTP 通道与 HTML 提取。
- `lib/tavily.mjs`：Tavily `/search` 与 `/extract` 客户端。
- `test.mjs`：纯逻辑自测（`node extensions/web-access/test.mjs`）。

安全默认值：拒绝 `localhost` / 内网 / 云元数据地址（可在设置中显式放开）；Cookie 值不会通过工具结果回显给模型；页面内容一律视为不可信外部数据。

## v1.1.0 新能力（媒体 / 下载器集成）

- **抖音图文读取**：`browser(action="read", url="https://v.douyin.com/xxx/")` 现在通过抖音官方详情接口读取：
  视频返回标题 / 作者 / 时长 / 播放点赞收藏转发 / 视频直链 / 封面 / 原声；
  图文（笔记）额外返回 `image_urls` 图片地址列表，并把前几张图片带进模型上下文（`include_images` 默认开，`image_limit` 可调）。
  模型可以直接引用 `image_urls` 用 `chat_send` 的 images 转发。
- **Cookie 导出给下载器**：面板新增「导出 cookies.txt」，也支持 `POST /api/web-access/cookies { "export": true, "domains": ["bilibili.com","douyin.com"] }`，
  导出 Netscape 格式到 `<数据目录>/web-access/files/`（只回传路径，不回传 Cookie 值）。
- **快捷登录**：面板新增「登录抖音 / 登录 B站」按钮，一键打开独立浏览器窗口；登录完成后点「同步 Cookie」即可长期复用（CDP 读取，不受 Chrome/Edge App-Bound 加密影响）。
- **给其它插件用的服务**：后端桥现在 `ctx.provide('web-access', ...)`，提供 `search / read / readDouyin / cookieHeaderFor / cookieSummary / exportCookies / browserStatus`，
  供「点歌台（media-post）」等插件复用搜索、Cookie 与抖音图文解析能力。

## v2.1.0 新能力（公网图源查看）

- **新增 `web_image` 工具**：把网络图片直接拉进模型上下文查看确认。
  - `{ "url": "https://.../a.jpg" }`：直链图片，返回 `images`（Data URI，模型可直接看到）与 `image_urls`（原始 URL）。
  - `{ "url": "https://.../gallery", "max_images": 2 }`：网页地址会自动提取 `og:image` / `<img>` / `srcset` / 内联背景图候选，并下载前几张给模型看。
  - `source_page` 可传 Referer 绕过部分盗链；SSRF 防护、Cookie 库、浏览器登录态与代理逻辑与 `browser` 完全共用。
- **与 Agnes 生图 / 生视频插件联动**：模型可以按「web_search 找图源 → web_image 确认图片 → agnes_generate_image / agnes_generate_video 的 `reference_image_ids` 引用已保存图片」完成“先找参考图，再按参考图生成”的链路。`web_image` 会把看到的图同时保存到念风图片服务并返回 `image_ids`，比直接传原站 URL 更稳（不受防盗链 / Cookie 影响）。
- 后端桥服务新增 `image(params)`，其它插件也可以直接复用「按 URL / 网页拉图」能力。
- `safeFetch` 新增 `proxy` 参数；`web_image` 会跟随「设置 → 网络」的全局代理，也支持图源站点的 Cookie 登录态。

### 一句话示例

```text
用户：你去找一下《崩坏：星穹铁道》知更鸟的图，然后帮我改成赛博朋克夜景风格。

模型：
1. web_search / browser 找到候选图源页面
2. web_image 拉取并确认确实是知更鸟
3. agnes_generate_image({ prompt: "赛博朋克夜景，保留角色身份与构图", reference_image_ids: ["web_image 返回的 imageId"], ratio: "3:4" })
4. 生成完成后插件自动把图片发回会话
```
