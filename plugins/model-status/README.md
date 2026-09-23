# 模型状态订阅（model-status）· 念风独立扩展

给念风聊天客户端增加一套「模型厂商状态页订阅」能力，**独立目录、不改本体**：

- 在插件设置里为**每个渠道**（QQ 群 / 私聊 / 微信等）选择要订阅哪些厂商状态页；
- 状态页出现故障 / 质量下降、恢复或计划维护时，默认只把重要节点自动推送到对应渠道，过程更新和普通公告不刷屏；
- 同一轮检查的多条变化会自动合并成摘要，英文状态会尽量中文化；
- 还可以精确到具体模型 / 组件（如 OpenAI 的 API / ChatGPT、Google 的 Gemini API 产品）；
- 第一次检查只建立基线，不会刚安装就补发一堆历史故障；休眠 / 重启后过旧的事件也会自动忽略。

## 支持的状态页

绝大多数模型厂商使用 Atlassian Statuspage，可直接读取其官方 `summary.json` / RSS；
少数厂商（Google Cloud）使用 `incidents.json`。插件内置以下来源，均可在设置页点「测试连接」验证：

| 厂商 | 默认地址 | 说明 |
|---|---|---|
| DeepSeek | `status.deepseek.com/history.rss` | 官方 RSS 动态（页面不是 Statuspage API） |
| Claude（Anthropic） | `status.anthropic.com` | 官方 Statuspage |
| GPT（OpenAI） | `status.openai.com` | 官方 Statuspage |
| Grok（xAI） | `status.x.ai/feed.xml` | 官方 RSS 动态（页面不是 Statuspage API） |
| Gemini（Google） | `status.cloud.google.com/incidents.json` | 默认只筛 Gemini / Generative Language 相关产品，可在订阅里改关键词或选具体产品 |
| Mistral AI | `status.mistral.ai` | Statuspage；部分网络 / 代理出口会被 Cloudflare 403 |
| Perplexity | `status.perplexity.com/feed.rss` | 官方 RSS 动态 |
| Groq | `groqstatus.com/feed.rss` | 官方 RSS 动态 |
| Together AI | `status.together.ai/feed` | 官方 RSS 动态 |
| Fireworks AI | `status.fireworks.ai` | Statuspage |
| Cohere | `status.cohere.com` | Statuspage |
| Hugging Face | `status.huggingface.co` | 自动识别官方 RSS |
| OpenRouter | `status.openrouter.ai` | Statuspage；部分网络 / 代理出口会被 Cloudflare 403 |
| Llama API（Meta） | `status.llama.com` | Statuspage；地址可能在部分网络不可达 |
| Kimi（Moonshot） | `status.moonshot.cn` | Statuspage |
| MiniMax | `status.minimax.io` | Statuspage |
| Z.ai / 智谱 | `status.z.ai` | 地址可能在部分网络不可达，失败请改用自定义来源 |
| Cursor | `status.cursor.com` | Statuspage · 编程助手 |
| Stability AI | `status.stability.ai` | Statuspage · 图像模型 |
| Fal.ai | `status.fal.ai/history.rss` | 官方 RSS 动态 · 图像 / 视频模型 |
| Runway | `status.runwayml.com` | Statuspage · 视频模型 |
| ElevenLabs | `status.elevenlabs.io` | Statuspage · 语音模型 |
| Deepgram | `status.deepgram.com` | Statuspage · 语音模型 |
| AssemblyAI | `status.assemblyai.com` | Statuspage · 语音模型 |
| Pinecone | `status.pinecone.io` | Statuspage · AI 基础设施 |
| Modal | `status.modal.com` | 自动识别官方 RSS · AI 基础设施 |

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

在「设置 → 插件 → 添加插件」中上传 `model-status-v2.2.1.zip`（本目录下）。上传后刷新页面，必要时点「重新扫描」。

### 方式 C：手动安装

把本目录完整复制到 `<数据目录>/plugins/model-status/`（保留 `lib/` 子目录），然后在插件页「重新扫描」。

## 配置入口

- 「设置 → 功能 → 模型状态订阅」
- 「设置 → 插件 → 模型状态订阅 → 设置」

### 1. 轮询与通知设置

- **轮询间隔**：默认 2 分钟。Statuspage 的组件状态更新通常会实时变化，但没有必要检查得太频繁。
- **通知模式**：默认「仅异常与恢复」——只推送服务出错 / 中断 / 质量下降、以及最终恢复；同一故障的
  调查中 → 已定位 → 观察中过程更新只记录到「最近事件」，不再逐条刷群。切换为「全部状态更新」可恢复旧行为。
- **HTTP 代理**：留空跟随「设置 → 网络」的全局代理。OpenAI / Anthropic 等站点在部分网络无法直连，可在
  这里单独填 `http://127.0.0.1:7890`（支持 HTTP / HTTPS 代理）。
