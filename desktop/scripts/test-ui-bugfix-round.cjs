// 五联修回归（2026-10-19 bug 批次）：
//  1. 就绪检查 needs-reload：按钮必须是真·重载（unload→load），而非对运行中
//     worker 的幂等 no-op load；动作 action 从 'load' 改为 'reload'。
//  2. 运行相位检查：paused → warn + 「切换到运行」一键 setPhase('running')。
//  3. 删除剧本：window.prompt 在 Electron 渲染层不渲染（恒返 null）——改宿主
//     #prompt-dialog（requireMatch 门控 + 取消路径）。
//  4. NOW 播放头：几何缓存必须有重测通路（window resize / ResizeObserver），
//     且 height 单独变化也要落盘（旧代码只跟 top 联动）。
//  5. 账号卡网格：min-width:0 + 断行/省略必须实际生效（轨道不被长 URL 撑爆）。
const path = require('node:path')
const assert = require('node:assert/strict')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

const READINESS = {
  checks: [
    { id: 'worker', label: 'Worker 已加载', status: 'err', detail: '配置已保存，但当前 Worker 仍使用旧配置。', action: 'reload' },
    { id: 'phase', label: '运行相位', status: 'warn', detail: '入站消息只进入收件箱排队，不会触发回复。', action: 'run' },
    { id: 'channel', label: 'QQ 渠道已配置', status: 'ok', detail: '' },
    { id: 'model', label: '模型配置', status: 'ok', detail: '' },
    { id: 'account', label: '账号已绑定', status: 'ok', detail: '' },
    { id: 'whitelist', label: '交往对象已添加', status: 'ok', detail: '' },
  ],
  allOk: false,
  criticalOk: true,
  channel: { layers: [] },
  account: { layers: [] },
}

