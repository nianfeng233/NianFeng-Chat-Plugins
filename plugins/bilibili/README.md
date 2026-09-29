# 哔哩哔哩渠道（bilibili）

念风的外部渠道插件（**不进入本体目录**），把 B站账号接入「渠道」体系：

- **私信**：收 / 发独立，按对端 UID 分会话；
- **消息中心**：对应主页右上角「消息」里的 回复我的 / @我的 / 收到的赞 / 系统消息；
- **评论 / 互动**：可监控指定稿件（或自动监控自己最近投稿）的新评论，支持主动发评论、回复评论、点赞、投币、收藏与一键三连；
  @ 我 / 回复我的通知会自动补上视频标题、链接、UP 与简介，并在缺评论 ID 时自动反查；
- **登录**：应用内扫码（协议直连，推荐）/ Edge 托管登录（每渠道独立浏览器窗口）/ 手动 Cookie；
- **私信实时**：默认开启「WebSocket 镜像」——在该渠道独立的 Edge 里常驻一个 `message.bilibili.com` 标签页，
  通过 CDP hook 读取官方长连接帧，消息到达即推送；轮询自动降频只做断线补收，浏览器不可用时纯轮询兜底；
- **黑白名单**：按 **目标 UID** 判定，与显示昵称无关；名单外可选 照单全收 / 静默入库 / 概率处理 / 规则处理；
- **模型工具**：`bilibili_dm_send`、`bilibili_dm_read`、`bilibili_notice_read`、`bilibili_comment_read`、`bilibili_comment_post`、`bilibili_comment_reply`、`bilibili_video_like`、`bilibili_video_coin`、`bilibili_video_favorite`、`bilibili_video_triple`，每个都能单独调用。

