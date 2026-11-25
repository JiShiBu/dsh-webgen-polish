/**
 * 网页润色流水线 · Host 半
 *
 * 解决的问题：把一章切成 N 段，逐段发到「固定的网页版 DeepSeek 会话」，
 * 逐段等回稿、落盘，再发下一段。整条循环跑在 Host 进程里，**不受 shell 超时限制**。
 *
 * 与旧 ask.mjs 的关键差别（旧脚本会"假卡死"）：
 * 1. 完成判定不再只认「消息条数增加」——条数不变但文本变了也算开始，
 *    否则网页版复用节点时会一直等到超时。
 * 2. 每 1.5 秒把「已收到多少字、已等多少秒」回报给界面，看得见就不像卡住。
 * 3. 超时也把已收到的内容落盘（标 unfinished），不白等。
 * 4. 单条硬超时默认 900 秒（旧脚本 300 秒，1200 字改稿常常不够）。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { auditPart, properNamesOf, renderAudit } from './checks.js'

const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DEFAULT_PROFILE = join(homedir(), '.dsh', 'webgen-profile')

/* 默认不绑定任何私有会话：根地址＝用当前标签页的会话（见 sessionMode 说明） */
const DEFAULT_CHAT = 'https://chat.deepseek.com/'
const DEFAULT_OUT = join(homedir(), 'webgen-output')
const DEFAULT_TEMPLATE = `这是一本修真小说的正文（全章切 {{total}} 段，这是第 {{part}} 段）。
请你润色——让它读起来有修真感。
放开改：句子可以重写，句子长短随你，可以加东西、加细节、加器物、加动作。唯一要守的：情节不变、人物不换、事件不删、别自己造新的设定或人物。写完把这一段完整给我。段首空四格。

注意：这是同一章的第 {{part}} 段（全章 {{total}} 段），前面几段的正文已经在这个对话里，你可以往上翻看到。你写的这一段，不许重复前面已经写过的场面、动作、句子——前文写过的（谁推盾、谁射箭、谁被虫围住），这一段要么跳过、要么换个角度、要么往前推进，不要从头再写一遍。

原文里带《》的功法名（如《锻骨功》《土木相济功》《青焰焚天诀》），一律原样保留，不许删、不许换、不许合并；它们所在的那一段情节也不许删掉。

{{text}}`

/** 整段发（不切段）用的模板：不提「第 N 段」，免得模型自己找前文 */
const SINGLE_TEMPLATE = `这是一本修真小说的一场完整正文，一次给你，不用分段。\n请你润色——让它读起来有修真感。\n放开改：句子可以重写，句子长短随你，可以加东西、加细节、加器物、加动作。唯一要守的：情节不变、人物不换、事件不删、别自己造新的设定或人物。写完把这一场完整给我，不要分条、不要解释、不要总结。段首空四格。\n\n原文里带《》的功法名（如《锻骨功》《土木相济功》《青焰焚天诀》），一律原样保留，不许删、不许换、不许合并；它们所在的那一段情节也不许删掉。\n\n{{text}}`

const PROBE = `(() => {
  // ⚠ 每条回复其实是两个节点：'ds-markdown'（深度思考的分析块）+ 'ds-markdown ds-assistant-message-main-content'（正文）。
  // 只认正文那个，否则会读成思考块，或者一直等条数变化。
  const mains = [...document.querySelectorAll('.ds-assistant-message-main-content')];
  const all = [...document.querySelectorAll('.ds-markdown')];
  const lastMain = mains.length ? (mains[mains.length - 1].innerText || '').trim() : '';
  const ed = document.querySelector('textarea, [contenteditable="true"], #chat-input');
  return {
    href: location.href,
    mains: mains.length,
    nodes: all.length,
    text: lastMain,
    hasEditable: !!ed,
    signedOut: location.href.includes('sign_in'),
  };
})()`

const DEFAULT_GEMINI = 'https://gemini.google.com/app'

/**
 * Gemini 页面的探针。
 * 为什么不能复用 DeepSeek 那支：两站结构完全不同——回复在 <message-content> 里，
 * 输入框是 Quill 的 contenteditable，流式生成时会出现「停止」按钮。
 * signedOut 单独判：未登录时页面只有登录入口，没有输入框。
 */
const PROBE_GEMINI = `(() => {
  const models = [...document.querySelectorAll('message-content')];
  /* 不要在这里写 \n —— 模板字符串会把它变成真换行，页面拿到的是语法错误 */
  const last = models.length ? (models[models.length - 1].textContent || '').trim() : '';
  const ed = document.querySelector('.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"], textarea');
  const stop = document.querySelector('button[aria-label*="停止"], button[aria-label*="Stop"]');
  const signedOut = /accounts\\.google\\.com/.test(location.href) || (!!document.querySelector('a[href*="accounts.google.com"]') && !ed);
  return {
    href: location.href,
    mains: models.length,
    nodes: models.length,
    count: models.length,
    text: last,
    hasEditable: !!ed,
    streaming: !!stop,
    vis: document.visibilityState,
    signedOut,
  };
})()`

/** 每个站一支探针；job.options.backend 决定用哪支。 */
const PROBES = { deepseek: PROBE, gemini: PROBE_GEMINI }


/** 最近一次 Gemini 填字的诊断（失败时写进任务日志，便于排查） */
let fillDebug = ''

const EDITOR_LENGTH = `(() => {
  const ed = document.querySelector('textarea, [contenteditable="true"], #chat-input');
  return ed ? (ed.value || ed.innerText || '').length : -1;
})()`

/** Gemini 的输入框长度（Quill 的 .ql-editor，不能拿别的 contenteditable 凑） */
const EDITOR_LENGTH_GEMINI = `(() => {
  const ed = document.querySelector('rich-textarea .ql-editor[contenteditable="true"], .ql-editor[contenteditable="true"]');
  if (!ed) return -1;
  /* textContent：后台窗口里 innerText 取不到字，会把「已填好」误判成空 */
  return (ed.textContent || '').length;
})()`

const EDITOR_LENGTHS = { deepseek: EDITOR_LENGTH, gemini: EDITOR_LENGTH_GEMINI }

/* ------------------------------------------------------------------ 站点注册表
 *
 * 为什么要注册表：以后可能加 GPT / Claude 之类的网页端。
 * 站点差异只有四样东西——「找哪个标签」「回复在哪个选择器里」「怎么填字」「怎么发」。
 * 这四样抽成表，加站点就是加一条配置，不用再动流程代码。
 *
 * 自定义站点（config.sites 或 /run 的 sites）只要给：
 *   { label, match, url, selectors: { reply, editor, stop }, extract, fill, send }
 * 其中 fill: 'execCommand' | 'paste'，send: 'button' | 'enter'。
 */
const SITES = {
  deepseek: {
    label: 'DeepSeek 网页版',
    match: 'chat.deepseek.com',
    configKey: 'chatUrl',
    fallbackUrl: 'https://chat.deepseek.com/',
    probe: PROBE,
    editorLength: EDITOR_LENGTH,
    fill: 'execCommand',
    send: 'button',
    /* 这些 pathname 是「新会话入口」，不是具体会话 —— 别拿它们当固定会话导航 */
    newChatPaths: ['/', '/a/chat'],
  },
  gemini: {
    label: 'Gemini',
    match: 'gemini.google.com',
    configKey: 'geminiUrl',
    fallbackUrl: 'https://gemini.google.com/app',
    probe: PROBE_GEMINI,
    editorLength: EDITOR_LENGTH_GEMINI,
    fill: 'paste',
    send: 'enter',
    /* /app 是 Gemini 的新会话入口，导航过去＝每次开新会话 */
    newChatPaths: ['/', '/app'],
  },
  /* Venice：作者指定用来润「限制版场景」，默认**整段不切**（single:true） */
  venice: {
    label: 'Venice.ai（限制版场景）',
    match: 'venice.ai',
    configKey: 'veniceUrl',
    fallbackUrl: 'https://venice.ai/chat/agent',
    selectors: { reply: '.assistant-content', editor: 'textarea.chakra-textarea', stop: '' },
    fill: 'execCommand',
    send: 'button',
    single: true,
    newChatPaths: ['/chat/agent', '/chat/classic'],
    /* 它的回复前面会带一行运行状态（如「已运行 < 1s · 1 步」），要剥掉 */
    stripPatterns: ['^已运行[^\n]{0,60}?步\s*'],
  },
}

/**
 * 给「只给选择器」的站点现造一支探针。
 * 注意：这里不写任何反斜杠转义 —— 模板字符串会把 \n 变成真换行，页面侧直接语法错误。
 */
function makeGenericProbe(selectors = {}) {
  const reply = JSON.stringify(selectors.reply || '')
  const editor = JSON.stringify(selectors.editor || 'textarea, [contenteditable="true"]')
  /* stop 要用「原始值」判空：JSON.stringify 之后空串会变成两个引号，truthy，
     就会生成 querySelector("") —— 页面侧直接 SyntaxError（这次就是它把页面刷来刷去） */
  const stopRaw = selectors.stop || ''
  const stopExpr = stopRaw ? 'document.querySelector(' + JSON.stringify(stopRaw) + ')' : 'null'
  const extract = selectors.extract === 'innerText' ? 'innerText' : 'textContent'
  return `(() => {
    const nodes = [...document.querySelectorAll(${reply})];
    const last = nodes.length ? (nodes[nodes.length - 1].${extract} || '').trim() : '';
    const ed = document.querySelector(${editor});
    const stopEl = ${stopExpr};
    const href = location.href;
    return {
      href,
      mains: nodes.length,
      nodes: nodes.length,
      count: nodes.length,
      text: last,
      hasEditable: !!ed,
      streaming: !!stopEl,
      vis: document.visibilityState,
      signedOut: href.indexOf('sign_in') >= 0 || href.indexOf('accounts.google.com') >= 0,
    };
  })()`
}

function makeGenericEditorLength(selectors = {}) {
  const editor = JSON.stringify(selectors.editor || 'textarea, [contenteditable="true"]')
  return `(() => {
    const ed = document.querySelector(${editor});
    if (!ed) return -1;
    return (ed.textContent || '').length;
  })()`
}

/** 把内置站点与配置里的自定义站点合成一张表（每次调用都是干净的副本）。 */
function buildSiteTable(config) {
  const table = {}
  for (const [key, site] of Object.entries(SITES)) {
    table[key] = { ...site }
    if (!table[key].probe && site.selectors) {
      table[key].probe = makeGenericProbe(site.selectors)
      table[key].editorLength = makeGenericEditorLength(site.selectors)
    }
  }
  const extra = config && config.sites && typeof config.sites === 'object' ? config.sites : {}
  for (const [key, raw] of Object.entries(extra)) {
    if (!raw || typeof raw !== 'object') continue
    const selectors = raw.selectors && typeof raw.selectors === 'object' ? raw.selectors : {}
    table[key] = {
      label: String(raw.label || key),
      match: String(raw.match || ''),
      url: String(raw.url || ''),
      configKey: String(raw.configKey || ''),
      fallbackUrl: String(raw.url || ''),
      probe: makeGenericProbe(selectors),
      editorLength: makeGenericEditorLength(selectors),
      fill: raw.fill === 'paste' ? 'paste' : 'execCommand',
      send: raw.send === 'enter' ? 'enter' : 'button',
      custom: true,
    }
  }
  return table
}


