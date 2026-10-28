import { ApiError, commitChatTurn, isRecord } from './protocol.js'
import type { ChatTurn, ChatTurnDraft, LocationChoice } from './protocol.js'

export type MealStyle = 'any' | 'quick' | 'regular' | 'leisure'
export type Preferences = Readonly<{
  target_count: number
  radius_meters: number
  meal_style: MealStyle
  max_price_cny: number | null
  allow_unknown_price: boolean
  food_requirement: string | null
}>
export type PreferenceChanges = Partial<Preferences>
export type MatchState = 'satisfied' | 'unsatisfied' | 'unknown'
export type EvidenceField = 'name' | 'type' | 'typecode' | 'tag' | 'location' | 'business.cost' | 'business.currency' | 'business.cost_basis'
export type MatchEvidence = Readonly<{ state: MatchState; fields: readonly EvidenceField[] }>
export type CandidateAssessment = Readonly<{ candidate_id: string; range: MatchEvidence; food: MatchEvidence; price: MatchEvidence }>
export type ReasonCode = 'no_candidates' | 'insufficient_count' | 'outside_radius' | 'food_mismatch' | 'over_budget' | 'unknown_price' | 'preferences_conflict' | 'unknown_evidence'
export type RecommendationOption = Readonly<{
  option_id: string
  label: string
  observed_ids: readonly string[]
  reason_codes: readonly ReasonCode[]
  changes: PreferenceChanges
}>
// 方案引用的真实已观察候选的展示字段；三态评估按 candidate_id 在 assessments 中关联。旧服务端没有此字段。
export type ObservedCandidate = Readonly<{ candidate_id: string; name: string; address: string; distance_meters: number | null }>
// 服务端已校验的来源说明：品类据最新用户原话理解（quote 为原文片段）；冲突只用于澄清，proposed 未被采用。
export type FoodInterpretation = Readonly<{ requirement: string; quote: string; ambiguous: boolean }>
export type PreferenceConflict = Readonly<{ field: keyof Preferences; quote: string; proposed: PreferenceChanges }>
type DecisionBody = Readonly<{
  assessments: readonly CandidateAssessment[]; reason_codes: readonly ReasonCode[]; candidates?: readonly ObservedCandidate[]
  food_interpretation?: FoodInterpretation; conflict?: PreferenceConflict
}>
export type RecommendationDecision = DecisionBody & (
  | Readonly<{ status: 'ready'; selected_ids: readonly string[]; options: readonly [] }>
  | Readonly<{ status: 'needs_choice'; selected_ids: readonly []; options: readonly RecommendationOption[] }>
)
export type RecommendationSelection = Readonly<{ option_id: string; previous_preferences: Preferences; changes: PreferenceChanges }>
export type RecommendationRequest = Readonly<{ preferences: Preferences; selection?: RecommendationSelection }>
export type PendingRecommendation = Readonly<{ preferences: Preferences; options: readonly RecommendationOption[] }>

export const DEFAULT_PREFERENCES = {
  target_count: 3, radius_meters: 3000, meal_style: 'any', max_price_cny: null,
  allow_unknown_price: true, food_requirement: null,
} as const satisfies Preferences
const preferenceKeys = ['target_count', 'radius_meters', 'meal_style', 'max_price_cny', 'allow_unknown_price', 'food_requirement'] as const
const evidenceFields = ['name', 'type', 'typecode', 'tag', 'location', 'business.cost', 'business.currency', 'business.cost_basis'] as const
const reasonCodes = ['no_candidates', 'insufficient_count', 'outside_radius', 'food_mismatch', 'over_budget', 'unknown_price', 'preferences_conflict', 'unknown_evidence'] as const