- **时区**：通知正文和设置页显示的时间，默认 `Asia/Shanghai`。
- **旧事件补发上限**：默认 24 小时。休眠、后端离线、重装期间产生的、早于该时长的状态变化只记录在
  「最近事件」里，不再推送，避免醒来被历史故障刷屏。
- **通知过期时间**：默认 30 分钟。通知生成后长时间没有渠道运行时投递会自动作废。
- **消息最大长度**：默认 1200 字符，超出会截断并保留详情链接。

修改后点「保存配置」。

#### 默认通知规则（v2.2.0）

- **会推送**：服务出现故障 / 中断 / 暂停、错误率升高、性能下降、组件状态恶化，以及故障最终恢复；
- **不会推送（只进最近事件）**：调查中 → 已定位 → 观察中等过程更新、普通状态页公告、没有先看到异常的“恢复”、
  建立基线时已经存在的旧故障；
- **自动合并**：同一轮检查里同一来源出现多条异常 / 恢复 / 组件变化时，合并成一条摘要，避免一次全局故障
  把几十个组件拆成几十条消息；
- **英文中文化**：OpenAI 等英文 RSS 的标题、状态会尽量转成中文；无法可靠翻译的英文正文不会原文转发，
  只保留状态和受影响组件列表。

### 2. 渠道订阅

在「渠道订阅」区域会列出所有已添加的渠道。对每个渠道：

1. 在下拉框选择要订阅的厂商，点「添加来源」；
2. 在该来源行勾选要推送的事件：
   - 异常与恢复：首次出现的故障 / 中断 / 质量下降，以及最终恢复。过程更新默认不推送；
   - 计划维护：Statuspage / Google Cloud 的计划维护安排与状态变化；
   - 组件状态变化：模型组件从正常变为性能下降 / 部分故障 / 重大故障，以及恢复（故障事件已覆盖的组件变化会自动去重）。
3. 点「组件筛选」可以进一步勾选具体模型 / 组件；一个都不勾表示该来源下全部组件。RSS 动态流可用
   「关键词过滤」实现类似效果；
4. 顶部的「订阅中 / 未启用」开关控制该渠道是否接收通知；
5. 「测试推送」会生成一条测试通知，验证渠道外发链路。

订阅保存在后端 `<数据目录>/model-status.json`，浏览器关闭、只开服务端代聊时也会继续轮询和推送。

### 3. 来源目录

- 「测试连接」会立即访问一次该来源并建立基线（如果之前还没建立）；
- 「打开状态页」打开厂商官方状态页；
- 自定义来源会自动生成 `custom-xxx` 的 id，可随时删除；删除时引用它的渠道订阅也会移除。

### 4. 模型查询工具（model_status_query）

插件给模型注册了一个只读工具 `model_status_query`，用户不需要手动打开设置页，直接问模型即可：

- “DeepSeek 现在正常吗？”
- “Claude 有没有故障？”
- “Gemini API 状态怎么样？”
- “查一下最近哪些模型出问题了？”

工具参数：

| 参数 | 说明 |
|---|---|
| `action` | `status` 查询指定厂商当前状态（默认）；`list` 列出插件支持的全部来源；`events` 查看插件最近捕获的状态变化事件 |
| `vendor` | 厂商 id / 名称 / 关键词，如 `deepseek`、`claude`、`anthropic`、`openai`、`gpt`、`gemini`、`grok`、`groq`、`moonshot` |
| `keyword` | 可选，只关注包含该关键词的组件 / 产品 / 事件，如 `API`、`R1`、`ChatGPT`、`Gemini` |
| `limit` | 可选，`events` 返回条数，默认 10，最大 50 |

工具只读、不修改订阅、不发送渠道消息；返回内容会经过纯文本截断，适合模型直接总结给用户。

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
- 插件只有一个只读查询工具 `model_status_query`，无写操作，不会把状态页内容作为指令执行；
- 状态页内容一律按纯文本截断展示，不执行 HTML / 脚本。

## 已知边界

- 部分厂商状态页可能更换域名或关闭 Statuspage API，导致内置地址失效。设置页「测试连接」会给出明确错误，
  可改用「自定义来源」；
- Google Cloud 的 incidents.json 包含全部产品事件，默认只筛 `gemini` 关键词，误报 / 漏报时请在渠道订阅里
  修改关键词或选择具体产品；