/** 当前生效的站点表（apply 时按配置合成）；直接取用请走 siteOf()。 */
let SITE_TABLE = {}

/** 取站点配置；名字不认识就退回 deepseek（老调用方只传 backend，不能因此崩）。 */
function siteOf(name) {
  return SITE_TABLE[name] || SITE_TABLE.deepseek || SITES.deepseek
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function cdpUp(port) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(2500) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 浏览器没跑就自己拉起来。
 * 为什么必须有：这个 Chrome 常被上一轮 shell 连坐杀掉（父进程一退就被带走），
 * 用户再点开始时如果只报「fetch failed」，等于每章都要人工去跑 launch.mjs。
 */
async function ensureChrome(port, config, log) {
  if (await cdpUp(port)) return true
  const chrome = String(config?.chromePath || DEFAULT_CHROME)
  const profile = String(config?.profileDir || DEFAULT_PROFILE)
  const startUrl = String(config?.startUrl || 'https://chat.deepseek.com/')
  log?.('浏览器没在跑，正在拉起（已登录的配置目录会复用）…')
  try {
    const child = spawn(
      chrome,
      [
        '--user-data-dir=' + profile,
        '--remote-debugging-port=' + port,
        '--profile-directory=Default',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        '--window-size=1280,900',
        startUrl,
      ],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
  } catch (error) {
    log?.('拉起浏览器失败：' + String(error?.message ?? error))
    return false
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500)
    if (await cdpUp(port)) return true
  }
  log?.('20 秒内没等到调试端口，请手动打开一次自动化 Chrome')
  return false
}

/* ------------------------------------------------------------------ CDP */

async function listTargets(port) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('/json/list -> ' + response.status)
  return response.json()
}

async function ensureSiteTab(port, site) {
  const targets = await listTargets(port)
  const pages = targets.filter((target) => target.type === 'page' && /^https?:/.test(target.url || ''))
  const hit = site.match ? pages.find((target) => (target.url || '').includes(site.match)) : pages[0]
  if (hit) return hit
  /* 这个站点还没标签页：新开一个（两个后端并行时各占一个，互不打扰） */
  try {
    const url = site.fallbackUrl || site.url || 'about:blank'
    const created = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
    if (created.ok) {
      const target = await created.json()
      await sleep(1500)
      return target
    }
  } catch {
    /* 新开失败就退回第一个页面 */
  }
  return pages[0] || null
}

async function cdpConnect(port, selector) {
  const targets = await listTargets(port)
  const pages = targets.filter((target) => target.type === 'page' && /^https?:/.test(target.url || ''))
  const page = selector
    ? pages.find((target) => (typeof selector === 'function' ? selector(target.url || '') : selector.test(target.url || '')))
    : pages[0]
  if (!page) throw new Error('没有可用的页面标签（Chrome 是否带 --remote-debugging-port 启动？）')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, bad) => {
    socket.onopen = () => ok()
    socket.onerror = () => bad(new Error('WebSocket 连接失败'))
    setTimeout(() => bad(new Error('WebSocket 连接超时')), 8000)
  })
  let counter = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    }
  }
  const send = (method, params = {}) =>
    new Promise((ok, bad) => {
      const id = ++counter
      pending.set(id, { resolve: ok, reject: bad })
      socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          bad(new Error('CDP 超时: ' + method))
        }
      }, 30000)
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(String(result.exceptionDetails.text || '') + ' ' + String(result.exceptionDetails.exception?.description || ''))
    }
    return result.result.value
  }
  return { send, evaluate, close: () => socket.close() }
}

/* ------------------------------------------------------------------ 发送 */

async function pressEnter(cdp, site) {
  /* Quill 类富文本要收到 char 事件才算输入；DeepSeek 那边 keyDown 带 \r 就够 */
  const types = site && site.fill === 'paste' ? ['rawKeyDown', 'keyDown', 'char', 'keyUp'] : ['rawKeyDown', 'keyDown', 'keyUp'];
  for (const type of types) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: type === 'keyDown' || type === 'char' ? '\r' : undefined,
    })
    await sleep(150)
  }
}

/**
 * Gemini 专用填字。
 *
 * 为什么不能直接用 execCommand：Gemini 的输入框是 Quill 托管的 DIV.ql-editor，
 * execCommand('insertText') 只改了 DOM，Quill 内部状态还是空的 ——「眼中有字、发送按钮不出来」，
 * 实测就是卡在这里。可靠路径是：先真实点一下输入框，再用 CDP 的 Input.insertText（受信任输入事件）。
 */
async function fillGemini(cdp, text) {
  const focus = async () => {
    const box = await cdp
      .evaluate(`(() => {
        const ed = document.querySelector('rich-textarea .ql-editor[contenteditable="true"], .ql-editor[contenteditable="true"]');
        if (!ed) return null;
        ed.focus();
        const r = ed.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`)
      .catch(() => null)
    if (!box) return false
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }).catch(() => {})
    }
    await sleep(260)
    return true
  }

  /* 清空：Ctrl+A 再 Backspace/Delete。上一轮留字时直接插会叠在一起。
     返回剩余长度 —— 清不干净就绝不能往下填，否则粘贴+重填会叠成两遍
     （作者 2026-11-25 报的「提示词重复两遍」就是这个：Ctrl+A 失败后逐段重填追加了整份）。 */
  const clear = async () => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }).catch(() => {})
    }
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }).catch(() => {})
    }
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 }).catch(() => {})
    }
    await sleep(300)
    let left = await cdp.evaluate(EDITOR_LENGTH_GEMINI).catch(() => 0)
    if (left > 5) {
      await cdp
        .evaluate(`(() => {
          const ed = document.querySelector('rich-textarea .ql-editor[contenteditable="true"], .ql-editor[contenteditable="true"]');
          if (!ed) return false;
          ed.focus();
          document.execCommand('selectAll');
          document.execCommand('delete');
          ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          return true;
        })()`)
        .catch(() => false)
      await sleep(400)
      left = await cdp.evaluate(EDITOR_LENGTH_GEMINI).catch(() => 0)
    }
    return left
  }

  /* 兜底：逐段 Input.insertText + Shift+Enter（不碰系统剪贴板，所以不会因剪贴板/焦点失败整份重来）。
     每段插完看长度有没有涨，没涨就补插一次 —— 逐段可控，是替代「清空重贴」的兜底路径。 */
  const typeByParagraph = async () => {
    const paragraphs = String(text).split(/\n+/)
    let before = await cdp.evaluate(EDITOR_LENGTH_GEMINI).catch(() => 0)
    for (let index = 0; index < paragraphs.length; index += 1) {
      const piece = paragraphs[index]
      await cdp.send('Input.insertText', { text: piece }).catch(() => {})
      await sleep(120)
      let after = await cdp.evaluate(EDITOR_LENGTH_GEMINI).catch(() => 0)
      if (after <= before) {
        await cdp.send('Input.insertText', { text: piece }).catch(() => {})
        await sleep(180)
        after = await cdp.evaluate(EDITOR_LENGTH_GEMINI).catch(() => 0)
      }
      before = after
      if (index < paragraphs.length - 1) {
        /* Shift+Enter 才是「换行」；裸 Enter 在 Gemini 是「发送」，打一半就发出去了 */
        for (const type of ['rawKeyDown', 'keyUp']) {
          await cdp
            .send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 })
            .catch(() => {})
          await sleep(80)
        }
      }
    }
  }

  await cdp.send('Page.bringToFront').catch(() => {})
  await sleep(200)
  if (!(await focus())) return -1
  const leftBefore = await clear()
  /* 清不干净就停手：再填一次就会变成「两遍」 */
  if (leftBefore > 5) {
    fillDebug = '清空失败，输入框还剩 ' + leftBefore + ' 字（不敢再填，避免整份叠两遍）'
    return -1
  }

  /* 首选：真剪贴板 + 真 Ctrl+V。多段落（带空行）只有这条路 Quill 才收得稳。 */
  await cdp
    .send('Browser.grantPermissions', { origin: 'https://gemini.google.com', permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
    .catch(() => {})
  const wrote = await cdp
    .evaluate(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true).catch((error) => 'err:' + error.message)`)
    .catch((error) => 'ex:' + error.message)
  if (wrote) {
    for (const type of ['rawKeyDown', 'keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 }).catch(() => {})
      await sleep(120)
    }
    await sleep(1100)
  }

  let length = await cdp.evaluate(EDITOR_LENGTH_GEMINI).catch(() => -1)
  fillDebug = '剪贴板=' + String(wrote).slice(0, 48) + ' 长度=' + length + ' 期望=' + String(text).length

  /* 校验：输入框里必须是完整的那份（首尾都要对得上）。
     长度异常或首尾不对，宁可报错也不自动重填 —— 重填没清干净就会把整份发两遍。 */
  const readEditor = async () =>
    cdp
      .evaluate(`(() => {
        const ed = document.querySelector('rich-textarea .ql-editor[contenteditable="true"], .ql-editor[contenteditable="true"]');
        return ed ? (ed.innerText || ed.textContent || '') : '';
      })()`)
      .catch(() => '')
  const head = String(text).slice(0, 24).trim()
  const tail = String(text).slice(-24).trim()
  const looksWhole = async () => {
    const content = String(await readEditor()).replace(/\s+/g, '')
    if (!content) return false
    return (!head || content.includes(head.replace(/\s+/g, ''))) && (!tail || content.includes(tail.replace(/\s+/g, '')))
  }

  if (length < String(text).length * 0.5 || !(await looksWhole())) {
    /* 重填前必须确认是空的：上一次就是 Ctrl+A 失败、这里直接逐段追加，整份变成两遍 */
    const leftNow = await clear()
    if (leftNow > 5) {
      fillDebug += ' →清空失败剩 ' + leftNow + ' 字，放弃重填'
      return -1
    }
    await typeByParagraph()
    await sleep(700)
    length = await cdp.evaluate(EDITOR_LENGTH_GEMINI).catch(() => -1)
    fillDebug += ' →逐段重填=' + length
    if (!(await looksWhole())) {
      fillDebug += ' →重填后首尾仍不匹配，放弃发送'
      return -1
    }
  }
  return length
}

/**
 * 把文本填进输入框。
 * 先走 execCommand('insertText')：它触发的是浏览器原生输入事件，React 的受控组件收得到；
 * Input.insertText 有时只改了 DOM 没进 React state —— 那人眼看有字、点发送却是空的（本次踩到过）。
 */
async function fillEditor(cdp, text, site) {
  if (site && site.fill === 'paste') return fillGemini(cdp, text)
  await cdp
    .evaluate(`(() => {
      const ed = document.querySelector('textarea, [contenteditable="true"], #chat-input');
      if (!ed) return false;
      ed.focus();
      return true;
    })()`)
    .catch(() => false)
  await sleep(250)

  await cdp
    .evaluate(`(() => {
      const ed = document.querySelector('textarea, [contenteditable="true"], #chat-input');
      if (!ed) return false;
      ed.focus();
      try { return document.execCommand('insertText', false, ${JSON.stringify(text)}); } catch (error) { return false; }
    })()`)
    .catch(() => false)
  await sleep(600)

  let length = await cdp.evaluate(EDITOR_LENGTH).catch(() => -1)
  if (length <= 0) {
    await cdp.send('Input.insertText', { text }).catch(() => {})
    await sleep(700)
    await cdp
      .evaluate(`(() => {
        const ed = document.querySelector('textarea, [contenteditable="true"]');
        if (!ed) return false;
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        ed.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
      .catch(() => false)
    await sleep(400)
    length = await cdp.evaluate(EDITOR_LENGTH).catch(() => -1)
  }
  return length
}

async function clickSend(cdp) {
  /* 等到「发送」按钮真的可用（Gemini 的 Material 按钮有 disabled 态，disabled 时点它等于没点），
     然后用真实鼠标点它的中心 —— .click() 在 mdc 按钮上偶尔不触发提交。 */
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await cdp
      .evaluate(`(() => {
        const byButton = [...document.querySelectorAll('button[aria-label]')]
          .find((el) => /发送|send/i.test(el.getAttribute('aria-label') || ''));
        if (!byButton) return { ready: false };
        const r = byButton.getBoundingClientRect();
        return {
          ready: true,
          disabled: byButton.disabled === true || byButton.getAttribute('aria-disabled') === 'true',
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        };
      })()`)
      .catch(() => null)
    if (state && state.ready && !state.disabled) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: state.x, y: state.y, button: 'left', clickCount: 1 }).catch(() => {})
      }
      await sleep(300)
      /* 再补一次 DOM click：有些版本 mdc 按钮要 click 事件才提交 */
      await cdp
        .evaluate(`(() => {
          const b = [...document.querySelectorAll('button[aria-label]')]
            .find((el) => /发送|send/i.test(el.getAttribute('aria-label') || ''));
          if (!b) return false;
          b.click();
          return true;
        })()`)
        .catch(() => false)
      return 'mouse+click'
    }
    await sleep(500)
  }
  /* 没找到按钮：退回 DeepSeek 的老路（点最后一个带图标的按钮） */
  return cdp
    .evaluate(`(() => {
      const buttons = [...document.querySelectorAll('[role="button"], button, .ds-icon-button, .ds-button')]
        .filter((el) => el.querySelector('svg') && !/停止|stop/i.test(el.innerText || ''));
      const el = buttons[buttons.length - 1];
      if (!el) return 'NO_BUTTON';
      el.click();
      return 'clicked';
    })()`)
    .catch(() => 'NO_BUTTON')
}

