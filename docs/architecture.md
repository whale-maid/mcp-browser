# mcp-browser · 架构

> 状态: current ｜ 更新: 2026-09-24
> 本文档写当前的真实结构。与代码不一致时以代码为准并回写本文档。

## 1. 定位与目标

mcp-browser 是一个极简 MCP stdio 服务器，把 Edge（playwright-core）暴露为 `mcp__browser__*` 工具，由 dsh 的 `@deepseek-ai/dsh-mcp-client` 挂载，注册在 `~/.dsh/profiles/web/cordis.patch.yml`（id: `mcp-browser`，serverName: `browser`）。

服务器本体为单一文件 `browser-mcp.mjs`，通过 stdio transport 与 MCP 客户端通信，使用 JSON-RPC 2.0 协议（protocolVersion: `2024-11-05`，serverInfo.version `1.1.0`）。

v1.1（2026-09-18）加了两件事：**持久化 browser profile**（登录态跨重启保留）与**本地凭据库 + 自动登录**（账密不过 agent 的手）。

## 2. 目录与模块边界

| 模块 | 路径 | 职责 | 不负责 |
|---|---|---|---|
| 服务器本体 | `browser-mcp.mjs` | MCP stdio 服务器；浏览器生命周期（persistent context / page）；注册并分发工具；readline 解析 stdin 的 JSON-RPC 消息 | dsh 侧的 MCP 客户端挂载逻辑 |
| 凭据库 CLI | `vault.mjs` | 本机终端里增删查本地凭据库（`path`/`list`/`set`/`show`/`rm`）；**录入表通道**（`template` 出模板 / `import` 并库并默认删表，解析器 `parseInput`）；密码走隐藏输入；写入后收紧文件权限 | 不发起登录、不接触浏览器 |
| 录入台（双击入口） | `vault.cmd` → `vault.ps1` | 菜单式包装：1 生成/打开录入表 · 2 干跑+导入 · 3 列站点 · 4 删站点 · 5 开库文件夹。本脚本不读/不打印/不缓存账密，只转调 `vault.mjs` | 不含业务逻辑；`.cmd` 纯 ASCII、`.ps1` UTF-8 带 BOM |
| 自测靶页 | `tests/login-test.html` | 不联网的假登录页（账号框 / 密码框 / 提交按钮 / 结果区），给 `autologin` 做端到端回归 | 不参与运行时，服务器不加载它 |
| 截图输出目录 | `shots/` | 工具截图输出（`OUT_DIR`）；编号按进程内序，重启后从 `mcp-001` 重计 | 截图的清理或轮转 |
| 持久化 profile | `~/.dsh/browser-profile`（`DSH_BROWSER_PROFILE` 可覆盖） | 存放 Cookie/登录态，跨浏览器重启保留 | 不存放账密 |
| 本地凭据库 | `~/.dsh/secrets/sites.json`（`DSH_SECRETS_FILE` 可覆盖） | 站点登录页地址、填表选择器、账号、密码 | 不参与版本控制；不进对话/返回值/日志 |
| 依赖（运行时解析） | `D:/deepseek-harness/node_modules/.pnpm/playwright-core@1.61.1/...` | 浏览器驱动 | — |
| 系统 Edge | `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` | 浏览器可执行文件 | — |

## 3. 数据与控制流

