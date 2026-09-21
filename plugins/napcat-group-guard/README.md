<!--
念风chat · 扩展插件 · napcat-group-guard
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 群管助手（napcat-group-guard）

给念风 + NapCat 加两块**纯代码、不经过 LLM** 的群管能力：

1. **入群申请自动审核**：只响应「群规则」里显式配置过的群；QQ 等级门槛、隐藏等级拒绝、进群白词 / 黑词、共享黑名单、被踢 / 退群 / 连续被拒自动拉黑、拉黑后自动踢出、群内申请提示（纯文字）；
2. **进出群提示**：进群成功欢迎（默认 @ 新人）、主动退群 / 被踢提示；主动退群或被踢同时触发自动拉黑时，退群提示与黑名单提示会合并为同一条消息，不再刷两条重复文本；黑名单用户反复申请时静默处理、不刷屏；
3. **QQ 档案图（仅欢迎 / 退群带图）**：进群**申请提示固定纯文字**；欢迎 / 退群提示按 QQ 资料生成原创暗色「资料档案」图（Canvas / 服务端渲染），与文字放在**同一条消息**里；**头像由后端 Node 下载并转成 data URL 返回给前端**（同 AstrBot 的 `get_avatar` 思路，不走浏览器 CORS / Blob），头像失败才用占位图；欢迎使用文字 `@` 而不是 at 消息段，避免部分 NapCat 版本 at + 图导致图片空白；图片发送依次尝试 `base64://` → `data:image/...` → 后端落盘 `file:///`，整条消息全部失败则进入补发队列，**不会把图片拆成单独消息造成重复，也不会发送空白/纯文字降级图**；
4. **只响应已配置的群**：默认只有 `groups` JSON / 设置面板里显式配置过的群会处理事件；机器人所在的其它群收到入群 / 退群 / 申请时完全忽略，不会误欢迎、误审核、误踢人。需要旧版“全局默认套所有群”行为时，把全局 `allGroups` 打开；
5. **按群独立配置**：设置面板顶部下拉选择群，用表单改该群的等级、白词黑词、进出群提示、档案图开关、清理周期 / 阈值 / 文案等；未改的项自动继承全局。`groups` JSON 与 `group_config_set` 工具仍保留，方便批量修改；
6. **定时清理不活跃成员**：每个群可配自己的周期，周期到发 `@全体成员` 预告，等待 x 分钟后按群成员列表批量踢出持续 xx 天未活跃的人；支持模型主动把某群清理倒计时直接缩减为立即触发；每轮踢完后播报下一轮时间；自动清人固定在该周期落点当天的 18:00，每天约 20:00 播报下一轮清人日期、预计清理人数和剩余天数。

> **渲染器要求**：不需要 WebUI 页面常驻。欢迎 / 退群档案图优先用浏览器 Canvas 本地绘制；服务端代聊 / headless 实例没有 2D Canvas，会自动调用后端桥 `/api/group-guard/render` 生成档案图——优先 PowerShell + System.Drawing，若环境不允许拉起 PowerShell（EPERM / ENOENT）则自动降级为纯 Node PNG，仍能独立处理 `napcat:request`、notice 与清理租约。v1.1.9 启动日志会输出 `渲染器=浏览器 Canvas（本地）` 或 `渲染器=服务端渲染（PowerShell，失败自动纯 Node PNG）`。

- **类型**：外部扩展插件（本目录不随主体打包，需安装到数据目录的插件目录）
- **依赖**：内置 `napcat` 渠道插件（v1.0.0+）、`channel-registry`、`config`、`event-bus`、`tool-registry`
- **工具数量**：1 个（`napcat_group_guard`，内部覆盖黑名单增删查踢、清理预览 / 立即触发 / 兼容旧的手动强制清理）

---

## 1. 功能明细

### 1.1 入群申请自动审核（不走 LLM）