function invalid(): never { throw new ApiError('推荐条件或协商数据无效', 400) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) return invalid()
  return value
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid()
  return value
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) return invalid()
  return value
}
function oneOf<const T extends string>(value: unknown, values: readonly T[]): T {
  const match = values.find((candidate) => candidate === value)
  return match ?? invalid()
}
function array(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid()
  return value
}
function unique<T>(values: readonly T[]): readonly T[] {
  if (new Set(values).size !== values.length) return invalid()
  return values
}
export function samePreferences(left: Preferences, right: Preferences): boolean {
  return preferenceKeys.every((key) => left[key] === right[key])
}

function parsePreferenceFields(value: unknown): PreferenceChanges {
  const input = record(value, preferenceKeys)
  const food = input['food_requirement']
  if ('food_requirement' in input && food !== null && (typeof food !== 'string' || [...food].length > 100)) return invalid()
  const price = input['max_price_cny']
  const allow = input['allow_unknown_price']
  if ('allow_unknown_price' in input && typeof allow !== 'boolean') return invalid()
  const radius = 'radius_meters' in input ? integer(input['radius_meters'], 1, 50000) : undefined
  return {
    ...('target_count' in input ? { target_count: integer(input['target_count'], 1, 10) } : {}),
    ...(radius !== undefined ? { radius_meters: radius } : {}),
    ...('meal_style' in input ? { meal_style: oneOf(input['meal_style'], ['any', 'quick', 'regular', 'leisure']) } : {}),
    ...('max_price_cny' in input ? { max_price_cny: price === null ? null : integer(price, 1, 10000) } : {}),
    ...(typeof allow === 'boolean' ? { allow_unknown_price: allow } : {}),
    ...(food === null || typeof food === 'string' ? { food_requirement: food } : {}),
  }
}

export function parsePreferenceChanges(value: unknown): PreferenceChanges {
  const changes = parsePreferenceFields(value)
  if (changes.radius_meters !== undefined && (changes.radius_meters < 100 || changes.radius_meters % 100 !== 0)) return invalid()
  return changes
}

export function parsePreferences(value: unknown): Preferences {
  const input = record(value, preferenceKeys)
  if (preferenceKeys.some((key) => !(key in input))) return invalid()
  return { ...DEFAULT_PREFERENCES, ...parsePreferenceFields(input) }
}

export function parseSelection(value: unknown, current: Preferences): RecommendationSelection {
  const input = record(value, ['option_id', 'previous_preferences', 'changes'])
  const previous = parsePreferences(input['previous_preferences'])
  const changes = parsePreferenceChanges(input['changes'])
  const next = { ...previous, ...changes }
  if (samePreferences(previous, next) || !samePreferences(next, current)) return invalid()
  return { option_id: text(input['option_id'], 64), previous_preferences: previous, changes }
}

export function normalizeRecommendationRequest(value: unknown): RecommendationRequest {
  if (!isRecord(value)) return invalid()
  const radius = 'radius' in value ? integer(value['radius'], 1, 50000) : undefined
  const count = 'limit' in value ? integer(value['limit'], 1, 10) : undefined
  const preferences: Preferences = 'preferences' in value
    ? { ...DEFAULT_PREFERENCES, ...parsePreferenceChanges(value['preferences']) }
    : { ...DEFAULT_PREFERENCES, radius_meters: radius ?? 5000, target_count: count ?? 10 }
  if (radius !== undefined && radius !== preferences.radius_meters || count !== undefined && count !== preferences.target_count) return invalid()
  if ('selection' in value) {
    parsePreferences(value['preferences'])
    return { preferences, selection: parseSelection(value['selection'], preferences) }
  }
  return { preferences }
}