```
┌──────────────────────────────┐       stdio (JSON-RPC 2.0)        ┌─────────────────────────────────┐
│  dsh (@deepseek-ai/          │ ────────────────────────────────► │  browser-mcp.mjs                │
│  dsh-mcp-client)              │  stdin: initialize/tools/list/   │  readline 解析 → 方法分发        │
│  cordis.patch.yml 注册        │         tools/call/ping           │                                 │
│  id: mcp-browser              │ ◄──────────────────────────────── │  stdout: JSON-RPC result        │
│  serverName: browser          │                                   │                                 │
└──────────────────────────────┘                                   └──────────┬──────────────────────┘
                                                                              │
                                                     ensurePage() / relaunch()│
                                                                              ▼
                                                                   ┌─────────────────────────────────┐
                                                                   │  playwright-core (chromium)      │
                                                                   │  launchPersistentContext         │
                                                                   │  → Edge (executablePath)         │
                                                                   │  profile: ~/.dsh/browser-profile │
                                                                   │  headful 默认 true；单 page 模式   │
                                                                   └─────────────────────────────────┘
                                                                              ▲
                                                         readVault()          │
                                                                   ┌──────────┴──────────────────────┐
                                                                   │ ~/.dsh/secrets/sites.json        │
                                                                   │ ← 主人用 vault.mjs 在本机终端写入  │
                                                                   └─────────────────────────────────┘
```

控制流（来自 `browser-mcp.mjs`）：

1. **stdin 读取**：`readline` 逐行解析 JSON-RPC 消息。
2. **方法分发**：`initialize`（返回协议版本与能力）、`notifications/*`（无响应）、`ping`、`tools/list`（枚举 `tools` 对象）、`tools/call`（按 name 查表执行 `tool.run()`）。
3. **浏览器生命周期**：`ensurePage()` 惰性启动 `launchPersistentContext(PROFILE_DIR, …)`（headful 时用 `--window-size` / `--window-position`，headless 时给 1440×900 视口），复用 profile 中已有页面或新建；`relaunch()` 关闭 context 并置空（**profile 目录保留**，故登录态不丢）；stdin 关闭时关闭 context 并 `process.exit(0)`。
4. **凭据读取**：`readVault()` 读 `VAULT_FILE`，文件缺失或损坏一律返回空对象、不抛错；`publicSite()` 把站点配置投影成「有没有账号/密码/选择器」的对外视图，**不返回账密字段**。
5. **截图**：`shot()` 自增进程内序号，写入 `OUT_DIR/mcp-NNN.png`。
6. **结果封装**：`textResult()` 将返回值 JSON 序列化为 `content[0].text`；`errResult()` 把异常消息封装为 `isError: true`。

## 4. 工具清单

| 工具 | 走谁的网络栈 | 说明 |
|---|---|---|
| `browse` / `get_text` / `screenshot` / `click_text` / `click` / `press_key` / `fill_and_submit` | Chromium | 页面导航与交互 |
| `fill_field` | Chromium | 按选择器填单个输入框，不提交 |
| `click_at` | Chromium | **按视口坐标点击**（真 CDP 鼠标：`mouse.move(steps)` 分步 + down/up + 随机微延迟，`isTrusted=true`）。用于画在图片/canvas 里的目标（点选验证码、图表节点）——`click` 只能点元素中心 |
| `eval_js` | Chromium | 页面上下文执行 JS |
| `dl` / `http_get` | Node | 直连下载/取文本（受 hosts 限制） |
| `set_headful` / `set_window` | — | 切换可见性/窗口尺寸，触发 `relaunch`（登录态不受影响） |
| `login_sites` | — | 列凭据库站点（只报「有没有」） |
| `autologin` | Chromium | `{site, code?, submit?}` 自动填表登录 |
| `clear_profile` | — | `{confirm:true}` 清空持久化 profile（等于全站登出） |

## 5. 扩展点

| 扩展点 | 接入方式 | 约束 |
|---|---|---|
| 新增工具 | 在 `tools` 对象中添加 `{ description, inputSchema, async run(args) }`；`tools/list` 自动枚举 | inputSchema 必须为合法 JSON Schema（type: object）；run 返回值由 `textResult()` 序列化 |
| 新增可自动登录站点 | 用 `vault.mjs set <key>` 写一条：`login_url` + `selectors`（`user`/`pass`/`submit`/`code`/`send_code`）+ `mode`；无需改服务器代码 | 选择器必须能在该站登录页命中；账密只写本地文件 |
| dsh 侧挂载配置 | `~/.dsh/profiles/web/cordis.patch.yml` 中 `id: mcp-browser`、`serverName: browser` | 改动本目录代码后必须重启 dsh web |

