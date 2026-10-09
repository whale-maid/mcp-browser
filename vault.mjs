#!/usr/bin/env node
// vault.mjs — 本地凭据库 CLI（给"自动登录"用的站点账密）
//
// 为什么要有它：让 agent 能登录站点，但账密**不经过对话**。
// 主人在本机终端里把账密写进本地文件，agent 侧只用 autologin 工具去读去填。
//
// 用法：
//   node mcp-browser/vault.mjs path
//   node mcp-browser/vault.mjs list
//   node mcp-browser/vault.mjs template [输出路径]      # 写一份「录入表」模板（默认放库旁边）
//   node mcp-browser/vault.mjs import <录入表> [--dry-run] [--keep]   # 把录入表并进库，默认导入后删表
//   node mcp-browser/vault.mjs set xiaohongshu --label 小红书 --url https://www.xiaohongshu.com/login \
//        --user 13800000000 --mode phone --sel-user "input[placeholder*='手机号']" --sel-code "input[placeholder*='验证码']" \
//        --sel-send "text=获取验证码" --sel-submit "button:has-text('登录')"
//   node mcp-browser/vault.mjs set weibo --url https://weibo.com/login.php --user me@example.com   # 密码隐藏输入
//   node mcp-browser/vault.mjs show xiaohongshu
//   node mcp-browser/vault.mjs rm weibo
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const VAULT_FILE = process.env.DSH_SECRETS_FILE || path.join(os.homedir(), '.dsh', 'secrets', 'sites.json');

function readVault() {
  try {
    const raw = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function writeVault(v) {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(v, null, 1), { encoding: 'utf8', mode: 0o600 });
  try {
    // Windows：断开继承权限，只留当前用户（best-effort，失败不阻塞）
    if (process.platform === 'win32') {
      const me = process.env.USERNAME;
      execFileSync('icacls', [VAULT_FILE, '/inheritance:r', '/grant:r', `${me}:F`], { stdio: 'ignore' });
    } else {
      fs.chmodSync(VAULT_FILE, 0o600);
    }
  } catch { /* 权限收紧失败不影响可用性，仅少一层保护 */ }
}

/** 隐藏输入读取密码（TTY）；非 TTY 时退回读一行 */
function askHidden(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { buf += c; });
      process.stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(wasRaw); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n'); resolve(buf);
      } else if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      else if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); }
      else { buf += ch; }
    };
    stdin.on('data', onData);
  });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
    else out._.push(a);
  }
  return out;
}

/** 录入表模板：全部示例都注释着，直接导入不会塞进垃圾条目；把要用的块取消注释再改。 */
const TEMPLATE = `# dsh 凭据录入表 —— 填完保存，然后跑 import 并进凭据库（导入成功后本文件会被删掉）
#
# 规则：
#   * 整行以 # 或 ; 开头 = 注释（值里可以正常出现 #，不截断）
#   * [站点key] 起一个块，key 就是 autologin 用的那个 site
#   * 块内写  字段 = 值   （等号两侧空格随意）
#   * 留空的字段不覆盖库里已有的值
# 字段：
#   label        显示名（随便写）
#   url          登录页地址
#   user         账号 / 手机号
#   pass         密码（只写密码型站点；留空则库里保持原样）
#   mode         password | phone（phone = 手机号 + 验证码）
#   sel-user     账号输入框选择器       sel-pass   密码输入框
#   sel-code     验证码输入框选择器     sel-send   发送验证码按钮
#   sel-submit   登录按钮
#
# 填完任选其一跑：
#   node mcp-browser/vault.mjs import "<本文件路径>" --dry-run     # 先看一眼解析对不对（不写入）
#   node mcp-browser/vault.mjs import "<本文件路径>"               # 正式导入并删除本文件
#   node mcp-browser/vault.mjs import "<本文件路径>" --keep        # 导入但保留本文件（不推荐）
#
# ---- 例子一：密码型站点（把下面每行前面的 # 去掉，再改成你的站点）----
# [example-password]
# label = 示例·密码登录
# url = https://example.com/login
# user = your-account
# pass = your-password
# mode = password
# sel-user = input[name="username"]
# sel-pass = input[name="password"]
# sel-submit = button[type="submit"]
#
# ---- 例子二：手机号 + 验证码站点（mode=phone；验证码后面用 autologin 的 code 参数补）----
# [example-phone]
# label = 示例·手机号登录
# url = https://example.com/login
# user = 13800000000
# mode = phone
# sel-user = input[placeholder="手机号"]
# sel-code = input[placeholder="验证码"]
# sel-send = span.code-button
# sel-submit = button.submit
#
# ---- 例子三：小红书（2026-09-18 在真登录页实测命中的选择器，只要把手机号换成你的）----
# [xiaohongshu]
# label = 小红书
# url = https://www.xiaohongshu.com/login
# user = 13800000000
# mode = phone
# sel-user = input[name='xhs-pc-web-phone']
# sel-code = input[placeholder='输入验证码']
# sel-send = span.code-button
# sel-submit = button.submit
`;