/**
 * 发送并**验证真的发出去了**：
 * 判据是「正文节点数增加」或「最后一条正文内容变了」——这只能由新回复产生。
 * 15 秒内没有任何变化就按一次回车重试，仍未发出则报错，绝不"假成功"。
 */
/** 发送前硬校验：编辑器里的内容必须就是这一份（开头、结尾、长度、段落数）。
 *  任何一项不过就不发 —— 宁可这一段报错，也不发两遍。 */
async function inspectEditor(cdp, text) {
  const content = await cdp
    .evaluate(`(() => {
      const ed = document.querySelector('rich-textarea .ql-editor[contenteditable="true"], .ql-editor[contenteditable="true"]');
      return ed ? (ed.innerText || ed.textContent || '') : '';
    })()`)
    .catch(() => '')
  const norm = (value) => String(value || '').replace(/\s+/g, '')
  const got = norm(content)
  const want = norm(text)
  const head = norm(String(text).slice(0, 30))
  const tail = norm(String(text).slice(-30))
  const wantParas = String(text).split('\n').filter((line) => line.trim() !== '').length
  const gotParas = String(content).split('\n').filter((line) => line.trim() !== '').length
  const reasons = []
  if (!got) reasons.push('编辑器是空的')
  if (head && !got.includes(head)) reasons.push('开头对不上')
  if (tail && !got.includes(tail)) reasons.push('结尾对不上')
  if (want.length > 0 && got.length > want.length * 1.4) {
    reasons.push('长度多出 ' + Math.round((got.length / want.length - 1) * 100) + '%（疑似叠了两遍）')
  }
  if (wantParas > 1 && gotParas + 2 < wantParas) reasons.push('段落数少了（期望 ' + wantParas + '，实际 ' + gotParas + '）')
  return { ok: reasons.length === 0, reason: reasons.join('；'), gotLen: got.length, wantLen: want.length, wantParas, gotParas }
}

async function sendPrompt(cdp, text, before, probeScript, site) {
  const typed = await fillEditor(cdp, text, site)
  if (typed <= 0) throw new Error('文字没能填进输入框' + (fillDebug ? '（' + fillDebug + '）' : '（页面可能还在加载）') + '，本条未发送')

  /* 硬校验：三项全过才允许发送（作者 2026-11-25 定的规矩） */
  const check = await inspectEditor(cdp, text)
  if (!check.ok) {
    throw new Error('填进去的内容不对，本条中止（' + check.reason + '；长度 ' + check.gotLen + '/' + check.wantLen + '，段落 ' + check.gotParas + '/' + check.wantParas + '）')
  }

  const editorLength = async () => cdp.evaluate((site && site.editorLength) || EDITOR_LENGTH).catch(() => -1)

  /* 三种「已经发出去了」的判据，任一成立即算成功：
     ① 输入框被清空（这一条最硬，Gemini 发送后输入框立刻空）；
     ② 正文节点数增加或最后一条内容变了；
     ③ 出现「停止回答」（已在生成）。
     只用 ②③ 会误判 —— Gemini 要想几秒才出正文，插件就会以为没发出去再按一次回车，
     结果同一段被发了两遍（本次踩到）。 */
  const settled = async () => {
    const left = await editorLength()
    if (left >= 0 && left <= 6) return ' emptied'
    const snap = await cdp.evaluate(probeScript).catch(() => null)
    if (!snap) return ''
    if (snap.mains > before.mains || (snap.text !== '' && snap.text !== before.text)) return ' replied'
    if (snap.streaming === true) return ' streaming'
    return ''
  }

  if (site && site.send === 'enter') {
    await pressEnter(cdp, site)
    for (let waited = 0; waited < 30000; waited += 1000) {
      await sleep(1000)
      const why = await settled()
      if (why) return 'enter' + why
    }
    /* 只有输入框里还留着正文，才认为真的没发出去，再点一次按钮 */
    const left = await editorLength()
    if (left > 10) {
      const clicked = await clickSend(cdp)
      for (let waited = 0; waited < 20000; waited += 1000) {
        await sleep(1000)
        const why = await settled()
        if (why) return 'button' + why + '（回车没发出去，按钮补发；clicked=' + clicked + '）'
      }
      throw new Error('回车和按钮都没把这条发出去（输入框还剩 ' + left + ' 字；' + fillDebug + '），本条已中止')
    }
    throw new Error('按了回车、输入框也空了，但 30 秒内没看到新回复 —— 可能被限流或页面在等确认，看一眼 Gemini 窗口')
  }

  const clicked = await clickSend(cdp)
  for (let waited = 0; waited < 15000; waited += 1000) {
    await sleep(1000)
    const why = await settled()
    if (why) return (clicked === 'NO_BUTTON' ? 'no-button' : 'button') + why
  }
  await pressEnter(cdp, site)
  for (let waited = 0; waited < 10000; waited += 1000) {
    await sleep(1000)
    const why = await settled()
    if (why) return 'enter-retry' + why
  }

  const left = await editorLength()
  if (left > 0) throw new Error('消息没发出去（输入框还剩 ' + left + ' 字；点发送=' + clicked + '；' + fillDebug + '），本条已中止')
  throw new Error('点了发送但没看到新回复，也没看到输入框清空后的新消息，本条已中止')
}

/* ------------------------------------------------------------------ 切段 */

/** 按空行分段并聚合成 N 份；段数不均是常态，最后一格吃余量。 */
export function splitIntoParts(text, parts) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n')
  const blocks = normalized
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
  if (blocks.length === 0) return []
  const totalChars = blocks.reduce((sum, line) => sum + line.length, 0)
  const target = Math.ceil(totalChars / parts)
  const chunks = []
  let current = []
  let size = 0
  for (const line of blocks) {
    current.push(line)
    size += line.length
    if (size >= target && chunks.length < parts - 1) {
      chunks.push(current.join('\n'))
      current = []
      size = 0
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'))
  while (chunks.length > parts) {
    const last = chunks.pop()
    chunks[chunks.length - 1] += '\n' + last
  }
  return chunks
}

/* ------------------------------------------------------------------ 任务 */

let current = null
/** 在跑/刚跑完的任务：jobId -> job。不同 backend 可并行，同一 backend 串行。 */
const JOBS = new Map()
let healthCache = { at: 0, value: null }

function log(job, message) {
  job.logs.push({ at: Date.now(), message })
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400)
}

export function snapshotJob(job) {
  if (!job) return { ok: true, job: null }
  return {
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      stage: job.stage,
      startedAt: job.startedAt,
      backend: job.options.backend || 'deepseek',
      mergedFile: job.mergedFile || '',
      selftest: job.selftest || null,
      repeatReport: job.repeatReport || '',
      checkReport: job.checkReport || '',
      checks: job.checks || null,
      repeats: job.repeats || null,
      /* 事后核对"这次到底喂了什么"：资料包原文 + 长度 + 是否截断 */
      title: job.options.title || '',
      context: job.options.context || '',
      contextChars: (job.options.context || '').length,
      contextMode: job.options.contextMode || 'prefix',
      contextTruncated: job.options.contextTruncated === true,
      options: { stamp: job.options.stamp, outDir: job.options.outDir, total: job.parts.length },
      /* 这次实际用的是哪个会话（墨卿 #31 要的）：会话策略 + 会话地址 */
      sessionMode: job.sessionMode || '',
      sessionUrl: job.sessionUrl || '',
      parts: job.parts.map((part) => ({
        index: part.index,
        state: part.state,
        chars: part.chars,
        charsGot: part.charsGot,
        elapsed: part.elapsed,
        file: part.file,
        error: part.error,
        preview: part.text.slice(0, 80),
      })),
      logs: job.logs.slice(-60),
    },
  }
}

/** 按站点规则剥掉回复里的界面噪声（如 Venice 的运行状态行）。 */
function cleanOutput(site, text, options = {}) {
  let out = String(text || '')
  for (const pattern of (site && site.stripPatterns) || []) {
    try {
      out = out.replace(new RegExp(pattern, 'gu'), '')
    } catch {
      /* 规则写错不影响出稿 */
    }
  }
  const raw = out.replace(/\r\n/g, '\n')
  /* 段落规范化只在 strictFormat 打开时做（作者默认不要格式，模型怎么写就怎么落盘）；
     打开时按段补齐「段首两个全角空格」，空行结构保留，连续空行压成一个。 */
  const normalized = options.strictFormat === true
    ? raw
        .split('\n')
        .map((line) => {
          const trimmed = line.trim()
          if (trimmed === '') return ''
          if (line.trimStart().startsWith('　　')) return trimmed
          return '　　' + trimmed
        })
        .join('\n')
    : raw
  /* 只压多余空行、削首尾的换行 */
  return normalized.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '')
}