| 需求 | 实现 |
|---|---|
| 限制 QQ 等级 | 配置 `minLevel`，低于则拒绝，拒绝理由固定为 `等级低于xx` |
| 隐藏等级 / 查不到等级 | 拒绝理由固定为 `qq等级查询失败请打开后重试` |
| 进群白词 | 群需要进群答案且配置白词时，回答包含任意一个白词才放行，否则拒绝并说明原因 |
| 进群黑词 | 回答命中黑词直接拒绝并拉黑，理由支持 `{word}` 占位符 |
| 连续被拒 2 次自动拉黑 | `maxReject` 默认 2；每次“真正拒绝成功”计数，同意后清零；0 表示不自动拉黑 |
| 被踢自动拉黑 | 监听 `group_decrease(kick)`，把 QQ 加入该群绑定的黑名单 |
| 主动退群自动拉黑 | 监听 `group_decrease(leave)`，可用 `autoBlacklistOnLeave` 关闭 |
| 多群共用黑名单 | 每个群可配 `blacklistId`，多个群填同一个名字即共用；默认名单是 `default` |
| 拉黑后尚未踢出 | 加入黑名单后自动扫描该名单关联的群，仍在群里则立即踢出 |
| 踢人时加入 QQ 黑名单 | `kickRejectAdd` 控制 `set_group_kick` 的 `reject_add_request`（QQ 自己的「拒绝再次加群」） |
| 申请群内提示 | 处理后在群里发送纯文字：昵称、QQ、等级、进群回答、处理结果；模板可自定义。申请提示不带图 |
| 黑名单申请静默 | 如果申请人已在黑名单中，只快速拒绝，不再往群里推进群通知，避免反复申请刷屏 |
| 进群成功欢迎 | `group_increase` 时发送欢迎语（默认 @ 新成员），模板可自定义 |
| 退群 / 被踢提示 | `group_decrease(leave/kick)` 时发送退群 / 被移出提示，模板可自定义 |
| 拉黑提示 | 新加入黑名单后，向使用该黑名单的群发送拉黑原因提示 |
| QQ 档案图 | 进群欢迎 / 退群 / 被踢时根据 `get_stranger_info` + `get_group_member_info` 绘制暗色档案卡，含头像、昵称、QQ、等级、签名、VIP、QID、群成员资料等；与文字同条发送。图片过大自动降质，发送失败进入补发队列，不拆图 |
| 头像代理 | 插件自带 `bridge.mjs` 后端路由 `/api/group-guard/avatar`，由 Node 侧按参考项目的方式下载 QQ 头像字节流，前端 Canvas 不再受浏览器 CORS 限制 |
| 多页面仲裁 | 桌面端 / 网页端 / 手机端同时在线时，进群申请、notice、清理周期先在后端 `bridge.mjs` 抢租约，只允许一个实例执行，避免提示 / 欢迎 / 同意 / 踢人重复发送 |
| 按群独立配置 | 设置面板顶部下拉选择已配置的群，直接用表单改该群规则（等级 / 白词黑词 / 进出群提示 / 档案图 / 清理周期等）；未改的项自动继承全局。仍保留 `groups` JSON 便于批量编辑，工具也支持读写 |
| 漏事件的兜底 | 监听 `napcat:request` 的同时，周期性调用 `get_group_system_msg` 捞未处理申请并补审 |
| 演练模式 | `dryRun=true` 只判定并推送结果，不真正同意 / 拒绝 / 踢人 / 拉黑，适合先观察规则 |
| 只响应已配置群 | 默认 `allGroups=false`：只有 `groups` 里有配置的群会处理事件；`allGroups=true` 恢复旧版“全局默认套所有群”行为 |

审核判定顺序：

1. 黑名单用户 → 拒绝「黑名单用户」；
2. 命中进群黑词 → 拒绝 + 拉黑；
3. 需要等级但查不到（隐藏）→ 拒绝「qq等级查询失败请打开后重试」；
4. 等级低于 `minLevel` → 拒绝「等级低于xx」；
5. 配置了白词但回答不包含 → 按 `answerRejectReason` 拒绝；
6. 以上都通过 → 同意。

### 1.2 定时清理不活跃成员