/**
 * 解析录入表（INI 风格，宽松）：`[站点key]` 起块、块内 `字段 = 值`。
 * 容忍：空行、`#`/`;` 整行注释、未知字段（收集为 warning 后忽略）、空值（跳过）。
 * @param {string} text 录入表正文。
 * @returns {{ sites: Record<string, any>, warnings: string[] }} 解析出的站点与我警告。
 */
function parseInput(text) {
  const sites = {};
  const warnings = [];
  let cur = null;
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) {
      cur = m[1].trim();
      if (!cur) { warnings.push(`第 ${lineNo} 行站点 key 为空，忽略`); cur = null; continue; }
      if (!sites[cur]) sites[cur] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) { warnings.push(`第 ${lineNo} 行既不是 [块] 也不是 字段=值，已忽略：${line.slice(0, 40)}`); continue; }
    if (!cur) { warnings.push(`第 ${lineNo} 行出现在任何 [站点key] 之前，已忽略`); continue; }
    const k = line.slice(0, eq).trim().toLowerCase();
    const v = line.slice(eq + 1).trim();
    if (!v) continue;
    const block = sites[cur];
    if (k === 'url' || k === 'login_url' || k === 'login-url') block.login_url = v;
    else if (k === 'label') block.label = v;
    else if (k === 'user' || k === 'username') block.username = v;
    else if (k === 'pass' || k === 'password') block.password = v;
    else if (k === 'mode') block.mode = v;
    else if (k === 'sel-user' || k === 'sel_user') block.selectors = { ...(block.selectors || {}), user: v };
    else if (k === 'sel-pass' || k === 'sel_pass') block.selectors = { ...(block.selectors || {}), pass: v };
    else if (k === 'sel-submit' || k === 'sel_submit') block.selectors = { ...(block.selectors || {}), submit: v };
    else if (k === 'sel-code' || k === 'sel_code') block.selectors = { ...(block.selectors || {}), code: v };
    else if (k === 'sel-send' || k === 'sel_send') block.selectors = { ...(block.selectors || {}), send_code: v };
    else warnings.push(`第 ${lineNo} 行未知字段 "${k}"，已忽略`);
  }
  return { sites, warnings };
}

const [, , cmd, ...rest] = process.argv;
const a = parseArgs(rest);
const vault = readVault();