async function waitForReply(cdp, before, part, job) {
  const probeScript = (job.site || siteOf(job.options.backend)).probe
  const deadline = Date.now() + job.options.timeoutSec * 1000
  let last = ''
  let stable = 0
  let latest = ''
  let lastFront = 0
  let diagMains = -1
  let diagLen = -1
  let diagVis = ''
  while (Date.now() < deadline) {
    if (job.cancelled) return { text: latest, cancelled: true }
    await sleep(job.options.pollMs)
    let snap
    try {
      snap = await cdp.evaluate(probeScript)
    } catch (error) {
      log(job, '读取页面失败，继续等：' + String(error.message).slice(0, 80))
      continue
    }
    part.elapsed = Math.round((Date.now() - part.startedAt) / 1000)
    /* 诊断：只在「条数/末尾长度/可见性」变化时记一行，便于定位卡在哪一步 */
    if (snap.mains !== diagMains || String(snap.text || '').length !== diagLen || snap.vis !== diagVis) {
      diagMains = snap.mains
      diagLen = String(snap.text || '').length
      diagVis = snap.vis
      log(job, '诊断：条数 ' + snap.mains + '（发前 ' + before.mains + '）末尾 ' + diagLen + ' 字｜流式 ' + String(snap.streaming) + '｜可见 ' + String(snap.vis) + '｜页 ' + String(snap.href || '').slice(0, 60))
    }
    /* 窗口在后台时页面可能不渲染（DS 的已知坑，Gemini 也可能）——每 10 秒提一次前台 */
    if (snap.vis === 'hidden' && Date.now() - lastFront > 10000) {
      lastFront = Date.now()
      await cdp.send('Page.bringToFront').catch(() => {})
    }
    /* 「回复开始」= 正文节点多了一条，或者最后一条正文内容变了。
       判「开始」只看条数：Gemini 的消息节点先出现、正文隔一两秒才渲染，
       把「正文非空」也算进开始条件，就会一直卡在「等回复开始」。 */
    const hasNewMain = snap.mains > before.mains
    const changed = snap.text !== '' && snap.text !== before.text
    if (!hasNewMain && !changed) {
      job.stage = `第 ${part.index + 1} 段 · 等回复开始（${part.elapsed}s）`
      continue
    }
    if (hasNewMain && snap.text === '') {
      job.stage = `第 ${part.index + 1} 段 · 等正文渲染（${part.elapsed}s）`
      continue
    }
    latest = cleanOutput(job.site, snap.text, job.options)
    part.charsGot = latest.length
    /* Gemini 还在流式生成时（有「停止回答」按钮）不算稳定，否则会把半截当成品 */
    if (snap.streaming) {
      stable = 0
      last = latest
      job.stage = `第 ${part.index + 1} 段 · 收稿中 ${latest.length} 字（${part.elapsed}s）`
      continue
    }
    if (latest === last) stable += 1
    else {
      stable = 0
      last = latest
    }
    job.stage = `第 ${part.index + 1} 段 · 收稿中 ${latest.length} 字（${part.elapsed}s）`
    /* 完成判定：内容连续 4 次不变就算收工。
       minChars 只作"够不够像一则正经回复"的参考 —— 短回复（比如只回了几个字）
       等满 8 次仍不变也照收，否则会像旧脚本那样一直等到超时。 */
    if (stable >= 4) {
      /* 必须确认这次真的多出一条新消息：Gemini 在 /app 导航后会短暂残留上一会话的正文，
         只看「文字稳定」会把旧内容当成本次回复（踩过：new 模式抓到上一章正文）。 */
      const grew = typeof before.mains === 'number' && typeof snap.mains === 'number' ? snap.mains > before.mains : true
      if (!grew) {
        stable = 0
        job.stage = `第 ${part.index + 1} 段 · 等新回复出现（页面仍停在发送前状态，${part.elapsed}s）`
        continue
      }
      if (latest.length >= job.options.minChars) return { text: latest, done: true }
      if (stable >= 8) return { text: latest, done: true, short: true }
    }
  }
  return { text: latest, timedOut: true }
}

export function buildPrompt(job, part) {
  const options = job.options
  /* 全章口径优先：totalParts=本章一共几段，partOffset=本次第一段之前已发过几段。
     没传就退回「本次提交段数」，保持老行为兼容。 */
  const declaredTotal = Number(options.totalParts) > 0 ? Number(options.totalParts) : 0
  const offset = Number(options.partOffset) > 0 ? Number(options.partOffset) : 0
  const total = declaredTotal > 0 ? declaredTotal : job.parts.length
  const index = offset + part.index + 1
  /* contextMode：prefix＝每段都带资料包（默认，最稳）；first＝只带第 1 段，省 token */
  const useContext = options.context !== '' && (options.contextMode !== 'first' || part.index === 0)
  const block = useContext
    ? `【本章资料 · 请严格依此，不得另造】\n${options.context}\n\n注意：上面【本章资料】里没有的设定、人物、兽虫，一律不要添。\n\n`
    : ''

  let template = String(options.template)
    .replace(/\{\{\s*total\s*\}\}/g, String(total))
    .replace(/\{\{\s*part\s*\}\}/g, String(index))
    .replace(/\{\{\s*title\s*\}\}/g, options.title || '')

  /* 章名：模板没留 {{title}} 就接在抬头第一行末尾（要在补默认指令之前做，否则会粘到指令那行） */
  if (options.title && !/\{\{\s*title\s*\}\}/.test(String(options.template))) {
    const newline = template.indexOf('\n')
    const head = newline < 0 ? template : template.slice(0, newline)
    const rest = newline < 0 ? '' : template.slice(newline)
    template = head.replace(/\s*$/, '') + '章名：' + options.title + '。' + rest
  }

  if (/\{\{\s*context\s*\}\}/.test(template)) {
    template = template.replace(/\{\{\s*context\s*\}\}/g, block.trimEnd())
  } else if (block !== '') {
    /* 模板没留 {{context}}：资料包插在正文之前（没有 {{text}} 就放最前） */
    template = template.includes('{{text}}') ? template.replace('{{text}}', block + '{{text}}') : block + template
  }

  /* ③ 默认润色指令：模板/context 里没有「改」这个动词时，模型会把正文当资料读、原样退回。
     兜底补一句明确的改稿要求（作者踩过：1024 字进、1024 字出，67 段一字未动）。 */
  const wantsEdit = /润色|改写|重写|改一改|改一下|放开改/.test(template)
  if (!wantsEdit) {
    template =
      '请你润色下面的正文——让它读起来有修真感。放开改：句子可以重写、句子长短随你，可以加细节、加器物、加动作；唯一要守的：情节不变、人物不换、事件不删、别自己造设定或人物。写完把这一段完整给我，段首空四格。\n\n' +
      template
  }

  /* ① 分段隔离：多段时明确「只写这一段」，否则模型会拿整章骨架自己写一整章
     （作者踩过：4 段提交，回来 4 片全是第 4 段/重复整章，+138%）。 */
  const guard =
    total > 1 && !/只写这一段/.test(template)
      ? `【只写这一段】这是全章第 ${index} 段（共 ${total} 段）。你只写这一段：写完立刻停，不要写其他段，不要重述前文，不要从头另写一整章，不要拆成多段编号输出。\n\n`
      : ''

  /* ② 格式：瘦版两条，默认就带（作者 2026-11-25：「不重要不是不要」）。
     不再写「至少保留 N 段」那种量化长句 —— 那会让 prompt 变长、粘贴更容易失败。
     字数与缩进仍按需：maxInflation / strictFormat。 */
  const formatRules = []
  const strictFormat = options.strictFormat === true
  formatRules.push('保持原文分段，不要并成一大坨。')
  formatRules.push('段首空两格。')
  const maxInflation = Number(options.maxInflation) > 0 ? Number(options.maxInflation) : 0
  if (maxInflation > 0) {
    formatRules.push('篇幅不要超过原文的 ' + Math.round((1 + maxInflation) * 100) + '%，不做扩写。')
  }
  const rulesBlock = `【格式】\n${formatRules.join('\n')}\n\n`

  return template.replace(/\{\{\s*text\s*\}\}/g, guard + rulesBlock + part.text)
}

/** 等页面真的可用：有输入框，且**消息条数稳定 2 次**（历史加载完了，按钮才可点）。 */
async function waitForChatReady(cdp, timeoutMs, probeScript = PROBE, logFn) {
  const until = Date.now() + timeoutMs
  let lastCount = -1
  let stable = 0
  let probe = null
  while (Date.now() < until) {
    try {
      probe = await cdp.evaluate(probeScript)
    } catch (error) {
      if (logFn) logFn('读页面失败：' + String((error && error.message) || error).slice(0, 100))
      await sleep(800)
      continue
    }
    if (!probe || !probe.hasEditable) {
      stable = 0
      lastCount = -1
      await sleep(800)
      continue
    }
    if (probe.count === lastCount) stable += 1
    else {
      stable = 0
      lastCount = probe.count
    }
    if (stable >= 2) return probe
    await sleep(800)
  }
  return probe
}

/** 等页面真的可用（有输入框、不是登录页）。返回 probe 或 null。 */
async function waitForEditor(cdp, timeoutMs, probeScript = PROBE) {
  const until = Date.now() + timeoutMs
  let last = null
  while (Date.now() < until) {
    try {
      const probe = await cdp.evaluate(probeScript)
      last = probe
      if (probe && probe.hasEditable) return probe
    } catch {
      /* 页面正在加载/导航，取不到属正常 */
    }
    await sleep(1000)
  }
  return last
}

/** 连接 CDP；刚拉起 Chrome 时可能只有 about:blank，重试一段时间。 */
async function connectWhenReady(port, timeoutMs, selector) {
  const until = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < until) {
    try {
      return await cdpConnect(port, selector)
    } catch (error) {
      lastError = error
      await sleep(800)
    }
  }
  throw lastError || new Error('连不上 Chrome 调试端口')
}