1. 每个群按自己的 `cleanup.intervalMinutes` 计算周期落点，实际清人强制对齐到该落点当天的 18:00（落点已明显晚于 18:00 则顺延到次日）；到 18:00 前 `cleanup.warnMinutes` 发 `@全体成员` 预告，文案支持 `{minutes}` / `{days}` / `{group}` / `{group_id}`；
2. 到 18:00 时拉取群成员列表；
3. 以 `last_sent_time`（从未发言则退化为 `join_time`）判断活跃时间，超过该群 `cleanup.inactiveDays` 天的成员批量踢出；
4. 自动跳过机器人自己、群主、管理员（可配）、保护名单、机器人账号、活跃时间未知的成员；
5. `cleanup.blacklistKicked` 控制清理踢出的人是否自动加入黑名单（默认关闭）；
6. `cleanup.notifyResult` 控制清理完成后是否在群里播报踢人结果；
7. 每轮批量踢完后，会播报下一轮清理时间与剩余天数（`cleanup.nextMessage`，支持 `{next_date}` / `{days}` / `{days_text}`）；
8. 每天约 `cleanup.dailyBroadcastHour:cleanup.dailyBroadcastMinute`（默认 20:00）自动播报下一轮清人日期、当前预计清理人数和剩余天数（`cleanup.dailyMessage` 新增 `{count}`）；服务端代聊常驻，20:00 后再启动 / 刷新 WebUI 也会补播一次，多实例通过后端租约保证每天每群只播一次。
9. 模型可以调用工具 `cleanup_trigger`，把指定群（默认当前群）的下一轮清人倒计时直接缩减为立即触发；它不是一套“立即清人”的独立逻辑，只写入一次性 immediateAt 立即触发标记；手动触发属于用户主动操作，不受固定 18:00 限制，之后仍按“发预告 → 等待 `warnMinutes` → 批量踢人 → 播报下一轮”的原流程执行。

清理只作用于 `groups` 里显式配置过的群（`allGroups=true` 时恢复旧版全渠道行为）；可用全局 `cleanup.groups` 进一步限定范围，群规则里 `"cleanup": false` 或 `"cleanup": {"enabled": false}` 可单独排除某个群。每个群的周期 / 等待 / 不活跃天数 / 文案都独立计算，互不影响。

---

## 2. 安装

### 方式 A：脚本安装（推荐）

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\extensions\napcat-group-guard\install.ps1
```

默认安装到 `<仓库根目录>\user_data\plugins\napcat-group-guard\`。
数据目录不在默认位置时：

```powershell
# 指定数据目录（脚本会自动追加 \plugins）
.\extensions\napcat-group-guard\install.ps1 -DataDir "D:\nianfeng-data"