if (cmd === 'path') {
  console.log(VAULT_FILE);
  console.log(fs.existsSync(VAULT_FILE) ? '（已存在）' : '（尚未创建）');
} else if (cmd === 'list' || cmd === undefined) {
  const keys = Object.keys(vault);
  console.log(`凭据库: ${VAULT_FILE}`);
  if (!keys.length) { console.log('（空）'); process.exit(0); }
  for (const k of keys) {
    const s = vault[k] || {};
    const sel = s.selectors || {};
    console.log(`- ${k}  ${s.label || ''}  mode=${s.mode || 'password'}  url=${s.login_url || '(缺)'}  账号=${s.username ? '有' : '无'}  密码=${s.password ? '有' : '无'}  选择器=${['user', 'pass', 'submit', 'code', 'send_code'].filter((x) => sel[x]).join(',') || '无'}`);
  }
} else if (cmd === 'set') {
  const key = a._[0];
  if (!key) { console.error('用法: vault.mjs set <key> [--label 名] [--url 登录页] [--user 账号] [--mode password|phone] [--pass 密码] [--sel-user ..] [--sel-pass ..] [--sel-submit ..] [--sel-code ..] [--sel-send ..]'); process.exit(1); }
  const cur = vault[key] || {};
  const sel = { ...(cur.selectors || {}) };
  if (a['sel-user']) sel.user = a['sel-user'];
  if (a['sel-pass']) sel.pass = a['sel-pass'];
  if (a['sel-submit']) sel.submit = a['sel-submit'];
  if (a['sel-code']) sel.code = a['sel-code'];
  if (a['sel-send']) sel.send_code = a['sel-send'];

  let password = typeof a.pass === 'string' ? a.pass : cur.password;
  if (typeof a.pass !== 'string' && !cur.password && (a.mode || cur.mode) !== 'phone') {
    password = await askHidden(`输入 ${key} 的密码（不回显，直接回车=跳过）: `);
    if (!password) password = undefined;
  }

  vault[key] = {
    label: a.label || cur.label || key,
    mode: a.mode || cur.mode || (sel.pass ? 'password' : 'phone'),
    login_url: a.url || cur.login_url || '',
    selectors: sel,
    username: typeof a.user === 'string' ? a.user : cur.username,
    ...(password ? { password } : {}),
  };
  writeVault(vault);
  console.log(`已写入 ${key}（密码：${password ? '已保存' : '未保存'}）`);
  console.log(VAULT_FILE);
} else if (cmd === 'show') {
  const key = a._[0];
  if (!key || !vault[key]) { console.error('没有这个站点'); process.exit(1); }
  const s = vault[key];
  console.log(JSON.stringify({ ...s, password: s.password ? '******（已保存，不显示）' : undefined }, null, 1));
} else if (cmd === 'rm') {
  const key = a._[0];
  if (!key) { console.error('用法: vault.mjs rm <key>'); process.exit(1); }
  delete vault[key];
  writeVault(vault);
  console.log(`已删除 ${key}`);
} else if (cmd === 'template') {
  const out = typeof a._[0] === 'string' ? a._[0] : path.join(path.dirname(VAULT_FILE), 'sites.input.ini');
  if (fs.existsSync(out) && a.force !== true) {
    console.error(`录入表已存在：${out}`);
    console.error('要覆盖它请加 --force（已填的内容会丢）。');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, TEMPLATE, { encoding: 'utf8', mode: 0o600 });
  console.log(`已写出录入表模板：${out}`);
  console.log('用记事本打开，把要用的块取消注释、改成你的站点与账号密码，保存后跑：');
  console.log(`  notepad "${out}"`);
  console.log(`  node "${fileURLToPath(import.meta.url)}" import "${out}"`);
} else if (cmd === 'import') {
  const src = a._[0];
  if (!src) { console.error('用法: vault.mjs import <录入表路径> [--dry-run] [--keep]'); process.exit(1); }
  if (!fs.existsSync(src)) { console.error(`找不到录入表：${src}`); process.exit(1); }
  const { sites, warnings } = parseInput(fs.readFileSync(src, 'utf8'));
  const keys = Object.keys(sites);
  const describe = (s) => `url=${s.login_url || '(缺)'}  账号=${s.username ? '有' : '无'}  密码=${s.password ? '有' : '无'}  选择器=${Object.keys(s.selectors || {}).join(',') || '无'}`;
  if (!keys.length) {
    console.error('录入表里没有解析到任何 [站点key] 块（示例块是不是还整行注释着？）');
    for (const w of warnings) console.error(`[!] ${w}`);
    process.exit(1);
  }
  if (a['dry-run'] === true) {
    console.log(`--dry-run：解析到 ${keys.length} 个站点，未写入凭据库`);
    for (const k of keys) console.log(`- ${k}  ${describe(sites[k])}`);
  } else {
    for (const k of keys) {
      const cur = vault[k] || {};
      const selectors = { ...(cur.selectors || {}), ...(sites[k].selectors || {}) };
      const password = sites[k].password || cur.password;
      vault[k] = {
        label: sites[k].label || cur.label || k,
        mode: sites[k].mode || cur.mode || (selectors.pass ? 'password' : 'phone'),
        login_url: sites[k].login_url || cur.login_url || '',
        selectors,
        username: sites[k].username || cur.username,
        ...(password ? { password } : {}),
      };
    }
    writeVault(vault);
    console.log(`已导入 ${keys.length} 个站点：${keys.join(', ')}`);
    for (const k of keys) console.log(`- ${k}  ${describe(vault[k])}`);
    console.log(`凭据库：${VAULT_FILE}`);
    if (a.keep === true) {
      console.log(`录入表保留（--keep）：${src}`);
      console.log('注意：它里面是明文账密，跟凭据库一样要看好。');
    } else {
      fs.rmSync(src, { force: true });
      console.log(`录入表已删除（账密现在只存在凭据库里）：${src}`);
    }
  }
  for (const w of warnings) console.error(`[!] ${w}`);
} else {
  console.error('未知命令。可用: path | list | template | import | set | show | rm');
  process.exit(1);
}
