# AGENTS.md

抖音网页增强扩展（Chrome / Edge，Manifest V3）：在 douyin.com 上屏蔽弹幕 / 评论 / 直播弹幕中命中关键词或正则的内容。
纯原生 JS，**无第三方依赖、无构建步骤**；代码注释、界面文案、文档、提交信息统一用中文。

## 常用命令

- `npm test` —— 全量自测：规则引擎（test.js）+ DOM 过滤（test-dom.js）+ 存储层（test-storage.js）+ UI 一致性（check-ui.js）+ manifest（check-manifest.js）。改代码后提交前必跑。
- 单项：`npm run test:rules` / `test:dom` / `test:storage` / `check:ui`；`npm run check` = check-manifest + check-ui。
- `node tools/pack.js`（`npm run zip`）—— 打包 `dist/douyin-plus-<version>.zip`，只含 manifest.json / icons / rules / src。
- `node tools/make-icons.js` —— 无依赖生成图标。
- `bash tools/release.sh x.y.z` —— 发版：同步版本号 → 校验 → 补 CHANGELOG → commit → 打 `v*` tag → push；GitHub Actions 在 tag 上跑测试、打包并创建 Release。

没有 lint / typecheck。测试全部用 Node 内置模块（vm 沙箱加载 IIFE）编写，改行为要同步补断言。

## 目录结构

- `src/common/` 共享逻辑，挂载到 `globalThis.DouyinPlus`：`matcher.js`（匹配引擎）、`schema.js`（规则结构 / 导入导出 / 合并去重）、`storage.js`（chrome.storage 封装、内置与远程规则集落库）。
- `src/content/` 内容脚本：`interceptor.js`（MAIN world，劫持 fetch / XHR 过滤接口 JSON）、`bridge.js`（ISOLATED，下发规则 + 上报统计）、`dom-filter.js`（ISOLATED，MutationObserver 兜底过滤）、`content.css`。
- `src/background/` `service-worker.js`（`dyp:*` 消息路由、alarms、右键菜单）、`remote.js`（远程订阅拉取与地址归一化）。
- `src/popup/`、`src/options/` 快捷面板与管理页，纯 HTML/CSS/JS，用 `<script>` 直接引入 common 模块。
- `rules/` `default-rules.json`（随包内置）、`index.json` + `sets/*.json`（远程订阅规则库）。
- `tools/` 全部开发脚本；`docs/RULES.md` 规则格式与编写规范，**改规则前先读**。

## 模块约定（容易踩坑）

- common 模块都是 IIFE + `'use strict'`，用 `(globalThis.DouyinPlus = globalThis.DouyinPlus || {})` 挂载并自带重复加载保护；**禁止 import/export**。`matcher.js` 同时注入 MAIN world，不能碰任何 `chrome.*` API；`remote.js` 也被设置页直接引入，对 chrome 的访问必须在函数内惰性进行。
- **Chrome 对同一路径的内容脚本只注入一次（跨 world 去重）**：同一文件同时登记在 MAIN 与 ISOLATED 两个 `content_scripts` 里时，ISOLATED world 拿不到它（曾因此让 matcher 缺失、dom-filter 静默退出，DOM 兜底过滤整个失效）。需要两边都用的文件各自留一份：`matcher.js`（MAIN + 各页面）与 `matcher.isolated.js`（ISOLATED），内容必须逐字节一致；`tools/test.js` 与 `tools/check-manifest.js` 都会校验。
- 脚本加载顺序固定且显式声明：content_scripts 在 `manifest.json`，后台在 `service-worker.js` 的 `importScripts`。新增脚本文件必须在这两处登记（popup / options 页还要在对应 HTML 里加 `<script>`）。
- MAIN ↔ ISOLATED 通过 `window.postMessage` 通信，标记 `source: 'douyin-plus'`（规则下发）与 `'douyin-plus-main'`（命中上报）；扩展内部消息统一 `dyp:` 前缀，在 `service-worker.js` 的 `handlers` 表注册，响应形如 `{ok, data|error}`。
- 网络层过滤只删数组里“文本字段命中”的项，绝不删对象属性；`matcher.js` 的 `TEXT_FIELDS` 取值顺序敏感，取不到文本的对象（如用户信息）不删。关键词按换行 / 逗号拆词并按字面量转义，正则整条编译；单条 pattern 上限 500 字符，非法正则安全跳过。
- 规则改动通过 `settings.rulesRev` + `chrome.storage.onChanged` 即时下发，无需刷新页面；改存储或下发逻辑时保持该机制。

## 规则数据

- 官方远程订阅默认走 jsDelivr（`DEFAULT_REMOTE_URL`）：raw.githubusercontent.com 在部分网络不可达，**不要把默认值改回 raw**（已有 `FALLBACK_REMOTE_URLS` 回退）。自定义订阅地址首次使用需 `chrome.permissions.request` 授权，必须在用户点击调用栈里执行。
- 内置规则按 id 保留用户启停状态；用户删除的内置规则 id 记入 `hiddenIds`，同步时不会复活。远程规则每次整体替换 `source === 'remote'` 的规则，用户停用状态按 `type + pattern` 匹配保留。改动这部分必须跑 `npm run test:storage`。
- 编辑 `rules/` 下规则集：`version` +1、更新 `updatedAt`；新增文件要在 `rules/index.json` 的 `files` 登记。`npm run test:rules` 会校验所有规则可解析可编译、索引文件齐全、跨文件词条无重复。
- 词条编写规范（高误伤规则默认 `enabled: false`、宁短勿长、写清 note 等）见 `docs/RULES.md`。

## 版本与发布

- 版本号三处同步：`manifest.json`、`package.json`、`CHANGELOG.md`。`tools/check-manifest.js` 校验 manifest 与 package.json 一致；CI 另外校验 tag 与 manifest 版本一致，不符直接失败。
- 发版走 `bash tools/release.sh <x.y.z>`，不要手动打 tag；脚本在 CHANGELOG 缺条目时会插入模板并暂停，补完内容后再跑一次。
- `tools/pack.js` 的 `INCLUDE` 必须覆盖 manifest 引用的所有运行期文件，check-manifest 会校验。

## UI 约定

- 界面文案用中文；popup / options 通过各自页面的 `send()` 封装发 `chrome.runtime.sendMessage`。
- `tools/check-ui.js` 校验 JS 里 `$('id')` 引用的元素在 HTML 中存在、tab 的 `data-tab` 与面板 `id="tab-*"` 一一对应——加控件后跑 `npm run check:ui`。

## 其它

- `.gitattributes` 强制 LF；忽略 `dist/`、`node_modules`。不要引入第三方依赖，工具脚本只用 Node 内置模块。
- `minimum_chrome_version: 111`（content script 用了 `world: "MAIN"`），不要使用更低版本不支持的能力；service worker 会被随时回收，逻辑要能随时冷启动。