- RSS / Atom 只有条目，不提供完整组件状态；需要精确到模型时请优先使用 Statuspage 站点；
- `status.z.ai`、`status.llama.com` 等地址可能在部分地区的网络 / 代理出口不可达，失败时请改用自定义来源；
- 硅基流动的官方状态域名 `status.siliconflow.cn` 目前会 CNAME 到 Better Stack，但在多数网络下 TLS 握手失败、页面也无法打开；v2.1.0 已暂时移除该内置来源，等官方恢复后可用「自定义来源」重新添加；
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
│  ├─ text.mjs          英文状态分类、中文化、组件提取与摘要
│  ├─ kind.mjs          事件类型中文标签（前后端共用的纯常量）
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
# 结果：73/73 项通过
```

自测不联网，覆盖来源目录、Statuspage / RSS / Atom / Google Cloud 解析、基线建立、事件去重、
重要通知筛选、多条变化合并、英文中文化与组件筛选、通知文案截断等纯逻辑。

## 更新记录（v2.2.1）

- 修复外部插件热更新时 `bridge.mjs` 已重新加载、但 `lib/` 仍命中 Node 旧 ESM 模块缓存的问题：
  - bridge 与 lib 依赖链统一使用内核传入的 `?v=` revision，更新插件后不需要重启后端也能加载新模块；
  - 从 v2.1.1 / v2.2.0 更新到 v2.2.1 时，后端桥可以真正热加载，不再出现「重新扫描后 /api/model-status/* 404」；
- 启动阶段的待投递通知检查改为静默 404：后端桥尚未加载完成时不再右下角弹「后端桥未加载」，
  避免安装 / 重新扫描瞬间误报和多开页面重复弹两个；面板顶部仍会明确显示「后端桥未加载」。

## 更新记录（v2.2.0）

- 默认通知模式改为「仅异常与恢复」：同一条故障只在首次异常 / 质量下降时推一条，恢复时再推一条，
  调查中 → 已定位 → 观察中的过程更新只记录到「最近事件」，不再逐条刷群；
- 同一轮检查里同一来源的多条异常 / 恢复 / 组件变化会合并成一条摘要，避免全局故障时几十个组件
  各发一条通知；
- 针对 OpenAI 等英文 RSS：识别 `Status: Investigating / Identified / Monitoring / Resolved`，
  中文化常见事件标题，提取 affected components 列表；无法可靠翻译的英文正文不再原文转发；
- 修复 v2.1.x 旧快照升级后旧故障可能被当成新动态补发的问题：升级后的第一轮静默重建基线；
- 新增「通知模式」设置项，需要旧版逐条过程动态的用户可切换为「全部状态更新」；
- 修复 `index.mjs` 版本号未同步到 2.2.0、导致插件市场安装后仍显示「可更新 · 本地 2.1.1」的问题；自测新增「清单 / 前端 / 后端 / 面板版本号一致」检查，避免再次漏改。

## 更新记录（v2.1.1）

- 设置页修复：自定义来源区域改为独立表单布局，窄屏 / 长帮助文案不再把左侧文字挤成竖排；
- 新增模型工具 `model_status_query`（action=status/list/events），模型可主动查询指定厂商的整体状态、组件、进行中故障与最近事件；
- 后端新增 `/api/model-status/query`，支持按厂商 id / 名称 / 关键词模糊匹配来源，结果带缓存，避免模型重复追问时反复访问状态页；
- 硅基流动 `status.siliconflow.cn`（Better Stack 托管）在当前网络下 TLS 握手失败、页面无法访问，暂时移除内置来源，等官方恢复后可自定义添加；
- 面板顶部新增「后端 vX / 面板 vY」版本徽标：安装新版后如果仍看不到新布局或看不到「面板 v2.1.1」，说明浏览器还在用旧前端模块，请关闭设置浮层并 Ctrl+F5 强制刷新。
- 查询结果会自动走现有代理、SSRF 保护与纯文本截断，不写状态、不发渠道消息。

## 更新记录（v2.0.1）

- 修正 HTTP(S) 代理下的 HTTPS 隧道实现：之前与部分代理组合会报
  `EPROTO packet length too long` / 请求超时，现在统一使用 CONNECT + TLS socket；
- 补齐代理模式下的 TLS 握手与请求超时，避免网络异常时轮询卡死；
- RSS 事件检测加入同 guid 内容哈希：像 xAI 这类在原条目上追加更新的 feed 也能推送状态变化；
- 根据真实状态页验证结果修正内置来源：
  - DeepSeek 改为官方 `history.rss`（该站不是 Statuspage API）；
  - xAI / Grok 改为官方 `feed.xml`；
  - Groq、Perplexity、Together、Fal 改为官方 RSS 地址；
  - 移除无公开 API / RSS 的 Replicate，避免用户选中后反复失败；
  - 自动识别候选补充 `/feed`、`/feed.rss`、`/feed.xml` 等常见路径；
  - Moonshot / MiniMax / Hugging Face / Modal / Runway 等已通过实际状态页验证，标记为官方。

## 更新记录（v2.0.0）

- 首个版本：内置模型 / AI 基础设施厂商状态页；
- 支持每渠道订阅、事件类型开关、具体模型 / 组件筛选与关键词筛选；
- 支持 Statuspage API、RSS / Atom、Google Cloud incidents.json，自定义来源 auto 识别；
- 原子 claim 防重复投递、过期通知作废、旧事件补发上限、失败退避、代理与 SSRF 防护；
- 测试通知与最近事件面板，便于确认链路。