function parseEvidence(value: unknown): MatchEvidence {
  const input = record(value, ['state', 'fields'])
  const state = oneOf(input['state'], ['satisfied', 'unsatisfied', 'unknown'])
  const fields = unique(array(input['fields'], 8).map((field) => oneOf(field, evidenceFields)))
  if (state !== 'unknown' && fields.length === 0) return invalid()
  return { state, fields }
}
function parseReasons(value: unknown): readonly ReasonCode[] {
  return unique(array(value, 8).map((reason) => oneOf(reason, reasonCodes)))
}
function parseIDs(value: unknown): readonly string[] {
  return unique(array(value, 10).map((id) => text(id, 256)))
}
function parseOption(value: unknown): RecommendationOption {
  const input = record(value, ['option_id', 'label', 'observed_ids', 'reason_codes', 'changes'])
  const changes = parsePreferenceChanges(input['changes'])
  if (Object.keys(changes).length === 0) return invalid()
  return {
    option_id: text(input['option_id'], 64), label: text(input['label'], 200),
    observed_ids: parseIDs(input['observed_ids']), reason_codes: parseReasons(input['reason_codes']), changes,
  }
}

function parseCandidate(value: unknown): ObservedCandidate {
  const item = record(value, ['candidate_id', 'name', 'address', 'distance_meters'])
  const address = item['address']
  const distance = item['distance_meters']
  if (typeof address !== 'string' || [...address].length > 1024) return invalid()
  return {
    candidate_id: text(item['candidate_id'], 256), name: text(item['name'], 1024), address,
    distance_meters: distance === null ? null : integer(distance, 0, 20_100_000),
  }
}

function parseInterpretation(value: unknown): FoodInterpretation {
  const item = record(value, ['requirement', 'quote', 'ambiguous'])
  if (typeof item['ambiguous'] !== 'boolean') return invalid()
  return { requirement: text(item['requirement'], 100), quote: text(item['quote'], 100), ambiguous: item['ambiguous'] }
}
function parseConflict(value: unknown): PreferenceConflict {
  const item = record(value, ['field', 'quote', 'proposed'])
  const field = oneOf(item['field'], preferenceKeys)
  const proposed = parsePreferenceChanges(item['proposed'])
  if (Object.keys(proposed).length !== 1 || !(field in proposed)) return invalid()
  return { field, quote: text(item['quote'], 100), proposed }
}

export function parseRecommendationDecision(raw: string): RecommendationDecision {
  if (new TextEncoder().encode(raw).length > 64 * 1024) return invalid()
  const value: unknown = JSON.parse(raw)
  const input = record(value, ['status', 'selected_ids', 'assessments', 'reason_codes', 'options', 'candidates', 'food_interpretation', 'conflict'])
  const assessments = array(input['assessments'], 225).map((value): CandidateAssessment => {
    const item = record(value, ['candidate_id', 'range', 'food', 'price'])
    return { candidate_id: text(item['candidate_id'], 256), range: parseEvidence(item['range']), food: parseEvidence(item['food']), price: parseEvidence(item['price']) }
  })
  const ids = unique(assessments.map((item) => item.candidate_id))
  const selected = parseIDs(input['selected_ids'])
  const options = array(input['options'], 3).map(parseOption)
  unique(options.map((option) => option.option_id))
  const observed = options.flatMap((option) => option.observed_ids)
  if ([...selected, ...observed].some((id) => !ids.includes(id))) return invalid()
  const candidates = 'candidates' in input ? array(input['candidates'], 30).map(parseCandidate) : undefined
  if (candidates && unique(candidates.map((item) => item.candidate_id)).some((id) => !observed.includes(id))) return invalid()
  const body = {
    assessments, reason_codes: parseReasons(input['reason_codes']), ...(candidates ? { candidates } : {}),
    ...('food_interpretation' in input ? { food_interpretation: parseInterpretation(input['food_interpretation']) } : {}),
    ...('conflict' in input ? { conflict: parseConflict(input['conflict']) } : {}),
  }
  const status = oneOf(input['status'], ['ready', 'needs_choice'])
  switch (status) {
    case 'ready':
      if (selected.length === 0 || options.length !== 0) return invalid()
      return { ...body, status, selected_ids: selected, options: [] }
    case 'needs_choice':
      if (selected.length !== 0) return invalid()
      return { ...body, status, selected_ids: [], options }
    default:
      return assertNever(status)
  }
}