## 6. 关键约束

- **单页模式**：全局 `context` 与 `page` 各持一个实例；多工具调用共享同一页面。
- **凭据不外泄**：`login_sites` / `autologin` 的返回值、错误消息、日志中一律不含账号密码；`vault.mjs show` 把密码显示为 `******`。库文件写入后以 0600（Windows 用 `icacls` 断继承、只授当前用户）保护，失败不阻塞但会少一层保护。
- **登录态存续**：登录态只在持久化 profile 里，`clear_profile` 会清空它；`relaunch`（set_headful/set_window）不会。
- **人机校验不可代过**：扫码、图形/滑块验证码落在跨域 iframe 内，脚本点不进去；`autologin` 遇到这类页面只是把状态回报给人，由主人在可见窗口完成。
- **截图编号进程内序**：`shotSeq` 从 0 自增，重启后可能与既有文件同名覆盖。
- **依赖与路径硬编码**：playwright-core 路径、Edge 路径、`OUT_DIR` 均为硬编码；profile 与凭据库路径支持环境变量覆盖。
- **默认 headful**：`headful` 默认 `true`，默认 1280×800 @(40,40)。
- **错误处理**：未知工具或 `run` 抛异常返回 `isError: true`；stdin 的 JSON 解析失败静默忽略。

## 7. 已知限制

- **无 package.json / lockfile**：依赖在运行时从外部路径解析。
- **无并发保护**：`readline` 的 `line` 回调未做请求串行化；客户端在上一条 `tools/call` 未返回前发下一条时，响应顺序可能错乱。
- **凭据库为明文 JSON**：靠文件权限与「不过对话」控制暴露面，未做加密；若需更强保护应改为接系统凭据管理器。
- **`phone` 模式依赖站点选择器**：验证码框/发送按钮的 DOM 一变，`autologin` 就会打偏，需要更新库里的选择器。

## 8. 自测与验证状态

**端到端（2026-09-24 实测通过）**：不必用真站点——靶页 `tests/login-test.html` + 一条**假账密**记录即可走完整链路。

```powershell
# 1) 写一条自测记录（假账密）。必须是真库路径：MCP 子进程只认 VAULT_FILE，不吃临时环境变量
node mcp-browser\vault.mjs set _selftest --label 自测靶页 `
  --url "file:///D:/deepseek-harness/work%20space/mcp-browser/tests/login-test.html" `
  --user demo --pass demo123 `
  --sel-user "#username" --sel-pass "#password" --sel-submit "#submit-btn"

# 2) 让 MCP 真跑一次：调用工具 autologin { "site": "_selftest" }

# 3) 清理：删记录；若库文件原本就不存在，连文件一并删掉以恢复原状
node mcp-browser\vault.mjs rm _selftest
```

- 实测返回：`filled: ["user","pass"]`、`submitted: true`、`title: 已登录（自测靶页）`、正文含「登录成功：欢迎 demo」；**返回值里没有任何密码**（页面只回报「已收到 7 位」）。
- CLI 半身已在**影子库**离线验过（`DSH_SECRETS_FILE` 指向临时目录）：`path` / `set` / `list` / `show`（密码打码）/ `rm` 全通，落盘权限 0600 + `icacls` 断继承只授当前用户。
- 加真站点仍不需要改代码：`vault.mjs set <key>` 写 `login_url` + 选择器即可。
- **录入表（2026-09-24 增，已自测）**：`vault.mjs template` 在库旁写出 `sites.input.ini`（示例全为注释态，直接 import 会被拦下），主人填好后 `vault.mjs import <表> [--dry-run] [--keep]` 并库；成功默认删表（账密只留库一份）。解析规则：`[key]` 起块、`字段 = 值`、整行 `#`/`;` 为注释且**不截断值内的 `#`/`=`**、空值不覆盖已有字段、未知字段只告警。已验：两站点并库、mode/选择器正确、密码含 `#`/`=` 原样落盘、dry-run 不写、未改模板被安全拒绝。
