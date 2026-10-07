# douyin-plus

抖音网页版增强扩展（Chrome / Edge，Manifest V3）。

当前版本聚焦一件事：**弹幕与评论的屏蔽**。支持关键词与正则表达式、自建规则、
导入导出、以及从 GitHub 仓库订阅更新规则。

## 功能

- **弹幕 / 评论 / 直播弹幕屏蔽**：三个场景可独立开关。
- **关键词与正则**：关键词一条规则可写多个词（换行或逗号分隔）；正则用 JavaScript 语法。
- **两种处理方式**：`隐藏`（直接移除）与 `模糊`（保留位置、鼠标悬停可临时查看，适合剧透类）。
- **网络层拦截**：在页面 MAIN world 劫持 `fetch` / `XMLHttpRequest`，
  被屏蔽内容在渲染前就被移除，不占位、不闪烁、不占列表条数。
- **DOM 兜底过滤**：处理直播长连接、页面缓存等绕过接口的场景。
- **规则管理页**：增删改查、按来源/场景/状态筛选、批量启停与删除、逐条启停。
- **导入导出**：导出为统一规则集 JSON；导入支持本扩展格式、`[规则数组]`、
  `{rules:[…]}` 以及 `{keywords:[…], regex:[…]}` 简写，自动去重。
- **远程订阅**：填一个地址（GitHub raw / jsDelivr / 任意 URL），
  支持"索引 + 多个规则集文件"结构，按小时自动检查更新，更新时整体替换远程规则、不动自建规则。
- **内置默认规则**：营销引流、诈骗兼职、赌博、色情、辱骂、刷屏、剧透等分组，
  部分高误伤规则默认关闭，可按需打开。
- **屏蔽统计**：今日 / 累计计数、命中排行榜、浏览器图标角标。
- **右键快捷添加**：选中页面文字 → 右键 → 一键加入屏蔽规则。

## 安装（开发者模式）

1. 打开 `chrome://extensions/`，右上角开启"开发者模式"。
2. 点击"加载已解压的扩展程序"，选择本仓库根目录（或解压后的 Release zip）。
3. 打开 `https://www.douyin.com/`，扩展会自动注入。

Edge 同理：`edge://extensions/`。

## 使用

点击工具栏图标打开快捷面板：

- 顶部开关控制整体启停，下面的标签切换弹幕 / 评论 / 直播弹幕与页面兜底过滤。
- "快速添加规则"输入关键词或正则，回车即生效（无需刷新页面）。
- "规则订阅"里粘贴地址、保存后可点"立即更新"。

点"规则管理 →"进入完整管理页，分五个标签：规则 / 导入·导出 / 远程订阅 / 统计 / 关于。

## 规则订阅

默认地址走 jsDelivr CDN：

```
https://cdn.jsdelivr.net/gh/jeanhua/douyin-plus@main/rules/index.json
```

> **为什么不用 raw.githubusercontent.com？**
> 它在国内网络基本不可达（实测超时），而 jsDelivr 有国内节点。扩展内置了回退：
> 默认地址拉取失败时会自动重试 raw 源，两条路都走不通才报错。
> 你手动填的地址不会被替换成别的源，避免"我填了 A 却从 B 拉数据"。

> **关于缓存**：jsDelivr 的边缘缓存是 12 小时、浏览器缓存 7 天。扩展拉取时强制
> `no-store`，浏览器这一层不受影响；边缘缓存的 12 小时正好和默认的 12 小时检查
> 间隔吻合。如果刚更新完规则想立刻生效，可以在浏览器里打开
> `https://purge.jsdelivr.net/gh/jeanhua/douyin-plus@main/rules/index.json`
> 手动清一次缓存，或者把订阅地址临时换成 raw 源。

`rules/index.json` 是索引文件，格式如下，`files` 里 `enabled: false` 的文件会被跳过：

```json
{
  "schema": "douyin-plus/index",
  "version": 1,
  "files": [
    { "path": "sets/ads-extra.json", "name": "广告补充词库", "enabled": true }
  ]
}
```

订阅地址也可以直接是一个规则集文件，或 GitHub 网页地址
（`https://github.com/user/repo/blob/main/rules/index.json`，扩展会自动转成 raw 地址）。
也支持只填 `user/repo` 或 `user/repo/rules/index.json`，默认按 `main` 分支拼 raw 地址。

