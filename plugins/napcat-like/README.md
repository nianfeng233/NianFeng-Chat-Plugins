<!--
念风chat · 扩展插件 · napcat-like
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# NapCat 点赞助手（napcat-like）

NapCat / OneBot 11 渠道扩展，包含三个能力：

1. **每日 00:00 自动赞**：配置 QQ 列表，每天 00:00 逐个调用 `send_like` 点赞；
   支持设置每次点赞次数、点赞间隔、指定 NapCat 连接。
2. **群内「赞我」**：只有配置在启用列表里的群才响应；可设置触发词、群等级门槛、
   等级不足回复、等级未知回复、点赞成功 / 失败 / 已赞 / 不能给自己赞等文案；
   支持按群覆盖规则。
3. **chat_send 定向发送**：不修改念风本体源码，在运行时给已有的 `chat_send`
   工具扩展 `qq` / `group` / `instance_id` 参数。模型传 `qq` 或 `group`
   时，会通过 NapCat 直接向指定 QQ / 群发消息，不要求目标已配置成渠道；
   不传时仍走本体原来的 `chat_send` 逻辑。

> 本插件不修改 `plugins/features/chat-tools` 等本体文件。`chat_send` 的参数扩展是
> 外部插件在内存中完成的：给 `tool-registry` 里的 `chat_send` 记录临时追加
> schema 字段并包装 handler；插件卸载时会恢复原记录。

## 安装

### 方式一：插件目录

把本目录复制到：

```text
<数据目录>/plugins/napcat-like/
```

