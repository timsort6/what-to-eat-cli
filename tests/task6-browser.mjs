import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openSearchFixture, candidates, installProbes } from './task6-fixture.mjs'

test('task6真实浏览器回归：重试焦点、稳定几何与搜索可读性', async t => {
  const f = await openSearchFixture()
  t.after(f.close)
  const { page, wait } = f
  await f.reset()
  await f.omowright.emulate(page, 'desktop-1440')
  for (const scheme of ['light', 'dark']) {
    await page.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, f.sid)
    const borders = () => page.evaluate(() => {
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel / 255)
        .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
        .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0)
      return [...document.querySelectorAll('.location-search input')].map(input => {
        const css = getComputedStyle(input), edge = luminance(css.borderColor), surface = luminance(css.backgroundColor)
        return { focused: input === document.activeElement, hovered: input.matches(':hover'), border: css.borderColor,
          background: css.backgroundColor, outline: css.outlineWidth, outlineStyle: css.outlineStyle,
          width: input.getBoundingClientRect().width, height: input.getBoundingClientRect().height,
          ratio: (Math.max(edge, surface) + .05) / (Math.min(edge, surface) + .05) }
      })
    })
    for (const [index, selector] of ['input[type=search]', 'input[autocomplete=address-level2]'].entries()) {
      await page.evaluate(() => document.activeElement.blur())
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 }, f.sid)
      const normal = (await borders())[index]
      assert.ok(!normal.focused && !normal.hovered && normal.ratio >= 3, JSON.stringify({ scheme, selector, normal }))
      await page.locator(selector).hover()
      const hover = (await borders())[index]
      assert.ok(hover.hovered && !hover.focused && hover.ratio >= 3, JSON.stringify({ scheme, selector, hover }))
      assert.notEqual(hover.border, normal.border, `悬停边框必须区别于默认边框：${scheme} ${selector}`)
      assert.deepEqual([hover.background, hover.width, hover.height], [normal.background, normal.width, normal.height])
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 }, f.sid)
      await page.evaluate(selector => document.querySelector(selector).focus(), selector)
      const focus = (await borders())[index]
      assert.ok(focus.focused && !focus.hovered)
      assert.equal(focus.outline, '3px')
      assert.equal(focus.outlineStyle, 'solid')
    }
  }
  await f.omowright.emulate(page, 'iphone-14')
  await page.fill('input[type=search]', '公园')
  const geometry = () => page.evaluate(() => ['.location-button', '.empty-state button', '.location-search .button-primary', '.search-actions'].map(selector => {
    const rect = document.querySelector(selector).getBoundingClientRect()
    return { selector, y: rect.y + scrollY, height: rect.height }
  }))
  const waiting = await geometry()
  await f.nextSearch()
  assert.deepEqual(await geometry(), waiting)
  f.release(candidates, 502)
  await wait(() => document.querySelector('.location-search [role=alert]'))
  assert.deepEqual(await geometry(), waiting)
  await page.evaluate(() => document.querySelector('.search-actions button:last-child').focus())
  await page.keyboard.press('Enter')
  const focus = () => page.evaluate(() => document.activeElement?.getAttribute('type'))
  assert.equal(await focus(), 'search')
  await f.nextSearch()
  assert.equal(await focus(), 'search')
  f.release(candidates.map(item => ({ ...item, name: '很长的候选名称'.repeat(8), address: '很长的详细地址'.repeat(12) })))
  await wait(() => document.querySelector('.location-search .address-row'))
  assert.equal(await focus(), 'search')
  assert.deepEqual(await geometry(), waiting)
  const style = await page.evaluate(() => {
    const css = selector => getComputedStyle(document.querySelector(selector))
    const confirm = css('.location-search .button-primary')
    return { primary: css('.address-copy strong').fontSize, secondary: css('.address-copy small').fontSize,
      gap: css('.location-search .address-list').rowGap, opacity: confirm.opacity, color: confirm.color, background: confirm.backgroundColor,
      width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth }
  })
  assert.ok(parseFloat(style.primary) >= 17, JSON.stringify(style))
  assert.ok(parseFloat(style.secondary) >= 15)
  assert.ok(parseFloat(style.gap) >= 8)
  assert.equal(style.opacity, '1')
  assert.equal(style.overflow, false)
  await page.keyboard.press('Escape')
  assert.equal(await focus(), 'search')
  assert.deepEqual(await geometry(), waiting)
})