async function runJob(job) {
  let cdp = null
  const site = job.site || siteOf(job.options.backend)
  try {
    log(job, '连接浏览器…')
    const up = await ensureChrome(job.options.port, job.options, (message) => log(job, message))
    if (!up) throw new Error('自动化 Chrome 没起来：检查 chrome.exe 路径；起不来就手动跑一次 launch.mjs')
    await ensureSiteTab(job.options.port, site)
    cdp = await connectWhenReady(job.options.port, 20000, (url) => (site.match ? url.includes(site.match) : true))
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    /* 窗口在后台时 Gemini 的输入框可能不渲染 —— 先提到前台再等 */
    await cdp.send('Page.bringToFront').catch(() => {})
    await sleep(600)

    /* 刚拉起的 Chrome 会先停在空白页/加载中，必须等会话内容也稳定下来再判登录 */
    let probe = null
    if (site.fill === 'paste') {
      /* Gemini 单独判：只问「输入框在不在」，别的一概不问 —— 之前拿通用探针判，
         选择器差一个就误报「页面没就绪」，把好好的页面导航掉。 */
      const until = Date.now() + 45000
      while (Date.now() < until) {
        const check = await cdp
          .evaluate(`(() => {
            const ed = document.querySelector('.ql-editor[contenteditable="true"]');
            return { has: !!ed, href: location.href, vis: document.visibilityState };
          })()`)
          .catch((error) => {
            log(job, '探测输入框失败：' + String(error.message).slice(0, 80))
            return null
          })
        if (check && check.has) {
          probe = await cdp.evaluate(site.probe).catch(() => null)
          log(job, '输入框就位（可见性 ' + check.vis + '）')
          break
        }
        await sleep(1000)
      }
    } else {
      probe = await waitForChatReady(cdp, 25000, site.probe, (message) => log(job, message))
    }
    if (!probe || !probe.hasEditable) {
      /* 已经在正确的站上就**不要重载**（SPA 重载会丢渲染，Venice 尤其慢）；先把窗口提到前台再等 */
      const onSite = probe && probe.href && site.match && String(probe.href).includes(site.match)
      await cdp.send('Page.bringToFront').catch(() => {})
      if (onSite) {
        log(job, '已在 ' + site.label + '，不重载，继续等输入框…')
      } else {
        log(job, '页面还没就绪，导航一次再看…')
        await cdp.send('Page.navigate', { url: job.options.chatUrl })
      }
      probe = await waitForChatReady(cdp, 60000, site.probe, (message) => log(job, message))
    }
    if (!probe || !probe.hasEditable) {
      throw new Error(
        (site.label + ' 页面 65 秒内没有出现输入框——看一眼 Chrome 窗口（没登录／人机验证／标签页开错都会这样）'),
      )
    }
    if (probe.signedOut) throw new Error('网页版未登录——请在自动化 Chrome 窗口里登录一次再重跑')
    /* ---------- 会话策略（作者 2026-11-25 要求显式化）----------
       current = 绝不导航，就用当前标签页的会话（墨卿要的就是这个）
       fixed   = 导航到 chatUrl / geminiUrl 指定的具体会话（默认，保持老行为）
       new     = 导航到站点的新会话入口，并把生成的 /app/<id> 记下来
       关键修正：以前只把 pathname === '/' 当"新会话入口"，于是 gemini 的 /app
       被当成具体会话去导航 —— 结果是每跑一章就开一个新会话。 */
    const sessionMode = String(job.options.sessionMode || 'fixed')
    const want = String(job.options.chatUrl || '').trim()
    const pathOf = (value) => {
      try {
        return new URL(value).pathname || '/'
      } catch {
        return '/'
      }
    }
    const newChatPaths = Array.isArray(site.newChatPaths) ? site.newChatPaths : ['/']
    const isNewChatPath = (path) => newChatPaths.includes(path)
    job.sessionMode = sessionMode
    job.sessionUrl = probe.href

    if (sessionMode === 'current') {
      log(job, '会话策略 current：不导航，沿用当前标签页（' + String(probe.href).slice(0, 90) + '）')
    } else if (sessionMode === 'new') {
      const target = String(site.fallbackUrl || want)
      log(job, '会话策略 new：导航到新会话入口 ' + target)
      await cdp.send('Page.navigate', { url: target })
      const settledFirst = await waitForChatReady(cdp, 45000, site.probe)
      if (!settledFirst || !settledFirst.hasEditable) throw new Error('打开新会话后 45 秒还没就绪，请在 Chrome 里看一眼')
      let settled = settledFirst
      /* 导航到 /app 时 SPA 可能仍显示上一个会话的内容（实测第二次开新会话就这样），
         此时必须重载一次，否则等回复会抓到上一会话的旧消息。 */
      if (typeof settled.mains === 'number' && settled.mains > 0) {
        log(job, '新会话页里还有 ' + settled.mains + ' 条旧消息，重载一次…')
        await cdp.send('Page.reload', {}).catch(() => {})
        const again = await waitForChatReady(cdp, 45000, site.probe)
        if (again && again.hasEditable) settled = again
      }
      probe = settled
      /* 新会话的真实地址（/app/<id>）要等发出第一条消息才生成，这里只记入口，
         发送成功后由 part 完成处回填（见 runJob 里的 location.href 刷新）。 */
      job.sessionUrl = probe.href
      log(job, '新会话页已就绪，真实地址等发送后回填')
    } else if (want) {
      const wantPath = pathOf(want)
      const currentPath = pathOf(probe.href)
      const sameChat = wantPath !== '' && (currentPath === wantPath || currentPath.startsWith(wantPath + '/'))
      if (isNewChatPath(wantPath)) {
        log(job, '注意：chatUrl 指向的是新会话入口（' + wantPath + '），按「不导航、沿用当前会话」处理；要开新会话请传 sessionMode:"new"')
        job.sessionUrl = probe.href
      } else if (!sameChat) {
        log(job, '导航到固定会话…')
        await cdp.send('Page.navigate', { url: want })
        /* 会话历史多的时候，导航后要几十秒才渲染完；必须等条数稳定再发，否则会点空 */
        const settled = await waitForChatReady(cdp, 45000, site.probe)
        if (!settled || !settled.hasEditable) {
          throw new Error('导航到目标会话后 45 秒还没就绪，请在 Chrome 里看一眼')
        }
        probe = settled
        job.sessionUrl = probe.href
      } else {
        job.sessionUrl = probe.href
      }
    }
    log(job, '会话就绪：' + String(probe.href).split('/').pop() + '（站点 ' + (job.options.backend || 'deepseek') + ' / 探针 ' + String(site.probe).length + ' 字符）')

    const directory = resolve(job.options.outDir)
    await mkdir(directory, { recursive: true })

    for (const part of job.parts) {
      if (job.cancelled) break
      part.state = 'sending'
      job.stage = `第 ${part.index + 1} 段 · 发送中`
      /* 发送前等页面安静：上一次任务超时被取消后，它的回复可能迟到，
         那会让本次的 before 基线失效、把上一轮的回复当成本轮结果
         （踩过：D 段读到了 B 段的验证码）。这里等「无流式 + 条数/长度连续 3 秒不变」。 */
      const quietUntil = Date.now() + 45000
      let quietKey = ''
      let quietHits = 0
      while (Date.now() < quietUntil) {
        const snap = await cdp.evaluate(site.probe).catch(() => null)
        if (!snap) {
          await sleep(1000)
          continue
        }
        const key = snap.mains + '|' + String(snap.text || '').length
        if (snap.streaming) {
          quietHits = 0
          quietKey = key
          job.stage = `第 ${part.index + 1} 段 · 等上一条回复收尾`
        } else if (key === quietKey) {
          quietHits += 1
        } else {
          quietHits = 0
          quietKey = key
        }
        if (quietHits >= 3) break
        await sleep(1000)
      }
      const before = await cdp.evaluate(site.probe)
      const how = await sendPrompt(cdp, buildPrompt(job, part), before, site.probe, site)
      log(job, `第 ${part.index + 1} 段已发送（${how}）`)
      part.state = 'waiting'
      part.startedAt = Date.now()

      const outcome = await waitForReply(cdp, before, part, job)
      if (outcome.cancelled) {
        part.state = 'cancelled'
        break
      }
      /* 只削尾部空白：段首那两格全角是 cleanOutput 刚补上的，trim() 会把它削掉 */
      const text = String(outcome.text || '').replace(/\s+$/, '')
      if (text === '') {
        part.state = 'failed'
        part.error = outcome.timedOut ? '超时且没有内容' : '没有取到内容'
        log(job, `第 ${part.index + 1} 段落空`)
        break
      }
      const fileName = `${job.options.stamp}_part${String(part.index + 1).padStart(2, '0')}.txt`
      const fullPath = join(directory, fileName)
      await writeFile(fullPath, text, 'utf8')
      rememberPart({ file: fullPath }, text)
      part.file = fullPath
      part.charsGot = text.length
      part.state = outcome.timedOut ? 'done-unfinished' : 'done'
      /* 分段自检：原文几段、回来几段。合并成一大段时明确报警，别让作者自己数。 */
      const inParas = part.text.split('\n').map((line) => line.trim()).filter((line) => line !== '').length
      const outParas = text.split('\n').map((line) => line.trim()).filter((line) => line !== '').length
      if (inParas > 1 && outParas < inParas * 0.6) {
        part.paraLoss = { inParas, outParas }
        log(job, `⚠ 第 ${part.index + 1} 段分段被合并：原文 ${inParas} 段 → 回来 ${outParas} 段（提示词已要求保持段数）`)
      }
      /* 会话地址回填：new 模式下地址要等发出第一条才从 /app 变成 /app/<id> */
      const hrefNow = await cdp.evaluate('location.href').catch(() => '')
      if (hrefNow && /^https?:/.test(hrefNow)) {
        const changedSession = hrefNow !== job.sessionUrl
        job.sessionUrl = hrefNow
        if (changedSession) log(job, '会话地址：' + hrefNow)
      }
      log(
        job,
        `第 ${part.index + 1} 段完成：${text.length} 字 → ${fileName}` + (outcome.timedOut ? '（超时截取，请复核尾部）' : ''),
      )
      /* 自检：回来的字里必须包含那串随机码，否则说明读到的不是这一条的回复 */
      if (job.options.selftestCode) {
        const hit = text.includes(job.options.selftestCode)
        job.selftest = { code: job.options.selftestCode, ok: hit, got: text.slice(0, 60) }
        log(
          job,
          hit
            ? '自检通过：验证码 ' + job.options.selftestCode + ' 完整回来了'
            : '自检失败：回复里没有验证码 ' + job.options.selftestCode + '，读到的是「' + text.slice(0, 40) + '」',
        )
      }
      /* 硬约束自检：逐段先记，合并后再出一份总表（北方话/破折号/禁词/套话/膨胀/专名） */
      try {
        const audit = auditPart(part.text, text.replace(/^　　/gm, ''), job.options.mustKeep || [])
        part.inflation = audit.inflation
        part.audit = audit
        if (!job.audits) job.audits = []
        job.audits.push({ index: part.index, ...audit })
        log(
          job,
          '段 ' + (part.index + 1) + ' 硬约束：' + (audit.problems.length > 0 ? '⚠ ' + audit.problems.join('；') : '✓'),
        )
      } catch (error) {
        log(job, '硬约束自检失败（不影响出稿）：' + String(error.message || error).slice(0, 80))
      }
      await sleep(job.options.gapMs)
    }

    if (job.cancelled) {
      job.status = 'cancelled'
      job.stage = '已停止'
    } else if (job.parts.every((part) => part.state === 'done' || part.state === 'done-unfinished')) {
      const merged = job.parts.map((part) => readPart(part)).filter(Boolean).join('\n\n')
      if (merged) {
        const mergedPath = join(directory, `${job.options.stamp}_merged.txt`)
        await writeFile(mergedPath, merged, 'utf8')
        job.mergedFile = mergedPath
      }
      job.status = 'done'
      job.stage = '全部完成'
      log(job, '四段已合并：' + (job.mergedFile || '（无）'))

      /* 出稿自检：分段稿之间有没有同一场面写两遍 */
      const repeat = checkRepeats(job.parts.map((part) => readPart(part)), 0.55)
      job.repeats = repeat
      const reportPath = join(directory, `${job.options.stamp}_重复检测.txt`)
      await writeFile(reportPath, formatRepeatReport(repeat), 'utf8')
      job.repeatReport = reportPath
      if (repeat.pairs.length > 0) {
        job.stage = '完成，但有跨段重复'
        log(job, '⚠ 跨段重复 ' + repeat.pairs.length + ' 处（最重 ' + Math.max(repeat.pairs[0].full, repeat.pairs[0].edge, repeat.pairs[0].window) + '），详见 ' + reportPath)
        for (const pair of repeat.pairs.slice(0, 6)) {
          log(job, `  第 ${pair.a} 段 × 第 ${pair.b} 段：${pair.kind}（${pair.full}/${pair.edge}/${pair.window}）`)
        }
      } else {
        log(job, '跨段重复检测：干净')
      }

      /* 硬约束总表：和重复检测并排落盘，谁看都不用再手查 */
      if (job.audits && job.audits.length > 0) {
        const inChars = job.audits.reduce((sum, item) => sum + item.inChars, 0)
        const outChars = job.audits.reduce((sum, item) => sum + item.outChars, 0)
        const checkReport = {
          stamp: job.options.stamp,
          parts: job.audits,
          total: {
            inChars,
            outChars,
            inflation: inChars > 0 ? outChars / inChars - 1 : 0,
            problemParts: job.audits.filter((item) => item.problems.length > 0).length,
          },
          notes: (job.options.mustKeep || []).length > 0 ? ['调用方点名要保留：' + job.options.mustKeep.join('、')] : [],
        }
        const checkPath = join(directory, `${job.options.stamp}_硬约束自检.txt`)
        await writeFile(checkPath, renderAudit(checkReport), 'utf8')
        job.checkReport = checkPath
        job.checks = {
          total: checkReport.total,
          parts: job.audits.map((item) => ({ index: item.index, inflation: item.inflation, problems: item.problems })),
        }
        const bad = job.audits.filter((item) => item.problems.length > 0)
        if (bad.length > 0) {
          log(
            job,
            '⚠ 硬约束 ' + bad.length + ' 段有问题（' + bad.map((item) => '段' + (item.index + 1) + '：' + item.problems.join('；')).join('｜') + '），详见 ' + checkPath,
          )
        } else {
          log(job, '硬约束自检：全部通过 → ' + checkPath)
        }
      }
    } else {
      job.status = 'failed'
      job.stage = '中断：有一段没拿到'
    }
  } catch (error) {
    job.status = 'failed'
    job.stage = '出错'
    log(job, '出错：' + String(error?.message ?? error))
  } finally {
    /* 会话台账：无论成败都记一条，墨卿的脚本直接读 outDir/sessions.jsonl 就行 */
    try {
      const record = {
        stamp: job.options.stamp,
        backend: job.options.backend || 'deepseek',
        sessionUrl: job.sessionUrl || '',
        sessionMode: job.sessionMode || '',
        at: new Date().toISOString(),
        parts: job.parts.length,
        status: job.status,
        title: job.options.title || '',
      }
      await appendFile(join(resolve(job.options.outDir), 'sessions.jsonl'), JSON.stringify(record) + '\n', 'utf8')
    } catch (error) {
      log(job, '会话台账写入失败（不影响出稿）：' + String(error?.message ?? error).slice(0, 80))
    }
    try {
      cdp?.close()
    } catch {
      /* 关不掉不影响结果 */
    }
  }
}