export function selectRecommendationOption(optionID: string, pending: PendingRecommendation, current: Preferences): RecommendationRequest {
  if (!samePreferences(pending.preferences, current)) return invalid()
  const matches = pending.options.filter((option) => option.option_id === optionID)
  const option = matches[0]
  if (matches.length !== 1 || option === undefined) return invalid()
  const preferences = { ...current, ...option.changes }
  const selection = parseSelection({ option_id: option.option_id, previous_preferences: current, changes: option.changes }, preferences)
  return { preferences, selection }
}

function assertNever(_value: never): never { return invalid() }

export const TARGET_COUNT_OPTIONS: readonly number[] = [1, 3, 5, 10]
export const RADIUS_OPTIONS: readonly number[] = [1000, 2000, 3000, 5000, 10000]
export const PRICE_OPTIONS: readonly number[] = [30, 50, 100, 150, 200]
export const MEAL_STYLE_LABELS: Readonly<Record<MealStyle, string>> = {
  any: '不限', quick: '快速用餐（约30分钟）', regular: '日常正餐（约60分钟）', leisure: '休闲聚餐（90分钟以上）',
}
// 表单原始值：radius 为预设米数或 'custom'，price 为 'none'、预设元数或 'custom'；品类不设控件，由协商写入。
export type PreferenceForm = Readonly<{
  target_count: number
  radius: string
  custom_radius: string
  meal_style: MealStyle
  price: string
  custom_price: string
  allow_unknown_price: boolean
  food_requirement: string | null
}>
export type PreferenceFormErrors = Readonly<{ count?: string; radius?: string; price?: string }>
export type PreferenceFormResult = Readonly<{ ok: true; preferences: Preferences }> | Readonly<{ ok: false; errors: PreferenceFormErrors }>
export type PreferenceTurn = ChatTurn & Readonly<{ preferences: Preferences }>

export const DEFAULT_PREFERENCE_FORM: PreferenceForm = {
  target_count: 3, radius: '3000', custom_radius: '', meal_style: 'any', price: 'none', custom_price: '',
  allow_unknown_price: true, food_requirement: null,
}

function wholeNumber(raw: string): number | null {
  const value = raw.trim()
  return /^\d{1,6}$/.test(value) ? Number(value) : null
}

export function preferencesFromForm(form: PreferenceForm): PreferenceFormResult {
  const radius = wholeNumber(form.radius === 'custom' ? form.custom_radius : form.radius)
  const price = form.price === 'none' ? null : wholeNumber(form.price === 'custom' ? form.custom_price : form.price)
  const errors: { count?: string; radius?: string; price?: string } = {}
  if (!TARGET_COUNT_OPTIONS.includes(form.target_count)) errors.count = '推荐数量只能是 1、3、5 或 10 家'
  if (radius === null || radius < 100 || radius > 50000 || radius % 100 !== 0) errors.radius = '请输入 100–50000 之间、100 的整数倍（米）'
  if (form.price !== 'none' && (price === null || price < 1 || price > 10000)) errors.price = '请输入 1–10000 之间的整数（元）'
  if (radius === null || errors.count || errors.radius || errors.price) return { ok: false, errors }
  return { ok: true, preferences: parsePreferences({
    target_count: form.target_count, radius_meters: radius, meal_style: form.meal_style, max_price_cny: price,
    allow_unknown_price: form.allow_unknown_price, food_requirement: form.food_requirement,
  }) }
}

function radiusText(meters: number): string {
  return meters % 1000 === 0 ? `${meters / 1000} 公里` : `${meters} 米`
}

export function describePreferences(preferences: Preferences): string {
  return [
    `${preferences.target_count} 家`, `${radiusText(preferences.radius_meters)}内`, `用餐安排：${MEAL_STYLE_LABELS[preferences.meal_style]}`,
    preferences.max_price_cny === null ? '人均不限' : `人均 ${preferences.max_price_cny} 元以内`,
    preferences.allow_unknown_price ? '价格未知也展示（待核实）' : '仅限已核实价格',
    ...(preferences.food_requirement === null ? [] : [`品类：${preferences.food_requirement}`]),
  ].join(' · ')
}

