# 发布到社区

这份文件是给维护者看的，不会被打进 npm 包（`files` 白名单里没有它）。

## 0. 发布前检查

```sh
npm run check          # 语法检查，prepublishOnly 也会跑
npm pack --dry-run     # 看包里到底装了什么
```

当前包内容：`index.js` / `client.js` / `cordis.patch.yml` / `README.md` / `LICENSE` / `preview/*.png`。

## 1. 建仓库

- 仓库名建议就叫 `dsh-stock-strip`，与包名一致。
- 给仓库加 **`dsh-plugin`** topic（收录时会检查）。
- 仓库创建需**满 1 天**才能提交收录（CI 自动校验，防止 PR 前几分钟现建）。
- 把 `package.json` 里的 `repository` / `homepage` / `bugs` 补上：

```json
"repository": { "type": "git", "url": "git+https://github.com/<owner>/dsh-stock-strip.git" },
"homepage": "https://github.com/<owner>/dsh-stock-strip#readme",
"bugs": { "url": "https://github.com/<owner>/dsh-stock-strip/issues" }
```

## 2. 发 npm

```sh
npm login
npm publish          # 未加 scope 的包默认 public
```

包名 `dsh-stock-strip` 目前未被占用（2026-11 查证）。之后升级：

```sh
npm version patch|minor
npm publish
```

## 3. 提交收录（awesome-dsh-plugin）

列表由 `data/plugins/*.yml` 生成，**一个插件一个文件**，一个 PR 只加一个文件：

`data/plugins/<owner>__dsh-stock-strip.yml`

```yaml
url: https://github.com/<owner>/dsh-stock-strip
name: <owner>/dsh-stock-strip
category: ui          # 或 usage，取更贴切的一个
description:
  en: A thin always-on quote bar at the bottom of DeepSeek Harness showing watchlist prices and per-position P&L, with configurable fields and a two-row layout.
  zh: 贴在 DeepSeek Harness 底边的一条常驻行情条，显示自选股价格与每只持仓的浮动盈亏，字段可勾选、放不下自动变两行。
icon: https://raw.githubusercontent.com/<owner>/dsh-stock-strip/main/preview/icon-180.png
```

注意：

- 描述**必须属实**，审核会对着代码核对（别写「实时」「tick 级」——接口是快照/延时）。
- 描述里出现 `: `（英文冒号+空格）要加引号。
- 不要手改 README，列表是脚本生成的。
- `icon` 可选，不写会回退到作者头像；要独立图标就放一张 180×180 的 PNG。

## 4. 其他入口（可选）

- **dsh-market**（`dsh plugin add dshmarket`）读的就是同一份 catalog，收录后自动出现。
- 在 README 顶部加徽章：

```md
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
```

## 5. 收录后

- 保持仓库活跃：定期扫描会清理「仓库消失 / 归档 / 长期停更」的条目。
- 行情接口随时可能变（东财、腾讯都可能改字段或加限制），接口挂了要能优雅降级——
  现在的实现是：一路失败就保留上一次快照并显示「行情暂不可用」。

## 安全审查备忘

社区列表不替代安全审查，但会读代码。这份插件对外能解释清楚的点：

- Host 半区是空实现：不写文件、不注册工具、不读会话。
- 浏览器半区只请求 `push2.eastmoney.com` 与 `qt.gtimg.cn`，只带股票代码。
- 腾讯兜底用 `fetch` + `TextDecoder('gbk')`，**不往页面里注入第三方脚本**（早期版本是
  `<script>` 注入，存在被下发脚本执行的路径，已移除）。
- 配置只存 `localStorage`，无遥测。