> B站没有面向普通开发者的私信 / 评论机器人协议。插件走**登录态接口（协议）为主 + 每渠道独立 Edge 页面上下文兜底**，
> 属于非官方自动化，可能触发风控或限制账号。请使用小号、保持低频，并自行评估风险。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\extensions\bilibili\install.ps1
# 或指定数据目录 / 插件目录
.\extensions\bilibili\install.ps1 -DataDir "D:\nianfeng-data" -Force
```

安装后回到念风：**设置 → 插件 → 重新扫描**（新版内核会热加载 `bridge.mjs`，不需要重启整个程序），
再到**渠道 → 添加渠道 → 哔哩哔哩**。

## 使用流程

1. 添加渠道：选择角色、渠道分类、登录方式与接入能力；
2. 完成登录：
   - **应用内扫码**：手机 B站客户端扫码；登录态会 AES-256-GCM 加密保存到 `<数据目录>/bilibili.json`；
   - **Edge 托管登录**：后端为**该渠道**单独启动 Edge（独立 `--user-data-dir` + `--remote-debugging-pipe`），
     你在真实窗口里登录；插件读取 Cookie 后接管，浏览器可保留作为风控兜底；
   - **手动 Cookie**：至少需要 `SESSDATA`，建议同时提供 `bili_jct`、`DedeUserID`、`buvid3`；
3. 在渠道详情配置接入能力、轮询间隔、浏览器兜底与黑白名单。

## 黑白名单与名单外策略

判定顺序固定为：**黑名单 → 白名单 → 名单外策略**。每个分类（私信 / 评论 / @我 / 点赞 / 系统）可独立配置。

三档处理结果：

| 档位 | 含义 |
| --- | --- |
| `drop` | 丢弃：不落库、不进上下文、不回复 |
| `ingest` | 静默入库：写入聊天记录与上下文，但不触发模型、不回复 |
| `process` | 正常处理：触发模型并回复 |

名单外四种模式：

- `all` 照单全收：全部 `process`；
- `inbox` 静默入库：全部 `ingest`（默认，最保守）；
- `probability` 概率处理：按消息 ID 稳定哈希，命中概率 `process`，否则 `ingest`；
- `rules` 规则处理：按规则逐条匹配，命中取规则档位，未命中取「规则未命中时」的默认档位。

规则语法（每行一条）：

```
keyword:加群 -> process
regex:优惠|福利|抽奖 -> ingest
uid:123456 -> drop
```

- `keyword` 不区分大小写子串匹配 `regex` 为正则；`uid` 精确匹配发送者 UID；
- 不写 `-> 档位` 时默认 `process`；
- 启动 / 断线期间积压的消息即使命中 `process` 也会降级为 `ingest`，避免重启后批量刷屏；
- 首次同步每个会话 / 通知分类 / 监控稿件只保留最近 3 条静默入库，其余历史仅标记已读；
- 全局历史闸门：任何消息在真正被处理时已经超过 10 分钟，一律按 `ingest` 处理。

外部插件还可以监听 `bilibili:trigger-decision` 事件拦截 / 修改判定结果（与 NapCat 的扩展方式一致）。

## 实时私信（WebSocket 镜像）

B站没有公开的推送 API，但官方网页 `message.bilibili.com` 自己维持着私信长连接。插件不逆向这套
协议，而是用一个每渠道独立的 Edge 标签页「旁听」它：

1. `RealtimeDm` 在渠道浏览器里新建独立标签页，注入 WebSocket hook（`Page.addScriptToEvaluateOnNewDocument`）；
2. 页面每收到一帧长连接数据，通过 `Runtime.addBinding` 回传 Node；同时用
   `Network.webSocketFrameReceived` 兜底二进制帧；
3. Node 侧容错解析帧里的消息对象，交给私信模块去重 / 归一化 / 广播，因此策略、会话、模型链路完全复用；
4. 实时可用时私信轮询自动降到 120 秒以上，只做漏收补扫；页面掉线 / 解析失败 / 浏览器关闭都会自动回退轮询；
5. 可在渠道详情里关闭「私信实时推送」，关闭后恢复纯轮询。

> 消息中心（回复我的 / @我的 / 点赞 / 系统）没有可用的长连接，仍按配置的低频轮询处理。
> 私信记录接口做了多端点自动探测（新版 `svr_sync/fetch_session_msgs` → 旧版 `session_svr`），
> 全部不可用时用会话列表的 `last_msg` 兜住最新一条，不会刷屏报错。

## 每渠道隔离

- 一个渠道 = 一个 B站账号；
- 账号内再按线程拆分独立会话：私信对端一个会话、稿件评论一个会话，各自有上下文与外发目标；
- 每条渠道拥有独立 Edge profile / 进程、独立私信队列、独立评论队列；
- 私信 / 评论发送各自有「最小间隔 + 每小时上限 + 每日上限 + 风控冷却」；
  命中 B站风控码（-352 / -412 / -509 等）后暂停协议请求 15 分钟，后续自动走浏览器页面上下文执行；
- 模型在某个会话里调用 `bilibili_dm_send` / `bilibili_comment_post` / `bilibili_comment_reply` 主动发送后，
  该会话本轮助手总结文本会被抑制 15 秒，避免同一内容被自动外发重复发一遍；
- 评论会话的自动外发会在 2.2 秒窗口内合并：多条助手消息用换行拼成一条评论，超过 900 字才拆段；私信仍逐条发送。

## 评论被折叠 / 仅自己可见怎么办

`reply/add` 返回 `code=0` 只代表 B站 接收了提交，**不等于公开展示**。常见原因：

- **审核中**：新号 / 低等级 / 未绑定手机号或实名的账号，评论常先进入审核，只有自己可见；
- **风控**：协议直连（非浏览器）请求频繁，容易被判定自动化，后续评论可能被影子限制；
- **UP主评论筛选**：对方开启评论审核或关键词过滤，命中会待审核或折叠；
- **回复目标本身不可见**：被回复的那条评论若在审核 / 被折叠，你的回复也会跟着不可见；
- 重复 / 相似内容、链接、短时间连续 @ 与三连，都会提高触发概率。

插件提供的规避手段：

1. 渠道详情 → 接入能力 → **发送方式改为「浏览器优先」**：评论 / 点赞 / 投币 / 收藏通过该渠道独立
   Edge 的页面上下文发出，TLS 与请求指纹和真人页面一致，被风控概率更低；
2. 评论发送默认间隔 15~30 秒（可在详情里调轮询），不要短时间连续评论多个视频；
3. 账号先正常使用几天（观看 / 点赞 / 收藏、绑定手机号或实名）再提高频率；
4. 每次发送后插件会回查公开回复列表并给出「已公开 / 未公开（可能在审核）」结论与 rpid；
5. 持续未公开基本是账号侧风控 / 审核问题，换号或降低频率通常能恢复，不是插件逻辑能绕过的。

## 数据与隐私

| 路径 | 内容 |
| --- | --- |
| `<数据目录>/bilibili.json` | 渠道 Cookie（AES-256-GCM 加密）、账号信息、策略游标、收件箱 |
| `<数据目录>/bilibili/<channelId>/browser-profile` | 该渠道独立的 Edge 登录态 |
| `<数据目录>/bilibili/<channelId>/files` | 浏览器下载 / 截图等临时文件 |

加密密钥复用念风数据目录的 `.secret-key`；删除渠道时会同步删除对应状态与浏览器 profile 记录（profile 目录可在关闭程序后手动清理）。

## HTTP 路由（供前端 / 其它插件调用）

```
GET    /api/bilibili/status?channelId=
GET    /api/bilibili/inbox?channelId=&after=
POST   /api/bilibili/inbox/ack
POST   /api/bilibili/channels/config
DELETE /api/bilibili/channels/:channelId
POST   /api/bilibili/login/qrcode
GET    /api/bilibili/login/qrcode?channelId=&key=
POST   /api/bilibili/login/cookie
POST   /api/bilibili/login/browser
GET    /api/bilibili/login/browser?channelId=
POST   /api/bilibili/logout
POST   /api/bilibili/browser/close
POST   /api/bilibili/dm/send
GET    /api/bilibili/dm/sessions?channelId=
GET    /api/bilibili/dm/messages?channelId=&peerUid=&limit=
GET    /api/bilibili/notice/list?channelId=&kind=reply
POST   /api/bilibili/notice/refresh
POST   /api/bilibili/comment/post
POST   /api/bilibili/comment/reply
GET    /api/bilibili/comment/list?channelId=&target=&limit=
```

SSE 实时事件：`bilibili:message`（入站）、`bilibili:status`（账号 / 风控 / 浏览器状态）、`bilibili:notice`（风险提示）。

## 文件结构

```
extensions/bilibili/
├─ index.mjs        前端渠道：渠道注册、会话映射、入站策略、独立外发、工具、UI
├─ bridge.mjs       后端桥：路由、状态、每渠道运行时生命周期
├─ lib/
│  ├─ api.mjs         协议客户端（Cookie / WBI / 私信 / 消息中心 / 评论端点）
│  ├─ transport.mjs   协议优先 + 浏览器页面上下文兜底
│  ├─ runtime.mjs     单个渠道运行时（登录、轮询、浏览器、风险）
│  ├─ dm.mjs          私信收 / 发（独立队列）
│  ├─ notice.mjs      消息中心收
│  ├─ comment.mjs     评论扫描 / 主动评论 / 回复（独立队列）
│  ├─ policy.mjs      黑白名单与名单外策略（纯函数）
│  ├─ normalize.mjs   接口数据 → 统一入站结构
│  ├─ queue.mjs       串行 + 限速 + 每日上限队列
│  ├─ store.mjs       状态持久化与凭据加密
│  └─ browser.mjs     零依赖 CDP over --remote-debugging-pipe（自包含，复用自 web-access）
├─ vendor/qrcode/   离线二维码渲染
├─ style.mjs        UI 样式
└─ test.mjs         纯函数自测（node extensions/bilibili/test.mjs）
```

## 更新记录

### v1.6.0

- 新增「发送方式」：协议优先 / **浏览器优先**。浏览器优先时评论、点赞、投币、收藏走各渠道独立 Edge
  的页面上下文请求，TLS 与指纹更接近真人，降低被风控、评论仅自己可见的概率。
- 评论可见性回查改为多次重试（默认 3 次），并同时检查楼中楼与最新主评论，避免接口索引延迟造成误报。
- 评论发送间隔默认从 8~16 秒放宽到 15~30 秒，进一步降低风控概率。

### v1.5.0

- 评论外发合并：同一个评论会话里 2.2 秒窗口内的多条助手消息会用换行拼成**一条评论**再发送，
  不再突突突刷好几条；合并内容超过 900 字才按行拆段。
- 回复目标持久化到会话 meta（rpid / root / parent），延迟合并发送不会丢回复目标。
- 评论发送后可回查公开回复列表：若未公开可见（审核 / 折叠 / 仅自己可见）会明确提示并记录 rpid，
  不再把“已提交”当成“已公开”。
- 一键三连容错：重复点赞 / 已投过币 / 已收藏会被标记为 already 并继续，不再让整组失败。

### v1.4.1

- 发送类请求超时放宽：私信 / 评论 / 视频互动默认 120 秒，一键三连 180 秒；
  修复「工具报请求超时，评论实际没发出去 / 只发出第一条」的问题（原因是队列等待超过了前端默认 20 秒超时）。
- 缩短发送队列间隔：评论 8~16 秒、视频互动 4~8 秒（仍保留每小时 / 每日上限与风控冷却）；
  历史渠道 meta 里遗留的旧间隔会被忽略，统一用新默认。
- 一键三连现在能在一次工具调用里完整跑完并返回三步结果。

### v1.4.0

- 按真实通知字段重写解析：正文取 `source_content`，评论 ID 取 `source_id`，稿件取 `uri` 里的 BV 号，
  `business_id` 只当最后的兜底；不再出现把 1 当稿件 ID、把视频标题当评论正文的问题。
- enrich 解析出真实 aid 后会统一覆盖错误 oid，并把会话线程 key 归一到 `comment:<aid>:<type>`，
  避免同一稿件被错误 ID 拆成多个会话。
- 实时长连接确认为 protobuf 广播帧：不再打印未识别样本，统一为「任意帧 → REST 补收」；
  帧信号顺带以 25 秒冷却探测消息中心未读数，未读增加才拉取，@ / 回复等待从分钟级压到几十秒内。
- 消息中心默认轮询从 60 秒缩短为 30 秒（可在渠道详情调整）。

### v1.3.1

- 修复 1.3.0 引入的 `content is not defined` 崩溃：@ 通知处理会直接失败，现在已修正为使用原评论正文。
- @ 通知 oid 仍不可信时，新增「按视频标题回查自己最近投稿」兜底：匹配到真实 BV/aid 后再反查评论 rpid 与正文，
  不再对着 `av1` 尝试；若仍无法解析，会打印通知原始字段（截断）方便继续适配。
- 前端同步配置不再无条件重排轮询定时器，避免每次启动/热同步都把首次通知轮询往后推（“等很久”）。

### v1.3.0

- 修复 @ / 回复通知取错目标：`business_id` 在通知里可能只是业务编号（例如 1），现在优先用 `uri` 里的真实 oid，
  不会再出现把 `av1` 当视频去查、去回复的问题。
- 视频信息与评论正文拆成两条消息：视频信息作为独立的顶层 user 消息（每个会话只插一次），
  对方 @ 我的原评论保持原样；反查不到正文时明确写“未读取到原评论”，不再拿视频标题冒充。
- 实时镜像修复：启动前把协议登录态 Cookie 注入该渠道浏览器，未登录时不会建立长连接；
  日志会打印实时页 URL，停留在登录页会给出警告。
- 评论工具参数兼容模型常见别名：`video / url / bvid → target`、`content / message → text`、
  `comment_id / reply_id → rpid`；工具也能从当前评论会话自动取目标。

### v1.2.0

- 实时链路增强：WebSocket 帧改为「有变化就立即 REST 补收」的信号（解析失败也能近实时），
  25 秒收不到任何帧自动降级回常规轮询；实时健康时才把私信轮询降频。
- 新增视频互动能力：点赞 / 投币 / 收藏 / 一键三连，独立队列与频率、每日上限，
  新增工具 `bilibili_video_like`、`bilibili_video_coin`、`bilibili_video_favorite`、`bilibili_video_triple`。
- @ / 回复通知补全上下文：自动附上视频标题、链接、UP 主与简介；通知缺评论 rpid 时按发送者 UID
  在最新评论里反查，仍找不到则降级为在稿件下发新评论，不再直接“外发失败”。
- 评论工具支持从当前评论会话自动取 oid / rpid，模型不必再自己拼参数。

### v1.1.0

- 新增私信实时推送：镜像官方 `message.bilibili.com` WebSocket（每渠道独立 Edge 标签页 + CDP hook），
  实时可用时私信轮询降频为断线补收；可在渠道详情开关，失败自动回退轮询。
- 修复私信记录 404：消息接口改为多端点自动探测并缓存可用端点
  （新版 `svr_sync/fetch_session_msgs` → 旧版 `session_svr`），全部不可用时用会话 `last_msg` 兜底。
- 修复热更新缓存：`lib/*` 全部改为带 revision 的动态 import，避免出现「新 bridge + 旧 lib」导致修复不生效。
- 浏览器兜底请求改用临时标签页 + 互斥锁，不会把实时标签页导航走。
- 历史保护：首次同步每个会话只静默入库最近 3 条（全局上限 12 条），消息中心 / 评论同理；
  任何在「被处理时」已超过 10 分钟的消息一律 `ingest`，不会触发模型，避免重启后一口气回完历史。
- 实时启动不再重排已排队的轮询，修复首次收信「等很久」；轮询游标每轮定期落盘。
- 渠道详情支持草稿保持：宿主因新消息等事件重绘详情时，未保存的编辑会原样恢复，并显示「有未保存修改」。

### v1.0.0

- 首个版本：外部渠道插件、协议 + Edge 兜底、私信 / 消息中心 / 评论、UID 黑白名单与名单外策略。

## 已知限制

- 接口为非官方，B站调整后可能需要更新 `lib/api.mjs` 里的端点与参数；
- 图片 / 视频私信 v1 只以 `[图片]` 占位，暂不下载到本地模型上下文；
- 未互关或新号主动私信限制多，建议只回复主动来消息的人；
- 自动监控自己投稿需要 `x/space/wbi/arc/search` 权限，风控严格时可能拿不到列表，可改为手动填写 BV 号；
- 直播弹幕 / 动态主动评论暂未实现。
