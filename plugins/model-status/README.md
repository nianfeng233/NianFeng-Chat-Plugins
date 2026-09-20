# 模型状态订阅（model-status）· 念风独立扩展

给念风聊天客户端增加一套「模型厂商状态页订阅」能力，**独立目录、不改本体**：

- 在插件设置里为**每个渠道**（QQ 群 / 私聊 / 微信等）选择要订阅哪些厂商状态页；
- 状态页出现故障、恢复、计划维护或模型组件状态变化时，自动把消息推送到对应渠道；
- 还可以精确到具体模型 / 组件（如 OpenAI 的 API / ChatGPT、Google 的 Gemini API 产品）；
- 第一次检查只建立基线，不会刚安装就补发一堆历史故障；休眠 / 重启后过旧的事件也会自动忽略。

## 支持的状态页

绝大多数模型厂商使用 Atlassian Statuspage，可直接读取其官方 `summary.json` / RSS；
少数厂商（Google Cloud）使用 `incidents.json`。插件内置以下来源，均可在设置页点「测试连接」验证：

| 厂商 | 默认地址 | 说明 |
|---|---|---|
| DeepSeek | `status.deepseek.com` | 官方 |
| Claude（Anthropic） | `status.anthropic.com` | 官方 |
| GPT（OpenAI） | `status.openai.com` | 官方 |
| Grok（xAI） | `status.x.ai` | 官方 |
| Gemini（Google） | `status.cloud.google.com/incidents.json` | 默认只筛 Gemini / Generative Language 相关产品，可在订阅里改关键词或选具体产品 |
| Mistral AI | `status.mistral.ai` | |
| Groq | `status.groq.com` | |
| Together AI | `status.together.ai` | |
| Fireworks AI | `status.fireworks.ai` | |
| Replicate | `status.replicate.com` | |
| Cohere | `status.cohere.com` | |
| Hugging Face | `status.huggingface.co` | |
| OpenRouter | `status.openrouter.ai` | |
| Llama API（Meta） | `status.llama.com` | |
| Perplexity | `status.perplexity.ai` | 地址未在全部网络环境验证 |
| Kimi（Moonshot） | `status.moonshot.cn` | 地址未在全部网络环境验证，失败请改用自定义来源 |
| MiniMax | `status.minimax.io` | 地址未在全部网络环境验证 |
| Z.ai / 智谱 | `status.z.ai` | 地址未在全部网络环境验证 |
| 硅基流动 | `status.siliconflow.cn` | 地址未在全部网络环境验证 |
| Cursor | `status.cursor.com` | 编程助手 |
| Stability AI | `status.stability.ai` | 图像模型 |
| Fal.ai | `status.fal.ai` | 图像 / 视频模型 |
| Runway | `status.runwayml.com` | 视频模型 |
| ElevenLabs | `status.elevenlabs.io` | 语音模型 |
| Deepgram | `status.deepgram.com` | 语音模型 |
| AssemblyAI | `status.assemblyai.com` | 语音模型 |
| Pinecone | `status.pinecone.io` | AI 基础设施 |
| Modal | `status.modal.com` | AI 基础设施 |

找不到的厂商可以在设置页「添加自定义来源」，直接填状态页根地址或 RSS 地址：
auto 会优先尝试对根地址拼接 `/api/v2/summary.json`，再尝试 `/history.rss`，最后读取原地址本身；
也可以手动指定 `Statuspage API`、`RSS / Atom` 或 `Google Cloud 状态` 适配器。

## 安装

### 方式 A：脚本安装（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File .\extensions\model-status\install.ps1

# 自定义数据目录
.\extensions\model-status\install.ps1 -DataDir "D:\nianfeng-data"
# 或指定外部插件目录
.\extensions\model-status\install.ps1 -PluginsDir "D:\my-plugins" -Force
```

安装后回到「设置 → 插件」点一次「重新扫描」；新版内核会同时热加载后端桥，一般不需要重启。

### 方式 B：上传 zip

在「设置 → 插件 → 添加插件」中上传 `model-status-v2.0.0.zip`（本目录下）。上传后刷新页面，必要时点「重新扫描」。

### 方式 C：手动安装

把本目录完整复制到 `<数据目录>/plugins/model-status/`（保留 `lib/` 子目录），然后在插件页「重新扫描」。

## 配置入口

- 「设置 → 功能 → 模型状态订阅」
- 「设置 → 插件 → 模型状态订阅 → 设置」

### 1. 轮询与通知设置

- **轮询间隔**：默认 2 分钟。Statuspage 的组件状态更新通常会实时变化，但没有必要检查得太频繁。
- **HTTP 代理**：留空跟随「设置 → 网络」的全局代理。OpenAI / Anthropic 等站点在部分网络无法直连，可在
  这里单独填 `http://127.0.0.1:7890`（支持 HTTP / HTTPS 代理）。
- **时区**：通知正文和设置页显示的时间，默认 `Asia/Shanghai`。
- **旧事件补发上限**：默认 24 小时。休眠、后端离线、重装期间产生的、早于该时长的状态变化只记录在
  「最近事件」里，不再推送，避免醒来被历史故障刷屏。
- **通知过期时间**：默认 30 分钟。通知生成后长时间没有渠道运行时投递会自动作废。
- **消息最大长度**：默认 1200 字符，超出会截断并保留详情链接。

修改后点「保存配置」。

### 2. 渠道订阅

在「渠道订阅」区域会列出所有已添加的渠道。对每个渠道：

