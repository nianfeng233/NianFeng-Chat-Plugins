# 邮箱（social-bridge 精简版）

本扩展已移除 B站 / 抖音渠道、自动轮询、访客工具、联网访问依赖，只保留邮箱功能。

## 提供内容

- 一个 `email` 模型工具：
  - `status`：查看邮箱配置状态
  - `save`：保存 IMAP / SMTP 配置
  - `list`：列出邮件
  - `read`：读取指定 UID 的邮件
  - `send` / `reply`：发送 / 回复邮件
  - `test`：测试 IMAP / SMTP 连通性
- 一个「邮箱」设置面板：填写账号、授权码、IMAP/SMTP 地址并测试。

## v2.0.1 修复

- 读取邮件时按 `Content-Type` 声明的 charset 解码，支持 UTF-8 / GBK / GB18030 / GB2312 / Big5 等中文邮件，不再出现方块乱码。
- RFC2047 编码的寄件人 / 主题、quoted-printable / base64 / 8bit 正文，以及 multipart 邮件均按各自编码解码。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\extensions\social-bridge\install.ps1 -Force
```

然后回到念风：设置 → 插件 → 重新扫描；如果改动过 `bridge.mjs` / `lib`，建议再完整重启一次后端。

## QQ 邮箱配置

- IMAP：`imap.qq.com:993`（SSL）
- SMTP：`smtp.qq.com:465`（SSL）
- 邮箱账号：完整 QQ 邮箱地址
- 授权码：QQ 邮箱 设置 → 账户 → 开启 IMAP/SMTP 服务后生成

授权码会使用数据目录 `.secret-key` 做 AES-256-GCM 加密保存，历史配置仍保存在 `social-bridge.json` 的 `mail` 段。