export function commitPreferenceTurn(history: readonly PreferenceTurn[], draft: ChatTurnDraft, preferences: Preferences): readonly PreferenceTurn[] {
  if (commitChatTurn(history, draft) === history) return history
  return [...history, { user: draft.user, assistant: draft.assistant, preferences: Object.freeze({ ...preferences }) }]
}

// 请求品类为空且服务端采纳了原话品类时，把该品类并入本次条件（摘要、历史快照与下一轮 previous_preferences 均取此值）。
export function adoptPreferences(submitted: Preferences, done: Preferences | undefined): Preferences {
  return submitted.food_requirement === null && done?.food_requirement != null ? { ...submitted, food_requirement: done.food_requirement } : submitted
}

export function interpretationNote(decision: RecommendationDecision | undefined): string {
  const item = decision?.food_interpretation
  if (!item) return ''
  return item.ambiguous ? `原话“${item.quote}”的品类不够明确，请在方案中确认` : `品类“${item.requirement}”据你的原话“${item.quote}”理解`
}

// ready 但卡片少于期望数量时的确定性说明；needs_choice 或旧服务端不显示。
export function shortfallNote(status: RecommendationDecision['status'] | undefined, found: number, target: number): string {
  return status === 'ready' && found < target ? `找到 ${found} 家（期望 ${target} 家）` : ''
}

// 已确认的搜索地点显示“名称 · 地址”；其余坐标仍显示“当前位置 · 坐标”。
export function describeLocation(choice: LocationChoice | null): string {
  if (!choice) return '尚未选择位置'
  if (choice.kind === 'address') return choice.address.description
  const name = choice.name?.trim() ?? ''
  const address = choice.address?.trim() ?? ''
  if (choice.source === 'search' && name) return address && address !== name ? `${name} · ${address}` : name
  return `当前位置 · ${choice.location}`
}

// ---- 协商：方案仅存在于当前会话内存，绑定产生它的请求代际、位置与条件 ----
export type NeedsChoiceDecision = Extract<RecommendationDecision, { status: 'needs_choice' }>
export type Negotiation = Readonly<{ generation: number; locationKey: string; preferences: Preferences; decision: NeedsChoiceDecision }>
export type NegotiationContext = Readonly<{ generation: number; locationKey: string; preferences: Preferences | null }>

export function locationKey(choice: LocationChoice | null): string {
  if (!choice) return ''
  return choice.kind === 'address' ? `address:${choice.address.id}:${choice.address.location}` : `coordinates:${choice.location}`
}

// 代际（取消/新请求/新对话/退出）、位置或条件任一变化，旧方案即失效且不可恢复。
export function isNegotiationCurrent(negotiation: Negotiation, now: NegotiationContext): boolean {
  return negotiation.generation === now.generation && negotiation.locationKey === now.locationKey
    && now.preferences !== null && samePreferences(negotiation.preferences, now.preferences)
}

export function formWithChanges(form: PreferenceForm, changes: PreferenceChanges): PreferenceForm {
  const radius = changes.radius_meters
  const price = changes.max_price_cny
  return {
    ...form,
    ...(changes.target_count !== undefined ? { target_count: changes.target_count } : {}),
    ...(radius === undefined ? {} : RADIUS_OPTIONS.includes(radius) ? { radius: String(radius), custom_radius: '' } : { radius: 'custom', custom_radius: String(radius) }),
    ...(changes.meal_style !== undefined ? { meal_style: changes.meal_style } : {}),
    ...(price === undefined ? {} : price === null ? { price: 'none', custom_price: '' }
      : PRICE_OPTIONS.includes(price) ? { price: String(price), custom_price: '' } : { price: 'custom', custom_price: String(price) }),
    ...(changes.allow_unknown_price !== undefined ? { allow_unknown_price: changes.allow_unknown_price } : {}),
    ...(changes.food_requirement !== undefined ? { food_requirement: changes.food_requirement } : {}),
  }
}