# 或直接指定插件目录
.\extensions\napcat-group-guard\install.ps1 -PluginsDir "D:\plugins"
```

### 方式 B：手动复制

把 `index.mjs`、`bridge.mjs`、`manifest.json`、`README.md` 复制到：

```text
<数据目录>/plugins/napcat-group-guard/
```

然后在 设置 → 插件 里重新扫描 / 刷新页面；插件列表出现「群管助手」即安装成功（默认启用）。

### 方式 C：上传 zip 安装

在 设置 → 插件 →「外部插件目录」一行点 **添加插件**，选择本目录下的
`napcat-group-guard-v2.0.6.zip`；上传成功后插件会自动解压到服务器端外部插件目录，
按提示刷新页面即可。

> 注意：zip 内已经是插件根目录结构（`napcat-group-guard/index.mjs` 等），不要再手动套一层文件夹。

> **重要**：本插件包含后端桥 `bridge.mjs`（头像代理 `/api/group-guard/avatar` + 服务端档案图渲染 + 多实例事件 / 清理租约）。
> 后端桥只在**念风后端启动时**加载，所以安装 / 更新插件后需要重启一次后端（或整个应用），
> 头像代理、服务端档案图与多实例去重（桌面端 + 网页端 + headless 代聊同时在线时不再重复发进群提示 / 欢迎 / 清理）才会生效；
> 未重启时前端会退回实例内去重；如果当前实例有浏览器 Canvas 就继续本地生成档案图，不会影响群管事件处理。

### 验证

```powershell
node extensions\napcat-group-guard\test.mjs
```

111 项断言覆盖（含无 WebUI / 无 PowerShell 的服务端渲染、固定 18:00 对齐、每日预计清理人数）：等级 / 隐藏等级 / 白词 / 黑词 / 连续拒绝拉黑、黑名单工具增删查踢、
共享黑名单、黑名单申请静默、申请 / 进群 / 退群档案图、只响应已配置群、退群 / 被踢 / 拉黑提示、头像代理与多页面租约、
重复投递只处理一次、老成员旧 `group_increase` 重放不重复欢迎、同一次入群按 `join_time` 持久化幂等、启动补扫、按群覆盖规则、设置面板按群下拉表单、定时清理预告与批量踢人、
清理结束后的下一轮播报、模型 cleanup_trigger 立即触发、每日 20:00 播报、演练模式、补偿轮询、
断点恢复清理、总开关。

---

### 档案图没有出现时怎么查

1. 确认设置面板里的「进群申请 / 进群 / 退群档案图」是打开的（可以全局开，也可以只在目标群的覆盖规则里开）；
2. 更新到 **v1.1.9+** 后刷新页面，并重启一次念风后端；v1.1.9 在 v1.1.7 后端桥基础上新增 `/api/group-guard/render` 服务端渲染（PowerShell 不可用时自动降级为纯 Node PNG）、自动清人固定到周期落点当天 18:00、每天 20:00 播报附带预计清理人数，不再要求 WebUI 页面常驻；
3. 到 **设置 → 运行日志** 搜 `群管助手已加载`，确认桥正常工作；再搜 `档案图` 看告警：
   - 头像缺失优先检查 `设置 → 运行日志` 是否有 `/api/group-guard/avatar` 请求；v1.1.9 前端会优先走后端 JSON 头像接口（Node 下载，不受浏览器 CORS 影响）；
   - `服务端渲染降级`：说明当前机器不能拉起 PowerShell，已自动使用纯 Node PNG，图片仍会正常发送；
   - `图片发送失败 / 补发队列`：v1.1.9 会依次尝试 data URL、本机 file://；整条消息仍失败则进入补发队列，不会拆图、不会发空白图或纯文字；
4. 如果原先一个事件会收到「退群提示」「黑名单提示」两条文本，更新到 v1.1.9 后会合并成一条带档案图的消息。

## 3. 快速配置（在 设置 → 插件 → 群管助手 → 设置 里）

建议顺序：

1. **总开关**：保持开启；
2. **响应范围**：默认只处理「群规则」里有配置的群；需要旧版“全局默认套 NapCat 所有群”时，打开「响应所有群（兼容旧行为）」；
3. **按群配置**：在设置面板顶部「按群配置」下拉选择一个已配置的群，下面会直接展开该群的规则表单；
   - 布尔项可选 `继承全局` / `开` / `关`；数值和文本留空 = 继承全局；
   - 白词、黑词、保护名单、清理文案旁有「空」按钮，表示“显式覆盖为空”，用于覆盖全局的非空配置；
   - 底部「清除本群覆盖」= 删除该群全部独立规则，恢复完全继承全局；清除后该群也会退出「已配置群」范围；
4. **配置目标群规则**：必须先在「群规则」里给目标群写一条配置（哪怕是空对象也行）。默认 `allGroups=false`，没有配置的群不会处理任何事件；自动审核既可以全局打开，也可以在上一步的按群表单里单独开；
4. **群规则 JSON（批量编辑 / 高级）** 示例：

```json
{
  "123456789": {
    "autoReview": true,
    "minLevel": 16,
    "requireVisibleLevel": true,
    "whitelist": "b站/抖音/github",
    "blacklist": "广告/代练",
    "blacklistId": "default",
    "notifyJoinSuccess": true,
    "openBoxImage": true,
    "cleanup": {
      "enabled": true,
      "intervalMinutes": 10080,
      "warnMinutes": 10,
      "inactiveDays": 30,
      "message": "@全体成员 本群将在 {minutes} 分钟后清理持续 {days} 天未活跃的成员，请及时冒泡。"
    }
  },
  "987654321": {
    "autoReview": true,
    "minLevel": 10,
    "blacklistId": "联合黑名单",
    "notifyDecrease": false,
    "cleanup": { "enabled": false }
  }
}
```

也可以直接对角色说“把本群的进群等级改成 20，并把退群档案图关掉”，角色可以调用 `napcat_group_guard(group_config_set)` 写入当前群的独立覆盖。

6. **黑名单 JSON** 示例：

```json
{
  "default": ["123456", "234567"],
  "联合黑名单": ["345678"]
}
```

7. 想多群共用一个名单时，把群规则里的 `blacklistId` 写成同一个名字即可；
8. 调低 `maxReject`（默认 2）即可实现“拒绝两次直接拉黑”；
9. 定时清理默认关闭。开启后建议把「预告等待」设为 5~15 分钟；实际清人固定在该周期落点当天 18:00，先点 `cleanup_preview` 预览确认。

### 配置项速查

| 配置 | 默认 | 说明 |
|---|---|---|
| `napcat.groupGuard.enabled` | `true` | 总开关 |
| `napcat.groupGuard.allGroups` | `false` | 是否响应 NapCat 中所有群；默认只响应 `groups` 里显式配置过的群 |
| `napcat.groupGuard.autoReview` | `false` | 已配置群继承的全局自动审核默认；群规则里可单独覆盖 |
| `napcat.groupGuard.allowManage` | `true` | 是否允许角色调用黑名单 / 清理工具 |
| `napcat.groupGuard.dryRun` | `false` | 演练模式：只判定与提示，不执行 |
| `napcat.groupGuard.notifyOnRequest` | `true` | 申请处理后在群里发提示（黑名单用户申请时强制静默） |
| `napcat.groupGuard.notifyJoinSuccess` | `true` | 进群成功后发欢迎语（默认 @ 新成员） |
| `napcat.groupGuard.joinTemplate` | 见代码 | 进群欢迎模板 |
| `napcat.groupGuard.notifyDecrease` | `true` | 主动退群 / 被踢时发提示 |
| `napcat.groupGuard.leaveTemplate` / `kickTemplate` | 见代码 | 退群 / 被踢模板 |
| `napcat.groupGuard.notifyBlacklist` | `true` | 加入黑名单后向相关群发提示 |
| `napcat.groupGuard.blacklistTemplate` | 见代码 | 拉黑提示模板 |
| `napcat.groupGuard.openBoxImage` | `true` | 进群申请 / 进群 / 退群时生成并附带 QQ 档案图；过大自动降质 |
| `napcat.groupGuard.minLevel` | `0` | 最低 QQ 等级；0 表示不限制等级 |
| `napcat.groupGuard.requireVisibleLevel` | `true` | 查不到 qqLevel（隐藏）时按约定拒绝 |
| `napcat.groupGuard.answerWhitelist` | 空 | 进群白词，`/`、逗号、顿号或换行分隔 |
| `napcat.groupGuard.answerBlacklist` | 空 | 进群黑词，命中直接拉黑 |
| `napcat.groupGuard.maxReject` | `2` | 连续被拒多少次后自动拉黑；0 关闭 |
| `napcat.groupGuard.answerRejectReason` | 见代码 | 白词未命中的拒绝理由 |
| `napcat.groupGuard.blackwordRejectReason` | 见代码 | 黑词拒绝理由，支持 `{word}` |
| `napcat.groupGuard.notifyTemplate` | 见代码 | 申请提示模板 |
| `napcat.groupGuard.autoBlacklistOnKick` | `true` | 被踢自动拉黑 |
| `napcat.groupGuard.autoBlacklistOnLeave` | `true` | 主动退群自动拉黑 |
| `napcat.groupGuard.autoKickBlacklisted` | `true` | 拉黑后仍在群里则自动踢出 |
| `napcat.groupGuard.enforceOnStartup` | `true` | 页面启动后补扫一次黑名单，仍在群里的直接踢出 |
| `napcat.groupGuard.kickRejectAdd` | `true` | 自动踢人时勾选 QQ 的 `reject_add_request` |
| `napcat.groupGuard.protectedUsers` | 空 | 保护名单（逗号分隔 QQ），不踢不拉黑 |
| `napcat.groupGuard.blacklists` | `{}` | 黑名单 JSON |
| `napcat.groupGuard.groups` | `{}` | 群规则 JSON |
| `napcat.groupGuard.cleanup.enabled` | `false` | 定时清理开关 |
| `napcat.groupGuard.cleanup.intervalMinutes` | `10080` | 清理周期（分钟），默认 7 天；实际清人固定在该周期落点当天 18:00 |
| `napcat.groupGuard.cleanup.warnMinutes` | `10` | 发预告后等待多少分钟开始踢人 |
| `napcat.groupGuard.cleanup.inactiveDays` | `30` | 超过多少天未活跃视为不活跃 |
| `napcat.groupGuard.cleanup.skipAdmins` | `true` | 跳过管理员（群主始终跳过） |
| `napcat.groupGuard.cleanup.blacklistKicked` | `false` | 清理踢出的人是否加入黑名单 |
| `napcat.groupGuard.cleanup.notifyResult` | `false` | 清理完成后是否播报结果 |
| `napcat.groupGuard.cleanup.groups` | 空 | 限定清理群号 / 群名；空 = 所有已配置群聊渠道 |
| `napcat.groupGuard.cleanup.message` | 见代码 | 预告文案模板 |
| `napcat.groupGuard.cleanup.dailyBroadcast` | `true` | 每天约 20:00 播报下一轮清人时间 |
| `napcat.groupGuard.cleanup.dailyBroadcastHour` | `20` | 每日播报小时（0-23） |
| `napcat.groupGuard.cleanup.dailyBroadcastMinute` | `0` | 每日播报分钟（0-59） |
| `napcat.groupGuard.cleanup.dailyMessage` | 见代码 | 每日播报文案模板，支持 `{next_date}` / `{days}` / `{count}`（预计清理人数） |
| `napcat.groupGuard.cleanup.nextMessage` | 见代码 | 每轮踢完后播报下一轮时间的模板 |
| `napcat.groupGuard.pollIntervalSeconds` | `30` | 补偿轮询间隔（秒） |

---

## 4. 给角色的工具

工具名：`napcat_group_guard`

| action | 说明 |
|---|---|
| `status` | 查看当前配置、黑名单概况、各群生效规则、清理状态 |
| `blacklist_list` | 查看黑名单（可传 `list` 只看某个名单） |
| `blacklist_add` | 加入黑名单：`qq` 必填；`list` 可选（默认当前群规则绑定名单 / `default`）；`reason` 可选；`kick` 默认 true（还在群里立即踢出） |
| `blacklist_remove` | 移除黑名单：`qq` + `list`（同解析规则） |
| `blacklist_kick` | 对某个 / 全部黑名单执行一次联动踢出 |
| `group_config_get` | 查看某个群的独立覆盖 + 最终生效规则 |
| `group_config_set` | 写入 / 合并某个群的独立覆盖（等级、白词黑词、进出群提示、档案图、清理参数等） |
| `group_config_reset` | 清除某个群的独立覆盖，恢复继承全局默认 |
| `cleanup_preview` | 预览各群不活跃成员，不执行任何动作 |
| `cleanup_trigger` | 把当前群（或 `group` 指定群）的下一轮清人倒计时直接缩减为立即触发；随后仍按原流程发预告、等待 `warnMinutes`、批量踢人、播报下一轮 |
| `cleanup_run` | 兼容旧行为：强制所有启用清理的群立即走一轮（先发预告，等待配置分钟数后踢人） |

对 AI 说人话即可，例如：

- “把 123456 加入本群黑名单” → `blacklist_add`
- “把 123456 从黑名单放出来” → `blacklist_remove`
- “看看现在黑名单里都有谁” → `blacklist_list`
- “预览一下清理名单” → `cleanup_preview`
- “现在就把本群清人倒计时清零” / “提前触发本群清理” → `cleanup_trigger`
- “把本群进群等级改成 20，退群档案图关掉” → `group_config_set`
- “本群恢复和默认一样” → `group_config_reset`

---

## 5. 安全与边界

- 任何踢人动作都不会作用于：机器人自己、群主、保护名单成员；
- 黑名单按 QQ 号**精确匹配**，不做子串 / 补零匹配；
- 默认 `allGroups=false`，只有 `groups` JSON 里显式配置过的群才会处理事件；机器人所在的其它群完全忽略，避免误欢迎、误审核、误踢人；需要旧版行为时把 `allGroups` 打开，或在网关层不让机器人收到无关群的事件；
- 定时清理运行在服务端代聊 headless worker 里，关闭 WebUI 页面后仍会继续；自动清人固定为周期落点当天的 18:00，重新打开页面时，
  会恢复「已发预告、还没开始踢人」的未完成阶段；如果上一轮完整周期已到期，会延迟数秒自动补跑；
- 需要进群答案但插件未配置白词时，本插件不校验回答，会按等级等其他规则处理；
- 群 “进群答案” 是否必填由 QQ 群设置决定，插件无法读取该设置；配了白词即视为“该群要校验回答”；
- 清理判断依赖群成员列表里的 `last_sent_time`，部分数据源不返回时用 `join_time` 兜底；两者都没有的成员会被跳过（宁可不踢）；
- 档案图不是第三方开盒接口：有浏览器 Canvas 的实例本地绘制；headless 实例调用后端桥 `/api/group-guard/render`，优先 PowerShell + System.Drawing，失败自动降级为纯 Node PNG。头像优先通过本插件后端桥 `/api/group-guard/avatar` 获取（Node 侧下载，不受浏览器 CORS 限制），后端桥不可用时才退回 QQ 官方头像 CDN，仍失败则显示文字头像；图片发送失败会进入补发队列，按“图片是硬要求”处理，不退化为纯文字。
- 所有全局配置都可以在群规则 JSON 里按群覆盖，互不影响；清理默认只跑 `groups` 里配置过的群，`cleanup.groups` 可在此基础上进一步限定范围。

## 6. 对其它扩展的接口

插件提供 `napcat-group-guard` 服务：

```js
const guard = ctx.inject('napcat-group-guard')
guard.status()                                 // 配置与黑名单概况
guard.blacklists()                             // { 名单名: [qq, ...] }
guard.isBlacklisted('123456', 'default')       // 精确匹配
guard.addBlacklist('123456', 'default', '原因') // 加入并联动踢出
guard.removeBlacklist('123456', 'default')     // 移除
guard.kickBlacklisted('default')               // 批量联动踢出
guard.enforceBlacklistScan()                   // 每群拉一次成员列表，补踢漏网黑名单成员
guard.previewCleanup({ groupRef: '本群' })      // 不活跃预览
guard.triggerCleanup({ groupRef: '本群' })      // 把该群倒计时缩减为立即触发（正常流程）
guard.runCleanupCycle({ force: true })         // 兼容旧行为：强制所有启用清理的群走一轮
guard.broadcastDailyCleanup()                  // 立即检查一次“今天是否要播报下一轮清理”
guard.resumePending()                          // 恢复未完成的清理踢人阶段
guard.resolveRule('123456')                    // 查看某群最终生效规则
guard.pollRequests()                           // 手动触发一次积压申请轮询
```

事件：`napcat-group-guard:action`，payload 形如
`{ action: 'blacklist_add' | 'request_rejected' | 'request_approved' | 'kick' | 'cleanup_warning' | 'cleanup_done', ... }`。

## 7. 最近更新

- v2.0.1：修复清理预告重复 @ 全体成员；修复自动清理预告后踢人时间被顺延到下一轮的问题；清理 0 人 / 读取群成员失败时也会明确反馈。
- v2.0.2：修复升级后恢复旧版异常待办时会傻等到下一个周期的问题；检测到被顺延的旧待办后会自动补发新一轮预告，等待配置的 `warnMinutes` 后执行。
- v2.0.3：新增 `cleanup_kick`：已发过预告、正在等待踢人的待办可以直接执行，不再补发 @全体预告。
- v2.0.4：不活跃清理踢出不再逐人发送档案图，改为批次结束后合并一条文本摘要，避免刷屏。
- v2.0.5：修复 NapCat 断线重连 / 事件积压后补发旧 `group_increase` 导致同一位老成员被重复播报进群欢迎的问题；现在按「实例 + 群 + QQ + 入群时间」持久化幂等记忆，并对明显过期的入群事件直接跳过，真正做到同一次入群只欢迎一次。
- v2.0.6：修复 v2.0.5 的 `index.mjs` 导出版本号仍停留在 2.0.4、而 manifest 已升到 2.0.5，导致插件市场安装成功后仍显示「本地 2.0.4 / 可更新」的问题；导出版本号与 manifest 版本现已统一。

