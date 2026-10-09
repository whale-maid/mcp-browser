# mcp-browser — 浏览器 MCP 服务器

极简 MCP stdio 服务器：把 Edge（playwright-core）暴露为 `mcp__browser__*` 工具
（browse / screenshot / click / fill / eval / dl / autologin 等），由 dsh 的
`@deepseek-ai/dsh-mcp-client` 挂载，注册在
`~/.dsh/profiles/web/cordis.patch.yml`（id: `mcp-browser`，serverName: `browser`）。

## 布局

| 路径 | 说明 |
|---|---|
| `browser-mcp.mjs` | 服务器本体 |
| `vault.cmd` / `vault.ps1` | **双击入口**：菜单式凭据录入台（生成/打开录入表、干跑+导入、查站点、删站点、开库文件夹）。`.cmd` 纯 ASCII 只做包装，逻辑在 `.ps1`（UTF-8 带 BOM） |
| `vault.mjs` | 本地凭据库 CLI（给 `autologin` 用的站点账密，密码不进对话） |
| `tests/login-test.html` | **自测靶页**：不联网的假登录页（账号框/密码框/提交/结果区），给 `autologin` 做端到端回归 |
| `shots/` | 截图输出目录（`OUT_DIR`）；编号按进程内序，重启后从 `mcp-001` 重新计 |

## 登录与凭据（v1.1，2026-09-18）

两件事配套：**登录态要活得下来**，**账密不要过 agent 的手**。

### 1. 持久化 profile

浏览器用 `chromium.launchPersistentContext` 启动，profile 落盘在
`~/.dsh/browser-profile`（可用环境变量 `DSH_BROWSER_PROFILE` 覆盖）。
因此 Cookie/登录态**跨浏览器重启保留**——`set_headful` / `set_window` 触发的重启不再掉登录。
扫码/人机校验只需人工过**一次**。

### 2. 本地凭据库 + 自动登录

账密存在**本机文件**里，不进对话、不进返回值、不进日志：

```
~/.dsh/secrets/sites.json          # 可用 DSH_SECRETS_FILE 覆盖；写入时自动收紧权限
```

主人用 CLI 写（**密码走隐藏输入，不落在命令行历史里**）：

```sh
# 小红书：官方只提供 扫码 / 手机号+验证码，没有密码登录 → 用 phone 模式。
# 下面四条选择器 2026-09-18 在登录页实测命中；手机号换成主人自己的。
node mcp-browser/vault.mjs set xiaohongshu \
  --label 小红书 --url https://www.xiaohongshu.com/login \
  --user <主人手机号> --mode phone \
  --sel-user "input[name='xhs-pc-web-phone']" \
  --sel-code "input[placeholder='输入验证码']" \
  --sel-send "span.code-button" \
  --sel-submit "button.submit"

# 密码型站点：省略 --pass，会提示隐藏输入
node mcp-browser/vault.mjs set weibo --url https://weibo.com/login.php --user me@example.com
```

其他命令：`path` / `list` / `show <key>`（密码显示为 `******`）/ `rm <key>`。

agent 侧两个工具：

| 工具 | 作用 |
|---|---|
| `login_sites` | 列出库里已配置站点，只报「有没有账号/密码/选择器」，**不返回账密** |
| `autologin` | `{site, code?, submit?}`：打开登录页 → 按选择器填表 → 提交；账密由服务器自己读自己填 |

`mode` 两种：`password`（填账号+密码）、`phone`（填手机号 → 点 `send_code` 取码 → 用 `autologin({site, code})` 补验证码）。
扫码登录的站点没有 `autologin` 可用，靠持久化 profile 扫一次即可。

**注意**：改完本目录的服务器代码后必须**重启一次 dsh web**，否则 MCP 子进程还是旧代码、看不到新工具。

### 3. 简单录入表：填个文件就能加站点（2026-09-24 增）

不想在终端里敲一长串参数时，用「录入表」——一个纯文本文件，填完一条命令并进库：

```sh
node mcp-browser/vault.mjs template                      # 写出模板（默认放库旁边：~/.dsh/secrets/sites.input.ini）
notepad "C:\Users\ZhuanZ1\.dsh\secrets\sites.input.ini"  # 打开填：把要用的块取消注释、改成自己的站点与账密
node mcp-browser/vault.mjs import "<该文件>" --dry-run    # 先看一眼解析对不对（不写入）
node mcp-browser/vault.mjs import "<该文件>"              # 正式导入（成功后自动删表）
```

