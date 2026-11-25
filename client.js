/**
 * 网页润色流水线 · Client 半
 *
 * 一块浮在右侧的操作台：粘贴整章 → 切四段 → 开始 → 四段依次发到网页版，
 * 每段实时显示「已收多少字、等了多久」，不再出现"看着像卡死"。
 *
 * 数据全部来自 Host 半 /api/dsh-webgen-polish/*。
 */
window.__ModuleLoader__.load({
  id: 'dsh-webgen-polish',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/api/dsh-webgen-polish'
    const STORE = 'dsh-webgen-polish:v1'

    const readStore = () => {
      try {
        const raw = window.localStorage.getItem(STORE)
        return raw ? JSON.parse(raw) : {}
      } catch {
        return {}
      }
    }

    async function api(path, params, method) {
      const post = method === 'POST'
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), 20000)
      let response
      try {
        response = await fetch(API + path, {
          method: post ? 'POST' : 'GET',
          headers: post ? { 'content-type': 'application/json' } : { accept: 'application/json' },
          body: post ? JSON.stringify(params || {}) : undefined,
          cache: 'no-store',
          signal: controller.signal,
        })
      } catch (error) {
        window.clearTimeout(timer)
        if (error && error.name === 'AbortError') throw new Error('请求超时')
        throw error
      }
      window.clearTimeout(timer)
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || !data || data.ok === false) throw new Error((data && data.error) || 'HTTP ' + response.status)
      return data
    }

    /** 和 Host 同口径的切段：按行聚合成 N 份，段数不均是常态，最后一格吃余量。 */
    function splitIntoParts(text, parts) {
      const normalized = String(text || '').replace(/\r\n?/g, '\n')
      const blocks = normalized
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
        .filter((line) => line.trim() !== '')
      if (blocks.length === 0) return []
      const total = blocks.reduce((sum, line) => sum + line.length, 0)
      const target = Math.ceil(total / parts)
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

    function Svg(props) {
      return h(
        'svg',
        Object.assign(
          {
            viewBox: '0 0 16 16',
            width: 15,
            height: 15,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          props.extra || {},
        ),
        props.children,
      )
    }
    const PenIcon = () => h(Svg, null, h('path', { d: 'M10.9 2.6l2.5 2.5-8 8H2.9v-2.5z' }), h('path', { d: 'M9.4 4.1l2.5 2.5' }))
    const CloseIcon = () => h(Svg, null, h('path', { d: 'M4 4l8 8M12 4l-8 8' }))
    const StopIcon = () => h(Svg, null, h('rect', { x: 4.5, y: 4.5, width: 7, height: 7, rx: 1.2 }))
    const PlayIcon = () => h(Svg, null, h('path', { d: 'M5 3.4l7 4.6-7 4.6z' }))

    const CSS = `
.wgp-scope{position:fixed;inset:0;pointer-events:none;z-index:2147482100}
.wgp-scope *{box-sizing:border-box}
.wgp-panel{pointer-events:auto;position:fixed;display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1);
  -webkit-backdrop-filter:blur(20px) saturate(120%);backdrop-filter:blur(20px) saturate(120%);
  border:1px solid var(--dsw-alias-border-l1);border-radius:14px;
  box-shadow:0 18px 48px rgba(0,0,0,.3);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;isolation:isolate}
.wgp-head{display:flex;align-items:center;gap:8px;height:38px;padding:0 8px 0 12px;flex:0 0 auto;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:grab;user-select:none}
.wgp-head.dragging{cursor:grabbing}
.wgp-head svg{color:var(--dsw-alias-brand-primary);flex:0 0 auto}
.wgp-title{font-weight:600;font-size:13px;white-space:nowrap}
.wgp-spacer{flex:1 1 auto}
.wgp-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;
  border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto}
.wgp-btn:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.wgp-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 12px 14px;display:flex;flex-direction:column;gap:9px}
.wgp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wgp-tag{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:10px;font-size:11.5px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.wgp-dot{width:7px;height:7px;border-radius:4px;background:var(--dsw-alias-state-idle-primary)}
.wgp-dot.ok{background:var(--dsw-alias-state-success-primary)}
.wgp-dot.bad{background:var(--dsw-alias-state-error-primary)}
.wgp-dot.busy{background:var(--dsw-alias-state-warn-primary)}
.wgp-text{flex:1 1 auto;min-width:0;width:100%;min-height:120px;max-height:220px;resize:vertical;padding:8px 10px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);outline:none;font-family:inherit;font-size:12.5px;line-height:1.7}
.wgp-text:focus{border-color:var(--dsw-alias-brand-primary)}
.wgp-text-sm{min-height:96px;max-height:150px;font-size:12px}
.wgp-input{height:26px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;font:inherit;font-size:12px}
.wgp-input.small{width:56px;text-align:center}
.wgp-input.name{width:130px}
.wgp-primary{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:7px;cursor:pointer;
  border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);
  background:color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:650}
.wgp-primary:disabled{opacity:.45;cursor:default}
.wgp-ghost{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:7px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12.5px}
.wgp-ghost:disabled{opacity:.45;cursor:default}
.wgp-parts{display:flex;flex-direction:column;gap:5px}
.wgp-part{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-size:12px}
.wgp-part .idx{flex:0 0 auto;width:22px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.wgp-part .bar{flex:1 1 auto;height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden}
.wgp-part .bar i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s}
.wgp-part .st{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.wgp-part.done .st{color:var(--dsw-alias-state-success-primary)}
.wgp-part.failed .st{color:var(--dsw-alias-state-error-primary)}
.wgp-log{flex:0 0 auto;max-height:132px;overflow-y:auto;padding:6px 8px;border-radius:7px;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
  font-size:11px;line-height:1.65;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace}
.wgp-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.wgp-err{font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-all}
.wgp-rail{pointer-events:auto;position:fixed;right:0;top:46%;display:flex;flex-direction:column;align-items:center;gap:6px;
  padding:10px 5px;border:1px solid var(--dsw-alias-border-l1);border-right:0;border-radius:9px 0 0 9px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}
.wgp-rail:hover{background:var(--dsw-alias-bg-layer-2)}
.wgp-rail svg{color:var(--dsw-alias-brand-primary)}
.wgp-rail-text{writing-mode:vertical-rl;letter-spacing:2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
`

    function Panel() {
      const saved = useRef(readStore()).current || {}
      const [open, setOpen] = useState(saved.open !== false)
      const [pos, setPos] = useState({ x: typeof saved.x === 'number' ? saved.x : 420, y: typeof saved.y === 'number' ? saved.y : 90 })
      const [dragging, setDragging] = useState(false)

      const [config, setConfig] = useState(null)
      const [health, setHealth] = useState(null)
      const [raw, setRaw] = useState('')
      const [contextText, setContextText] = useState('')
      const [showContext, setShowContext] = useState(false)
      const [stamp, setStamp] = useState('')
      const [count, setCount] = useState(4)
      const [backend, setBackend] = useState('deepseek')
      const [single, setSingle] = useState(false)
      const [totalParts, setTotalParts] = useState('')
      const [sessionMode, setSessionMode] = useState('fixed')
      const [partOffset, setPartOffset] = useState('')
      const [chunks, setChunks] = useState([])
      const [job, setJob] = useState(null)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)
      const logRef = useRef(null)
      const pollRef = useRef(0)

      useEffect(() => {
        try {
          window.localStorage.setItem(STORE, JSON.stringify({ open, x: pos.x, y: pos.y }))
        } catch {
          /* ignore */
        }
      }, [open, pos.x, pos.y])

      const refreshHealth = useCallback(() => {
        api('/health')
          .then((data) => setHealth(data))
          .catch(() => setHealth({ cdp: false, error: '连不上插件服务' }))
      }, [])

      useEffect(() => {
        api('/config')
          .then(setConfig)
          .catch((err) => setError(String(err.message || err)))
        refreshHealth()
        const timer = window.setInterval(refreshHealth, 8000)
        return () => window.clearInterval(timer)
      }, [refreshHealth])

      /* 有任务在跑就 1 秒一拉进度 */
      useEffect(() => {
        if (!job || job.status !== 'running') return undefined
        const timer = window.setInterval(() => {
          api('/job')
            .then((data) => {
              const next = data.job
              setJob(next)
              if (next && next.status !== 'running') fetchResult()
            })
            .catch(() => {})
        }, 1000)
        pollRef.current = timer
        return () => window.clearInterval(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [job && job.status])

      useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      }, [job && job.logs && job.logs.length])

      function fetchResult() {
        api('/result')
          .then((data) => setResult(data))
          .catch(() => {})
      }

      const doSplit = useCallback(() => {
        const text = raw.trim()
        if (text === '') {
          setError('先把正文粘进来')
          return
        }
        const pieces = splitIntoParts(text, Number(count) || 4)
        setChunks(pieces)
        setError('')
        setJob(null)
        setResult(null)
      }, [raw, count])

      const start = useCallback(async () => {
        if (chunks.length === 0) return
        setError('')
        setResult(null)
        try {
          const data = await api('/run', {
            backend,
            single,
            totalParts: Number(totalParts) > 0 ? Number(totalParts) : undefined,
            sessionMode,
            partOffset: Number(partOffset) > 0 ? Number(partOffset) : undefined,
            chunks,
            stamp: stamp.trim() || 'polish',
            title: stamp.trim(),
            context: contextText.trim(),
            contextMode: 'prefix',
            chatUrl: config && config.chatUrl,
            outDir: config && config.outDir,
            timeoutSec: config && config.timeoutSec,
          }, 'POST')
          const begin = await api('/job')
          setJob(begin.job || { status: 'running', stage: '已提交', parts: [], logs: [] })
        } catch (err) {
          setError(String(err.message || err))
        }
      }, [backend, single, totalParts, partOffset, sessionMode, chunks, stamp, config])

      const stop = useCallback(() => {
        api('/cancel', {}, 'POST').catch(() => {})
      }, [])

      const copyResult = useCallback(async () => {
        const text = (result && result.merged) || ''
        if (!text) return
        try {
          await navigator.clipboard.writeText(text)
          setError('')
        } catch {
          setError('复制失败：浏览器没给剪贴板权限')
        }
      }, [result])

      const startDrag = (event) => {
        if (event.button !== 0) return
        if (event.target && event.target.closest && event.target.closest('[data-nodrag]')) return
        event.preventDefault()
        const origin = { x: event.clientX, y: event.clientY }
        const from = { x: pos.x, y: pos.y }
        setDragging(true)
        const move = (moveEvent) => {
          setPos({
            x: Math.max(0, Math.min(from.x + moveEvent.clientX - origin.x, window.innerWidth - 320)),
            y: Math.max(0, Math.min(from.y + moveEvent.clientY - origin.y, window.innerHeight - 120)),
          })
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          document.body.style.userSelect = ''
          setDragging(false)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        document.body.style.userSelect = 'none'
      }

      if (!open) {
        return h(
          'div',
          { className: 'wgp-scope' },
          h('style', null, CSS),
          h('button', { type: 'button', className: 'wgp-rail', title: '打开网页润色流水线', onClick: () => setOpen(true) },
            h(PenIcon, null), h('span', { className: 'wgp-rail-text' }, '润色流水线')),
        )
      }

      const running = job && job.status === 'running'
      const cdpOk = health && health.cdp && !health.signedOut
      const partRows = (job && job.parts) || []
      const total = chunkTotal(chunks)

      return h(
        'div',
        { className: 'wgp-scope' },
        h('style', null, CSS),
        h(
          'div',
          {
            className: 'wgp-panel',
            style: { left: pos.x + 'px', top: pos.y + 'px', width: '620px', height: '620px' },
          },
          h(
            'div',
            { className: 'wgp-head' + (dragging ? ' dragging' : ''), onMouseDown: startDrag },
            h(PenIcon, null),
            h('div', { className: 'wgp-title' }, '网页润色流水线'),
            h('div', { className: 'wgp-spacer' }),
            h('button', { type: 'button', className: 'wgp-btn', 'data-nodrag': '1', title: '收起', onClick: () => setOpen(false) },
              h(CloseIcon, null)),
          ),

          h(
            'div',
            { className: 'wgp-body' },
            h(
              'div',
              { className: 'wgp-row' },
              h('span', { className: 'wgp-tag' },
                h('i', { className: 'wgp-dot ' + (cdpOk ? 'ok' : health ? 'bad' : '') }),
                health ? (health.cdp ? (health.signedOut ? '未登录' : '浏览器已连接') : '浏览器未连接') : '检测中…'),
              health && health.mdNodes !== undefined ? h('span', { className: 'wgp-tag' }, '页面消息 ' + health.mdNodes + ' 条') : null,
              config ? h('span', { className: 'wgp-tag', title: config.chatUrl }, '会话 …' + String(config.chatUrl || '').slice(-8)) : null,
              config ? h('span', { className: 'wgp-tag' }, '单段上限 ' + Math.round((config.timeoutSec || 900) / 60) + ' 分') : null,
            ),

            running || (job && job.status !== 'running' && partRows.length > 0)
              ? null
              : h('textarea', {
                  className: 'wgp-text',
                  placeholder: '把整章正文粘进来（从 docx 里全选复制即可），下面点「切段」。',
                  value: raw,
                  onChange: (event) => setRaw(event.target.value),
                }),

            running || partRows.length === 0
              ? h(
                  'div',
                  { className: 'wgp-row' },
                  h('span', { className: 'wgp-hint' }, '章名'),
                  h('input', {
                    className: 'wgp-input name',
                    value: stamp,
                    placeholder: '如 051',
                    onChange: (event) => setStamp(event.target.value),
                    disabled: running,
                  }),
                  h('span', { className: 'wgp-hint' }, '段数'),
                  h('input', {
                    className: 'wgp-input small',
                    type: 'number',
                    min: 1,
                    max: 12,
                    value: count,
                    onChange: (event) => setCount(Number(event.target.value) || 4),
                    disabled: running,
                  }),
                  h('button', { type: 'button', className: 'wgp-ghost', onClick: doSplit, disabled: running }, '切段'),
                  h('span', { className: 'wgp-hint' }, chunks.length ? `${chunks.length} 段 / ${total} 字` : ''),
                )
              : null,

            /* 后端：DeepSeek 固定会话 / Gemini（同一个自动化 Chrome 里已登录的 Google 账号） */
            running
              ? null
              : h(
                  'div',
                  { className: 'wgp-row' },
                  h('span', { className: 'wgp-hint' }, '后端'),
                  h(
                    'select',
                    {
                      className: 'wgp-input small',
                      value: backend,
                      disabled: running,
                      onChange: (event) => {
                        const next = event.target.value;
                        setBackend(next);
                        /* Venice 默认整段不切；切回别的后端要复位，否则会把 4 段并成 1 段，
                           提示词里的「全章切 N 段」就变成 1（059 那次就是这么错的） */
                        setSingle(next === 'venice');
                      },
                    },
                    h('option', { value: 'deepseek' }, 'DeepSeek（固定会话）'),
                    h('option', { value: 'gemini' }, 'Gemini'),
                    h('option', { value: 'venice' }, 'Venice.ai（限制版场景）'),
                  ),
                  h(
                    'span',
                    { className: 'wgp-hint' },
                    backend === 'gemini'
                      ? '固定会话：Gemini 润色会话；产物文件名带 _gemini'
                      : backend === 'venice'
                        ? 'Venice 默认整段发（不切段）；产物文件名带 _venice'
                        : '固定会话：修真味改稿',
                  ),
                ),

            running
              ? null
              : h(
                  'div',
                  { className: 'wgp-row' },
                  h(
                    'label',
                    { className: 'wgp-hint', style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                    h('input', {
                      type: 'checkbox',
                      checked: single,
                      disabled: running,
                      onChange: (event) => setSingle(event.target.checked),
                    }),
                    '整段不切（不分段，一次发整场）',
                  ),
                  h('span', { className: 'wgp-hint' }, single ? (chunks.length > 1 ? '⚠ 会把 ' + chunks.length + ' 段并成 1 段（提示词里的「全章切 N 段」会变成 1）' : '整场一次发，适合限制版场景') : '按上面段数切开'),
                ),

            /* 全章口径：一次只发一段时，用它让提示词写「全章切 4 段，这是第 2 段」 */
            running
              ? null
              : h(
                  'div',
                  { className: 'wgp-row' },
                  h('span', { className: 'wgp-hint' }, '全章口径'),
                  h('input', {
                    className: 'wgp-input small',
                    style: { flex: '0 0 72px' },
                    type: 'number',
                    min: 1,
                    placeholder: '共几段',
                    value: totalParts,
                    onChange: (event) => setTotalParts(event.target.value),
                  }),
                  h('input', {
                    className: 'wgp-input small',
                    style: { flex: '0 0 72px' },
                    type: 'number',
                    min: 0,
                    placeholder: '之前已发',
                    value: partOffset,
                    onChange: (event) => setPartOffset(event.target.value),
                  }),
                  h('span', { className: 'wgp-hint' }, totalParts !== '' ? '提示词会写：全章切 ' + totalParts + ' 段，这是第 ' + (Number(partOffset || 0) + 1) + ' 段' : '留空＝按本次提交段数（老行为）'),
                ),

            /* 会话策略：current 不动页面（整批待同一会话）/ fixed 导航到固定会话 / new 开新会话 */
            running
              ? null
              : h(
                  'div',
                  { className: 'wgp-row' },
                  h('span', { className: 'wgp-hint' }, '会话策略'),
                  h(
                    'select',
                    {
                      className: 'wgp-input small',
                      value: sessionMode,
                      onChange: (event) => setSessionMode(event.target.value),
                      style: { flex: '0 0 150px' },
                    },
                    h('option', { value: 'current' }, 'current · 不动页面'),
                    h('option', { value: 'fixed' }, 'fixed · 导航到固定会话'),
                    h('option', { value: 'new' }, 'new · 开新会话'),
                  ),
                  h('span', { className: 'wgp-hint' }, sessionMode === 'current' ? '沿用当前标签页的会话，绝不导航' : sessionMode === 'new' ? '导航到新会话入口，并记下生成的会话地址' : '按配置里的会话地址导航'),
                ),

            /* 本章资料包：人选填，拼在每段提示词的最前面 */
            running
              ? null
              : h(
                  'div',
                  { className: 'wgp-row' },
                  h('button', {
                    type: 'button',
                    className: 'wgp-ghost',
                    onClick: () => setShowContext((value) => !value),
                  }, (showContext ? '▾ ' : '▸ ') + '本章资料' + (contextText.trim() ? `（${contextText.trim().length} 字）` : '（可选）')),
                  h('span', { className: 'wgp-hint' }, '人物 / 兽虫 / 本书规矩，写进来它就不会瞎造'),
                ),

            showContext && !running
              ? h('textarea', {
                  className: 'wgp-text wgp-text-sm',
                  placeholder: '【本章资料 · 请严格依此，不得另造】\n· 人物：朱天启（主角）…\n· 兽虫：玄背箭豪猪（背脊铁灰色针鬃，体型如牛犊）…\n· 规矩：用「灵气」不用「妖气」；旁白不报阶',
                  value: contextText,
                  onChange: (event) => setContextText(event.target.value),
                })
              : null,

            partRows.length > 0
              ? h(
                  'div',
                  { className: 'wgp-parts' },
                  partRows.map((part) => {
                    const ratio = part.chars > 0 ? Math.min(1, (part.charsGot || 0) / Math.max(part.chars, 1)) : 0
                    const stateText =
                      part.state === 'done' ? `${part.charsGot} 字 · ${part.elapsed}s`
                        : part.state === 'done-unfinished' ? `${part.charsGot} 字 · 超时截取`
                          : part.state === 'waiting' ? `生成中 ${part.charsGot || 0} 字 · ${part.elapsed || 0}s`
                            : part.state === 'sending' ? '已发送…'
                              : part.state === 'failed' ? (part.error || '失败')
                                : part.state === 'cancelled' ? '已停止'
                                  : '待发送 ' + part.chars + ' 字'
                    return h(
                      'div',
                      { key: part.index, className: 'wgp-part ' + (part.state === 'done' || part.state === 'done-unfinished' ? 'done' : part.state === 'failed' ? 'failed' : '') },
                      h('span', { className: 'idx' }, String(part.index + 1)),
                      h('span', { className: 'bar' }, h('i', { style: { width: (part.state === 'done' || part.state === 'done-unfinished' ? 1 : ratio) * 100 + '%' } })),
                      h('span', { className: 'st' }, stateText),
                    )
                  }),
                )
              : null,

            h(
              'div',
              { className: 'wgp-row' },
              running
                ? h('button', { type: 'button', className: 'wgp-ghost', onClick: stop }, h(StopIcon, null), '停止')
                : h('button', { type: 'button', className: 'wgp-primary', onClick: start, disabled: chunks.length === 0 || !cdpOk },
                    h(PlayIcon, null), chunks.length === 0 ? '先切段' : `开始润色这 ${chunks.length} 段`),
              running ? h('span', { className: 'wgp-hint' }, job.stage || '') : null,
              !running && !cdpOk ? h('span', { className: 'wgp-hint' }, '浏览器没连上：先跑 launch.mjs') : null,
            ),

            job && job.logs && job.logs.length > 0
              ? h('div', { className: 'wgp-log', ref: logRef },
                  job.logs.map((entry, index) =>
                    h('div', { key: index }, new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false }) + '  ' + entry.message)))
              : null,

            job && (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')
              ? h(
                  'div',
                  { className: 'wgp-row' },
                  h('button', { type: 'button', className: 'wgp-ghost', onClick: () => { setJob(null); setChunks([]); setResult(null) } }, '再来一章'),
                  result && result.merged ? h('button', { type: 'button', className: 'wgp-ghost', onClick: copyResult }, '复制合并稿') : null,
                  result && result.mergedFile ? h('span', { className: 'wgp-hint', title: result.mergedFile }, '已存：' + result.mergedFile) : null,
                )
              : null,

            error ? h('div', { className: 'wgp-err' }, error) : null,
            !error && !running && chunks.length > 0 && !job
              ? h('div', { className: 'wgp-hint' }, '一段一段发在同一个会话里，前一段改完再发下一段；每段都会单独存一份 txt。')
              : null,
          ),
        ),
      )
    }

    function chunkTotal(chunks) {
      return chunks.reduce((sum, item) => sum + String(item || '').length, 0)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'webgen-polish', order: 45 }, Panel),
        )
      },
    }
  },
})
