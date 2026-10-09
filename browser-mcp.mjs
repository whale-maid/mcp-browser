// browser-mcp.mjs — 极简 MCP stdio 服务器：把 Edge 浏览器暴露为工具
// 供 @deepseek-ai/dsh-mcp-client 以 stdio transport 挂载（serverName: browser）
//
// 两条与"登录"相关的设计要点：
// 1) 持久化 profile（launchPersistentContext）：Cookie/登录态落盘，重启浏览器不再丢；
//    set_headful / set_window 触发的 relaunch 因此不再把登录踢掉。
// 2) 本地凭据库（~/.dsh/secrets/sites.json，可用 DSH_SECRETS_FILE 覆盖）：
//    autologin 工具自己读库、自己填表，账密不进对话、不进返回值、不进日志。
//    只用 selectors 描述"往哪个框里填"，账密本身由主人用 vault.mjs 写进本地文件。
import { createRequire } from 'module';
import readline from 'readline';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { chromium } = require('D:/deepseek-harness/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');

const OUT_DIR = 'D:/deepseek-harness/work space/mcp-browser/shots';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE_DIR = process.env.DSH_BROWSER_PROFILE || path.join(os.homedir(), '.dsh', 'browser-profile');
const VAULT_FILE = process.env.DSH_SECRETS_FILE || path.join(os.homedir(), '.dsh', 'secrets', 'sites.json');

let context = null; // 持久化上下文（persistent context 下它同时是"浏览器"）
let page = null;
let shotSeq = 0;
let headful = true; // 默认可见窗口：用户可实时监控操作（后续可用 set_headful 工具切换）
let winW = 1280;    // headful 窗口宽（不最大化，留出桌面空间供用户移动/缩放）
let winH = 800;     // headful 窗口高
let winX = 40;
let winY = 40;

async function ensurePage() {
  if (!context) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath: EDGE,
      headless: !headful,
      viewport: headful ? null : { width: 1440, height: 900 },
      locale: 'zh-CN',
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        ...(headful ? [`--window-size=${winW},${winH}`, `--window-position=${winX},${winY}`] : []),
      ],
    });
  }
  if (!page || page.isClosed()) {
    const open = context.pages();
    page = open.length ? open[0] : await context.newPage();
  }
  return page;
}

async function relaunch() {
  try { if (context) await context.close(); } catch {}
  context = null;
  page = null;
}

