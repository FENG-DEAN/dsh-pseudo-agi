/**
 * Client half of the Whale-girl AGI panel: the left-sidebar entry and the
 * read-only panel it opens.
 *
 * Everything it shows comes from the Host route `/pseudo-agi/api/state`, which
 * reads the files the other layers write. The panel never writes, never calls a
 * tool, and never assumes a layer is loaded — a missing layer simply renders as
 * zero.
 */
window.__ModuleLoader__.load({
  id: '@pseudo-agi/panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const NS = 'pseudoAgiPanel'
    const PANEL_ID = 'pseudo-agi-panel'
    const API = '/pseudo-agi/api'
    const LAYERS = ['working', 'episodic', 'semantic', 'procedural']

    const STRINGS = {
      en: {
        panel: 'Whale AGI',
        title: 'Whale-girl AGI panel',
        subtitle: 'Read-only view of the pseudo-AGI: layers, memories, event journal, working bench.',
        refresh: 'Refresh',
        loading: 'Loading…',
        failed: 'Cannot read panel state',
        memories: 'Memories',
        memoriesHint: 'Newest first. Source of truth is Markdown under .pseudo-agi/memory.',
        events: 'Recent events',
        eventsHint: 'From the governance journal: decision, action, outcome.',
        bench: 'Working bench',
        benchHint: 'AGI_STATE.md — what the consciousness is currently doing.',
        layers: 'Layers',
        emptyMemories: 'No memory records yet.',
        emptyEvents: 'No events yet (governance off, or the session just started).',
        emptyBench: 'AGI_STATE.md not found.',
        tools: 'tools',
        generated: 'Snapshot',
      },
      zh: {
        panel: '鲸鱼娘 AGI',
        title: '鲸鱼娘 · AGI 管理面板',
        subtitle: '伪AGI 的只读视图：分层状态、记忆、事件轨迹、工作台。',
        refresh: '刷新',
        loading: '加载中…',
        failed: '无法读取面板状态',
        memories: '记忆',
        memoriesHint: '按更新时间倒序。真源是 .pseudo-agi/memory 下的 Markdown。',
        events: '最近事件',
        eventsHint: '来自治理日志：决策、行动、结果。',
        bench: '工作台',
        benchHint: 'AGI_STATE.md —— 意识当前在做什么。',
        layers: '分层',
        emptyMemories: '还没有记忆记录。',
        emptyEvents: '还没有事件（治理层未启用，或会话刚开始）。',
        emptyBench: '未找到 AGI_STATE.md。',
        tools: '个工具',
        generated: '快照',
      },
    }

    const CSS = `
.pa-root { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; overflow-y: auto; color: var(--dsw-alias-label-primary); font-size: 13px; background: var(--dsw-alias-bg-layer-1, transparent); }
.pa-head { display: flex; align-items: flex-start; gap: 16px; padding: 22px 26px 14px; flex: none; }
.pa-headText { flex: 1; min-width: 0; }
.pa-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.3; }
.pa-subtitle { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.5; }
.pa-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; padding: 5px 12px; border-radius: 8px; cursor: pointer; }
.pa-btn:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.pa-btn:disabled { opacity: 0.55; cursor: default; }
.pa-body { padding: 0 26px 26px; display: flex; flex-direction: column; gap: 18px; }
.pa-strip { display: flex; flex-wrap: wrap; gap: 10px; }
.pa-chip { display: inline-flex; align-items: baseline; gap: 6px; padding: 6px 12px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, transparent); border: 1px solid var(--dsw-alias-border-l1); }
.pa-chipValue { font-size: 16px; font-weight: 600; }
.pa-chipLabel { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.pa-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; overflow: hidden; }
.pa-cardHead { padding: 12px 14px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.pa-cardTitle { margin: 0; font-size: 13.5px; font-weight: 600; }
.pa-cardHint { margin: 3px 0 0; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.5; }
.pa-cardBody { padding: 10px 14px 14px; }
.pa-row { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; border-bottom: 1px dashed transparent; }
.pa-row + .pa-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.pa-layer { flex: none; min-width: 74px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.pa-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-meta { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.pa-empty { color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 6px 0; }
.pa-pre { margin: 0; padding: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary); max-height: 320px; overflow: auto; }
.pa-error { padding: 10px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.pa-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary); }
.pa-dot[data-on='true'] { background: var(--dsw-alias-brand-primary); }
`

    /**
     * Call one panel route.
     * @param {string} action route action.
     * @returns {Promise<object>} the payload.
     */
    async function request(action) {
      let response
      try {
        response = await fetch(`${API}/${action}`, { headers: { accept: 'application/json' } })
      } catch {
        throw new Error('NETWORK')
      }
      const raw = await response.text()
      let parsed
      try { parsed = raw === '' ? {} : JSON.parse(raw) } catch { parsed = {} }
      if (!response.ok || parsed.ok !== true) throw new Error(parsed.error ?? `HTTP ${response.status}`)
      return parsed.data
    }

    /**
     * One-line account of a journal record.
     * @param {object} record journal line.
     * @returns {string} the summary.
     */
    function summarise(record) {
      const detail = record?.detail ?? {}
      switch (record?.kind) {
        case 'step': return `步 ${detail.turn}/${detail.step} · ${detail.messages ?? '?'} 条消息`
        case 'scaffold': return detail.injected ? '注入纪律' : '本步未注入'
        case 'tool': return `${detail.name ?? '?'} ${detail.isError ? '失败' : '成功'}`
        case 'memory': return detail.found
          ? `命中 ${detail.hitCount} 条（score ${detail.topScore}）`
          : `未命中（扫描 ${detail.considered} 条）`
        case 'turn': return `轮 ${detail.turn} 结束`
        case 'error': return String(detail.message ?? 'error').slice(0, 64)
        default: return String(record?.kind ?? '?')
      }
    }

    /** The sidebar entry; the shell owns the button around it. */
    function SidebarIcon({ size = 18 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M2.8 13.2c0-3.4 3.2-6.1 7.2-6.1 3.3 0 6 1.9 6.9 4.5' }),
        h('path', { d: 'M2.8 13.2c0 3.1 2.8 5.6 6.4 5.6 2.7 0 5-1.4 6.2-3.4' }),
        h('path', { d: 'M16.9 11.6c1.5-.8 2.5-2 2.9-3.5-.3 1.8 0 3.1 1 4.2-1.2.6-2.3.4-3.2-.2' }),
        h('circle', { cx: 7.6, cy: 11.6, r: 0.85, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M8.6 5.6c.3-1.4 1.5-2.3 2.9-2.4-.9.5-1.3 1.2-1.4 2.1' }))
    }

    /**
     * The panel body.
     * @param {object} props renderer props with the panel translation.
     * @returns {object} the React element tree.
     */
    function Panel(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        try {
          setState(await request('state'))
          setError(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const layers = state?.layers ?? {}
      const memories = state?.memories ?? []
      const events = state?.events ?? []

      const chip = (value, label) => h('span', { className: 'pa-chip' },
        h('span', { className: 'pa-chipValue' }, String(value)),
        h('span', { className: 'pa-chipLabel' }, label))

      const card = (title, hint, body) => h('section', { className: 'pa-card' },
        h('div', { className: 'pa-cardHead' },
          h('h2', { className: 'pa-cardTitle' }, title),
          hint === null ? null : h('p', { className: 'pa-cardHint' }, hint)),
        h('div', { className: 'pa-cardBody' }, body))

      const layerRows = LAYERS.map(layer => h('div', { className: 'pa-row', key: layer },
        h('span', { className: 'pa-dot', 'data-on': String((layers[layer] ?? 0) > 0) }),
        h('span', { className: 'pa-layer' }, layer),
        h('span', { className: 'pa-name' }, `${layers[layer] ?? 0} 条`)))

      const memoryRows = memories.length === 0
        ? h('div', { className: 'pa-empty' }, t('emptyMemories'))
        : memories.slice(0, 12).map(record => h('div', { className: 'pa-row', key: record.id },
          h('span', { className: 'pa-layer' }, record.layer),
          h('span', { className: 'pa-name', title: record.title }, record.title),
          h('span', { className: 'pa-meta' },
            `${record.confidence === null ? '?' : record.confidence.toFixed(2)} · ${String(record.updatedAt ?? '').slice(0, 10)}`)))

      const eventRows = events.length === 0
        ? h('div', { className: 'pa-empty' }, t('emptyEvents'))
        : events.slice().reverse().map((record, index) => h('div', { className: 'pa-row', key: `${record.at ?? ''}-${index}` },
          h('span', { className: 'pa-layer' }, String(record.kind ?? '?')),
          h('span', { className: 'pa-name' }, summarise(record)),
          h('span', { className: 'pa-meta' }, String(record.at ?? '').slice(11, 19))))

      return h('div', { className: 'pa-root' },
        h('style', null, CSS),
        h('header', { className: 'pa-head' },
          h('div', { className: 'pa-headText' },
            h('h1', { className: 'pa-title' }, t('title')),
            h('p', { className: 'pa-subtitle' }, t('subtitle'))),
          h('button', { type: 'button', className: 'pa-btn', onClick: () => { void load() }, disabled: busy }, busy ? t('loading') : t('refresh'))),
        h('div', { className: 'pa-body' },
          error === null ? null : h('div', { className: 'pa-error', role: 'alert' }, `${t('failed')}: ${error}`),
          h('div', { className: 'pa-strip' },
            chip(state?.memoryTotal ?? 0, t('memories')),
            chip(state?.toolCount ?? '?', t('tools')),
            chip(events.length, t('events'))),
          card(t('layers'), state === null ? null : `${t('generated')} ${String(state.generatedAt).slice(0, 19).replace('T', ' ')}`, h('div', {}, layerRows)),
          card(t('memories'), t('memoriesHint'), h('div', {}, memoryRows)),
          card(t('events'), t('eventsHint'), h('div', {}, eventRows)),
          card(t('bench'), t('benchHint'),
            h('pre', { className: 'pa-pre' }, state?.agiState ?? t('emptyBench')))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, STRINGS), 'pseudo-agi-panel:locale')
        const bind = ctx.locale.bind(NS)
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Panel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 22,
          label: () => bind('panel'),
          locale: NS,
        }, SidebarIcon))
      },
    }
  },
})