const partText = new Map()
function rememberPart(part, text) {
  partText.set(part.file, text)
}
function readPart(part) {
  return partText.get(part.file) || ''
}
/* ------------------------------------------------------------------ 跨段重复检测 */

/**
 * 为什么要有这道检查：分段润色时 DS 常常把上一段写过的场面从头再写一遍，
 * 结果是同一场「越线—塌方—救人」在正文里发生两次。相似度只看数字能看出来，
 * 肉眼读一遍反而容易漏，所以出稿后自动比对一次。
 *
 * 口径：
 * - 先把标点空白去掉，取 4 字滑窗做 shingle；
 * - 每段都带的样板行（【本次约束】这类表头）先剔掉，否则会误报 1.00；
 * - 两种情况都报：整段相似（全文重复）、局部滑窗相似（某场景重复，默认窗口 400 字）。
 */
const SIM_STRIP = /[\s\u3000，。！？；：、“”‘’（）《》【】〈〉「」『』—…·,.!?;:"'()[\]<>\\/|-]/g

function simText(text) {
  return String(text || '').replace(SIM_STRIP, '')
}

function shingles(text, size = 4) {
  const s = simText(text)
  const set = new Set()
  for (let i = 0; i + size <= s.length; i += 1) set.add(s.slice(i, i + size))
  return set
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const gram of a) if (b.has(gram)) inter += 1
  return inter / (a.size + b.size - inter)
}

/** 剔掉每段都带的样板行（润色提示词回执、【本次约束】表头等）。
 *  条件收紧：必须在**所有**段里都出现、且是短行、且不含句末标点——
 *  否则「同一场面被写两遍」正好会被当成样板行剔掉，检测就白做了。 */
function stripCommonLines(texts) {
  const counts = new Map()
  for (const text of texts) {
    const seen = new Set()
    for (const line of String(text).split(/\r?\n/)) {
      const key = line.trim()
      if (key.length < 6 || key.length > 60 || seen.has(key)) continue
      if (/[。！？]/.test(key)) continue
      seen.add(key)
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  const floor = Math.max(2, texts.length)
  return texts.map((text) =>
    String(text)
      .split(/\r?\n/)
      .filter((line) => {
        const key = line.trim()
        if (key.length < 6 || key.length > 60) return true
        if (/[。！？]/.test(key)) return true
        return (counts.get(key) || 0) < floor
      })
      .join('\n'),
  )
}

/** 一段的尾部 vs 下一段的头部。分段拼接处重复最常见。 */
function boundarySimilarity(a, b, size = 500) {
  const left = shingles(simText(a).slice(-size))
  const right = shingles(simText(b).slice(0, size))
  return jaccard(left, right)
}

/** 两段之间最像的一对窗口（同一场面被写了两遍）。 */
function windowMax(a, b, size = 400, step = 200) {
  const left = simText(a)
  const right = simText(b)
  let best = 0
  let at = [0, 0]
  const rightWindows = []
  for (let s = 0; s + size <= right.length; s += step) rightWindows.push({ at: s, grams: shingles(right.slice(s, s + size)) })
  for (let s = 0; s + size <= left.length; s += step) {
    const grams = shingles(left.slice(s, s + size))
    for (const win of rightWindows) {
      const sim = jaccard(grams, win.grams)
      if (sim > best) {
        best = sim
        at = [s, win.at]
      }
    }
  }
  return { best, at }
}

/** 两段之间最长的一段「字字相同」的连续文本：照抄整句时窗口相似度会被稀释，这个不会。 */
function longestCommonRun(a, b, size = 10) {
  const left = simText(a)
  const right = simText(b)
  if (left.length < size || right.length < size) return 0
  const index = new Map()
  for (let i = 0; i + size <= left.length; i += 1) {
    const key = left.slice(i, i + size)
    if (!index.has(key)) index.set(key, [])
    const spots = index.get(key)
    if (spots.length < 6) spots.push(i)
  }
  let best = 0
  for (let j = 0; j + size <= right.length; j += 1) {
    const spots = index.get(right.slice(j, j + size))
    if (spots === undefined) continue
    for (const i of spots) {
      let len = size
      while (i + len < left.length && j + len < right.length && left[i + len] === right[j + len]) len += 1
      if (len > best) best = len
    }
  }
  return best
}

/**
 * 检测一轮分段落盘稿里的跨段重复。
 * @param parts 按顺序的正文
 * @param threshold 窗口/全文相似度门槛，默认 0.55
 * @returns { threshold, pairs: [{ a, b, full, edge, window, run, kind }] }
 */
export function checkRepeats(rawTexts, threshold = 0.55) {
  const parts = stripCommonLines(rawTexts)
  const pairs = []
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      const full = jaccard(shingles(parts[i]), shingles(parts[j]))
      const edge = j === i + 1 ? boundarySimilarity(parts[i], parts[j]) : 0
      const win = windowMax(parts[i], parts[j])
      const run = longestCommonRun(parts[i], parts[j])
      const worst = Math.max(full, edge, win.best)
      /* 两个入口：整体像，或者有一大段字字相同（后者常常是整句照抄） */
      if (worst < threshold && run < 80) continue
      pairs.push({
        a: i + 1,
        b: j + 1,
        full: Number(full.toFixed(2)),
        edge: Number(edge.toFixed(2)),
        window: Number(win.best.toFixed(2)),
        run,
        at: win.at,
        kind:
          run >= 80 && win.best < threshold
            ? '整句照抄'
            : win.best >= threshold && win.best >= full && win.best >= edge
              ? '场景重复'
              : edge >= full
                ? '拼接处重复'
                : '整段重复',
      })
    }
  }
  pairs.sort((x, y) => Math.max(y.full, y.edge, y.window) - Math.max(x.full, x.edge, x.window) || y.run - x.run)
  return { threshold, pairs }
}

function formatRepeatReport(result) {
  const lines = ['跨段重复检测（阈值 ' + result.threshold + '）']
  if (result.pairs.length === 0) {
    lines.push('没有发现跨段重复。')
    return lines.join('\n')
  }
  lines.push('发现 ' + result.pairs.length + ' 处可疑重复：')
  for (const pair of result.pairs) {
    lines.push(
      `- 第 ${pair.a} 段 × 第 ${pair.b} 段：${pair.kind} ｜全文 ${pair.full} ／拼接处 ${pair.edge} ／最像窗口 ${pair.window} ／照抄长 ${pair.run} 字（位置 ${pair.at[0]}×${pair.at[1]}）`,
    )
  }
  lines.push('')
  lines.push('处置建议：只留一处，另一处按「跳过／换角度／往前推」重写；改完把这一轮的分段稿留下，别混进定稿。')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ 路由 */

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8 * 1024 * 1024) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