/** 读本地凭据库；文件不存在或损坏一律当空库，不抛错 */
function readVault() {
  try {
    const raw = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** 站点配置的对外视图：只暴露"有没有"，绝不暴露账密本身 */
function publicSite(key, s) {
  const sel = s.selectors || {};
  return {
    key,
    label: s.label || key,
    mode: s.mode || 'password',
    login_url: s.login_url || '',
    has_username: !!s.username,
    has_password: !!s.password,
    selectors: { user: !!sel.user, pass: !!sel.pass, submit: !!sel.submit, code: !!sel.code, send_code: !!sel.send_code },
  };
}

/**
 * 导航（带降级）：部分站点有长连接/埋点，load 事件迟迟不触发。
 * 先等 load，超时退到 domcontentloaded，再超时就直接用当前状态继续——填表/取文本都已够用。
 */
async function goto(p, url) {
  for (const waitUntil of ['load', 'domcontentloaded']) {
    try {
      await p.goto(url, { waitUntil, timeout: 30000 });
      return waitUntil;
    } catch { /* 换下一档 */ }
  }
  return 'timeout';
}

async function shot() {
  const p = page;
  const file = path.join(OUT_DIR, `mcp-${String(++shotSeq).padStart(3, '0')}.png`);
  try { await p.screenshot({ path: file }); return file; } catch { return null; }
}

async function settle(ms = 1500) { await new Promise((r) => setTimeout(r, ms)); }

const tools = {
  browse: {
    description: '在共享浏览器中打开一个 URL 并等待渲染，返回标题、可见文本和截图路径。页面在多次调用之间保持打开。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '要打开的完整 URL' } }, required: ['url'], additionalProperties: false },
    async run(args) {
      const p = await ensurePage();
      const waited = await goto(p, args.url);
      await settle(2500);
      const title = await p.title();
      const text = (await p.evaluate(() => document.body.innerText)).slice(0, 3000);
      return { url: p.url(), title, text, waited, screenshot: await shot() };
    },
  },
  get_text: {
    description: '返回当前页面全部可见文本（可截断）。',
    inputSchema: { type: 'object', properties: { maxChars: { type: 'number' } }, additionalProperties: false },
    async run(args) {
      const p = page;
      if (!p) return { error: 'no page open; call browse first' };
      const text = await p.evaluate(() => document.body.innerText);
      return { url: p.url(), text: text.slice(0, args.maxChars ?? 20000), total: text.length };
    },
  },
  screenshot: {
    description: '对当前页面截图保存，返回图片路径',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (!page) return { error: 'no page open; call browse first' };
      return { url: page.url(), screenshot: await shot() };
    },
  },
  click_text: {
    description: '点击页面上包含给定文本的第一个可点元素（按钮/链接等），等待后返回可见文本和截图。',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: '要匹配的可见文本' } }, required: ['text'], additionalProperties: false },
    async run(args) {
      const p = await ensurePage();
      const loc = p.getByText(args.text, { exact: false }).first();
      await loc.click({ timeout: 15000 });
      await settle(2500);
      return { url: p.url(), text: (await p.evaluate(() => document.body.innerText)).slice(0, 3000), screenshot: await shot() };
    },
  },
  fill_and_submit: {
    description: '在最后一个文本框/文本域/可编辑区域输入文本并回车提交（聊天输入框）。',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    async run(args) {
      const p = await ensurePage();
      const input = p.locator('textarea, input[type="text"], [contenteditable="true"]').last();
      await input.click({ timeout: 10000 });
      await input.fill(args.value);
      await p.keyboard.press('Enter');
      await settle(2500);
      return { url: p.url(), text: (await p.evaluate(() => document.body.innerText)).slice(0, 3000), screenshot: await shot() };
    },
  },
  press_key: {
    description: '按下一个键盘键，如 Enter、Escape、ArrowDown。',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
    async run(args) {
      const p = await ensurePage();
      await p.keyboard.press(args.key);
      await settle(1200);
      return { url: p.url(), screenshot: await shot() };
    },
  },
  click: {
    description: '点击页面上匹配 CSS 选择器的第一个元素（精确控制，用于图标按钮等无文本元素）。',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'], additionalProperties: false },
    async run(args) {
      const p = await ensurePage();
      await p.locator(args.selector).first().click({ timeout: 10000 });
      await settle(2000);
      return { url: p.url(), text: (await p.evaluate(() => document.body.innerText)).slice(0, 3000), screenshot: await shot() };
    },
  },
  fill_field: {
    description: '按 CSS 选择器往指定输入框填入文本（不提交）。用于登录时逐格填写。',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'], additionalProperties: false },
    async run(args) {
      const p = await ensurePage();
      await p.locator(args.selector).first().fill(args.value, { timeout: 10000 });
      return { url: p.url(), ok: true };
    },
  },
  // 2026-09-24 增：极验点选这类「要真鼠标」的场景——`click` 只能点元素中心，
  // 而验证码目标画在图里没有 DOM；用页面里 dispatchEvent 造的事件客户端能过、**服务端过不去**
  // （极验把鼠标轨迹加密上报，服务端校验轨迹，合成事件没有轨迹）。本工具走 Playwright 的
  // CDP 鼠标：分步移动 + 按下/抬起，带随机微延迟，事件 isTrusted=true。
  click_at: {
    description: '按页面坐标点击（真实 CDP 鼠标：先分步移动再按下/抬起，可选步数与抖动）。画在图片/canvas 里的目标（如点选验证码）用它。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '视口坐标 X（CSS px）' },
        y: { type: 'number', description: '视口坐标 Y（CSS px）' },
        steps: { type: 'number', description: '移动插值步数，默认 14（越大越像人，1 = 直接跳）' },
        jitter: { type: 'number', description: '落点随机抖动半径 px，默认 2' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    async run(args) {
      const p = await ensurePage();
      const steps = Number.isFinite(args.steps) && args.steps > 0 ? Math.min(60, Math.floor(args.steps)) : 14;
      const jitter = Number.isFinite(args.jitter) ? Math.max(0, Math.min(8, args.jitter)) : 2;
      const jx = args.x + (Math.random() * 2 - 1) * jitter;
      const jy = args.y + (Math.random() * 2 - 1) * jitter;
      await p.mouse.move(jx, jy, { steps });
      await settle(90 + Math.floor(Math.random() * 160));
      await p.mouse.down();
      await settle(35 + Math.floor(Math.random() * 55));
      await p.mouse.up();
      await settle(150 + Math.floor(Math.random() * 120));
      return { clicked: [Math.round(jx), Math.round(jy)], steps, jitter };
    },
  },
  eval_js: {
    description: '在页面上下文中执行 JavaScript 并返回结果（支持 async/await 与 fetch；对象自动 JSON 序列化）。',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
    async run(args) {
      const p = await ensurePage();
      const out = await p.evaluate(async (code) => {
        const r = await eval(code);
        return typeof r === 'string' ? r : JSON.stringify(r);
      }, args.code);
      return { url: p.url(), result: out };
    },
  },
  dl: {
    description: '通过 Node 直接下载任意 URL（二进制也支持）到工作区指定路径，返回文件大小。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, path: { type: 'string' } }, required: ['url', 'path'], additionalProperties: false },
    async run(args) {
      const resp = await fetch(args.url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
      const buf = Buffer.from(await resp.arrayBuffer());
      const abs = path.resolve(args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      return { ok: true, status: resp.status, file: abs, bytes: buf.length, contentType: resp.headers.get('content-type') };
    },
  },
  http_get: {
    description: '通过 Node 直接发起 HTTP GET（可带 headers/查询串），返回状态码与响应文本（用于调 JSON 接口）。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'string' }, method: { type: 'string' } }, required: ['url'], additionalProperties: false },
    async run(args) {
      const resp = await fetch(args.url, { method: args.method ?? 'GET', headers: args.headers ?? {}, body: args.body, signal: AbortSignal.timeout(60000) });
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, url: resp.url, body: text.slice(0, 200000) };
    },
  },
  set_headful: {
    description: '切换浏览器为可见窗口模式（true，用户可实时监控操作）或无头模式（false）。下一次 browser 调用生效。登录态保存在持久化 profile 里，切换不会掉登录。',
    inputSchema: { type: 'object', properties: { headful: { type: 'boolean' } }, required: ['headful'], additionalProperties: false },
    async run(args) {
      headful = !!args.headful;
      await relaunch();
      return { mode: headful ? 'headful (visible window)' : 'headless (invisible)', note: 'next browser call opens the new mode' };
    },
  },
  set_window: {
    description: '调整可见浏览器窗口的大小与位置（宽/高/左上角坐标）。调用后重启浏览器，登录态不受影响。',
    inputSchema: { type: 'object', properties: { width: { type: 'number', description: '窗口宽（px，如 1280）' }, height: { type: 'number', description: '窗口高（px，如 800）' }, x: { type: 'number', description: '左上角 X（可选，默认 40）' }, y: { type: 'number', description: '左上角 Y（可选，默认 40）' } }, additionalProperties: false },
    async run(args) {
      if (args.width) winW = Math.max(400, Math.floor(args.width));
      if (args.height) winH = Math.max(300, Math.floor(args.height));
      winX = Math.max(0, Math.floor(args.x ?? winX));
      winY = Math.max(0, Math.floor(args.y ?? winY));
      if (headful) await relaunch(); // 重开使尺寸生效
      return { window: `${winW}×${winH} at (${winX},${winY})`, note: '生效于下一次 browser 调用（headful 模式）' };
    },
  },
  login_sites: {
    description: '列出本地凭据库里已配置的站点（站点 key / 登录地址 / 是否已存账号密码 / 填表选择器是否齐备）。只报"有没有"，绝不返回账号密码本身。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const v = readVault();
      const sites = Object.entries(v).map(([k, s]) => publicSite(k, s || {}));
      return {
        vault_file: VAULT_FILE,
        exists: fs.existsSync(VAULT_FILE),
        count: sites.length,
        sites,
        hint: '库里没有想要站点时，用 CLI 写：node mcp-browser/vault.mjs set <key> --url <登录页> --user <账号>（密码隐藏输入）',
      };
    },
  },
  autologin: {
    description: '用本地凭据库自动登录：打开该站登录页 → 按库里选择器填账号密码 → 提交。账号密码全程由服务器自己读写，不会出现在返回值、截图说明或日志里。验证码/人机校验过不去的，会返回页面状态，由主人在可见窗口手动完成。',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: '凭据库里的站点 key（先用 login_sites 查看）' },
        code: { type: 'string', description: '短信/邮箱验证码（可选；仅当站点 mode=phone 时需要）' },
        submit: { type: 'boolean', description: '是否点击提交（默认 true；仅想填好留给人手动提交时传 false）' },
      },
      required: ['site'],
      additionalProperties: false,
    },
    async run(args) {
      const v = readVault();
      const s = v[args.site];
      if (!s) throw new Error(`凭据库里没有站点 "${args.site}"；先调 login_sites 看已配置的 key`);
      if (!s.login_url) throw new Error(`站点 "${args.site}" 缺 login_url`);

      const sel = s.selectors || {};
      const p = await ensurePage();
      await goto(p, s.login_url);
      await settle(2500);

      const filled = [];
      const mode = s.mode || (sel.pass ? 'password' : 'phone');

      if (sel.user && s.username) { await p.locator(sel.user).first().fill(String(s.username), { timeout: 10000 }); filled.push('user'); }

      if (mode === 'phone') {
        if (sel.send_code && s.username && args.code === undefined) {
          await p.locator(sel.send_code).first().click({ timeout: 10000 });
          await settle(1500);
        }
        if (args.code && sel.code) { await p.locator(sel.code).first().fill(String(args.code), { timeout: 10000 }); filled.push('code'); }
      } else if (sel.pass && s.password) {
        await p.locator(sel.pass).first().fill(String(s.password), { timeout: 10000 });
        filled.push('pass');
      }

      let submitted = false;
      const canSubmit = (mode === 'password') || (mode === 'phone' && args.code);
      if (sel.submit && canSubmit && args.submit !== false) {
        await p.locator(sel.submit).first().click({ timeout: 10000 });
        submitted = true;
        await settle(4000);
      } else {
        await settle(800);
      }

      const title = await p.title();
      const text = (await p.evaluate(() => document.body.innerText)).slice(0, 1500);
      return {
        site: args.site,
        mode,
        filled,
        submitted,
        url: p.url(),
        title,
        text,
        screenshot: await shot(),
        note: submitted
          ? '已提交。若页面停在人机校验/扫码/二次验证，请在可见窗口里手动完成——登录态会存进持久化 profile。'
          : '已按库中配置填写，未提交。',
      };
    },
  },
  clear_profile: {
    description: '清空持久化 browser profile（等于退出所有站点登录）。慎用：只能由主人明确要求时调用。',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'], additionalProperties: false },
    async run(args) {
      if (args.confirm !== true) throw new Error('需要 confirm: true');
      await relaunch();
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      return { ok: true, cleared: PROFILE_DIR };
    },
  },
};

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }], isError: false };
}
function errResult(msg) {
  return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'browser', version: '1.1.0' } },
    }) + '\n');
  } else if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
    // 无响应
  } else if (msg.method === 'ping') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) },
    }) + '\n');
  } else if (msg.method === 'tools/call') {
    const { name, arguments: raw } = msg.params ?? {};
    const tool = tools[name];
    try {
      if (!tool) throw new Error(`unknown tool: ${name}`);
      const out = await tool.run(raw ?? {});
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: textResult(out) }) + '\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: errResult(e.message) }) + '\n');
    }
  }
});
rl.on('close', async () => {
  try { if (context) await context.close(); } catch {}
  process.exit(0);
});