;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'))
    await page.goto('file://' + path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html'))
    await page.waitForFunction(() => document.querySelector('.primary-clip'))
    await page.evaluate(READINESS => {
      window.__ipcCalls = []
      window.confirm = () => true // reloadSelected / deleteStory 的原生确认
      window.hdsiDesktop.connection = { firstRunReadiness: async () => READINESS }
      const rec = (name) => async (...args) => { window.__ipcCalls.push([name, ...args]) }
      window.hdsiDesktop.stories.unload = rec('unload')
      window.hdsiDesktop.stories.load = rec('load')
      window.hdsiDesktop.stories.setPhase = async (id, phase) => {
        window.__ipcCalls.push(['setPhase', id, phase])
        const story = state.stories.find(item => item.meta.id === id)
        if (story) story.meta.phase = phase
        return story
      }
      window.hdsiDesktop.stories.delete = rec('delete')
      state.storyId = 'fixture'
      // readiness 缓存清掉，保证 force 取到 stub
      readinessCache.delete('fixture')
    }, READINESS)
    await page.evaluate(() => selectStory('fixture', false))
    await new Promise(r => setTimeout(r, 200))

    // ── 1+2：就绪检查动作按钮 ──────────────────────────────────────────
    await page.evaluate(() => setSurface('connect'))
    await page.evaluate(() => renderReadyPanel())
    await page.waitForFunction(() => document.querySelector('#connect-ready-panel [data-ready-action="reload"]'))
    const buttons = await page.evaluate(() => ({
      reload: document.querySelector('[data-ready-action="reload"]')?.textContent.trim(),
      run: document.querySelector('[data-ready-action="run"]')?.textContent.trim(),
      summary: document.querySelector('#connect-ready-panel .ready-summary')?.textContent,
    }))
    assert.match(buttons.reload, /重载 Worker/, 'needs-reload 必须提供重载按钮（不再是误导性的“加载 Worker”）')
    assert.match(buttons.run, /切换到运行/, 'paused 相位必须提供一键切回运行')
    assert.match(buttons.summary, /基本就绪/, '相位 warn 不得把整体打成 ERROR 尚未就绪')

    // 点击「重载 Worker」：必须 unload → load 成对出现（真·重载）
    await page.click('[data-ready-action="reload"]')
    await page.waitForFunction(() => window.__ipcCalls.some(call => call[0] === 'load'))
    const reloadCalls = await page.evaluate(() => window.__ipcCalls.filter(call => ['unload', 'load'].includes(call[0])))
    assert.deepEqual(reloadCalls, [['unload', 'fixture'], ['load', 'fixture']], `重载必须是 unload→load，实际：${JSON.stringify(reloadCalls)}`)

    // 点击「切换到运行」：setPhase(running)
    await page.click('#connect-ready-panel [data-ready-action="run"]')
    await page.waitForFunction(() => window.__ipcCalls.some(call => call[0] === 'setPhase'))
    const phaseCall = await page.evaluate(() => window.__ipcCalls.find(call => call[0] === 'setPhase'))
    assert.deepEqual(phaseCall, ['setPhase', 'fixture', 'running'])

    // ── 3：删除剧本对话框（hostPrompt）─────────────────────────────────
    await page.evaluate(() => { window.__deletePromise = deleteStory(selectedStory()) })
    await page.waitForFunction(() => byId('prompt-dialog').open === true)
    const gated = await page.evaluate(() => ({ disabled: byId('prompt-confirm').disabled, hint: byId('prompt-hint').hidden }))
    assert.equal(gated.disabled, true, 'requireMatch 未满足时确认必须禁用')
    // 错误 ID 依然禁用；正确 ID 解锁
    await page.type('#prompt-input', 'wrong')
    assert.equal(await page.evaluate(() => byId('prompt-confirm').disabled), true)
    await page.evaluate(() => { byId('prompt-input').value = '' })
    await page.type('#prompt-input', 'fixture')
    assert.equal(await page.evaluate(() => byId('prompt-confirm').disabled), false)
    // 取消路径：promise 以 null 收场，不调用 delete
    await page.click('#prompt-cancel')
    const cancelled = await page.evaluate(() => Promise.race([window.__deletePromise, new Promise(r => setTimeout(() => r('TIMEOUT'), 1500))]))
    assert.equal(cancelled, undefined, '取消路径必须让 deleteStory 正常返回（不悬挂）')
    assert.equal(await page.evaluate(() => window.__ipcCalls.some(call => call[0] === 'delete')), false, '取消不得触发删除')
    // 重来一次并确认
    await page.evaluate(() => { window.__deletePromise = deleteStory(selectedStory()) })
    await page.waitForFunction(() => byId('prompt-dialog').open === true)
    await page.type('#prompt-input', 'fixture')
    await page.click('#prompt-confirm')
    await page.waitForFunction(() => window.__ipcCalls.some(call => call[0] === 'delete'))
    assert.equal(await page.evaluate(() => byId('prompt-dialog').open), false, '确认后对话框必须关闭')

    // ── 4：NOW 播放头几何重测通路 ──────────────────────────────────────
    await page.evaluate(() => { setSurface('studio'); renderArrangement() })
    await page.waitForFunction(() => document.querySelector('.now-playhead'))
    const h0 = await page.evaluate(() => canvas.playhead.h)
    await page.evaluate(() => {
      const arr = byId('arrangement')
      arr.style.height = Math.max(60, Math.round(arr.offsetHeight / 2)) + 'px'
      window.dispatchEvent(new Event('resize'))
    })
    await page.waitForFunction(prev => canvas.playhead.h < prev, { timeout: 3000 }, h0)
    // height 单独变化也必须写入元素（旧代码 height 只跟 top 联动）。
    // 冻结 remeasure：这里验证 rAF 应用逻辑；观测器通路上面已验证。
    await page.evaluate(() => { byId('arrangement').style.height = '' })
    await new Promise(r => setTimeout(r, 150))
    const applied = await page.evaluate(async () => {
      const orig = refreshPlayheadGeometry
      refreshPlayheadGeometry = () => {}
      try {
        canvas.pxPerMs = 0; canvas.viewWidthPx = 800 // timeToPx(now)=0 → 播放头恒在视口内
        canvas.playhead = { x: 10, y: 7, h: 123 }
        const el = document.querySelector('.now-playhead')
        el.style.top = '7px'; el.style.height = '40px'
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        return el.style.height
      } finally { refreshPlayheadGeometry = orig }
    })
    assert.equal(applied, '123px', 'rAF 循环必须独立应用新高度')

    // ── 5：账号卡网格稳定化 ────────────────────────────────────────────
    await page.evaluate(() => {
      window.hdsiDesktop.accounts = { list: async () => [{ storyId: 'fixture', storyName: 'UI fixture', selfId: '10086', nickname: '测试角色', channelKind: 'qq', externalState: 'online', externalUpstream: { endpoint: 'ws://127.0.0.1:6709/onebot/v11/ws?very-long-query-string-to-force-overflow-behavior' } }], status: async () => ({}) }
      setSurface('connect')
    })
    await page.evaluate(() => renderConnectView())
    await page.waitForFunction(() => document.querySelector('.account-card'))
    const cardCss = await page.evaluate(() => {
      const card = document.querySelector('.account-card')
      const span = card.querySelector('.account-card-endpoint span')
      const cs = getComputedStyle(card), ss = getComputedStyle(span)
      const grid = getComputedStyle(card.closest('.account-cards'))
      return { minWidth: cs.minWidth, wordBreak: ss.wordBreak, overflowWrap: ss.overflowWrap, columns: grid.gridTemplateColumns.split(' ').length, cardWidth: card.getBoundingClientRect().width, containerWidth: card.closest('.account-cards').getBoundingClientRect().width }
    })
    assert.equal(cardCss.minWidth, '0px', '卡片必须显式 min-width:0（解除 grid auto 最小宽）')
    assert.equal(cardCss.wordBreak, 'break-all', 'endpoint 必须可断行')
    assert.ok(cardCss.cardWidth <= cardCss.containerWidth + 1, `卡片宽（${cardCss.cardWidth}）不得超过容器（${cardCss.containerWidth}）`)

    // ── 6：诊断日志等级下拉（替掉 select[multiple] + size 技巧的怪框）────
    await page.evaluate(() => setSurface('logs'))
    const dropdown = await page.evaluate(() => {
      const select = byId('log-level-filter')
      return { multiple: select.multiple, options: [...select.options].map(o => [o.value, o.textContent]) }
    })
    assert.equal(dropdown.multiple, false, '等级筛选必须是普通单选下拉，不得再用 multiple')
    assert.deepEqual(dropdown.options, [['', '全部等级'], ['debug', '仅 debug'], ['info+', 'info 及以上'], ['warn+', 'warn 及以上'], ['error', '仅 error']])
    const threshold = await page.evaluate(() => {
      byId('log-level-filter').value = 'info+'
      applyLogFilters()
      return [...logFilter.levels].sort()
    })
    assert.deepEqual(threshold, ['error', 'info', 'warn'], '「info 及以上」= info/warn/error 阈值集合')
    const reset = await page.evaluate(() => {
      byId('log-level-filter').selectedIndex = 0
      applyLogFilters()
      return logFilter.levels.size
    })
    assert.equal(reset, 0, '「全部等级」必须清空等级过滤')

    // ── 7：时间尺度旋钮方向（上拉=顺时针=增大范围）─────────────────────
    await page.evaluate(() => setSurface('studio'))
    const knob = await page.evaluate(() => {
      const wrap = document.querySelector('.time-knob-wrap')
      wrap.setPointerCapture = () => {} // 合成 PointerEvent 无活动指针，stub 掉捕获
      const rect = wrap.getBoundingClientRect()
      const base = { bubbles: true, clientX: rect.x + 5, clientY: rect.y + 5, pointerId: 1, isPrimary: true }
      const before = layoutFor().spanMinutes
      wrap.dispatchEvent(new PointerEvent('pointerdown', base))
      wrap.dispatchEvent(new PointerEvent('pointermove', { ...base, clientY: rect.y - 55 })) // 上拉 60px
      wrap.dispatchEvent(new PointerEvent('pointerup', base))
      const afterUp = layoutFor().spanMinutes
      wrap.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientY: rect.y + 5 }))
      wrap.dispatchEvent(new PointerEvent('pointermove', { ...base, clientY: rect.y + 65 })) // 下拉 60px
      wrap.dispatchEvent(new PointerEvent('pointerup', base))
      const afterDown = layoutFor().spanMinutes
      return { before, afterUp, afterDown }
    })
    assert.ok(knob.afterUp > knob.before, `上拉必须增大时间范围（旋钮顺时针）：${JSON.stringify(knob)}`)
    assert.ok(knob.afterDown < knob.afterUp, `下拉必须缩小时间范围（旋钮逆时针）：${JSON.stringify(knob)}`)

    assert.deepEqual(errors, [], `页面错误：${errors.join(' | ')}`)
    console.log('test-ui-bugfix-round: PASS（重载/相位/删除对话框/播放头/账号卡/日志下拉/旋钮方向 ×7）')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exit(1) })
