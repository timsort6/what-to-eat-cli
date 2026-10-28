import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRenderer, h, nextTick, ref } from 'vue'

const root = fileURLToPath(new URL('../', import.meta.url))
const outDir = fileURLToPath(new URL('../.test-dist/preferences-panel/', import.meta.url))
// vue 设为外部依赖，组件与本测试共用同一份运行时。
await build({
  configFile: false, root, logLevel: 'silent', plugins: [vue()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir, emptyOutDir: true, minify: false, lib: { entry: 'src/PreferencesPanel.vue', formats: ['es'], fileName: () => 'PreferencesPanel.js' }, rollupOptions: { external: ['vue'] } },
})
const { default: PreferencesPanel } = await import(new URL('../.test-dist/preferences-panel/PreferencesPanel.js', import.meta.url).href)
const { DEFAULT_PREFERENCE_FORM, describePreferences, preferencesFromForm } = await import('../.test-dist/recommendation.js')

// 极简内存节点树渲染器：Node 环境无 DOM，也不新增依赖。
function detach(node) {
  const siblings = node.parent?.children
  if (siblings) siblings.splice(siblings.indexOf(node), 1)
  node.parent = null
}
const { createApp } = createRenderer({
  createElement: (tag) => ({ tag, props: {}, children: [], parent: null }),
  createText: (text) => ({ text, parent: null }),
  createComment: () => ({ text: '', comment: true, parent: null }),
  setText: (node, text) => { node.text = text },
  setElementText: (element, text) => { element.children = text ? [{ text, parent: element }] : [] },
  insert: (child, parent, anchor) => {
    detach(child)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child)
    else parent.children.splice(index, 0, child)
    child.parent = parent
  },
  remove: detach,
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp: (element, key, _previous, next) => { element.props[key] = next },
})
const textOf = (node) => node.comment ? '' : node.children ? node.children.map(textOf).join('') : node.text
const findAll = (node, match) => [...(node.children && match(node) ? [node] : []), ...(node.children ?? []).flatMap((child) => findAll(child, match))]
const clearButtons = (container) => findAll(container, (node) => node.tag === 'button' && textOf(node).includes('清除品类'))

function mountPanel(food) {
  const form = ref({ ...DEFAULT_PREFERENCE_FORM, target_count: 2, price: '50', food_requirement: food })
  const disabled = ref(false)
  const container = { tag: 'root', props: {}, children: [], parent: null }
  createApp({
    render: () => {
      const result = preferencesFromForm(form.value)
      return h(PreferencesPanel, {
        modelValue: form.value, 'onUpdate:modelValue': (value) => { form.value = value }, disabled: disabled.value,
        errors: result.ok ? {} : result.errors, summary: result.ok ? describePreferences(result.preferences) : '',
      })
    },
  }).mount(container)
  return { form, disabled, container }
}

test('有品类时显示品类与清除按钮，点击只把 food_requirement 置 null 且摘要不再含品类', async () => {
  const { form, container } = mountPanel('冰品甜品')
  const before = { ...form.value }
  assert.match(textOf(container), /品类：冰品甜品/)
  const [button] = clearButtons(container)
  assert.ok(button, '应出现“清除品类”按钮')
  assert.equal(button.props.type, 'button', '不能触发外层表单提交')
  assert.ok(textOf(button).trim() || button.props['aria-label'], '按钮需有可读名称')
  button.props.onClick()
  await nextTick()
  assert.deepEqual(form.value, { ...before, food_requirement: null })
  assert.doesNotMatch(textOf(container), /品类/)
  assert.equal(clearButtons(container).length, 0)
})

test('品类为 null 时不显示清除按钮', () => {
  const { container } = mountPanel(null)
  assert.equal(clearButtons(container).length, 0)
})

test('disabled（推荐进行中）时清除按钮不可点', async () => {
  const { disabled, container } = mountPanel('冰品甜品')
  disabled.value = true
  await nextTick()
  const [button] = clearButtons(container)
  assert.ok(button)
  assert.equal(button.props.disabled, true)
})