test('task17视觉回归：手机字号、禁用/次要按钮、摘要断行、自定义半径行对齐、侧栏可达', async t => {
  const f = await openSearchFixture()
  t.after(f.close)
  const { page, wait } = f
  // 地址簿较长 + 正文较长（模拟长回答）时，侧栏高于 1440×900 视口才会暴露 sticky 遮挡。
  f.setAddresses(Array.from({ length: 10 }, (_, i) => ({ id: i + 1, label: `地址${i + 1}`, is_default: i === 0, location: `116.40${i},39.90${i}`, formatted_address: `测试路 ${i + 1} 号` })))
  await f.reset()
  await installProbes(page)
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  // 各项先收集再统一断言，旧代码一次即可暴露全部失败项。
  const result = {}, problems = []
  const check = (ok, message) => { if (!ok) problems.push(message) }

  await f.omowright.emulate(page, 'iphone-14')
  await settle()
  result.mobile = await page.evaluate(() => {
    const p = window.__probe, summary = document.querySelector('.preference-summary')
    const segments = summary.textContent.replace('当前条件：', '').split(' · ')
    return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
      body: p.size('.ask-panel textarea'), hint: p.size('.preference-summary'), label: p.size('.field > span'), legend: p.size('.preferences legend'),
      button: p.size('.ask-panel button[type=submit]'), eyebrow: p.size('.eyebrow'), empty: p.size('.result-empty'),
      segments: segments.map(segment => [segment, p.lines(summary, segment)]),
      submit: p.button(document.querySelector('.ask-panel button[type=submit]')),
      confirm: p.button(document.querySelector('.location-search .button-primary')),
      quiet: [...document.querySelectorAll('.search-actions button')].map(node => p.button(node)) }
  })
  const m = result.mobile
  assert.equal(m.width, 390)
  assert.equal(m.overflow, false, JSON.stringify(m))
  check(m.body >= 17 && m.hint >= 15 && m.label >= 15 && m.legend >= 15 && m.button >= 15 && m.empty >= 15 && m.eyebrow >= 13, `C1 手机字号：${JSON.stringify(m)}`)
  for (const [segment, lines] of m.segments) check(lines === 1, `C5 摘要分段不得被拆行：${segment}`)
  for (const primary of [m.submit, m.confirm]) {
    assert.ok(primary.disabled, primary.text)
    check(primary.opacity === '1', `H5 禁用主按钮不得用 opacity：${JSON.stringify(primary)}`)
    check(primary.textContrast >= 4.5, `H5 禁用主按钮文字对比度：${JSON.stringify(primary)}`)
  }
  for (const quiet of m.quiet) {
    check(quiet.disabled && quiet.opacity === '1' && quiet.textContrast >= 4.5, `E2 禁用次要按钮弱化但可读：${JSON.stringify(quiet)}`)
    check(quiet.filled === false, `E2 禁用次要按钮不得是实底：${JSON.stringify(quiet)}`)
  }
  await page.fill('input[type=search]', '公园')
  await f.nextSearch()
  f.release(candidates, 502)
  await wait(() => document.querySelector('.location-search [role=alert]'))
  result.enabledQuiet = await page.evaluate(() => [...document.querySelectorAll('.search-actions button')].map(node => window.__probe.button(node)))
  for (const quiet of result.enabledQuiet) {
    check(!quiet.disabled && quiet.bounded && quiet.textContrast >= 4.5, `E2 可用次要按钮需有可见边界：${JSON.stringify(quiet)}`)
  }

  await f.omowright.emulate(page, 'desktop-1440')
  await page.evaluate(() => {
    const select = [...document.querySelectorAll('.preferences label.field')].find(node => node.querySelector('span').textContent.startsWith('搜索范围')).querySelector('select')
    select.value = 'custom'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await wait(() => document.querySelector('.preferences input[type=number]'))
  await settle()
  result.row = await page.evaluate(() => [...document.querySelectorAll('.preference-grid > .field')].map(field => {
    const control = field.querySelector('select, input').getBoundingClientRect(), box = field.getBoundingClientRect()
    return { label: field.querySelector('span').textContent, row: Math.round(box.top), height: Math.round(control.height), bottom: Math.round(control.bottom) }
  }))
  for (const item of result.row) check(Math.abs(item.height - 44) <= 1, `A7 控件高度应为 44px：${JSON.stringify(result.row)}`)
  const rows = Object.groupBy(result.row, item => item.row)
  for (const row of Object.values(rows)) check(Math.max(...row.map(item => item.bottom)) - Math.min(...row.map(item => item.bottom)) <= 1, `A7 同行控件底边对齐：${JSON.stringify(result.row)}`)

  await page.evaluate(() => { document.querySelector('.content-column').style.paddingBottom = '1600px' })
  await page.evaluate(() => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * .35))
  await settle()
  result.sticky = await page.evaluate(() => {
    const aside = document.querySelector('.sidebar'), search = document.querySelector('.location-search'), css = getComputedStyle(aside)
    const a = aside.getBoundingClientRect(), s = search.getBoundingClientRect()
    return { innerHeight, scrollY: Math.round(scrollY), asideTop: Math.round(a.top), asideBottom: Math.round(a.bottom), searchTop: Math.round(s.top), overflowY: css.overflowY,
      scrollable: ['auto', 'scroll'].includes(css.overflowY) && aside.scrollHeight > aside.clientHeight, position: css.position }
  })
  const st = result.sticky
  // sticky 侧栏不得有落在视口下方、随页面滚动也到不了的部分；搜索区要么在视口内，要么可在侧栏内滚动到达。
  check((st.position !== 'sticky' || st.asideBottom <= st.innerHeight + 1) && (st.searchTop < st.innerHeight || st.scrollable), `A6 侧栏高于视口时搜索区须可达：${JSON.stringify(st)}`)
  // 真实滚轮在侧栏上滚动后，搜索区进入视口。
  const center = await page.evaluate(() => { const r = document.querySelector('.sidebar').getBoundingClientRect(); return { x: r.x + r.width / 2, y: Math.min(r.y + r.height / 2, innerHeight / 2) } })
  for (let i = 0; i < 6; i++) await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...center, deltaX: 0, deltaY: 400 }, f.sid)
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
  result.afterWheel = await page.evaluate(() => { const r = document.querySelector('.location-search').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), innerHeight } })
  check(result.afterWheel.top >= 0 && result.afterWheel.top < result.afterWheel.innerHeight, `A6 滚轮后搜索区可见：${JSON.stringify(result.afterWheel)}`)
  const dir = process.env.TASK17_EVIDENCE_DIR ?? f.evidenceDir
  writeFileSync(join(dir, 'task17-visual-probe.json'), JSON.stringify({ result, problems }, null, 2))
  await page.evaluate(() => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * .35))
  writeFileSync(join(dir, 'task17-1440-sticky-0.35.png'), await page.screenshot())
  assert.deepEqual(problems, [])
})