1. 在下拉框选择要订阅的厂商，点「添加来源」；
2. 在该来源行勾选要推送的事件：
   - 故障与恢复：新的故障事件、状态更新（调查中 → 已定位 → 观察中）以及最终恢复；
   - 计划维护：Statuspage / Google Cloud 的计划维护安排与状态变化；
   - 组件状态：模型组件从正常变为性能下降 / 部分故障 / 重大故障等（故障事件已覆盖的组件变化会自动去重）。
3. 点「组件筛选」可以进一步勾选具体模型 / 组件；一个都不勾表示该来源下全部组件。RSS 动态流可用
   「关键词过滤」实现类似效果；
4. 顶部的「订阅中 / 未启用」开关控制该渠道是否接收通知；
5. 「测试推送」会生成一条测试通知，验证渠道外发链路。

订阅保存在后端 `<数据目录>/model-status.json`，浏览器关闭、只开服务端代聊时也会继续轮询和推送。

### 3. 来源目录

- 「测试连接」会立即访问一次该来源并建立基线（如果之前还没建立）；
- 「打开状态页」打开厂商官方状态页；
- 自定义来源会自动生成 `custom-xxx` 的 id，可随时删除；删除时引用它的渠道订阅也会移除。

## 工作原理

```
浏览器 / 服务端代聊（index.mjs）
  ├─ 设置页：按渠道保存订阅
  ├─ 认领后端生成的待投递通知
  └─ 写入渠道会话 → channel-base 外发到 QQ / 微信等
                ▲
                │ SSE model-status:event + claim 轮询
                │
后端桥（bridge.mjs）
  ├─ 定时轮询 Statuspage summary / RSS / Google Cloud incidents
  ├─ 对比上次快照：incident.updated_at / component.status / RSS guid
  ├─ 生成事件 + 按渠道订阅过滤 → notifications
  └─ 持久化 <数据目录>/model-status.json
```

- **基线**：第一次成功读取某个来源时只保存快照，不产生通知；从第二次检查开始才比较变化。
- **事件去重**：每次事件有稳定的 id（来源 id + 事件 id + 更新时间 / guid），同一事件对同一渠道
  只生成一条通知。
- **多端投递**：浏览器与 `server-agent` 同时运行时通过原子 claim 接口认领，保证同一条通知只外发一次。
- **失败退避**：某个来源连续检查失败会指数放大重试间隔，最长 30 分钟；设置页可看到最近错误。

## 安全与隐私

- 只读公开状态页 / RSS，不发送任何账号凭据；
- 自定义 URL 会经过 SSRF 校验：拒绝 localhost / 内网 / 云元数据地址，重定向每一跳都会重新校验；
- 支持已配置的 HTTP(S) 代理，代理地址只保存在本机 `model-status.json`；
- 插件无模型工具、无写操作，不会把状态页内容作为提示词交给模型；
- 状态页内容一律按纯文本截断展示，不执行 HTML / 脚本。

## 已知边界

- 部分厂商状态页可能更换域名或关闭 Statuspage API，导致内置地址失效。设置页「测试连接」会给出明确错误，
  可改用「自定义来源」；
- Google Cloud 的 incidents.json 包含全部产品事件，默认只筛 `gemini` 关键词，误报 / 漏报时请在渠道订阅里
  修改关键词或选择具体产品；
- RSS / Atom 只有条目，不提供完整组件状态；需要精确到模型时请优先使用 Statuspage 站点；
- `status.moonshot.cn` 等未验证地址可能受你所在地区的网络影响；
- 通知正文是纯文本，兼容 QQ / NapCat / 微信；不会发送图片。

## 目录结构

```
extensions/model-status/
├─ index.mjs            前端插件：设置页注册、通知认领与渠道投递、SSE
├─ panel.mjs            设置面板：渠道订阅 / 来源目录 / 最近事件
├─ ui.mjs               自包含样式与小组件，不依赖本体 src
├─ bridge.mjs           后端桥：轮询、事件检测、通知队列、HTTP 路由
├─ lib/
│  ├─ sources.mjs       内置来源目录 + 自定义来源
│  ├─ statuspage.mjs    Statuspage summary / incident / component 解析
│  ├─ feed.mjs          RSS 2.0 / Atom 解析
│  ├─ google-cloud.mjs  Google Cloud incidents.json 解析
│  ├─ detect.mjs        快照对比、事件过滤、通知文案
│  ├─ http.mjs          代理 + 手动重定向的受控 HTTP 客户端
│  └─ net-guard.mjs     SSRF 防护（DNS 固定 / 逐跳校验）
├─ manifest.json
├─ install.ps1
├─ test.mjs             纯逻辑自测：node test.mjs
└─ README.md
```

## 自测

```powershell
node extensions/model-status/test.mjs
# 结果：45/45 项通过
```

自测不联网，覆盖来源目录、Statuspage / RSS / Atom / Google Cloud 解析、基线建立、事件去重、
组件筛选、通知文案截断等纯逻辑。

## 更新记录（v2.0.0）

- 首个版本：内置 20+ 模型 / AI 基础设施厂商状态页；
- 支持每渠道订阅、事件类型开关、具体模型 / 组件筛选与关键词筛选；
- 支持 Statuspage API、RSS / Atom、Google Cloud incidents.json，自定义来源 auto 识别；
- 原子 claim 防重复投递、过期通知作废、旧事件补发上限、失败退避、代理与 SSRF 防护；
- 测试通知与最近事件面板，便于确认链路。