**远程规则与自建规则相互独立**：每次更新只会整体替换 `source = remote` 的规则；
你手动停用过的远程规则在更新后会保留停用状态。

## 规则格式

详见 [docs/RULES.md](docs/RULES.md)。最小示例：

```json
{
  "schema": "douyin-plus/ruleset",
  "name": "我的规则",
  "version": 1,
  "rules": [
    { "name": "广告", "type": "keyword", "pattern": "加微信\n刷单", "action": "hide" },
    { "name": "手机号", "type": "regex", "pattern": "(?<!\\d)1[3-9]\\d{9}(?!\\d)",
      "targets": { "comment": true }, "action": "hide" }
  ]
}
```

## 目录结构

```
manifest.json              扩展清单（MV3）
icons/                     图标（由 tools/make-icons.js 生成）
rules/                     内置默认规则 + 远程订阅规则库
  default-rules.json       随扩展打包的默认规则
  index.json               远程订阅索引
  sets/*.json              远程规则集（广告/辱骂/直播/剧透）
src/common/matcher.js      匹配引擎（正则缓存、JSON 深度过滤）
src/common/schema.js       规则结构、格式识别、导入导出、去重合并
src/common/storage.js      存储层（设置、规则、统计、内置/远程规则写入）
src/content/interceptor.js MAIN world 网络拦截
src/content/bridge.js      ISOLATED world 规则下发与命中上报
src/content/dom-filter.js  ISOLATED world DOM 兜底过滤
src/background/           service worker 与远程规则拉取
src/popup/                 快捷面板
src/options/               规则管理页
tools/test.js              规则引擎与打包文件自测
tools/test-dom.js          DOM 过滤层集成测试
tools/test-storage.js      存储层测试
tools/check-ui.js          UI 元素引用一致性检查
tools/make-icons.js        图标生成
tools/pack.js              打包 zip
```

## 开发

```bash
npm test                       # 跑全部自测（83 项断言 + UI/ manifest 校验）
node tools/test.js             # 规则引擎、规则文件、manifest 完整性
node tools/test-dom.js         # DOM 过滤层集成测试（内置最小 DOM 实现）
node tools/test-storage.js     # 存储层测试（内置/远程规则同步、统计）
node tools/check-ui.js         # 检查 HTML 与 JS 的元素引用是否对得上
node tools/check-manifest.js   # 版本号一致性、权限、CI 脚本引用校验
npm run test:live              # 联网验证线上订阅地址整条链路（需网络）
node tools/make-icons.js       # 重新生成图标
node tools/pack.js             # 打包成 dist/douyin-plus-<version>.zip
```

无构建步骤，改完代码在扩展管理页点"重新加载"即可（内容脚本改动需要刷新抖音页面）。

测试覆盖的要点：关键词/正则匹配与边界、非法正则的安全降级、`targets` 各写法、
JSON 深度过滤（不误删非文本对象）、规则去重与合并、导出再导入的往返一致性、
内置与远程规则文件的可编译性、DOM 命中与恢复、统计不重复计数、用户停用/删除状态在
规则更新后是否保留、UI 元素引用一致性、版本号跨文件一致。

## 持续集成与发版

[`.github/workflows/build.yml`](.github/workflows/build.yml) 会在 push / PR 时跑测试、校验
manifest、打包并上传产物；打 `v*` 标签时会额外创建 Release 并把 zip 作为附件。

```bash
bash tools/release.sh 0.2.0    # 同步版本号 → 校验 → 提交 → 打 tag → 推送
```

脚本会在需要手写 CHANGELOG 时暂停，补完变更说明后按提示执行后续命令即可。
也可以手动：改 `manifest.json` 与 `package.json` 的版本号 → 提交 → `git tag v0.2.0` → 推送 tag。

## 已知限制

- 抖音前端类名是构建期生成的哈希，DOM 兜底过滤依赖 `data-e2e` 属性与类名片段，
  页面大改版后选择器可能需要更新；网络层拦截不受影响。
- 直播弹幕若走 WebSocket 长连接，只能靠 DOM 过滤，可能有一次渲染的可见时间。
- 正则规则由用户自己填写，写得过于宽泛会误伤正常内容；建议先在管理页用"仅评论"范围试。

## 许可

MIT，见 [LICENSE](LICENSE)。
