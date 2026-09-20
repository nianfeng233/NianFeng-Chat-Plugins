# 念风官方插件仓库

本仓库是念风 Chat 的官方插件市场源，格式同时兼容第三方仓库使用。

## 文件说明

- `index.json`：市场索引，记录允许上架的插件仓库；念风 WebUI 默认读取该文件。
- `market.json`：本仓库的插件清单，声明插件 id、版本、目录、SHA-256 与仓库地址。
- `plugins/<id>/`：插件本体，每个目录必须包含 `index.mjs`；后端桥为可选的 `bridge.mjs`。
- `scripts/build-market.mjs`：修改插件后重新生成 `market.json` / `index.json`。

## 安全约定

- 每个插件必须有稳定、唯一的 `id`，安装目录只使用该 id。
- 插件版本与 `market.json` 中的版本必须一致，安装时会校验。
- `sha256` 是插件目录内所有文件按稳定算法计算出的内容哈希；念风安装前会复算并拒绝不一致的压缩包。
- 单仓库可以放多个插件（本仓库即为这种模式）；第三方也可以一个仓库只放一个插件。
- 有 GitHub Release 的仓库可提供 `release.url` / release `sha256`，程序优先使用 release，否则直接下载仓库源码压缩包。

## 维护命令

```bash
node scripts/build-market.mjs
```

## 发布

```bash
git remote add origin https://github.com/nianfeng233/NianFeng-Chat-Plugins.git
git add -A
git commit -m "更新插件市场清单"
git push -u origin main
```

如果换了仓库地址，请同时修改念风主仓库 `src/shared/market-format.mjs` 里的
`OFFICIAL_MARKET_REPO` / `OFFICIAL_MARKET_INDEX_URL`，保证官方源指向正确位置。