async function handleHealth(res, port) {
  const now = Date.now()
  if (healthCache.value && now - healthCache.at < 2500) return writeJson(res, 200, healthCache.value)
  let value = { ok: true, cdp: false, href: '', signedOut: false, mdNodes: 0, stop: false, backends: Object.keys(SITE_TABLE) }
  let cdp = null
  try {
    cdp = await cdpConnect(port)
    const probe = await cdp.evaluate(PROBE)
    value = {
      ok: true,
      cdp: true,
      href: probe.href,
      signedOut: !!probe.signedOut,
      hasEditable: !!probe.hasEditable,
      mdNodes: probe.count,
      stop: !!probe.stop,
      backends: Object.keys(SITE_TABLE),
    }
  } catch (error) {
    value = {
      ok: true,
      cdp: false,
      chrome: await cdpUp(port),
      error: String(error?.message ?? error).slice(0, 160),
    }
  } finally {
    try {
      cdp?.close()
    } catch {
      /* ignore */
    }
  }
  healthCache = { at: now, value }
  return writeJson(res, 200, value)
}

/** 会话体检：每个标签页里已经堆了多少轮、多少字（判断该不该换固定会话）。 */
async function handleSession(res, port) {
  const rows = []
  let targets = []
  try {
    targets = await listTargets(port)
  } catch (error) {
    return writeJson(res, 200, { ok: false, error: '连不上 Chrome：' + String(error.message || error), tabs: [] })
  }
  for (const target of targets) {
    if (target.type !== 'page' || !/^https?:/.test(target.url || '')) continue
    const cdp = await cdpConnect(port, (url) => url === target.url).catch(() => null)
    if (!cdp) continue
    const info = await cdp
      .evaluate(`(() => {
        const ds = [...document.querySelectorAll('.ds-assistant-message-main-content')];
        const gem = [...document.querySelectorAll('message-content')];
        let chars = 0;
        for (const el of [...ds, ...gem]) chars += (el.textContent || '').length;
        return {
          href: location.href,
          dsTurns: ds.length,
          gemTurns: gem.length,
          chars,
          lastLen: gem.length ? (gem[gem.length - 1].textContent || '').length : ds.length ? (ds[ds.length - 1].textContent || '').length : 0,
          vis: document.visibilityState,
        };
      })()`)
      .catch(() => null)
    cdp.close()
    if (info) rows.push(info)
  }
  return writeJson(res, 200, { ok: true, tabs: rows })
}

/** 切会话（墨卿 #31 ②）：导航到指定会话并等就绪，省得再写 CDP 脚本。
 *  POST /session/switch { backend, url } → { ok, href, msgs, hasEditable } */
async function handleSessionSwitch(request, res, config) {
  const body = await readJsonBody(request).catch(() => ({}))
  const backend = String(body?.backend || 'deepseek')
  const site = siteOf(backend)
  if (!site) return writeJson(res, 400, { ok: false, error: '不认识的后端：' + backend })
  const port = Number(config?.port || 9333)
  const want = String(body?.url || '').trim() || String(site.fallbackUrl || '')
  const started = Date.now()
  if (!(await ensureChrome(port, config, null))) {
    return writeJson(res, 200, { ok: false, backend, url: want, error: '浏览器起不来（检查 chromePath / profileDir，或先手动开一次登录）' })
  }
  /* 选择器必须是「按 url 匹配的函数/正则」；传站点探针脚本会永远匹配不到（踩过：45 秒超时） */
  const matcher = (url) => (site.match ? String(url || '').includes(site.match) : true)
  const cdp =
    (await connectWhenReady(port, 20000, matcher).catch(() => null)) ||
    (await connectWhenReady(port, 15000, null).catch(() => null))
  if (!cdp) return writeJson(res, 200, { ok: false, backend, url: want, error: '连不上调试端口（Chrome 是否带 --remote-debugging-port 启动？）' })
  try {
    await cdp.send('Page.bringToFront').catch(() => {})
    await cdp.send('Page.navigate', { url: want })
    const waitMs = Number(body?.timeoutSec) > 0 ? Number(body.timeoutSec) * 1000 : 60000
    const probe = await waitForChatReady(cdp, waitMs, site.probe)
    if (!probe || !probe.hasEditable) {
      return writeJson(res, 200, {
        ok: false,
        backend,
        url: want,
        error: '导航后没等到输入框（没登录 / 人机验证 / 页面结构变了）',
        ms: Date.now() - started,
      })
    }
    return writeJson(res, 200, {
      ok: true,
      backend,
      url: want,
      href: probe.href,
      msgs: probe.msgs ?? probe.turns ?? null,
      hasEditable: probe.hasEditable === true,
      signedOut: probe.signedOut === true,
      ms: Date.now() - started,
    })
  } catch (error) {
    return writeJson(res, 200, { ok: false, backend, url: want, error: String(error?.message ?? error).slice(0, 200) })
  } finally {
    try {
      cdp.close()
    } catch {
      /* 关不掉不影响结果 */
    }
  }
}

/** 页面自检（只读）：看最后一轮用户消息有多长，用来确认没有「整份发两遍」。 */
async function handlePage(res, config) {
  const port = Number(config?.port || 9333)
  const site = siteOf('gemini')
  const match = (url) => String(url || '').includes(site.match)
  const cdp = (await connectWhenReady(port, 15000, match).catch(() => null)) || (await connectWhenReady(port, 8000, null).catch(() => null))
  if (!cdp) return writeJson(res, 200, { ok: false, error: '连不上 Chrome 调试端口' })
  try {
    const info = await cdp
      .evaluate(`(() => {
        const users = [...document.querySelectorAll('user-query')];
        const last = users.length ? (users[users.length - 1].innerText || '').trim() : '';
        return {
          href: location.href,
          userMsgs: users.length,
          lastLen: last.length,
          lastHead: last.slice(0, 60),
          lastTail: last.slice(-40),
        };
      })()`)
      .catch(() => null)
    if (!info) return writeJson(res, 200, { ok: false, error: '读不到页面（可能是别的站点）' })
    return writeJson(res, 200, { ok: true, ...info })
  } finally {
    try {
      cdp.close()
    } catch {
      /* 关不掉不影响结果 */
    }
  }
}