或者在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\extensions\napcat-like\install.ps1
```

然后回到念风：**设置 → 插件 → 重新扫描**，确认「NapCat 点赞助手」已启用。

### 方式二：zip

把 `napcat-like-v2.0.0.zip` 拖进「设置 → 插件 → 添加插件」即可。
安装 / 重新扫描后，外部桥 `bridge.mjs` 会自动热加载；如果旧版本没有热加载逻辑，
重启一次念风后端即可。

## 配置位置

**设置 → 插件 → NapCat 点赞助手 → 设置**。也可以直接读 / 改配置中心里
`napcat.like.*` 开头的键。

| 配置键 | 说明 |
|---|---|
| `napcat.like.enabled` | 插件总开关，默认开 |
| `napcat.like.autoEnabled` | 每日自动赞开关，默认开 |
| `napcat.like.autoList` | 自动赞 QQ 列表，逗号 / 换行分隔 |
| `napcat.like.autoTimes` | 每个 QQ 的点赞次数，1-20，默认 10 |
| `napcat.like.autoInstance` | 自动赞使用的 NapCat 连接 id；留空时只有恰好一个在线连接才执行 |
| `napcat.like.autoIntervalMs` | 每个 QQ 之间的间隔，默认 1200ms |
| `napcat.like.catchUp` | 错过 00:00 后是否当天补赞，默认开 |
| `napcat.like.commandEnabled` | 群内「赞我」总开关，默认开 |
| `napcat.like.groups` | 启用「赞我」的群列表，群号 / 群名，逗号 / 换行分隔 |
| `napcat.like.triggers` | 触发词，默认「赞我」 |
| `napcat.like.minGroupLevel` | 最低群等级（成员在本群的活跃等级），0 不限制 |
| `napcat.like.requireVisibleLevel` | 查不到群等级时是否拒绝，默认开 |
| `napcat.like.commandTimes` | 「赞我」每次点赞次数，默认跟随 `autoTimes` |
| `napcat.like.oncePerDay` | 同一人每天只赞一次，默认开 |
| `napcat.like.mentionSender` | 回复时是否 @ 本人，默认开 |
| `napcat.like.successText` | 点赞成功回复 |
| `napcat.like.rejectText` | 等级不足回复 |
| `napcat.like.levelUnknownText` | 群等级查询不到时的回复 |
| `napcat.like.failText` | 点赞失败回复 |
| `napcat.like.alreadyText` | 今天已赞回复 |
| `napcat.like.selfText` | 不能给自己点赞的回复 |
| `napcat.like.groupRules` | 按群覆盖规则，JSON |
| `napcat.like.directSendEnabled` | 是否启用 `chat_send` 的 qq / group 定向发送，默认开 |
| `napcat.like.directInstance` | 定向发送默认 NapCat 连接；目标已有渠道时优先用渠道绑定连接 |
| `napcat.like.state` | 插件运行状态，自动维护，不需要手改 |

### 回复文案变量

`successText` / `rejectText` / `levelUnknownText` / `failText` / `alreadyText` / `selfText`
支持以下占位符：

```text
{qq} {nickname} {group} {groupId} {level} {minLevel} {times} {error}
```

### 按群覆盖示例

```json
{
  "123456789": {
    "minGroupLevel": 10,
    "successText": "已经给 {nickname} 点满啦！",
    "oncePerDay": false
  },
  "987654321": {
    "enabled": false
  }
}
```

## 每日 00:00 自动赞

- 默认每天本地时间 00:00 后的第一次检查执行；多实例通过后端桥租约规避重复。
- 如果 00:00 时服务没开：
  - `catchUp = true`（默认）：当天稍后启动时会补执行一次，避免当天完全错过；
  - `catchUp = false`：只在 00:00 后 10 分钟窗口内执行，超时当天不再自动赞。
- 如果没有在线的 NapCat 连接，会保持等待并下一分钟重试；连接恢复后自动执行。
- 如果配置了多个在线连接但没有指定 `autoInstance`，为避免用错账号，插件不会执行，
  请在设置里选一个连接或给 `instance_id` 一个默认值。
- 点赞结果、上次执行时间、今日已赞用户会写入插件状态并在设置页展示。

## 群内「赞我」流程

1. 群里有人发「赞我」（或配置的触发词）；
2. 插件先拦截 NapCat 的 `napcat:trigger-decision`，阻止模型再回复一遍；
3. 检查群是否在启用列表；
4. 检查发送者是否已经点过赞；
5. 配置了最低群等级时调用 `get_group_member_info` 拉取成员群等级：
   - 等级不足：回复 `rejectText`；
   - 等级查不到：按 `requireVisibleLevel` 回复 `levelUnknownText` 或继续点赞；
6. 调用 `send_like`，默认 10 次；
7. 成功回复 `successText`，失败回复 `failText`，并默认 @ 发送者。

多实例同时在线时，同一消息由后端桥租约保证只处理一次；没有后端桥时回退为实例内去重。

## chat_send 定向发送

模型调用示例：

```json
{
  "messages": ["在的，这是单独发给你的消息"],
  "qq": "123456789",
  "end": true
}
```

```json
{
  "messages": ["群公告：今晚八点开黑"],
  "group": "123456789",
  "end": true
}
```

- `qq` / `group` 只能填一个，同时填会返回参数错误；
- `qq` 必须是 3-20 位数字；
- `group` 可以填群号，也可以填一个已配置群聊渠道的群名；
- 不传这两个参数时，仍走本体 `chat_send` 原逻辑（`channel` 参数、当前渠道等）；
- `instance_id` 可选。省略时按以下顺序选连接：
  1. 目标 QQ / 群已绑定的 NapCat 渠道；
  2. `napcat.like.directInstance`；
  3. 恰好只有一个在线连接时使用该连接；
  4. 命中多个在线连接且无法确定时返回错误，要求模型 / 用户指定 `instance_id`。
- 定向发送不会写入目标渠道的聊天记录（目标没有渠道时本来也没有记录），
  但会返回 `message_ids` 与 `target`，可以用于排错。

> 定向发送绕过了渠道的跨渠道发送权限，属于强能力；如不希望模型随便发给任意账号，
> 关闭 `napcat.like.directSendEnabled` 即可，关闭后传 `qq` / `group` 会被拒绝。

## 与其它插件的关系

- 依赖内置 `napcat` 渠道插件（`napcat-channel` 服务）；
- `bridge.mjs` 只提供 `/api/napcat-like/claim` 等租约路由，不修改本体接口；
- 与 `napcat-group-guard`、`group-chat-tools` 可以同时安装，事件和工具互不冲突；
- 设置面板依赖 `plugin-manager`；后端桥依赖 `httpApi`，均随念风默认提供。

## 常见问题

**Q：自动赞为什么没有执行？**
检查 `napcat.like.autoEnabled`、`autoList` 是否为空、是否配置了 `autoInstance` 或
只有一个在线连接；查看设置页「运行状态」里的上次执行时间和最近结果。

**Q：「赞我」没反应？**
确认群号确实填在 `napcat.like.groups` 里；群聊渠道的存在并不等于自动启用，
必须显式配置。然后确认发送者能查到群等级（或降低 / 关闭等级门槛）。

**Q：群等级是哪一项？**
取 `get_group_member_info` 返回的 `level` 字段（QQ 群成员活跃等级）。
如果 NapCat 返回字段缺失，会按「等级未知」处理。

**Q：会重复点赞 / 重复回复吗？**
在 WebUI 和 headless 同时运行时，默认由后端桥租约保证一次；
如果后端桥尚未加载或后端不是通过念风 `start.mjs` 启动，可能回退为实例内去重。
安装 / 更新插件后建议按提示重启一次后端。

## 许可

与念风Chat 一致：Apache License 2.0。