// 只有明确点选的方案 ID 才会生成选择；选单必须能精确表示方案差异（如 2 家不在数量选项中则拒绝），否则不发请求。
export function applyNegotiationOption(optionID: string, pending: PendingRecommendation, form: PreferenceForm): Readonly<{ form: PreferenceForm; request: RecommendationRequest }> {
  const current = preferencesFromForm(form)
  if (!current.ok) return invalid()
  const request = selectRecommendationOption(optionID, pending, current.preferences)
  const next = formWithChanges(form, request.selection?.changes ?? {})
  const synced = preferencesFromForm(next)
  if (!synced.ok || !samePreferences(synced.preferences, request.preferences)) return invalid()
  return { form: next, request }
}

const FIELD_LABELS: Readonly<Record<keyof Preferences, string>> = {
  target_count: '推荐数量', radius_meters: '搜索范围（直线）', meal_style: '用餐安排', max_price_cny: '人均上限',
  allow_unknown_price: '未知价格', food_requirement: '品类',
}
function preferenceText(preferences: Preferences, key: keyof Preferences): string {
  switch (key) {
    case 'target_count': return `${preferences.target_count} 家`
    case 'radius_meters': return radiusText(preferences.radius_meters)
    case 'meal_style': return MEAL_STYLE_LABELS[preferences.meal_style]
    case 'max_price_cny': return preferences.max_price_cny === null ? '不限' : `${preferences.max_price_cny} 元`
    case 'allow_unknown_price': return preferences.allow_unknown_price ? '也展示（待核实）' : '仅限已核实价格'
    case 'food_requirement': return preferences.food_requirement ?? '未指定'
  }
}
export type ChangeLine = Readonly<{ field: string; before: string; after: string }>
export function describeChanges(previous: Preferences, changes: PreferenceChanges): readonly ChangeLine[] {
  const next = { ...previous, ...changes }
  return preferenceKeys.filter((key) => changes[key] !== undefined)
    .map((key) => ({ field: FIELD_LABELS[key], before: preferenceText(previous, key), after: preferenceText(next, key) }))
}

export const REASON_LABELS: Readonly<Record<ReasonCode, string>> = {
  no_candidates: '本次检索在当前条件内没有找到候选（不代表附近一定没有）',
  insufficient_count: '符合条件的店铺少于期望数量',
  outside_radius: '部分候选在当前搜索范围之外',
  food_mismatch: '范围内的候选与所需品类不符',
  over_budget: '部分候选已知人均超出上限',
  unknown_price: '部分候选价格未知',
  preferences_conflict: '当前条件之间没有能同时满足的候选',
  unknown_evidence: '部分候选信息待核实',
}

// 依据原条件下的三态评估标出替代候选的偏离项；未知只标“待核实”，不当作满足。
export type CandidateNote = Readonly<{ kind: 'deviation' | 'unknown'; text: string }>
export function candidateNotes(assessment: CandidateAssessment | undefined, preferences: Preferences): readonly CandidateNote[] {
  if (!assessment) return [{ kind: 'unknown', text: '评估信息缺失' }]
  const notes: CandidateNote[] = []
  const add = (state: MatchState, deviation: string, unknown: string) => {
    if (state === 'unsatisfied') notes.push({ kind: 'deviation', text: deviation })
    if (state === 'unknown') notes.push({ kind: 'unknown', text: unknown })
  }
  add(assessment.range.state, '超出原搜索范围', '距离未知')
  if (preferences.food_requirement !== null) add(assessment.food.state, '品类与原要求不符', '品类待核实')
  if (preferences.max_price_cny !== null) add(assessment.price.state, '超出原人均上限', '价格待核实')
  return notes
}
