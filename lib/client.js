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

    /**
     * Every panel field, in render order. `kind` decides the control: booleans
     * toggle, `surface` selects, numbers and the runtime path take staged text.
     */
    const FIELDS = [
      { field: 'guide', kind: 'toggle', section: 'behavior' },
      { field: 'frontload', kind: 'toggle', section: 'behavior' },
      { field: 'surface', kind: 'enum', section: 'behavior' },
      { field: 'autoSync', kind: 'toggle', section: 'advanced' },
      { field: 'executable', kind: 'text', section: 'advanced' },
      { field: 'exploreTimeoutMs', kind: 'number', section: 'advanced' },
      { field: 'indexTimeoutMs', kind: 'number', section: 'advanced' },
    ]

    /** Fields whose draft must be a positive whole number of milliseconds. */
    const POSITIVE_MS = new Set(['exploreTimeoutMs', 'indexTimeoutMs'])

    /** Panel copy. Chosen from `navigator.language` so no locale plugin is required. */
    const COPY = {
      zh: {
        title: 'CodeGraph',
        desc: '代码知识图谱：系统提示词指引、提问前预取、工具面与运行时。',
        behavior: '行为',
        advanced: '高级',
        guide: '在系统提示词里注入 CodeGraph 指引',
        guideHint: '让模型在 grep/read 之前先想到 codegraph_explore；subagent 同样生效。',
        frontload: '在提问前预取相关代码',
        frontloadHint: '结构性提问时把代码上下文提前注入模型，超时 3 秒即放弃。',
        surface: '工具面',
        surfaceHint: 'core = explore + index（官方实测推荐）；full 追加 8 个窄工具。',
        core: 'core（2 个工具）',
        full: 'full（10 个工具）',
        autoSync: '查询前自动 sync',
        autoSyncHint: '索引没有 watcher：不 sync 时新增符号会静默查不到。大仓库可以关掉。',
        executable: '运行时路径',
        executableHint: '留空 = 自动搜索（插件依赖 → 磁盘安装 → PATH）；填了就优先使用。',
        executablePlaceholder: '自动搜索',
        exploreTimeoutMs: 'explore 超时（毫秒）',
        exploreTimeoutMsHint: '单次 explore 调用的上限，默认 120000。',
        indexTimeoutMs: 'index 超时（毫秒）',
        indexTimeoutMsHint: 'init / index / sync 的上限，默认 900000。',
        invalidMs: '需为正整数毫秒',
        override: '已改',
        resetField: '重置',
        dismissHint: '留空保存即恢复部署默认',
        readOnly: '当前设置文档只读，修改不可用。',
        failed: '保存失败，草稿已保留。',
        discard: '放弃修改',
        save: '保存',
        saving: '保存中…',
        collapse: '收起',
        expand: '展开',
        loading: '读取中…',
      },
      en: {
        title: 'CodeGraph',
        desc: 'Code knowledge graph: prompt guide, prefetch, tool surface, and runtime.',
        behavior: 'Behavior',
        advanced: 'Advanced',
        guide: 'Inject the CodeGraph guide into the system prompt',
        guideHint: 'Makes the model reach for codegraph_explore before grep/read; subagents included.',
        frontload: 'Prefetch relevant code before a question',
        frontloadHint: 'For structural prompts, inject code context up front; gives up after 3 seconds.',
        surface: 'Tool surface',
        surfaceHint: 'core = explore + index (the vendor-recommended pair); full adds eight narrow tools.',
        core: 'core (2 tools)',
        full: 'full (10 tools)',
        autoSync: 'Sync before a query',
        autoSyncHint: 'The index has no watcher: without a sync, newly added symbols are silently missing. Turn off on large repos.',
        executable: 'Runtime path',
        executableHint: 'Empty = automatic search (plugin dependency, disk install, PATH); a value here wins.',
        executablePlaceholder: 'automatic',
        exploreTimeoutMs: 'Explore timeout (ms)',
        exploreTimeoutMsHint: 'Ceiling for one explore call; default 120000.',
        indexTimeoutMs: 'Index timeout (ms)',
        indexTimeoutMsHint: 'Ceiling for init / index / sync; default 900000.',
        invalidMs: 'A positive whole number of milliseconds',
        override: 'modified',
        resetField: 'Reset',
        dismissHint: 'Save it empty to restore the deployment default',
        readOnly: 'The settings document is read-only here, so changes are unavailable.',
        failed: 'The save failed; the draft was kept.',
        discard: 'Discard',
        save: 'Save',
        saving: 'Saving…',
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
      '.codegraph-select{appearance:none;background:var(--dsw-alias-bg-module-platform);height:34px;width:auto;min-width:150px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:17px;padding:0 32px 0 14px;font-size:14px;line-height:22px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 17px) 15px,calc(100% - 12px) 15px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}',
      '.codegraph-select:disabled{cursor:default;opacity:.5}',
      '.codegraph-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      '.codegraph-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}',
      '.codegraph-foot{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
      '.codegraph-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}',
      '.codegraph-discard,.codegraph-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
      '.codegraph-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
      '.codegraph-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.codegraph-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.codegraph-discard:disabled,.codegraph-save:disabled{opacity:.4;cursor:default}',
      '.codegraph-discard:focus-visible,.codegraph-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
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
     * One field row, laid out as the settings section's own staged fields are:
     * the label with its override/reset affordances on one line, the control
     * under it for text and number fields, and the hint last.
     * @param props - the copy, the field descriptor, the shown value, the staged draft, and the writer.
     * @returns the row element.
     */
    function row(props) {
      const { text, spec, shown, staged, disabled } = props
      const value = staged[spec.field] !== undefined ? staged[spec.field] : shown[spec.field]
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
            onChange: (next) => props.onStage(spec.field, next),
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
              onChange: (event) => props.onStage(spec.field, event.target.value),
            },
            react.createElement('option', { value: 'core' }, text.core),
            react.createElement('option', { value: 'full' }, text.full),
          ),
        )
      }

      const children = [react.createElement('div', { key: 'head', className: 'codegraph-head-row' }, label, badges)]
      if (!inline) {
        children.push(
          react.createElement('input', {
            key: 'input',
            className: spec.invalid ? 'codegraph-input codegraph-input-invalid' : 'codegraph-input',
            type: spec.kind === 'number' ? 'number' : 'text',
            min: spec.kind === 'number' ? '1' : undefined,
            disabled,
            value: value === undefined || value === null ? '' : String(value),
            placeholder: text[spec.field + 'Placeholder'],
            onChange: (event) => props.onStage(spec.field, event.target.value),
          }),
        )
      }
      children.push(
        spec.invalid
          ? react.createElement('p', { key: 'hint', className: 'codegraph-invalid' }, text.invalidMs)
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
        // Staged edits, keyed by field: absent means "show the resolved value".
        // An empty string on a text or number field stages a withdrawal instead.
        const [staged, setStaged] = react.useState({})
        // Collapsed like the section's own cards; `defaultOpen` exists so the
        // open body is reachable in a render-only test.
        const [open, setOpen] = react.useState(props.defaultOpen === true)
        const [saving, setSaving] = react.useState(false)
        const [failed, setFailed] = react.useState(false)

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
        const dirty = Object.keys(staged).length > 0
        const invalid = Object.entries(staged).some(([field, value]) => POSITIVE_MS.has(field) && !isValidMs(value))
        const disabled = readOnly || saving

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
            dirty ? react.createElement('span', { className: 'codegraph-tag' }, text.pending) : null,
            chevron(),
          ),
          open ? body() : null,
        )

        /** Render the open panel: sections, controls, then the write footer. */
        function body() {
          return react.createElement(
            'div',
            { className: 'codegraph-body' },
            readOnly ? react.createElement('p', { className: 'codegraph-note' }, text.readOnly) : null,
            ...rows(),
            react.createElement(
              'div',
              { className: 'codegraph-foot' },
              failed ? react.createElement('p', { className: 'codegraph-failed' }, text.failed) : null,
              react.createElement(
                'button',
                { type: 'button', className: 'codegraph-discard', disabled: disabled || !dirty, onClick: discard },
                text.discard,
              ),
              react.createElement(
                'button',
                { type: 'button', className: 'codegraph-save', disabled: disabled || !dirty || invalid, onClick: save },
                saving ? text.saving : text.save,
              ),
            ),
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
                invalid: POSITIVE_MS.has(spec.field) && staged[spec.field] !== undefined && !isValidMs(staged[spec.field]),
              },
              shown,
              staged,
              disabled,
              overridden: Object.hasOwn(user, spec.field),
              onDismiss: () => dismiss(spec.field),
              onStage: (field, value) => {
                setFailed(false)
                setStaged((current) => ({ ...current, [field]: value }))
              },
            }),
          )
        }

        /** Drop every staged edit. */
        function discard() {
          setFailed(false)
          setStaged({})
        }

        /** Withdraw one field's user override, exactly as clearing the control and saving would. */
        function dismiss(field) {
          if (!Object.hasOwn(user, field)) return
          setFailed(false)
          scope.mutate([{ op: 'unset', path: [field] }], snapshot.revision).then(
            () => {
              setStaged((current) => {
                if (current[field] === undefined) return current
                const next = { ...current }
                delete next[field]
                return next
              })
            },
            () => setFailed(true),
          )
        }

        /** Write the staged edits as one mutation, then re-seed from what the Host accepted. */
        function save() {
          const ops = []
          for (const [field, value] of Object.entries(staged)) {
            if (POSITIVE_MS.has(field)) {
              if (!isValidMs(value)) continue
              ops.push({ op: 'set', path: [field], value: Math.trunc(Number(value)) })
              continue
            }
            if (typeof value === 'string' && value.trim() === '') {
              // An emptied control withdraws the override, so the field
              // re-inherits the deployment default instead of storing "".
              ops.push({ op: 'unset', path: [field] })
              continue
            }
            ops.push({ op: 'set', path: [field], value: typeof value === 'string' ? value.trim() : value })
          }
          if (ops.length === 0) {
            setStaged({})
            return
          }
          setSaving(true)
          scope.mutate(ops, snapshot.revision).then(
            () => {
              setSaving(false)
              setStaged({})
            },
            () => {
              setSaving(false)
              setFailed(true)
            },
          )
        }
      }
    }

    /**
     * Whether a staged numeric draft is a positive whole number of milliseconds.
     * @param value - the staged text.
     * @returns true when the Host's own `validate` would accept it.
     */
    function isValidMs(value) {
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