test('task18保存地址表单禁用“取消”与全局次要按钮禁用样式一致', async t => {
  const f = await openSearchFixture()
  t.after(f.close)
  await f.reset()
  await f.omowright.emulate(f.page, 'desktop-1440')
  await f.page.evaluate(() => document.querySelector('.create-entry').click())
  await f.wait(() => document.querySelector('.address-create'))
  const styles = await f.page.evaluate(() => {
    const pick = node => { const css = getComputedStyle(node); return { color: css.color, background: css.backgroundColor, border: css.borderTopColor, borderWidth: css.borderTopWidth, opacity: css.opacity } }
    const cancel = [...document.querySelectorAll('.address-create button')].find(node => node.textContent.trim() === '取消')
    // 保存中“取消”才禁用且转瞬即逝；直接置 disabled，只验证样式层叠。
    cancel.disabled = true
    const reference = document.querySelector('.search-actions .button-quiet:disabled')
    return { cancel: pick(cancel), reference: pick(reference) }
  })
  assert.deepEqual(styles.cancel, styles.reference, JSON.stringify(styles))
})

test('task6候选详细地址可用真实指针拖选', async t => {
  const f = await openSearchFixture()
  t.after(f.close)
  await f.reset()
  await f.omowright.emulate(f.page, 'desktop-1440')
  await f.page.fill('input[type=search]', '公园')
  await f.nextSearch()
  f.release()
  await f.wait(() => document.querySelector('.location-search .address-row'))
  const box = await f.page.evaluate(() => {
    const node = document.querySelector('.location-search .address-row .address-copy small:last-child')
    node.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.selectNodeContents(node)
    const { left, right, top, height } = range.getBoundingClientRect()
    return { left, right, y: top + height / 2 }
  })
  const mouse = (type, x, buttons) => f.page.cdp.send('Input.dispatchMouseEvent', { type, x, y: box.y, button: 'left', buttons, clickCount: 1 }, f.sid)
  await mouse('mousePressed', box.left + 1, 1)
  for (const step of [.5, 1]) await mouse('mouseMoved', box.left + 1 + (box.right - box.left + 4) * step, 1)
  await mouse('mouseReleased', box.right + 3, 0)
  const selected = await f.page.evaluate(() => getSelection().toString())
  assert.ok(selected.includes(candidates[0].address), `候选地址必须可被选择复制，实际选区：${JSON.stringify(selected)}`)
})

test('task6原生断网显示中文恢复提示且有效字段保持有效', async t => {
  const f = await openSearchFixture()
  t.after(f.close)
  await f.reset()
  await f.page.cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, f.sid)
  await f.page.fill('input[type=search]', '公园')
  await f.wait(() => document.querySelector('.location-search [role=alert]'))
  const state = await f.page.evaluate(() => ({ text: document.querySelector('.location-search [role=alert]').textContent,
    invalid: [...document.querySelectorAll('.location-search input')].map(input => input.getAttribute('aria-invalid')) }))
  assert.match(state.text, /网络.*检查.*重新搜索/)
  assert.doesNotMatch(state.text, /Failed to fetch|NetworkError/)
  assert.deepEqual(state.invalid, ['false', 'false'])
})

for (const field of ['query', 'city']) test(`task6浏览器只将实际超限字段标记无效：${field}`, async t => {
  const f = await openSearchFixture()
  t.after(f.close)
  await f.reset()
  await f.page.fill(field === 'query' ? 'input[type=search]' : 'input[autocomplete=address-level2]', '文'.repeat(field === 'query' ? 81 : 101))
  const state = await f.page.evaluate(() => ({ text: document.querySelector('.location-search [role=alert]').textContent,
    invalid: [...document.querySelectorAll('.location-search input')].map(input => input.getAttribute('aria-invalid')) }))
  assert.deepEqual(state.invalid, field === 'query' ? ['true', 'false'] : ['false', 'true'])
  assert.match(state.text, field === 'query' ? /搜索地点.*80/ : /城市.*100/)
})
