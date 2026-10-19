/**
 * V3 §21/§33.3：Declarative Layout DSL。主题包用 JSON 重排页面，运行时把它
 * 渲染成 DOM——只允许登记过的组件与节点类型，条件只读 View Model，动作只
 * 经 Action Registry（confirm 不可绕过）。禁止原始 HTML、函数与表达式：
 * 验证器在这一层就把它们拒掉，渲染器对可疑字符串不再二次执行。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSILayoutDSL = api
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict'

  const NODE_TYPES = ['stack', 'row', 'grid', 'split', 'tabs', 'scroll', 'when', 'repeat', 'component', 'slot', 'divider', 'spacer']
  const CONDITION_OPS = ['equals', 'notEquals', 'in', 'exists', 'gt', 'gte', 'lt', 'lte']
  const MOTION_TRIGGERS = ['enter', 'exit', 'expand', 'collapse', 'switch', 'success', 'error']
  const MOTION_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/
  const GAPS = { sm: 'var(--hdsi-space-2)', md: 'var(--hdsi-space-3)', lg: 'var(--hdsi-space-4)' }
  const REPEAT_LIMIT = 500

  const components = new Map()   // id → { version, accepts?, render(props, ctx) }
  const slots = new Map()        // slotId → LayoutNode[]（官方页面的扩展点注册）

  function registerComponent(id, definition) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(String(id || ''))) return false
    if (typeof definition?.render !== 'function') return false
    components.set(id, { version: definition.version || '0.0.1', accepts: definition.acceptes || definition.accepts || [], render: definition.render })
    return true
  }

  function registerSlot(slotId, node) {
    if (!/^[\w.-]+$/.test(String(slotId || '')) || !node) return false
    if (!slots.has(slotId)) slots.set(slotId, [])
    slots.get(slotId).push(node)
    return true
  }

  // ── 验证器（§33.3：解析器必须拒绝函数、表达式与未登记节点）──────────
  function validateNode(node, errors, path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { errors.push(`${path}: 节点必须是对象`); return }
    if (typeof node.type !== 'string' || !NODE_TYPES.includes(node.type)) { errors.push(`${path}: 未知节点类型 ${JSON.stringify(node.type)}`); return }
    if (typeof node.className === 'string' && /[<>]/.test(node.className)) errors.push(`${path}: className 含标记字符`)
    switch (node.type) {
      case 'stack': case 'row': case 'grid': case 'scroll': {
        if (node.gap !== undefined && !(node.gap in GAPS)) errors.push(`${path}: gap 档位非法`)
        if (node.type === 'grid' && node.columns !== undefined) {
          const cols = node.columns
          if (typeof cols !== 'object' || !Number.isFinite(cols.min) || cols.min < 80 || cols.min > 960) errors.push(`${path}: grid.columns.min 需为 80–960 的像素值`)
        }
        if (node.type === 'scroll' && !['x', 'y', 'both'].includes(node.axis)) errors.push(`${path}: scroll.axis 非法`)
        const children = node.type === 'scroll' ? (node.child ? [node.child] : []) : node.children || []
        if (node.type === 'scroll' && !node.child) errors.push(`${path}: scroll 需要 child`)
        if (node.type !== 'scroll' && !Array.isArray(children)) errors.push(`${path}: children 必须是数组`)
        else children.forEach((child, i) => validateNode(child, errors, `${path}.children[${i}]`))
        break
      }
      case 'split': {
        if (!['horizontal', 'vertical'].includes(node.direction)) errors.push(`${path}: split.direction 非法`)
        if (!Number.isFinite(node.ratio) || node.ratio < 0.05 || node.ratio > 0.95) errors.push(`${path}: split.ratio 需在 0.05–0.95`)
        if (!Array.isArray(node.children) || node.children.length !== 2) errors.push(`${path}: split 恰有两个 children`)
        else node.children.forEach((child, i) => validateNode(child, errors, `${path}.children[${i}]`))
        break
      }
      case 'tabs': {
        if (!Array.isArray(node.items) || !node.items.length) { errors.push(`${path}: tabs 需要 items`); break }
        node.items.forEach((item, i) => {
          if (!item || typeof item.id !== 'string' || typeof item.label !== 'string') errors.push(`${path}.items[${i}]: 需要 id 与 label`)
          if (typeof item.label === 'string' && /[<>]/.test(item.label)) errors.push(`${path}.items[${i}]: label 含标记字符`)
          validateNode(item.content, errors, `${path}.items[${i}].content`)
        })
        break
      }
      case 'when': {
        validateCondition(node.condition, errors, `${path}.condition`)
        validateNode(node.then, errors, `${path}.then`)
        if (node.else !== undefined) validateNode(node.else, errors, `${path}.else`)
        break
      }
      case 'repeat': {
        if (typeof node.source !== 'string' || !/^[\w-]+(\.[\w-]+)*$/.test(node.source)) errors.push(`${path}: repeat.source 必须是 View Path`)
        if (typeof node.key !== 'string' || !node.key) errors.push(`${path}: repeat 需要 key`)
        validateNode(node.item, errors, `${path}.item`)
        if (node.empty !== undefined) validateNode(node.empty, errors, `${path}.empty`)
        break
      }
      case 'component': {
        if (typeof node.component !== 'string' || !components.has(node.component)) errors.push(`${path}: 未登记组件 ${JSON.stringify(node.component)}`)
        if (node.props !== undefined && (typeof node.props !== 'object' || Array.isArray(node.props))) errors.push(`${path}: props 必须是对象`)
        if (node.props) for (const [key, value] of Object.entries(node.props)) {
          if (typeof value === 'string' && (value.includes('=>') || /^function\b/.test(value.trim()) || value.trim().startsWith('javascript:'))) errors.push(`${path}.props.${key}: 禁止函数或表达式`)
        }
        break
      }
      case 'slot': {
        if (typeof node.slot !== 'string' || !/^[\w.-]+$/.test(node.slot)) errors.push(`${path}: slot id 非法`)
        if (node.fallback !== undefined) validateNode(node.fallback, errors, `${path}.fallback`)
        break
      }
      case 'divider': case 'spacer': break
    }
  }

  function validateCondition(condition, errors, path) {
    if (!condition || typeof condition !== 'object') { errors.push(`${path}: 条件必须是对象`); return }
    if (typeof condition.path !== 'string' || !/^[\w-]+(\.[\w-]+)*$/.test(condition.path)) errors.push(`${path}.path 必须是 View Path`)
    if (!CONDITION_OPS.includes(condition.op)) errors.push(`${path}: 未知条件运算 ${JSON.stringify(condition.op)}`)
    if (typeof condition.value === 'string' && (condition.value.includes('=>') || condition.value.includes('('))) errors.push(`${path}.value 禁止表达式`)
    if (['in'].includes(condition.op) && !Array.isArray(condition.value)) errors.push(`${path}: in 需要 value 数组`)
  }

  function validateMotionBinding(binding, errors, path) {
    if (binding === undefined) return
    if (typeof binding === 'string') {
      if (!MOTION_NAME_RE.test(binding)) errors.push(`${path}: preset 名非法`)
      return
    }
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) { errors.push(`${path}: 必须是 preset 名或对象`); return }
    for (const [trigger, preset] of Object.entries(binding)) {
      if (!MOTION_TRIGGERS.includes(trigger)) errors.push(`${path}.${trigger}: 未知触发名`)
      else if (typeof preset !== 'string' || !MOTION_NAME_RE.test(preset)) errors.push(`${path}.${trigger}: preset 名非法`)
    }
  }

  function validatePage(page) {
    const errors = []
    if (!page || typeof page !== 'object' || !page.page) { errors.push('页面定义缺少 page 根'); return { ok: false, errors } }
    const inner = page.page
    if (typeof inner.id !== 'string' || !/^[\w-]+$/.test(inner.id)) errors.push('page.id 非法')
    if (typeof inner.viewModel === 'string' && !/^[\w-]+$/.test(inner.viewModel)) errors.push('page.viewModel 非法')
    validateMotionBinding(inner.motion, errors, 'page.motion')
    validateNode(inner.layout, errors, 'layout')
    return { ok: errors.length === 0, errors }
  }

  // ── 求值与绑定 ─────────────────────────────────────────
  function evaluateCondition(condition, ctx) {
    if (!condition || typeof condition.path !== 'string') return false
    const dot = condition.path.indexOf('.')
    if (dot <= 0) return false
    const ns = condition.path.slice(0, dot)
    ctx?.deps?.add(ns)
    const actual = ctx?.vm?.get(condition.path)
    const expected = condition.value
    switch (condition.op) {
      case 'equals': return actual === expected
      case 'notEquals': return actual !== expected
      case 'in': return Array.isArray(expected) && expected.includes(actual)
      case 'exists': return actual !== undefined && actual !== null
      case 'gt': return compare(actual, expected) > 0
      case 'gte': return compare(actual, expected) >= 0
      case 'lt': return compare(actual, expected) < 0
      case 'lte': return compare(actual, expected) <= 0
      default: return false
    }
  }
  function compare(a, b) {
    const na = Number(a), nb = Number(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    return String(a ?? '') < String(b ?? '') ? -1 : String(a ?? '') > String(b ?? '') ? 1 : 0
  }

  /** $item.<path> / $vm.<path> 引用解析；其余原样返回（纯数据） */
  function resolveProp(value, ctx) {
    if (typeof value !== 'string') return value
    if (value.startsWith('$item.') && ctx?.scope?.$item !== undefined) return pickPath(ctx.scope.$item, value.slice(6))
    if (value.startsWith('$vm.')) {
      const path = value.slice(4)
      const dot = path.indexOf('.')
      if (dot > 0) ctx?.deps?.add(path.slice(0, dot))
      return ctx?.vm?.get(path)
    }
    return value
  }
  function pickPath(target, path) {
    return String(path).split('.').reduce((value, key) => (value === undefined || value === null) ? undefined : value[key], target)
  }

  // ── 渲染器 ─────────────────────────────────────────────
  function el(tag, className, html) {
    const node = root.document.createElement(tag)
    if (className) node.className = className
    if (html !== undefined) node.innerHTML = html
    return node
  }

  function applyGapStyle(node, gap) {
    if (gap && GAPS[gap]) node.style.gap = GAPS[gap]
  }

  function decorateMotion(output, binding) {
    if (!output || typeof output !== 'object' || !binding) return output
    const map = typeof binding === 'string' ? { enter: binding } : binding
    const normalized = {}
    for (const trigger of MOTION_TRIGGERS) {
      if (typeof map?.[trigger] === 'string' && MOTION_NAME_RE.test(map[trigger])) normalized[trigger] = map[trigger]
    }
    if (!Object.keys(normalized).length) return output
    // 元数据只由宿主读取；主题包没有机会注入监听器或脚本。
    output.__hdsiMotion = Object.freeze(normalized)
    if (typeof output.setAttribute === 'function') {
      for (const [trigger, preset] of Object.entries(normalized)) output.setAttribute(`data-hdsi-motion-${trigger}`, preset)
    }
    return output
  }

  function render(node, ctx) {
    if (!node || typeof node !== 'object') return null
    const finish = output => decorateMotion(output, node.motion)
    switch (node.type) {
      case 'stack': case 'row': {
        const box = el('div', node.className || (node.type === 'stack' ? 'dsl-stack' : 'dsl-row'))
        // 带 className 时布局交给该类自己的 CSS（如 .connect-layout 网格）
        if (!node.className) {
          box.style.display = 'flex'
          box.style.flexDirection = node.type === 'stack' ? 'column' : 'row'
        }
        if (node.grow) box.style.flex = '1'
        applyGapStyle(box, node.gap)
        for (const child of node.children || []) { const rendered = render(child, ctx); if (rendered) box.appendChild(rendered) }
        return finish(box)
      }
      case 'grid': {
        const box = el('div', node.className || 'dsl-grid')
        if (!node.className) {
          box.style.display = 'grid'
          if (node.columns) box.style.gridTemplateColumns = `repeat(auto-fit, minmax(${node.columns.min}px, ${node.columns.max ?? 1}fr))`
          else if (Number.isFinite(node.cols)) box.style.gridTemplateColumns = `repeat(${node.cols}, minmax(0, 1fr))`
        }
        applyGapStyle(box, node.gap)
        for (const child of node.children || []) { const rendered = render(child, ctx); if (rendered) box.appendChild(rendered) }
        return finish(box)
      }
      case 'split': {
        const box = el('div', node.className || 'dsl-split')
        box.style.display = 'flex'
        box.style.flexDirection = node.direction === 'vertical' ? 'column' : 'row'
        const [first, second] = node.children || []
        const a = render(first, ctx), b = render(second, ctx)
        for (const [pane, ratio] of [[a, node.ratio], [b, 1 - node.ratio]]) {
          if (!pane) continue
          pane.style.flex = String(ratio)
          pane.style.minWidth = '0'; pane.style.minHeight = '0'
          box.appendChild(pane)
        }
        return finish(box)
      }
      case 'tabs': {
        const box = el('div', node.className || 'dsl-tabs')
        const bar = el('div', 'dsl-tabbar')
        const panels = el('div', 'dsl-tabpanels')
        const items = node.items || []
        items.forEach((item, index) => {
          const tab = el('button', index === 0 ? 'active' : '')
          tab.type = 'button'
          tab.textContent = item.label
          tab.addEventListener('click', () => {
            bar.querySelectorAll('button').forEach(btn => btn.classList.remove('active'))
            panels.querySelectorAll(':scope > .dsl-tabpanel').forEach(pane => pane.classList.remove('active'))
            tab.classList.add('active')
            panels.children[index]?.classList.add('active')
          })
          bar.appendChild(tab)
          const panel = el('div', 'dsl-tabpanel' + (index === 0 ? ' active' : ''))
          const content = render(item.content, ctx)
          if (content) panel.appendChild(content)
          panels.appendChild(panel)
        })
        box.append(bar, panels)
        return finish(box)
      }
      case 'scroll': {
        const box = el('div', node.className || 'dsl-scroll')
        box.style.overflow = node.axis === 'x' ? 'auto hidden' : node.axis === 'y' ? 'hidden auto' : 'auto'
        if (node.grow) box.style.flex = '1'
        const child = render(node.child, ctx)
        if (child) box.appendChild(child)
        return finish(box)
      }
      case 'when': {
        const branch = evaluateCondition(node.condition, ctx) ? node.then : node.else
        return branch ? finish(render(branch, ctx)) : null
      }
      case 'repeat': {
        const dot = String(node.source || '').indexOf('.')
        if (dot <= 0) return null
        ctx?.deps?.add(node.source.slice(0, dot))
        const items = ctx?.vm?.get(node.source)
        // 路径不存在/非数组同样落入 empty 分支——主题包不该为此得到空白区域
        if (!Array.isArray(items)) return node.empty ? finish(render(node.empty, ctx)) : null
        if (items.length > REPEAT_LIMIT) return finish(el('div', 'dsl-error', `repeat 数据超限（${items.length} > ${REPEAT_LIMIT}）`))
        if (!items.length) return node.empty ? finish(render(node.empty, ctx)) : null
        const box = el('div', node.className || 'dsl-repeat')
        box.style.display = 'contents'
        items.forEach((item, index) => {
          const childCtx = { ...ctx, scope: { ...(ctx?.scope || {}), $item: item, $index: index } }
          const rendered = render(node.item, childCtx)
          if (rendered) box.appendChild(rendered)
        })
        return finish(box)
      }
      case 'component': {
        const def = components.get(node.component)
        if (!def) return finish(el('div', 'dsl-error', `未登记组件：${node.component}`))
        const props = {}
        for (const [key, value] of Object.entries(node.props || {})) props[key] = resolveProp(value, ctx)
        try {
          const output = def.render(props, ctx)
          // 组件登记方受核心控制（社区包只能引用已登记 id），返回值只可能是元素或 HTML 字符串
          if (output && typeof output === 'object' && typeof output.appendChild === 'function') return finish(output)
          if (typeof output === 'string') return finish(el('div', node.className || '', output))
          return null
        } catch (error) {
          return finish(el('div', 'dsl-error', `组件渲染失败：${node.component} — ${error}`))
        }
      }
      case 'slot': {
        const extensions = slots.get(node.slot) || []
        if (extensions.length) {
          const box = el('div', 'dsl-slot')
          for (const extension of extensions) { const rendered = render(extension, ctx); if (rendered) box.appendChild(rendered) }
          return finish(box)
        }
        return node.fallback ? finish(render(node.fallback, ctx)) : null
      }
      case 'divider': return finish(el('div', 'dsl-divider'))
      case 'spacer': { const space = el('div', 'dsl-spacer'); space.style.flex = '1'; return finish(space) }
      default: return null
    }
  }

  /** 官方 Button 组件（§22.4）：动作绑定的唯一示范；confirm 由注册表强制 */
  registerComponent('Button', {
    version: '1.0.0',
    render(props, ctx) {
      const button = el('button', 'dsl-button' + (props.intent === 'primary' ? ' primary' : ''))
      button.type = 'button'
      button.textContent = String(props.label ?? '')
      if (props.action) {
        button.addEventListener('click', async () => {
          const args = typeof props.args === 'object' && props.args
            ? Object.fromEntries(Object.entries(props.args).map(([key, value]) => [key, resolveProp(value, ctx)]))
            : undefined
          await ctx?.actions?.dispatch(String(props.action), args)
        })
      }
      return button
    },
  })

  return {
    NODE_TYPES, CONDITION_OPS, MOTION_TRIGGERS,
    registerComponent, registerSlot, components: () => [...components.keys()],
    validate: validateNode, validatePage, render, evaluateCondition, resolveProp,
  }
})
