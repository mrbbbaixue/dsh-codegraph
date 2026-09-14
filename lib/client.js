/**
 * Browser half: the CodeGraph panel in **Settings ▸ Plugins ▸ Plugin configuration**.
 *
 * Hand-written as the client module system's lazy-CJS factory, so the package
 * ships without a bundler. The shape mirrors the installed `dsh-context` bundle:
 * `window.__ModuleLoader__.load({ id, factory })`, where `factory(require)`
 * returns `{ name, inject, apply }` and every side effect lives in the closure.
 *
 * The Host half registers the `dsh-codegraph` settings namespace and this half
 * registers a card under the *same* key; the tab pairs the two ledgers and
 * renders the intersection. Nothing else joins them, so the namespace string
 * below is load-bearing and must stay identical in both files.
 *
 * The card is one `<li>`, the shape the section's own cards use: a disclosure
 * header (collapsed by default) plus a body that stacks the fields. Every setting
 * the plugin has is here — the four that used to live only in `cordis.patch.yml`
 * included — so no value needs a YAML edit to be inspected or changed.
 *
 * There is no save button: a control writes through `scope.set` / `scope.unset` as
 * it changes, so what the panel shows is always what the Host document holds.
 *
 * Controls come from `@deepseek-ai/dsh-client-ui-primitives`, which the browser
 * module table supplies (`react`, `dsh-client-store`, `dsh-client-ui-slots`,
 * `dsh-client-ui-dockkit` are its neighbours), and the card/field metrics are
 * the settings section's own, restated under this plugin's class prefix. The
 * panel therefore looks like the deployment's settings page rather than like a
 * look-alike; nothing here is bundled, so the module table is the only source.
 *
 * @module @mrbbbaixue/dsh-codegraph/client
 */