/** 会话台账（墨卿 #31 ①）：读 outDir/sessions.jsonl，支持 ?stamp=012&limit=50 */
async function handleSessions(res, config, request) {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  const stamp = url.searchParams.get('stamp') || ''
  const limit = Math.min(Number(url.searchParams.get('limit') || 50) || 50, 500)
  const file = join(resolve(config?.outDir || DEFAULT_OUT), 'sessions.jsonl')
  let rows = []
  try {
    const text = await readFile(file, 'utf8')
    rows = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch (error) {
    return writeJson(res, 200, { ok: true, file, total: 0, sessions: [], note: '还没有会话台账（' + String(error?.message ?? error).slice(0, 60) + '）' })
  }
  if (stamp) rows = rows.filter((row) => String(row.stamp || '').includes(stamp))
  rows.reverse()
  return writeJson(res, 200, { ok: true, file, total: rows.length, sessions: rows.slice(0, limit) })
}

/** 任务列表：并行时一次看清谁在跑、谁跑完了。 */
function snapshotList() {
  return [...JOBS.values()].slice(-20).map((job) => ({
    id: job.id,
    backend: job.options.backend,
    status: job.status,
    stage: job.stage,
    parts: job.parts.length,
    done: job.parts.filter((part) => part.state === 'done' || part.state === 'done-unfinished').length,
    mergedFile: job.mergedFile || '',
    checkReport: job.checkReport || '',
    selftest: job.selftest || null,
  }))
}

function handleJobs(res) {
  return writeJson(res, 200, { ok: true, jobs: snapshotList(), backends: Object.keys(SITE_TABLE) })
}

/** 取任务：?jobId=xxx 取指定，?all=1 取列表，默认取最近一个。 */
function handleJob(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const jobId = url.searchParams.get('jobId')
  if (url.searchParams.get('all') === '1') return writeJson(res, 200, { ok: true, jobs: snapshotList() })
  if (jobId) {
    const job = JOBS.get(jobId)
    /* 墨卿 #28：job 被清理后不能"少字段"，否则调用方 KeyError；给一个明确的墓碑态 */
    if (!job) {
      return writeJson(res, 200, {
        ok: true,
        status: 'gone',
        job: null,
        jobId,
        error: '这个任务已经清理（只保留最近 12 个）',
        hint: '用 /jobs 看还在的；需要长留就把 outDir 里的落盘文件当记录',
      })
    }
    return writeJson(res, 200, snapshotJob(job))
  }
  return writeJson(res, 200, snapshotJob(current))
}

/** 取消：{jobId} 指定一个，{backend} 指定一路，什么都不给就全停。 */
async function handleCancel(request, res) {
  const body = await readJsonBody(request).catch(() => ({}))
  const jobId = body && typeof body.jobId === 'string' ? body.jobId : ''
  const backend = body && typeof body.backend === 'string' ? body.backend : ''
  const stopped = []
  for (const job of JOBS.values()) {
    if (job.status !== 'running') continue
    if (jobId && job.id !== jobId) continue
    if (!jobId && backend && job.options.backend !== backend) continue
    job.cancelled = true
    stopped.push(job.id)
    log(job, '收到停止请求')
  }
  return writeJson(res, 200, { ok: true, stopped })
}

/* ------------------------------------------------------------------ 生图（走聊天栏，不走 API）
 *
 * 作者要的：在 Venice 经典聊天里，把提示词当消息发进去，让它出图。
 * 做法：CDP 驱动聊天栏 → 输入提示词 → 回车发送 → 等新出现的 <img>（blob:）→
 * 在页面里 fetch 成 dataURL → 落到磁盘。全程不碰 API Key。
 */

/** 模型按钮/菜单的候选词（Venice 的免费生图模型大多含这些词） */
async function handleRun(request, res, config) {
  const body = await readJsonBody(request)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
  return startJob(body, res, config, { wait: body.wait === true || body.wait === 1 })
}

/**
 * 自检：发一条带随机验证码的极短消息，看回来的字里有没有这串码。
 * 为什么不用「收到」：两个字的回复太容易和上一次撞上（之前就因此误判过）。
 */
async function handleSelftest(request, res, config) {
  const body = await readJsonBody(request).catch(() => ({}))
  const wanted = body && typeof body.backend === 'string' && body.backend !== '' ? body.backend : 'deepseek'
  /* backend:"all" = 所有站点各发一条，并行跑 */
  const names = wanted === 'all' ? Object.keys(SITE_TABLE) : [wanted]
  const started = []
  for (const name of names) {
    const site = siteOf(name)
    const code = 'TK-' + Math.random().toString(36).slice(2, 6).toUpperCase()
    const result = await startJob(
      {
        backend: name,
        selftestCode: code,
        chatUrl: body && body.chatUrl,
        /* 让自检也能守在同一会话里（墨卿 #31：整批待一个会话） */
        sessionMode: body && body.sessionMode,
        chunks: ['这是一次连通性自检，不涉及小说内容（' + site.label + '）。请只回复下面这串验证码，不要任何别的话：' + code],
        stamp: 'selftest_' + name,
        minChars: 1,
        timeoutSec: 240,
      },
      res,
      config,
      { silent: true },
    )
    if (result && result.job) started.push({ backend: name, jobId: result.job.id, code })
    else started.push({ backend: name, error: (result && result.error) || '没起来' })
  }
  return writeJson(res, 200, { ok: true, started })
}

async function startJob(body, res, config, options = {}) {
  const backend = typeof body.backend === 'string' && body.backend !== '' ? body.backend : 'deepseek'
  const busy = [...JOBS.values()].find((item) => item.status === 'running' && item.options.backend === backend)
  if (busy) {
    if (options.silent) return { error: '同一后端已有任务在跑', status: 409, jobId: busy.id }
    return writeJson(res, 409, {
      ok: false,
      error: '同一后端一次只跑一个（' + busy.id + ' 还在跑）。不同后端可以并行——同时提交 deepseek 与 gemini 即可。',
      jobId: busy.id,
    })
  }
  /* 站点：内置 deepseek/gemini/venice，config.sites 可加 */
  const site = siteOf(backend)
  /* 整段不切：显式 single:true，或站点本身默认整段（如 Venice），除非显式 single:false */
  const single = body.single === true || (site.single === true && body.single !== false)
  let chunks = Array.isArray(body.chunks) ? body.chunks.filter((item) => typeof item === 'string' && item.trim() !== '') : []
  const chunksBefore = chunks.length
  const mergedForSingle = single && chunks.length > 1
  if (mergedForSingle) chunks = [chunks.join('\n\n')]
  /* 静默合并最容易出事：一份 4 段的稿子被并成 1 段，模型就会拿「第 1 段」当全章写 */
  const mergeWarning = mergedForSingle
    ? '注意：single=true，已把收到的 ' + chunksBefore + ' 段合并成 1 段（模板里的「全章切 N 段」会变成 1）。如果这不是你要的，去掉 single 再提交。'
    : ''
  if (chunks.length === 0) {
    if (options.silent) return { error: '没有可发送的段落', status: 400 }
    return writeJson(res, 400, { ok: false, error: '没有可发送的段落' })
  }

  const stamp = String(body.stamp || new Date().toISOString().slice(0, 10)).replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 60)

  const siteUrl = String(site.url || (site.configKey && config && config[site.configKey]) || site.fallbackUrl || DEFAULT_CHAT)
  const stampFinal = backend !== 'deepseek' && !new RegExp('_' + backend + '$').test(stamp) ? stamp + '_' + backend : stamp

  /* 本章资料包：调用方直接给纯文本，插件只负责拼接，不解析内容 */
  const rawContext =
    typeof body.context === 'string' ? body.context : typeof config?.context === 'string' ? config.context : ''
  const CONTEXT_LIMIT = 4000
  const contextTruncated = rawContext.length > CONTEXT_LIMIT
  const contextText = (contextTruncated ? rawContext.slice(0, CONTEXT_LIMIT) : rawContext).trim()
  const contextMode = body.contextMode === 'first' ? 'first' : 'prefix'
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 60) : ''

  current = {
    id: 'job-' + Date.now().toString(36),
    status: 'running',
    stage: '准备中',
    startedAt: Date.now(),
    cancelled: false,
    mergedFile: '',
    parts: chunks.map((text, index) => ({
      index,
      text,
      chars: text.length,
      charsGot: 0,
      elapsed: 0,
      state: 'pending',
      file: '',
      error: '',
      startedAt: 0,
    })),
    logs: [],
    options: {
      backend,
      probe: site.probe,
      port: Number(body.port || config?.port || 9333),
      chatUrl: String(body.chatUrl || siteUrl),
      startUrl: siteUrl,
      outDir: String(body.outDir || config?.outDir || DEFAULT_OUT),
      chromePath: String(body.chromePath || config?.chromePath || DEFAULT_CHROME),
      profileDir: String(body.profileDir || config?.profileDir || DEFAULT_PROFILE),
      timeoutSec: Math.min(Math.max(Number(body.timeoutSec || config?.timeoutSec || 900), 60), 3600),
      minChars: Math.min(Math.max(Number(body.minChars || 200), 1), 20000),
      pollMs: 1500,
      gapMs: 3000,
      stamp: stampFinal,
      title,
      context: contextText,
      contextMode,
      contextTruncated,
      singlePart: single,
      mergedForSingle,
      mergeWarning,
      /* 全章口径（调用方给）：本章共几段、本次第一段之前发过几段
         同时接受墨卿 #28 提的命名：totalSegments / segmentIndex（1 起算） */
      totalParts: (() => {
        const value = Number(body.totalParts ?? body.totalSegments)
        return value > 0 ? Math.floor(value) : 0
      })(),
      partOffset: (() => {
        if (Number(body.partOffset) > 0) return Math.floor(Number(body.partOffset))
        if (Number(body.segmentIndex) > 0) return Math.floor(Number(body.segmentIndex)) - 1
        return 0
      })(),
      /* 会话策略：current 不导航 / fixed 导航到指定会话（默认）/ new 开新会话 */
      sessionMode: (() => {
        const value = String(body.sessionMode || '').trim()
        return value === 'current' || value === 'new' || value === 'fixed' ? value : 'fixed'
      })(),
      /* 膨胀上限：传 1.3 表示"最多比原文多 30%"，不传就不管（作者默认不限制，要灵感） */
      maxInflation: Number(body.maxInflation) > 0 ? Number(body.maxInflation) : 0,
      /* 格式约束：默认关（作者 2026-11-25：格式不重要，回来墨卿自己修）；要就显式传 true */
      strictFormat: body.strictFormat === true,
      template: String(body.template || config?.template || (single ? SINGLE_TEMPLATE : DEFAULT_TEMPLATE)),
      selftestCode: String(body.selftestCode || ''),
      mustKeep: Array.isArray(body.mustKeep) ? body.mustKeep.filter((item) => typeof item === 'string' && item.trim() !== '') : [],
    },
  }
  for (const part of current.parts) rememberPart(part, part.text)
  const job = current
  job.site = site
  JOBS.set(job.id, job)
  current = job
  for (const [id, item] of JOBS) {
    if (item.status !== 'running' && JOBS.size > 12) JOBS.delete(id)
  }
  log(job, '新任务：' + chunks.length + ' 段，输出到 ' + job.options.outDir + (job.options.selftestCode ? '（自检码 ' + job.options.selftestCode + '）' : ''))
  if (job.options.mergeWarning) log(job, job.options.mergeWarning)
  /* 全章口径提示：一次性只发 1 段时，用户最容易看到「全章切 1 段」而困惑 */
  if (job.options.totalParts > 0) {
    const from = job.options.partOffset + 1
    const to = job.options.partOffset + chunks.length
    log(job, '全章口径：本章共 ' + job.options.totalParts + ' 段，本次是第 ' + from + (to > from ? '–' + to : '') + ' 段')
  } else if (chunks.length === 1) {
    log(job, '提示：本次只发 1 段，模板里的「全章切 N 段」会显示 1。要按全章编号，请传 totalParts（本章共几段）与 partOffset（之前已发几段）。')
  }
  if (options.silent) {
    runJob(job).catch(() => {})
    return { job }
  }
  if (!options.wait) {
    writeJson(res, 202, { ok: true, jobId: job.id })
    runJob(job).catch(() => {})
    return job
  }
  /* wait=1：跑完才回，调用方一个请求拿到结果，不用自己轮询 */
  runJob(job).catch(() => {})
  const deadline = Date.now() + (job.options.timeoutSec + 120) * 1000
  while (Date.now() < deadline && job.status === 'running') await sleep(1000)
  writeJson(res, 200, { ok: true, waited: true, job: snapshotJob(job).job })
  return job
}

export function apply(ctx, config) {
  SITE_TABLE = buildSiteTable(config)
  ctx.inject(['webServer'], (webCtx) => {
    const routes = [
      { kind: 'exact', path: '/api/dsh-webgen-polish/health', handler: (req, res) => guard(req, res, 'GET', () => handleHealth(res, Number(config?.port || 9333))) },
      { kind: 'exact', path: '/api/dsh-webgen-polish/job', handler: (req, res) => guard(req, res, 'GET', () => handleJob(req, res)) },
      { kind: 'exact', path: '/api/dsh-webgen-polish/jobs', handler: (req, res) => guard(req, res, 'GET', () => handleJobs(res)) },
      { kind: 'exact', path: '/api/dsh-webgen-polish/run', handler: (req, res) => guard(req, res, 'POST', () => handleRun(req, res, config)) },
      { kind: 'exact', path: '/api/dsh-webgen-polish/session', handler: (req, res) => guard(req, res, 'GET', () => handleSession(res, Number(config?.port || 9333))) },
      { kind: 'exact', path: '/api/dsh-webgen-polish/session/switch', handler: (req, res) => guard(req, res, 'POST', () => handleSessionSwitch(req, res, config)) },
      { kind: 'exact', path: '/api/dsh-webgen-polish/sessions', handler: (req, res) => guard(req, res, 'GET', () => handleSessions(res, config, req)) },
      { kind: 'exact', path: '/api/dsh-webgen-polish/page', handler: (req, res) => guard(req, res, 'GET', () => handlePage(res, config)) },
      { kind: 'exact', path: '/api/dsh-webgen-polish/selftest', handler: (req, res) => guard(req, res, 'POST', () => handleSelftest(req, res, config)) },
      { kind: 'exact', path: '/api/dsh-webgen-polish/cancel', handler: (req, res) => guard(req, res, 'POST', () => handleCancel(req, res)) },
      {
        kind: 'exact',
        path: '/api/dsh-webgen-polish/result',
        handler: (req, res) =>
          guard(req, res, 'GET', () => {
            if (!current) return writeJson(res, 200, { ok: true, merged: '', parts: [] })
            const parts = current.parts.map((part) => ({ index: part.index, state: part.state, text: readPart(part) }))
            const merged = parts.map((part) => part.text).filter(Boolean).join('\n\n')
            return writeJson(res, 200, {
              ok: true,
              merged,
              mergedFile: current.mergedFile || '',
              parts,
            })
          }),
      },
      {
        kind: 'exact',
        path: '/api/dsh-webgen-polish/config',
        handler: (req, res) =>
          guard(req, res, 'GET', () =>
            writeJson(res, 200, {
              ok: true,
              port: Number(config?.port || 9333),
              chatUrl: String(config?.chatUrl || DEFAULT_CHAT),
              outDir: String(config?.outDir || DEFAULT_OUT),
              timeoutSec: Number(config?.timeoutSec || 900),
              template: String(config?.template || DEFAULT_TEMPLATE),
              /* 全书通用资料（如「用灵气不用妖气」），没传 context 时用它兜底 */
              context: String(config?.context || ''),
              contextMode: 'prefix',
              contextLimit: 4000,
            }),
          ),
      },
    ]

    webCtx.effect(() => {
      const disposers = routes.map((route) => webCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-webgen-polish: 分段润色路由')
  })
}

async function guard(request, res, method, run) {
  if (!isLoopback(request)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
  const actual = request.method ?? 'GET'
  if (actual !== method) return writeJson(res, 405, { ok: false, error: 'method not allowed: ' + actual })
  try {
    return await run()
  } catch (error) {
    return writeJson(res, 500, { ok: false, error: String(error?.message ?? error).slice(0, 240) })
  }
}
