# 规则格式说明

本文档说明 douyin-plus 的规则结构、导入导出格式，以及如何编写与分享规则。

## 目录

- [单条规则字段](#单条规则字段)
- [规则集文件](#规则集文件)
- [索引文件（远程订阅）](#索引文件远程订阅)
- [其它可导入格式](#其它可导入格式)
- [匹配语义](#匹配语义)
- [正则写法建议](#正则写法建议)
- [编写规范的注意事项](#编写规范的注意事项)

## 单条规则字段

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 自动生成 | 规则唯一标识。**分享规则时建议省略**，由导入方自动生成，避免不同人的规则 id 冲突。 |
| `name` | string | 按类型默认 | 规则的显示名称，建议写成 `分类 · 简述`，例如"广告 · 加微信"。 |
| `type` | `"keyword"` \| `"regex"` | `keyword` | 匹配方式。 |
| `pattern` | string | 必填 | 匹配内容。关键词可用换行或逗号分隔多个词；正则直接写表达式，**不带两侧斜杠**。 |
| `caseSensitive` | boolean | `false` | 是否区分大小写。 |
| `targets` | 见下 | 全部场景 | 生效场景。 |
| `action` | `"hide"` \| `"blur"` | `hide` | `hide` 完全移除；`blur` 保留位置并模糊，鼠标悬停可临时查看。 |
| `enabled` | boolean | `true` | 是否启用。停用的规则不参与匹配。 |
| `note` | string | 空 | 备注，只在管理页显示。 |
| `source` | string | 导入时决定 | `builtin` / `user` / `remote`，一般不用手写。 |

### targets 的写法

三种写法等价：

```json
{ "targets": { "danmaku": true, "comment": true, "live": true } }
{ "targets": ["danmaku", "comment", "live"] }
{ "targets": "all" }
```

场景含义：

- `danmaku` —— 短视频页面的弹幕（含视频弹幕开关打开时的浮层弹幕）
- `comment` —— 视频/图集评论区、二级评论
- `live` —— 直播间聊天区弹幕

只想让规则在评论区生效：

```json
{ "targets": { "comment": true } }
```

> 注意：显式写了 `targets` 时，未列出的场景视为不生效；
> 完全不写 `targets` 才表示三个场景全部生效。

## 规则集文件

一个规则集就是包含 `rules` 数组的 JSON，扩展也接受顶层直接是数组的文件。

```json
{
  "schema": "douyin-plus/ruleset",
  "schemaVersion": 1,
  "name": "我的规则集",
  "description": "可选，说明这个规则集针对什么",
  "author": "你的名字",
  "homepage": "https://github.com/you/repo",
  "version": 3,
  "updatedAt": "2026-10-07T00:00:00.000Z",
  "rules": [
    {
      "name": "广告 · 微信引流",
      "type": "keyword",
      "pattern": "加微信\n加vx\n私我微信",
      "targets": "all",
      "action": "hide"
    },
    {
      "name": "广告 · 手机号",
      "type": "regex",
      "pattern": "(?<!\\d)1[3-9]\\d{9}(?!\\d)",
      "targets": { "comment": true, "danmaku": true },
      "action": "hide"
    },
    {
      "name": "剧透",
      "type": "keyword",
      "pattern": "结局是\n凶手是\n最后死了",
      "action": "blur",
      "enabled": false
    }
  ]
}
```

字段说明：

- `version` —— 规则集版本号，每次改词库就 +1。远程订阅会记录它，方便判断是否更新。
- `name` / `description` / `author` / `homepage` —— 元信息，导入时会显示。
- 每条规则的 `id` 省略即可，导入时自动生成。

## 索引文件（远程订阅）

订阅地址可以是一个索引文件，指向多个规则集。这样可以把不同类别的规则分开维护，
用户可以只订阅其中一部分。

```json
{
  "schema": "douyin-plus/index",
  "schemaVersion": 1,
  "name": "douyin-plus 官方规则订阅",
  "version": 2,
  "updatedAt": "2026-10-07T00:00:00.000Z",
  "files": [
    { "path": "sets/ads-extra.json", "name": "广告补充词库", "enabled": true },
    { "path": "sets/live-extra.json", "name": "直播间专项", "enabled": true },
    { "path": "sets/spoiler.json", "name": "剧透保护", "enabled": false }
  ]
}
```

- `path` —— 相对索引文件的路径，也可以是完整 URL。
- `enabled` —— 设为 `false` 的文件在订阅时会被跳过。用户可以自行 fork 后改这里。
- 单个文件拉取失败不会导致整次更新失败，失败信息会记在设置页的订阅状态里。

## 其它可导入格式

导入时会自动识别下列格式，方便直接用别人整理的词库：

**1. 纯关键词数组**

```json
["加微信", "刷单", "博彩"]
```

**2. 关键词 / 正则分列（简写格式）**

```json
{
  "keywords": ["加微信", "刷单"],
  "regex": ["1[3-9]\\d{9}"]
}
```

`blacklist` 也可作为 `keywords` 的别名。

**3. 字段别名**

单条规则也接受这些别名，降低迁移成本：

| 正式字段 | 可接受的别名 |
| --- | --- |
| `pattern` | `regex`、`keyword`、`keywords`、`text`、`value`、`match` |
| `type` | `mode`；或通过 `regex` / `re` 字段是否存在推断 |
| `name` | `label`、`title` |
| `note` | `description`、`desc` |
| `targets` | `scope`、`scene` |
| `words` | `keywords` 数组，自动展开成多行关键词 |

**4. 带 data 包装的响应体**

```json
{ "code": 0, "data": { "rules": [ … ] } }
```

会自动向下穿透一层 `data`。

## 匹配语义

- **关键词规则**：`pattern` 按换行、英文逗号、中文逗号拆成多个词，
  每个词按**字面量**处理（`+ ? . *` 等符号没有特殊含义），任意一个词出现在内容里即命中。
- **正则规则**：整个 `pattern` 作为一条正则编译，不做拆分。
- **大小写**：默认忽略大小写；`caseSensitive: true` 时区分。
- **单条 pattern 上限**：500 字符，超长会被拒绝（防止误粘贴整篇文章）。
- **匹配目标**：页面接口返回的 JSON 里的文本字段，按
  `text` → `content` → `danmaku_text` → `content_text` → `reply_text` → `display_text` → `desc`
  的顺序取第一个非空字段。取不到文本字段的对象不会被删除（例如用户信息对象）。
- **删除粒度**：只删除数组里"文本命中"的那一项，不删除对象的普通属性，
  因此不会破坏接口返回的数据结构。

## 正则写法建议

- 不加两侧斜杠：写 `1[3-9]\d{9}`，不要写 `/1[3-9]\d{9}/`。
- JSON 里反斜杠要转义：`"\\d"`、`"\\s"`。
- 用 `(?:...)` 做非捕获分组，避免产生无意义的捕获组。
- 加边界避免误伤：手机号加 `(?<!\d)` 与 `(?!\d)` 后，`138123456789012`
  这种长数字串就不会被当成手机号。
- 避免 `.*` 打头的宽松模式，例如 `.*优惠.*` 不如直接写关键词 `优惠` 快且准。
- 慎重使用回溯灾难型写法：`(a+)+b`、`(.|\s)*` 这类模式在长文本上会卡住页面。

## 编写规范的注意事项

1. **词条宁短勿长**：写 `加微信` 比写 `大家快来加微信领取资料` 覆盖更广、误伤更低。
2. **避免常见字词的子串**：例如用 `日结` 会误伤"日结工资"以外的一些正常表达，
   而 `兼职日结` 更精确。
3. **高误伤规则默认 `enabled: false`**：例如"你妈"这类口语中常见的词，
   默认关闭、由用户按需打开，比默认打开引发投诉要好。
4. **给 note 写清意图**：用户看到一条陌生规则时，note 是判断该不该留的依据。
5. **同类合并成多行关键词**：一条规则里写 20 个词比 20 条单词语规则更容易维护，
   在管理页里也只占一行。
6. **区分场景**：长文本刷屏规则只在弹幕/直播启用（`targets` 不含 `comment`），
   因为评论区正常会有长影评。

## 贡献规则

1. Fork 本仓库。
2. 在 `rules/sets/` 下新增或修改规则集文件，`version` +1，更新 `updatedAt`。
3. 如需新增文件，在 `rules/index.json` 的 `files` 里登记。
4. 运行 `node tools/test.js`，确认所有规则可解析、可编译，且词条之间没有重复。
5. 提交 PR，说明新增词条针对哪类内容、误伤风险评估。