window.__ModuleLoader__.load({
  // Both this id and the exported `name` MUST be the full package name. The boot
  // graph keys every row by package name, and the loader looks the factory up by
  // that same key — a shorter id resolves to nothing and fails loudly with
  // "cannot resolve ... not a row in the boot graph". `@linxin666/dsh-client-ui-git-graph`
  // and `dsh-context` are the references: each uses its own package name verbatim.
  id: '@mrbbbaixue/dsh-codegraph',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')
    // The browser module table supplies these; the settings tab's own cards use
    // the same ones, so the controls are the deployment's, not a look-alike.
    const { IconChevronDownOutline14, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    /**
     * The settings namespace. Deliberately NOT the package name: namespaces are
     * restricted to lowercase letters, digits, and hyphens, so a scope or slash
     * would be rejected at registration. This is the join key the Host half
     * registers and the card is dispatched under.
     */
    const NS = 'dsh-codegraph'

    /** How long a text or number control waits for typing to stop before it writes. */
    const WRITE_DELAY_MS = 400

    /**
     * Every panel field, in render order. `kind` decides the control: booleans
     * toggle, `surface` selects, numbers and the runtime path take text.
     */
    const FIELDS = [
      { field: 'guide', kind: 'toggle' },
      { field: 'frontload', kind: 'toggle' },
      { field: 'surface', kind: 'enum' },
      { field: 'autoSync', kind: 'toggle' },
      { field: 'autoIndex', kind: 'toggle' },
      { field: 'autoIndexMaxFiles', kind: 'number' },
      { field: 'executable', kind: 'text' },
      { field: 'exploreTimeoutSec', kind: 'number' },
      { field: 'indexTimeoutSec', kind: 'number' },
      { field: 'sessionIdleSec', kind: 'number' },
    ]

    /** Numeric fields, mapped to the copy shown when a draft is not a positive whole number. */
    const NUMBERS = {
      autoIndexMaxFiles: 'invalidCount',
      exploreTimeoutSec: 'invalidSec',
      indexTimeoutSec: 'invalidSec',
      sessionIdleSec: 'invalidSec',
    }

    /** Panel copy. Chosen from `navigator.language` so no locale plugin is required. */
    const COPY = {
      zh: {
        title: 'Codegraph',
        desc: '代码知识图谱：系统提示词指引、提问前预取、工具面与运行时。',
        guide: '在系统提示词里注入 CodeGraph 指引',
        guideHint: '让模型在 grep/read 之前先想到 codegraph_explore；subagent 同样生效。',
        frontload: '在提问前预取相关代码',
        frontloadHint: '结构性提问时把代码上下文提前注入模型，超时 3 秒即放弃。',
        surface: '工具面',
        surfaceHint: 'core = explore + index（官方实测推荐）；full 追加 8 个窄工具。',
        core: 'core（2 个工具）',
        full: 'full（10 个工具）',
        autoSync: '查询前自动 sync',
        autoSyncHint: '只作用于 CLI 回退路径（索引走常驻会话，由后台 daemon 的文件 watcher 自动同步）。大仓库可以关掉。',
        autoIndex: '没有索引时自动建立',
        autoIndexHint: '第一次查询发现工作区没有 .codegraph/ 就直接跑 init。只读目录或超大仓库可以关掉。',
        autoIndexMaxFiles: '自动索引的文件数上限',
        autoIndexMaxFilesHint: '文件数超过这个值就不再自动建索引，改由模型或用户决定；默认 10000。',
        autoIndexMaxFilesUnit: '个文件',
        executable: '运行时路径',
        executableHint: '留空 = 自动搜索（插件依赖 → 磁盘安装 → PATH）；填了就优先使用。',
        executablePlaceholder: '自动搜索',
        exploreTimeoutSec: 'explore 超时',
        exploreTimeoutSecHint: '单次 explore 调用的上限，单位秒，默认 120。',
        exploreTimeoutSecUnit: '秒',
        indexTimeoutSec: 'index 超时',
        indexTimeoutSecHint: 'init / index / 自动建索引的上限，单位秒，默认 900。',
        indexTimeoutSecUnit: '秒',
        sessionIdleSec: '常驻会话空闲回收',
        sessionIdleSecHint: '项目会话这么久没被查询就停掉，释放进程；下次查询自动重建。默认 900。',
        sessionIdleSecUnit: '秒',
        invalidSec: '需为正整数秒',
        invalidCount: '需为正整数',
        override: '已改',
        resetField: '重置',
        readOnly: '当前设置文档只读，修改不可用。',
        failed: '保存失败。',
        collapse: '收起',
        expand: '展开',
        loading: '读取中…',
      },
      en: {
        title: 'Codegraph',
        desc: 'Code knowledge graph: prompt guide, prefetch, tool surface, and runtime.',
        guide: 'Inject the CodeGraph guide into the system prompt',
        guideHint: 'Makes the model reach for codegraph_explore before grep/read; subagents included.',
        frontload: 'Prefetch relevant code before a question',
        frontloadHint: 'For structural prompts, inject code context up front; gives up after 3 seconds.',
        surface: 'Tool surface',
        surfaceHint: 'core = explore + index (the vendor-recommended pair); full adds eight narrow tools.',
        core: 'core (2 tools)',
        full: 'full (10 tools)',
        autoSync: 'Sync before a query',
        autoSyncHint: 'CLI fallback path only (indexed projects go over the resident session, whose background daemon watches and syncs for you). Can be turned off on large repos.',
        autoIndex: 'Build a missing index automatically',
        autoIndexHint: 'The first query on a workspace without .codegraph/ runs init. Turn off for read-only or very large projects.',
        autoIndexMaxFiles: 'Automatic index file ceiling',
        autoIndexMaxFilesHint: 'Above this many files the plugin stops building an index on its own; default 10000.',
        autoIndexMaxFilesUnit: 'files',
        executable: 'Runtime path',
        executableHint: 'Empty = automatic search (plugin dependency, disk install, PATH); a value here wins.',
        executablePlaceholder: 'automatic',
        exploreTimeoutSec: 'Explore timeout',
        exploreTimeoutSecHint: 'Ceiling for one explore call, in seconds; default 120.',
        exploreTimeoutSecUnit: 'sec',
        indexTimeoutSec: 'Index timeout',
        indexTimeoutSecHint: 'Ceiling for init / index / an automatic index, in seconds; default 900.',
        indexTimeoutSecUnit: 'sec',
        sessionIdleSec: 'Idle session reaper',
        sessionIdleSecHint: 'A project session unused for this long is stopped to release its process; the next query rebuilds it. Default 900.',
        sessionIdleSecUnit: 'sec',
        invalidSec: 'A positive whole number of seconds',
        invalidCount: 'A positive whole number',
        override: 'modified',
        resetField: 'Reset',
        readOnly: 'The settings document is read-only here, so changes are unavailable.',
        failed: 'The save failed.',
        collapse: 'Collapse',
        expand: 'Expand',
        loading: 'Loading…',
      },
    }

    /**
     * This panel's stylesheet. The card and control metrics are the settings
     * section's own (`.YyYd_a_*` and `.At1oFq_*` in
     * `dsh-client-ui-settings-plugins`), restated under this plugin's prefix so
     * a class-name collision cannot restyle another plugin's card.
     */
    const STYLE_ID = '@mrbbbaixue/dsh-codegraph/panel.css'
    const CSS = [
      '.codegraph-panel{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}',
      '.codegraph-panel:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.codegraph-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.codegraph-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      '.codegraph-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.codegraph-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      '.codegraph-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.codegraph-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.codegraph-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
      '.codegraph-open .codegraph-chevron{transform:rotate(180deg)}',
      '.codegraph-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.codegraph-note{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',
      '.codegraph-loader{color:var(--dsw-alias-label-tertiary);padding:14px 16px;font-size:13px}',
      '.codegraph-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      '.codegraph-field+.codegraph-field{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.codegraph-head-row{align-items:center;gap:8px;display:flex}',
      '.codegraph-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
      '.codegraph-badges{align-items:center;gap:8px;display:inline-flex}',
      '.codegraph-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}',
      '.codegraph-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.codegraph-reset:disabled{cursor:default;opacity:.5}',
      '.codegraph-input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;width:100%;box-sizing:border-box;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
      '.codegraph-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.codegraph-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.codegraph-input-invalid{border-color:var(--dsw-alias-label-error)}',
      '.codegraph-number{align-items:center;gap:8px;display:flex}',
      '.codegraph-input-num{width:150px;flex:none}',
      '.codegraph-unit{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      '.codegraph-select{appearance:none;background:var(--dsw-alias-bg-module-platform);height:34px;width:auto;min-width:150px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:17px;padding:0 32px 0 14px;font-size:14px;line-height:22px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 17px) 15px,calc(100% - 12px) 15px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}',
      '.codegraph-select:disabled{cursor:default;opacity:.5}',
      '.codegraph-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      '.codegraph-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}',
      '.codegraph-failed{min-width:0;color:var(--dsw-alias-label-error);margin:0;padding-top:12px;font-size:12px;line-height:1.5}',
    ].join('')

    /** Inject the panel stylesheet once per document. */
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@mrbbbaixue/dsh-codegraph'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** @returns the copy for the browser's language. */
    function strings() {
      const language = typeof navigator === 'object' && typeof navigator.language === 'string' ? navigator.language : ''
      return language.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
    }

    /**
     * One field row, laid out as the settings section's own fields are: the label
     * with its override/reset affordances on one line, the control under it for
     * text and number fields, and the hint last. A control writes as it changes:
     * toggles and selects immediately, text and number fields through `onEdit`
     * and, once the user leaves them, `onFlush`.
     * @param props - the copy, the field descriptor, the shown value, the draft text, and the writers.
     * @returns the row element.
     */
    function row(props) {
      const { text, spec, shown, draft, disabled } = props
      const value = draft[spec.field] !== undefined ? draft[spec.field] : shown[spec.field]
      const inline = spec.kind === 'toggle' || spec.kind === 'enum'
      const label = react.createElement('span', { key: 'label', className: 'codegraph-label' }, text[spec.field])
      const badges = []
      if (props.overridden) {
        badges.push(
          react.createElement(
            'button',
            { key: 'reset', type: 'button', className: 'codegraph-reset', disabled, onClick: props.onDismiss },
            text.resetField,
          ),
        )
      }
      if (spec.kind === 'toggle') {
        badges.push(
          react.createElement(Switch, {
            key: 'switch',
            checked: value !== false,
            disabled,
            label: text[spec.field],
            onChange: (next) => props.onWrite(spec.field, next),
          }),
        )
      } else if (spec.kind === 'enum') {
        badges.push(
          react.createElement(
            'select',
            {
              key: 'select',
              className: 'codegraph-select',
              disabled,
              'aria-label': text[spec.field],
              value: value === 'full' ? 'full' : 'core',
              onChange: (event) => props.onWrite(spec.field, event.target.value),
            },
            react.createElement('option', { value: 'core' }, text.core),
            react.createElement('option', { value: 'full' }, text.full),
          ),
        )
      }

      const children = [react.createElement('div', { key: 'head', className: 'codegraph-head-row' }, label, badges)]
      if (!inline) {
        const numeric = spec.kind === 'number'
        const classes = ['codegraph-input']
        if (numeric) classes.push('codegraph-input-num')
        if (spec.invalid) classes.push('codegraph-input-invalid')
        const input = react.createElement('input', {
          key: 'input',
          className: classes.join(' '),
          type: numeric ? 'number' : 'text',
          min: numeric ? '1' : undefined,
          disabled,
          value: value === undefined || value === null ? '' : String(value),
          placeholder: text[spec.field + 'Placeholder'],
          onChange: (event) => props.onEdit(spec.field, event.target.value),
          onBlur: () => props.onFlush(spec.field),
        })
        // A number means nothing without its unit, and a box the width of the panel
        // for three digits reads as a text field. The unit sits beside the control
        // instead of inside the label, where it doubled as a bracket.
        children.push(
          numeric
            ? react.createElement(
                'div',
                { key: 'control', className: 'codegraph-number' },
                input,
                react.createElement('span', { key: 'unit', className: 'codegraph-unit' }, text[spec.field + 'Unit']),
              )
            : input,
        )
      }
      children.push(
        spec.invalid
          ? react.createElement('p', { key: 'hint', className: 'codegraph-invalid' }, text[spec.invalidCopy])
          : react.createElement('p', { key: 'hint', className: 'codegraph-hint' }, text[spec.field + 'Hint']),
      )

      return react.createElement('div', { className: 'codegraph-field', 'data-field': spec.field }, ...children)
    }

    /** The disclosure chevron: the settings tab's own icon, rotated by CSS when open. */
    function chevron() {
      return react.createElement(IconChevronDownOutline14, { className: 'codegraph-chevron' })
    }

    /**
     * Build the panel component bound to one settings scope.
     * @param scope - the bound namespace scope.
     * @returns the card component.
     */
    function makeCard(scope) {
      /** @param onChange - the store listener. */
      const subscribe = (onChange) => scope.subscribe(onChange)
      /** @returns the current snapshot. */
      const getSnapshot = () => scope.getSnapshot()

      return function CodegraphPanel(props) {
        const text = strings()
        react.useEffect(injectStyles, [])
        const snapshot = react.useSyncExternalStore(subscribe, getSnapshot)
        // Text and number drafts, keyed by field: absent means "show the resolved
        // value". A toggle or select keeps no draft — the snapshot echoes the write.
        const [draft, setDraft] = react.useState({})
        // Collapsed like the section's own cards; `defaultOpen` exists so the
        // open body is reachable in a render-only test.
        const [open, setOpen] = react.useState(props.defaultOpen === true)
        const [failed, setFailed] = react.useState(false)
        // One pending write per edited control: the timer plus the draft it carries,
        // so a blur can settle it without reading state that has not re-rendered yet.
        const timers = react.useRef({})
        // Leaving the panel must not drop a draft that is still waiting: settle them all.
        react.useEffect(
          () => () => {
            for (const [field, pending] of Object.entries(timers.current)) {
              clearTimeout(pending.id)
              commit(field, pending.value)
            }
          },
          [],
        )

        if (snapshot.status === 'loading' && snapshot.value === undefined) {
          return react.createElement(
            'li',
            { className: 'codegraph-panel' },
            react.createElement('div', { className: 'codegraph-loader' }, text.loading),
          )
        }
        if (snapshot.status === 'unavailable') return null

        const shown = { ...(snapshot.base ?? {}), ...(snapshot.value ?? {}) }
        const user = snapshot.user ?? {}
        const readOnly = snapshot.writable !== true

        return react.createElement(
          'li',
          { className: open ? 'codegraph-panel codegraph-open' : 'codegraph-panel' },
          react.createElement(
            'button',
            {
              type: 'button',
              className: 'codegraph-head',
              'aria-expanded': open,
              'aria-label': `${open ? text.collapse : text.expand}: ${text.title}`,
              onClick: () => setOpen(!open),
            },
            react.createElement(
              'span',
              { className: 'codegraph-headtext' },
              react.createElement('span', { className: 'codegraph-name' }, text.title),
              react.createElement('span', { className: 'codegraph-desc' }, text.desc),
            ),
            chevron(),
          ),
          open ? body() : null,
        )

        /** Render the open panel: the field rows, then the write outcome, if any. */
        function body() {
          return react.createElement(
            'div',
            { className: 'codegraph-body' },
            readOnly ? react.createElement('p', { className: 'codegraph-note' }, text.readOnly) : null,
            ...rows(),
            failed ? react.createElement('p', { className: 'codegraph-failed' }, text.failed) : null,
          )
        }

        /**
         * Every field in panel order.
         * @returns the row elements.
         */
        function rows() {
          return FIELDS.map((spec) =>
            react.createElement(row, {
              key: spec.field,
              text,
              spec: {
                ...spec,
                invalid:
                  NUMBERS[spec.field] !== undefined &&
                  draft[spec.field] !== undefined &&
                  String(draft[spec.field]).trim() !== '' &&
                  !isPositiveInt(draft[spec.field]),
                invalidCopy: NUMBERS[spec.field],
              },
              shown,
              draft,
              disabled: readOnly,
              overridden: Object.hasOwn(user, spec.field),
              onDismiss: () => dismiss(spec.field),
              onWrite: write,
              onEdit: stage,
              onFlush: flush,
            }),
          )
        }

        /**
         * Write one field now; `undefined` withdraws the override so the field
         * re-inherits the deployment default.
         * @param field - the field name.
         * @param value - the value to store, or undefined to clear the override.
         */
        function write(field, value) {
          setFailed(false)
          const request = value === undefined ? scope.unset(field) : scope.set(field, value)
          request.then(undefined, () => setFailed(true))
        }

        /**
         * Show an edited draft and schedule its write once typing settles.
         * @param field - the field name.
         * @param value - the control's text.
         */
        function stage(field, value) {
          setFailed(false)
          setDraft((current) => ({ ...current, [field]: value }))
          const pending = timers.current[field]
          if (pending !== undefined) clearTimeout(pending.id)
          timers.current[field] = { id: setTimeout(() => commit(field, value), WRITE_DELAY_MS), value }
        }

        /**
         * Store an edited draft. An emptied control withdraws the override; a number
         * draft that is neither empty nor a positive whole number of milliseconds is
         * left unwritten, since the Host's validate would refuse it.
         * @param field - the field name.
         * @param value - the control's text.
         */
        function commit(field, value) {
          delete timers.current[field]
          if (NUMBERS[field] !== undefined) {
            if (String(value).trim() === '') return write(field, undefined)
            if (!isPositiveInt(value)) return
            return write(field, Math.trunc(Number(value)))
          }
          const trimmed = String(value).trim()
          return write(field, trimmed === '' ? undefined : trimmed)
        }

        /**
         * Write a draft without waiting out the delay, which is what leaving the
         * control means.
         * @param field - the field name.
         */
        function flush(field) {
          const pending = timers.current[field]
          if (pending === undefined) return
          clearTimeout(pending.id)
          commit(field, pending.value)
        }

        /**
         * Withdraw one field's user override, exactly as emptying the control would.
         * @param field - the field name.
         */
        function dismiss(field) {
          if (!Object.hasOwn(user, field)) return
          const pending = timers.current[field]
          if (pending !== undefined) clearTimeout(pending.id)
          delete timers.current[field]
          setFailed(false)
          scope.unset(field).then(
            () =>
              setDraft((current) => {
                if (current[field] === undefined) return current
                const next = { ...current }
                delete next[field]
                return next
              }),
            () => setFailed(true),
          )
        }
      }
    }

    /**
     * Whether a numeric draft is a positive whole number, which is the shape both
     * the millisecond ceilings and the file ceiling accept.
     * @param value - the control's text.
     * @returns true when the Host's own `validate` would accept it.
     */
    function isPositiveInt(value) {
      const number = Number(value)
      return String(value).trim() !== '' && Number.isFinite(number) && Number.isInteger(number) && number > 0
    }

    /**
     * Register the card against the namespace the Host half owns.
     * @param ctx - the client cordis context.
     */
    function apply(ctx) {
      ctx.inject(['settingsScope'], (raw) => {
        const binder = raw.settingsScope
        if (binder === undefined) return
        const scope = binder.bind({ namespace: NS })
        const Card = makeCard(scope)
        raw.slots.inject('settings.plugin.item', () =>
          raw.slots.register({ name: 'settings.plugin.item', key: NS }, (props) => react.createElement(Card, props)),
        )
      })
    }

    module.exports = { name: '@mrbbbaixue/dsh-codegraph', inject: ['slots'], apply }
    return module.exports
  },
})