- 格式：`[站点key]` 起块，块内 `字段 = 值`；整行 `#` / `;` 是注释，**值里可以正常写 `#` 和 `=`**（不截断）；留空的字段不覆盖库里已有的值。
- 字段：`label` / `url` / `user` / `pass` / `mode` / `sel-user` / `sel-pass` / `sel-submit` / `sel-code` / `sel-send`。
- **导入成功后录入表自动删除**——账密只留在 `sites.json` 一处（加 `--keep` 可保留，但那意味着明文账密存在两处）。
- 模板里的示例全部是注释状态，**没改就导入会被拦下**（不会塞进垃圾条目）。
- 也可以把这活交给 agent：填好表说一声，它跑 `import`——输出只报「有没有账号/密码/选择器」，不打印账密，导入完文件即消失。

### 4. 自测（2026-09-24 实测通过）

不想用真站点验证时，用靶页 `tests/login-test.html` + 一条**假账密**记录走完整链路：

```sh
# 1) 写自测记录（假账密；必须是真库路径——MCP 子进程只认 VAULT_FILE）
node mcp-browser/vault.mjs set _selftest --label 自测靶页 \
  --url "file:///D:/deepseek-harness/work%20space/mcp-browser/tests/login-test.html" \
  --user demo --pass demo123 \
  --sel-user "#username" --sel-pass "#password" --sel-submit "#submit-btn"

# 2) 调工具 autologin { "site": "_selftest" }
# 3) 清理
node mcp-browser/vault.mjs rm _selftest
```

实测：`filled: ["user","pass"]`、`submitted: true`、标题变「已登录（自测靶页）」、正文含「登录成功：欢迎 demo」，**返回值里没有密码**。
CLI 半身另有影子库离线验法：把 `DSH_SECRETS_FILE` 指到临时目录再跑 `path/set/list/show/rm`。

## 注意事项

- 搬迁后必须**重启一次 dsh web**（加载新 `cordis.patch.yml` 路径与新的 `OUT_DIR`）；
  重启前若浏览器 MCP 断线重连，会按旧路径 `work space/browser-mcp.mjs` 查找而失败。
- 依赖（运行时解析）：`D:/deepseek-harness/node_modules/.pnpm/playwright-core@1.61.1/...`、
  系统 Edge。均不在本目录内。
- 旧探测脚本与 RikkaHub 搜索服务脚本已归档到 `../_archive/rikka/`。

## 网络通道差异（2026-09-10 实测，很关键）

同一台机器上，本 MCP 的**两类工具走的是不同网络栈**——这决定了能不能访问被 hosts 劫持的站点（如 GitHub）：

| 工具 | 走谁的网络栈 | 受限情况 |
|---|---|---|
| `browse` / `screenshot` / `get_text` / `eval_js` / `click*` / `fill_and_submit` / `autologin` | **Chromium（系统 Edge）** | 走宿主正常网络 → **能打开 `github.com`**（`raw.githubusercontent.com` 仍被 hosts 挡） |
| `dl` / `http_get` | **Node（= dsh 进程）** | 与 dsh 同级受限 → **被 hosts 挡死**（GitHub 报 `fetch failed`），尽管名字看着像浏览器 |

要下载 GitHub 上的文件，别用 `dl`：改用 Chromium 侧 `browse` 打开 **jsDelivr CDN** 地址
（`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/<path>`），或用宿主页 `../tools/fetch-file.html?u=<CDN 地址>` 把文本取出来。
完整结论与排查命令见 `../tools/AGENTS.md` 第七节「网络通道与 GitHub 取用」。

## 实测边界（2026-09-18）

本机网络下各站点可达性（决定素材从哪来）：

| 站点 | 结果 |
|---|---|
| 小红书 | 站可达，但**搜索需登录**（用持久化 profile 登一次即可） |
| 花瓣 huaban | 腾讯云 EdgeOne 人机验证，验证码在跨域 iframe 内，脚本点不进去 |
| 微博 m.weibo.cn | 可达；图片搜索接口 `containerid=100103type=2&q=<kw>` 返回 JSON |
| Pinterest / Instagram / i.pinimg.com | **网络不可达**（直连超时） |
| WEAR(403) / ZOZO | 不可用 |
| 得物 / 堆糖 / 抖音 / Vogue | 首页可达，未深入验证 |
