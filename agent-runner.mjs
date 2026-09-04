import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { applyFastMode } from './model-request.mjs'

const STEPS = ['topics', 'mindmap', 'plan', 'artifact', 'retro']
const TOOLS = ['read_task', 'read_workflow_state', 'propose_direction', 'propose_creative_forms', 'ask_user', 'write_section', 'record_assumption', 'build_artifact', 'inspect_artifact', 'validate_step', 'advance_step', 'finalize_delivery']
const MAX_ACTIONS_PER_RESUME = 14
const COUNTDOWN_ENABLED = false

function clone(value) { return structuredClone(value) }
function now() { return new Date().toISOString() }
function text(value) { return typeof value === 'string' ? value.trim() : '' }
function bytes(value) { return Buffer.byteLength(value || '', 'utf8') }
function updateRemainingTime(state) {
  if (!COUNTDOWN_ENABLED) { state.remainingTime = 25 * 60; return }
  if (!state.startedAt) { state.remainingTime = 25 * 60; return }
  const endpoint = state.finishedAt ? Date.parse(state.finishedAt) : state.pausedAt ? Date.parse(state.pausedAt) : Date.now()
  state.remainingTime = Math.max(0, 25 * 60 - Math.floor((endpoint - Date.parse(state.startedAt) - state.accumulatedPauseMs) / 1000))
}

function extractJsonObject(value) {
  const cleaned = text(value).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  try { const parsed = JSON.parse(cleaned); return parsed && !Array.isArray(parsed) ? parsed : null } catch { /* locate an object below */ }
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue
    let depth = 0; let quoted = false; let escaped = false
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') quoted = true
      else if (char === '{') depth += 1
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(cleaned.slice(start, index + 1)) } catch { break }
      }
    }
  }
  return null
}

function upstreamConfig(baseUrl) {
  const base = text(baseUrl).replace(/\/$/, '')
  const parsed = new URL(base)
  const nativeDashScope = /\/api\/v1$/.test(parsed.pathname)
  return nativeDashScope
    ? { mode: 'dashscope', url: `${base}/services/aigc/text-generation/generation` }
    : { mode: 'compatible', url: /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions` }
}

function valueText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => valueText(item?.text ?? item?.content ?? item)).join('')
  return value && typeof value === 'object' ? valueText(value.text ?? value.content ?? '') : ''
}

function streamParts(data) {
  const choice = data?.choices?.[0]
  const outputChoice = data?.output?.choices?.[0]
  return valueText(choice?.delta?.content ?? choice?.message?.content ?? outputChoice?.message?.content ?? data?.output?.text ?? data?.text)
}

async function callModel(runtime, agent, title, systemPrompt, userPrompt, temperature = 0.25, options = {}) {
  const { config, controller, state } = runtime
  if (!text(config.apiKey)) return ''
  state.modelCalls ||= []
  const call = { id: crypto.randomUUID(), agent, title, systemPrompt, userPrompt, output: '', status: 'running', startedAt: now(), updatedAt: now() }
  state.modelCalls.push(call)
  if (state.modelCalls.length > 80) state.modelCalls = state.modelCalls.slice(-80)
  const upstream = upstreamConfig(config.baseUrl)
  const payload = applyFastMode(upstream.mode === 'dashscope'
    ? { model: config.model, input: { messages: [{ role: 'system', content: [{ text: systemPrompt }] }, { role: 'user', content: [{ text: userPrompt }] }] }, parameters: { incremental_output: true } }
    : { model: config.model, temperature, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }, upstream.mode, config.fastMode)
  if (options.maxTokens) {
    if (upstream.mode === 'dashscope') payload.parameters = { ...payload.parameters, max_tokens: options.maxTokens }
    else payload.max_tokens = options.maxTokens
  }
  try {
    const response = await fetch(upstream.url, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}`, ...(upstream.mode === 'dashscope' ? { 'X-DashScope-SSE': 'enable' } : {}) }, body: JSON.stringify(payload) })
    if (!response.ok) throw new Error(`模型请求失败（HTTP ${response.status}）：${(await response.text()).slice(0, 180)}`)
    if ((response.headers.get('content-type') || '').includes('text/event-stream') && response.body) {
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n'); buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') continue
          try { call.output += streamParts(JSON.parse(raw)) } catch { /* ignore malformed upstream events */ }
        }
        call.updatedAt = now()
      }
    } else {
      call.output = streamParts(await response.json())
    }
    call.status = 'completed'; call.finishedAt = now(); call.updatedAt = call.finishedAt
    return call.output
  } catch (error) {
    call.status = error?.name === 'AbortError' ? 'cancelled' : 'failed'; call.error = error instanceof Error ? error.message : '未知错误'; call.finishedAt = now(); call.updatedAt = call.finishedAt
    throw error
  }
}

function parseTopics(task) {
  const source = (task.match(/TOPICS\s*\/\/([\s\S]*?)(?:NOTE\s*\/\/|$)/i)?.[1] || task).trim()
  const matches = [...source.matchAll(/([ABC])(?=[\u4e00-\u9fff])([^]*?)(?=[ABC](?=[\u4e00-\u9fff])|$)/g)]
  if (matches.length === 3) return matches.map((match) => {
    const description = match[2].trim()
    const marker = description.search(/选\s*[ABC]\s*意味着|选择该方向意味着|意味着/)
    return { id: match[1], title: (marker > 0 ? description.slice(0, marker) : description.split(/[。；\n]/)[0]).trim().slice(0, 36) || `方向 ${match[1]}`, description, recommendationReason: '', reverseQuestion: '为什么它在本场景下不能作为主目标？' }
  })
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const blocks = []
  for (const line of lines) {
    const standalone = line.match(/^(?:[-*]\s*)?([ABC]|[1-3])$/)
    const inline = line.match(/^(?:[-*]\s*)?([ABC]|[1-3])(?:[.、:：)）]\s*|\s+)(.+)$/)
    const marker = standalone?.[1] || inline?.[1]
    if (marker) blocks.push({ id: marker, content: inline?.[2] ? [inline[2]] : [] })
    else if (blocks.length) blocks.at(-1).content.push(line)
  }
  if (blocks.length === 3 && new Set(blocks.map((block) => block.id)).size === 3) return blocks.map((block) => {
    const description = block.content.join('\n').trim()
    const choiceMarker = description.search(new RegExp(`选\\s*${block.id}\\s*意味着|选择该方向意味着|意味着`))
    return { id: block.id, title: (choiceMarker > 0 ? description.slice(0, choiceMarker) : description.split(/[。；\n]/)[0]).trim().slice(0, 36) || `方向 ${block.id}`, description, recommendationReason: '', reverseQuestion: '为什么它在本场景下不能作为主目标？' }
  })
  const numbered = lines.map((line) => line.match(/^(?:[-*]\s*)?(?:([ABC])|([1-3]))[.、:：)）\s]+(.+)$/)).filter(Boolean)
  return numbered.slice(0, 3).map((match, index) => ({ id: match?.[1] || match?.[2] || String(index + 1), title: match?.[3].split(/[。；]/)[0].slice(0, 36), description: match?.[3] || '', recommendationReason: '', reverseQuestion: '为什么它在本场景下不能作为主目标？' }))
}

function selectedOption(state) { return state.topicOptions.find((item) => item.id === state.decision?.optionId) }
function rejectedOptions(state) { return state.topicOptions.filter((item) => item.id !== state.decision?.optionId) }

export function validateAgentStep(state, step) {
  const issues = []
  if (step === 'topics') {
    if (state.topicOptions.length !== 3) issues.push('必须有且仅有三个候选主题')
    if (!state.decision?.confirmedAt) issues.push('等待用户确认主攻方向')
  }
  if (step === 'mindmap') {
    const body = text(state.artifacts.mindmap)
    if (!body) issues.push('思考脑图为空')
    if (body.length > 5000) issues.push(`思考脑图超过 5000 字（当前 ${body.length} 字）`)
    for (const [pattern, label] of [[/冲突/, '三类冲突'], [/主攻|选择理由/, '主攻与选择理由'], [/放弃|反向理由/, '反向理由'], [/A4|执行方案|下一步动作/, 'A4 执行方案'], [/不做|不服务|边界|关键前提/, '边界与前提'], [/犹豫|不确定/, '最犹豫取舍或最不确定假设'], [/25\s*分钟|额外时间|优先改/, '额外 25 分钟的优先改动'], [/一致性/, '一致性自证']]) if (!pattern.test(body)) issues.push(`缺少${label}`)
    if (/最满意|最想改变|想问面试官/.test(body)) issues.push('思考脑图混入了最终复盘专属内容')
    const selected = selectedOption(state)
    if (selected && !body.includes(selected.id) && !body.includes(selected.title)) issues.push('未引用用户确认的主攻方向')
  }
  if (step === 'plan') {
    for (const [key, label] of [['persona', '用户画像'], ['pain', '核心痛点'], ['path', '解决路径'], ['aiTool', 'AI 工具选型'], ['effect', '预期效果'], ['risk', '风险应对']]) if (!text(state.artifacts.plan[key])) issues.push(`${label}为空`)
    if (!/Codex/i.test(state.artifacts.plan.aiTool || '')) issues.push('AI 工具必须明确为 Codex')
    if (/^\s*Codex\s*$/i.test(state.artifacts.plan.aiTool || '')) issues.push('需要说明选择 Codex 的原因')
    const selected = selectedOption(state)
    const combined = Object.values(state.artifacts.plan).join('\n')
    if (selected && !combined.includes(selected.id) && !combined.includes(selected.title)) issues.push('方案六要素未引用用户确认的主攻方向')
  }
  if (step === 'artifact') {
    const { html, images, aiRecord } = state.artifacts
    if ((state.creativeOptions || []).length < 3) issues.push('尚未生成多种创作形式')
    if (!(state.selectedCreativeIds || []).length) issues.push('尚未由用户确认创作形式')
    if (html && images.length) issues.push('HTML 和图片不能同时作为主交付')
    if (!html && !images.length) issues.push('没有落地作品')
    if (html && bytes(html) > 5 * 1024 * 1024) issues.push('HTML 超过 5 MB')
    if (html && (!/<!doctype\s+html/i.test(html) || !/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html))) issues.push('HTML 不是完整单文件')
    if (images.length > 8) issues.push('图片超过 8 张')
    for (const image of images) if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type)) issues.push(`${image.name} 类型不合规`)
    if (!text(aiRecord.introduction)) issues.push('缺少一句话介绍')
    if (aiRecord.toolName !== 'Codex') issues.push('AI 工具名称必须是 Codex')
    if (!text(aiRecord.firstPrompt) || aiRecord.firstPrompt !== state.firstPrompt || aiRecord.firstPromptSource !== 'run_log') issues.push('首条提示词不是 Run 真实记录')
    if (!text(aiRecord.dissatisfaction)) issues.push('缺少不满意之处')
    if (!text(aiRecord.iterationLogic)) issues.push('缺少迭代逻辑')
    if (state.artifactStale) issues.push('作品已过期')
    const selected = selectedOption(state)
    if (selected && html && !html.includes(selected.id) && !html.includes(selected.title)) issues.push('HTML 作品与用户确认的主攻方向不一致')
  }
  if (step === 'retro') for (const [key, label] of [['satisfied', '最满意的地方'], ['change', '最想改变的地方'], ['extraTime', '再给 25 分钟'], ['interviewerQuestion', '面试官提问']]) if (!text(state.artifacts.retro[key])) issues.push(`${label}为空`)
  return { step, ok: !issues.length, issues, checkedAt: now(), kind: 'deterministic' }
}

function summarizeState(state) {
  return {
    goal: state.goal, currentStep: state.currentStep, status: state.status, remainingTime: state.remainingTime,
    facts: state.facts, topicOptions: state.topicOptions, recommendedOptionId: state.recommendedOptionId, decision: state.decision,
    assumptions: state.assumptions, openQuestions: state.openQuestions,
    creativeOptions: state.creativeOptions, selectedCreativeIds: state.selectedCreativeIds,
    artifactLanes: (state.artifactLanes || []).map((lane) => ({ id: lane.id, creativeId: lane.creativeId, title: lane.title, status: lane.status, versions: lane.versions?.length || 0 })), primaryArtifactLaneId: state.primaryArtifactLaneId,
    artifacts: { mindmap: state.artifacts.mindmap, plan: state.artifacts.plan, html: state.artifacts.html ? `[HTML ${bytes(state.artifacts.html)} bytes]` : '', images: state.artifacts.images.map(({ name, type, size }) => ({ name, type, size })), aiRecord: state.artifacts.aiRecord, retro: state.artifacts.retro },
    artifactStale: state.artifactStale, validationResults: state.validationResults.slice(-6), retryCounts: state.retryCounts, completedSteps: state.completedSteps,
    recentActions: state.actionHistory.slice(-6), promptVersion: state.promptVersion,
  }
}

function summarize(value, limit = 280) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw
}

function appendAction(state, tool, args, summary, toolResult, ok = true) {
  state.actionHistory.push({ id: crypto.randomUUID(), at: now(), actor: 'agent', tool, goal: summary || `执行 ${tool}`, inputSummary: summarize(args), resultSummary: summarize(toolResult), ok })
  if (state.actionHistory.length > 120) state.actionHistory = state.actionHistory.slice(-120)
}

function normalizeState(state) {
  state.creativeOptions ||= []
  state.selectedCreativeIds ||= []
  state.artifactLanes ||= []
  state.primaryArtifactLaneId ||= ''
  state.modelCalls ||= []
  state.lockedModules ||= []
  state.contentSnapshots ||= []
  state.promptSnapshot ||= state.prompts || {}
  state.validationResults = (state.validationResults || []).map((item) => {
    const issues = Array.isArray(item.issues) ? item.issues.map(text).filter(Boolean) : []
    if (item.ok === true && issues.length) {
      const migratedSummary = `历史非阻断建议：${issues.join('；')}`
      return { ...item, issues: [], summary: [text(item.summary), migratedSummary].filter(Boolean).join(' ') }
    }
    return { ...item, issues }
  })
  return state
}

function fallbackMindmap(state) {
  const chosen = selectedOption(state)
  const rejected = rejectedOptions(state)
  return `# 思考脑图\n\n## 1. 三类关键冲突及影响\n- 规模冲突：原题中的人数或覆盖需求超过现场承载，直接影响安全与体验。\n- 资源冲突：物料与预算不足，直接影响可执行范围。\n- 交付冲突：教学或执行人力不足，直接影响现场稳定性。\n\n## 2. 方向选择与反向理由\n- 主攻 ${chosen?.id || ''}「${chosen?.title || '已确认方向'}」。选择理由：${state.decision?.reason || '围绕用户确认方向建立最小可执行闭环。'}\n${rejected.map((item) => `- 暂不以 ${item.id}「${item.title}」为主目标：${state.decision?.rejectedReasons?.[item.id] || '它无法在当前时限内优先解决已确认方向对应的核心瓶颈；保留为降级措施。'}`).join('\n')}\n\n## 3. 一页 A4 执行方案\n1. 立即锁定服务边界与参与规则。\n2. 按硬约束拆分资源、人员与时间。\n3. 发布确认信息并进行一次最小演练。\n4. 现场按检查表执行，触发红线时切换降级方案。\n5. 结束后完成回收、记录和后续通知。\n\n## 4. 取舍、边界与关键前提\n- 不做：不在本轮同时追求三个方向的最优解。\n- 不服务：不承诺覆盖超出安全承载与资源上限的需求。\n- 关键前提：原题给出的时间、资源和场地约束真实有效。\n\n## 5. 自我说明\n- 最犹豫的取舍：覆盖更多人还是保证主攻目标的完成质量。\n- 最不确定的假设：现有资源能按计划准时到位。\n- 额外 25 分钟优先改动：验证关键假设并补一次现场演练。\n\n## 6. 一致性自证\n主攻方向、A4 行动与明确不做的边界均围绕同一瓶颈。`
}

function fallbackPlan(state) {
  const chosen = selectedOption(state)
  return {
    persona: '需要在有限时间和资源下获得清晰、安全、可执行体验的目标参与者，以及负责现场落地的执行人员。',
    pain: `原题中的容量、资源与执行人力同时受限，且必须围绕已确认的 ${chosen?.id || ''}「${chosen?.title || '主攻方向'}」做取舍。`,
    path: '锁定服务边界 → 按硬约束拆分动作 → 设置检查点和降级条件 → 现场执行 → 复盘记录。',
    aiTool: 'Codex：用于把完整题目拆成结构化约束、保持五步答案的一致性，并快速生成和校验单文件 HTML；最终方向仍由用户确认。',
    effect: '在 25 分钟内形成可解释、可执行、可检查且能直接提交的完整交付。',
    risk: '关键假设失效或现场资源变化时，立即触发已声明的降级边界，并保留人工确认点。',
  }
}

function fallbackRetro() {
  return { satisfied: '最满意的是主攻方向、行动方案和明确不做的边界能够相互印证。', change: '最想改变的是进一步用真实数据验证关键假设，而不是只依赖题面信息。', extraTime: '再给 25 分钟会优先做一次桌面演练，验证时间、资源和降级条件。', interviewerQuestion: '您更看重这类任务中的决策质量、执行细节，还是候选人验证假设的方式？' }
}

function fallbackHtml(state) {
  const selected = selectedOption(state)
  const escape = (value) => String(value || '').replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(selected?.title || '面试方案')}</title><style>body{font-family:system-ui,sans-serif;margin:0;color:#17212b;background:#f4f7f8}main{max-width:980px;margin:auto;padding:28px}h1{margin:0 0 8px}.meta{color:#47606c}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:20px}section{background:white;border:1px solid #ccd9de;border-radius:8px;padding:16px}ol,ul{padding-left:20px;line-height:1.65}@media(max-width:680px){.grid{grid-template-columns:1fr}}@media print{body{background:white}main{padding:0}section{break-inside:avoid}}</style></head><body><main><h1>${escape(selected?.id || '')} ${escape(selected?.title || '已确认方案')}</h1><p class="meta">围绕用户已确认方向的一页执行方案</p><div class="grid"><section><h2>核心判断</h2><p>${escape(state.artifacts.plan.pain)}</p></section><section><h2>解决路径</h2><p>${escape(state.artifacts.plan.path)}</p></section><section><h2>行动清单</h2><ol><li>锁定服务边界</li><li>核对资源与人员</li><li>完成最小演练</li><li>按检查表执行</li></ol></section><section><h2>风险与降级</h2><p>${escape(state.artifacts.plan.risk)}</p></section></div></main></body></html>`
}

function fallbackCreativeOptions(state) {
  const direction = selectedOption(state)?.title || '已确认方向'
  return [
    { id: 'format-1', title: '一页行动指挥板', description: `用时间轴、责任人和红线条件呈现「${direction}」的执行闭环。`, difficulty: '低', estimatedMinutes: 6, tags: ['高信息密度', 'A4'], risk: '互动性较弱', fallback: '保留行动清单和风险表，删除装饰模块', score: 92 },
    { id: 'format-2', title: '情境决策模拟器', description: `让面试官切换关键约束，观察「${direction}」下的取舍和降级动作。`, difficulty: '高', estimatedMinutes: 14, tags: ['互动', '决策'], risk: '制作时间容易超限', fallback: '降级为三个静态情境卡片', score: 84 },
    { id: 'format-3', title: '现场流程看板', description: `按准备、入场、执行、异常、收尾五段展示「${direction}」的下一步动作。`, difficulty: '中', estimatedMinutes: 9, tags: ['流程', '可扫描'], risk: '可能与文字方案重复', fallback: '只保留关键节点和责任分工', score: 88 },
    { id: 'format-4', title: '风险响应矩阵', description: `以触发条件、负责人和降级动作突出「${direction}」如何应对不确定性。`, difficulty: '中', estimatedMinutes: 8, tags: ['风险', '复盘'], risk: '主叙事可能不够直观', fallback: '矩阵上方增加一句核心决策和三步路径', score: 82 },
  ]
}

async function generateCreativeOptions(runtime) {
  const { state, config, prompts } = runtime
  if (!text(config.apiKey)) return fallbackCreativeOptions(state)
  const user = `【完整原题】\n${state.task}\n\n【用户已确认主攻方向，不得更换】\n${JSON.stringify({ decision: state.decision, option: selectedOption(state) })}\n\n【思考脑图】\n${state.artifacts.mindmap}\n\n【方案六要素】\n${JSON.stringify(state.artifacts.plan)}\n\n【剩余秒数】${state.remainingTime}\n\n返回 schema：{"options":[{"id":"format-1","title":"","description":"","difficulty":"低|中|高","estimatedMinutes":8,"tags":[""],"risk":"","fallback":"","score":90}]}，必须恰好 4 项。`
  const parsed = extractJsonObject(await callModel(runtime, '创意 Agent', '生成创作形式候选', prompts.creative || prompts.artifact, user, 0.45))
  const source = Array.isArray(parsed?.options) ? parsed.options.slice(0, 4) : []
  if (source.length !== 4) return fallbackCreativeOptions(state)
  return source.map((item, index) => ({
    id: text(item.id) || `format-${index + 1}`, title: text(item.title) || `创作形式 ${index + 1}`, description: text(item.description),
    difficulty: ['低', '中', '高'].includes(item.difficulty) ? item.difficulty : '中', estimatedMinutes: Math.max(1, Math.min(25, Number(item.estimatedMinutes) || 8)),
    tags: Array.isArray(item.tags) ? item.tags.map(text).filter(Boolean).slice(0, 4) : [], risk: text(item.risk), fallback: text(item.fallback), score: Math.max(0, Math.min(100, Number(item.score) || 0)),
  }))
}

function fallbackAction(state) {
  const latest = [...state.validationResults].reverse().find((item) => item.step === state.currentStep)
  if (state.currentStep === 'topics') {
    if (state.topicOptions.length !== 3) return { tool: 'propose_direction', arguments: {}, summary: '解析三个候选方向并提出建议' }
    if (!state.recommendedOptionId) return { tool: 'propose_direction', arguments: {}, summary: '基于三个候选方向生成推荐' }
    if (!state.decision?.confirmedAt) return { tool: 'ask_user', arguments: { questions: ['请选择并确认一个主攻方向。'] }, summary: '方向必须由用户确认' }
  }
  if (state.currentStep === 'mindmap' && !text(state.artifacts.mindmap)) return { tool: 'write_section', arguments: { section: 'mindmap' }, summary: '生成思考脑图' }
  if (state.currentStep === 'plan' && !text(state.artifacts.plan.persona)) return { tool: 'write_section', arguments: { section: 'plan' }, summary: '生成方案六要素' }
  if (state.currentStep === 'artifact' && !state.creativeOptions?.length) return { tool: 'propose_creative_forms', arguments: {}, summary: '基于已确认方向生成多种创作形式' }
  if (state.currentStep === 'artifact' && !state.selectedCreativeIds?.length) return { tool: 'ask_user', arguments: { questions: ['请从创作形式候选中选择至少一种，再启动制作。'] }, summary: '等待用户确认创作形式' }
  if (state.currentStep === 'artifact') {
    state.artifactLanes ||= []
    const pending = state.selectedCreativeIds.filter((creativeId) => !state.artifactLanes.some((lane) => lane.creativeId === creativeId && lane.status === 'done'))
    if (pending.length) return { tool: 'build_artifact', arguments: { format: 'html', creativeIds: pending }, summary: '最多两路并发制作已选择的创意赛道' }
    if (!state.primaryArtifactLaneId && !state.artifacts.images.length) return { tool: 'ask_user', arguments: { questions: ['请比较已完成赛道并指定一个主作品。'] }, summary: '等待用户指定最终作品' }
  }
  if (state.currentStep === 'retro' && !text(state.artifacts.retro.satisfied)) return { tool: 'write_section', arguments: { section: 'retro' }, summary: '生成最终复盘' }
  if (!latest) return { tool: 'validate_step', arguments: { step: state.currentStep }, summary: '校验当前步骤' }
  if (!latest.ok && (state.retryCounts[state.currentStep] || 0) < 2) return state.currentStep === 'artifact' ? { tool: 'build_artifact', arguments: { format: 'html', issues: latest.issues }, summary: '按校验结果修订作品' } : { tool: 'write_section', arguments: { section: state.currentStep, issues: latest.issues }, summary: '按校验结果局部修订' }
  if (!latest.ok) return { tool: 'ask_user', arguments: { questions: latest.issues.slice(0, 3) }, summary: '自动修订达到上限，需要用户决策（系统检查失败）' }
  if (latest.ok && !state.validationResults.some((item) => item.step === state.currentStep && item.kind === 'semantic')) return { tool: 'validate_step', arguments: { step: state.currentStep }, summary: '补充语义审查' }
  if (state.currentStep === 'retro') return { tool: 'finalize_delivery', arguments: {}, summary: '运行全局检查并完成交付' }
  return { tool: 'advance_step', arguments: {}, summary: '当前步骤通过，进入下一步' }
}

async function chooseAction(runtime, lastToolResult) {
  const { state, config, prompts } = runtime
  if (!text(config.apiKey)) return fallbackAction(state)
  const user = `【工具列表】\n${TOOLS.join(', ')}\n\n【关键工具参数】\npropose_direction 使用 {"options":[...],"recommendedOptionId":"候选ID","recommendationReason":"推荐原因"}；原题已有三个方向时 options 可省略，但推荐字段名不得改变。\n\n【当前可审计状态】\n${JSON.stringify(summarizeState(state), null, 2)}\n\n【上一工具结果】\n${JSON.stringify(lastToolResult || null)}\n\n请选择唯一下一动作。write_section 的 section 只能是 mindmap、plan、retro；artifact 步骤先 propose_creative_forms，必须等待用户选择后才能 build_artifact。若当前步骤已经通过校验，使用 advance_step；retro 通过后使用 finalize_delivery。`
  const parseAction = (output) => {
    const action = extractJsonObject(output)
    if (!action || !TOOLS.includes(action.tool) || !action.arguments || typeof action.arguments !== 'object') return null
    return action
  }
  let action = parseAction(await callModel(runtime, '编排 Agent', '选择下一项工具动作', prompts.orchestrator, user, 0.1, { maxTokens: 1200 }))
  if (state.currentStep === 'topics' && state.topicOptions.length === 3 && !state.recommendedOptionId && action?.tool !== 'propose_direction') {
    const correction = `${user}\n\n上一轮动作不符合第一步协议。当前已有三个候选方向但没有推荐结果，必须调用 propose_direction，并在 arguments 中返回有效的 recommendedOptionId（只能是 A、B 或 C）和 recommendationReason；禁止调用 ask_user。`
    action = parseAction(await callModel(runtime, '编排 Agent', '补充第一步方向推荐', prompts.orchestrator, correction, 0.1, { maxTokens: 1200 }))
  }
  if (!action) return fallbackAction(state)
  if (state.currentStep === 'topics' && state.topicOptions.length === 3 && !state.recommendedOptionId && action.tool !== 'propose_direction') {
    return { tool: 'ask_user', arguments: { questions: ['模型未返回有效的方向推荐，请重新运行第一步解析。'] }, summary: '模型推荐结果缺失，等待重新解析' }
  }
  if ((action.tool === 'propose_creative_forms' || action.tool === 'build_artifact') && state.currentStep !== 'artifact') return fallbackAction(state)
  if (action.tool === 'write_section' && !['mindmap', 'plan', 'retro'].includes(state.currentStep)) return fallbackAction(state)
  const argumentsForTool = action.tool === 'write_section'
    ? { section: state.currentStep, ...(Array.isArray(action.arguments.issues) ? { issues: action.arguments.issues.slice(0, 8) } : {}) }
    : action.arguments
  return { tool: action.tool, arguments: argumentsForTool, summary: text(action.summary) || `执行 ${action.tool}` }
}

async function generateSection(runtime, section, issues = []) {
  const { state, config, prompts } = runtime
  if (!text(config.apiKey)) return section === 'mindmap' ? fallbackMindmap(state) : section === 'plan' ? fallbackPlan(state) : fallbackRetro()
  const schema = section === 'mindmap' ? '{"content":"Markdown 原文"}' : section === 'plan' ? '{"persona":"","pain":"","path":"","aiTool":"Codex 及选择原因","effect":"","risk":""}' : '{"satisfied":"","change":"","extraTime":"","interviewerQuestion":""}'
  const currentContent = section === 'mindmap' ? state.artifacts.mindmap : state.artifacts[section]
  const upstream = section === 'plan' ? { mindmap: state.artifacts.mindmap } : section === 'retro' ? { mindmap: state.artifacts.mindmap, plan: state.artifacts.plan } : null
  const user = `【完整原题（事实）】\n${state.task}\n\n【提取事实】\n${JSON.stringify(state.facts)}\n\n【用户已确认方向】\n${JSON.stringify({ decision: state.decision, option: selectedOption(state) })}\n\n【显式假设与用户补充】\n${JSON.stringify(state.assumptions)}\n\n【已通过的上游基准，不得擅自改口径】\n${JSON.stringify(upstream)}\n\n【当前版本】\n${JSON.stringify(currentContent)}\n\n【当前步骤】${section}\n【需要修复的问题】${JSON.stringify(issues)}\n\n${issues.length ? '这是局部修订：只修复列出的问题，保留当前版本中未被指出的事实、数字和执行策略；不得换成另一套互斥方案。' : '生成时必须选择一套唯一、可执行的数字与资源口径，不得写“或、二选一、视情况”作为最终方案。'}\n【输出 schema】${schema}`
  const parsed = extractJsonObject(await callModel(runtime, '内容 Agent', `生成或修订 ${section}`, prompts.content, user, 0.3))
  if (section === 'mindmap') return text(parsed?.content) || fallbackMindmap(state)
  const fallback = section === 'plan' ? fallbackPlan(state) : fallbackRetro()
  return Object.fromEntries(Object.keys(fallback).map((key) => [key, text(parsed?.[key]) || fallback[key]]))
}

async function generateArtifact(runtime, issues = [], creativeId = '') {
  const { state, config, prompts } = runtime
  const creative = state.creativeOptions?.find((item) => item.id === creativeId)
  if (!text(config.apiKey)) return fallbackHtml(state)
  const user = `【完整原题】\n${state.task}\n\n【用户已确认方向】\n${JSON.stringify({ decision: state.decision, option: selectedOption(state) })}\n\n【用户已选择的创作形式】\n${JSON.stringify(creative || null)}\n\n【思考脑图】\n${state.artifacts.mindmap}\n\n【方案六要素】\n${JSON.stringify(state.artifacts.plan)}\n\n【需要修复的问题】\n${JSON.stringify(issues)}\n\n生成不超过 5 MB、无外部依赖的完整单文件 HTML。`
  const output = text(await callModel(runtime, '作品 Agent', `制作：${creative?.title || '主作品'}`, prompts.artifact, user, 0.35)).replace(/^```(?:html)?/i, '').replace(/```$/i, '').trim()
  return /<!doctype\s+html/i.test(output) ? output : fallbackHtml(state)
}

async function semanticReview(runtime) {
  const { state, config, prompts } = runtime
  if (!text(config.apiKey)) return { ok: true, issues: [], summary: '离线模式仅完成确定性检查' }
  const reviewContent = state.currentStep === 'mindmap'
    ? { mindmap: state.artifacts.mindmap }
    : state.currentStep === 'plan'
      ? { mindmap: state.artifacts.mindmap, plan: state.artifacts.plan }
      : state.currentStep === 'artifact'
        ? { mindmap: state.artifacts.mindmap, plan: state.artifacts.plan, artifact: state.artifacts.html ? `${bytes(state.artifacts.html)} bytes HTML` : state.artifacts.images.map(({ name, type, size }) => ({ name, type, size })), aiRecord: state.artifacts.aiRecord }
        : { mindmap: state.artifacts.mindmap, plan: state.artifacts.plan, retro: state.artifacts.retro, artifact: state.artifacts.html ? `${bytes(state.artifacts.html)} bytes HTML` : state.artifacts.images.map(({ name, type, size }) => ({ name, type, size })) }
  const user = `【原题事实】\n${state.task}\n\n【用户确认】\n${JSON.stringify({ decision: state.decision, option: selectedOption(state) })}\n\n【假设】\n${JSON.stringify(state.assumptions)}\n\n【当前步骤】${state.currentStep}\n【本轮应检查的内容】\n${JSON.stringify(reviewContent)}\n\n只把会导致事实、方向、人数/资源口径、边界或交付不可执行的矛盾放入 issues 并令 ok=false。措辞优化和可选增强只写进 summary，不得阻断步骤。不得检查尚未进入的下游步骤。`
  const parsed = extractJsonObject(await callModel(runtime, '审查 Agent', `检查 ${state.currentStep}`, prompts.reviewer, user, 0.1))
  const issues = Array.isArray(parsed?.issues) ? parsed.issues.map(text).filter(Boolean).slice(0, 8) : ['Reviewer 返回格式无效']
  return { ok: parsed?.ok === true && issues.length === 0, issues, summary: text(parsed?.summary) }
}

async function executeTool(runtime, action) {
  const { state } = runtime
  const args = action.arguments || {}
  let toolResult = null; let stop = false; let ok = true; let nextAction = null
  const allowedBeforeDecision = ['read_task', 'read_workflow_state', 'propose_direction', 'ask_user', 'record_assumption']
  if (!state.decision?.confirmedAt && !allowedBeforeDecision.includes(action.tool)) {
    state.openQuestions = ['请选择并确认一个主攻方向。']
    state.waitingReason = '服务端阻止了未确认方向时的下游动作。'
    state.status = 'waiting_user'
    toolResult = { blocked: true, reason: state.waitingReason }
    appendAction(state, action.tool, args, action.summary, toolResult, false)
    return { toolResult, stop: true }
  }
  const contentSteps = ['mindmap', 'plan', 'retro']
  const phaseMismatch = (action.tool === 'write_section' && !contentSteps.includes(state.currentStep))
    || ((action.tool === 'build_artifact' || action.tool === 'propose_creative_forms') && state.currentStep !== 'artifact')
    || (action.tool === 'finalize_delivery' && state.currentStep !== 'retro')
    || (action.tool === 'propose_direction' && Boolean(state.decision?.confirmedAt))
  if (phaseMismatch) {
    toolResult = { blocked: true, reason: `${action.tool} 不能在 ${state.currentStep} 步骤执行` }
    appendAction(state, action.tool, args, action.summary, toolResult, false)
    return { toolResult, stop: false, nextAction: fallbackAction(state) }
  }
  if (action.tool === 'read_task') toolResult = { task: state.task, facts: state.facts }
  else if (action.tool === 'read_workflow_state') toolResult = summarizeState(state)
  else if (action.tool === 'propose_direction') {
    const provided = Array.isArray(args.options) ? args.options : []
    const normalized = provided.slice(0, 3).map((item, index) => ({ id: text(item.id) || String(index + 1), title: text(item.title).slice(0, 60), description: text(item.description), recommendationReason: text(item.recommendationReason), reverseQuestion: text(item.reverseQuestion) || '为什么它在本场景下不能作为主目标？' }))
    state.topicOptions = normalized.length === 3 ? normalized : parseTopics(state.task)
    const requestedOptionId = text(args.recommendedOptionId) || text(args.optionId)
    if (!state.topicOptions.some((item) => item.id === requestedOptionId)) {
      state.recommendedOptionId = ''
      state.openQuestions = ['模型未返回有效的方向推荐，请重新运行第一步解析。']
      state.waitingReason = '方向推荐必须由模型返回有效的候选项。'
      state.status = 'waiting_user'
      toolResult = { blocked: true, reason: state.waitingReason }
      appendAction(state, action.tool, args, action.summary, toolResult, false)
      return { toolResult, stop: true }
    }
    state.recommendedOptionId = requestedOptionId
    const recommendationReason = text(args.recommendationReason) || text(args.reason)
    if (state.topicOptions.length === 3) state.topicOptions = state.topicOptions.map((item) => ({
      ...item,
      recommendationReason: item.id === state.recommendedOptionId ? recommendationReason || item.recommendationReason || 'Agent 建议：该方向最直接响应当前硬约束；仍需用户确认。' : item.recommendationReason || '',
    }))
    toolResult = { count: state.topicOptions.length, recommendedOptionId: state.recommendedOptionId }
    if (state.topicOptions.length !== 3) { state.openQuestions = ['题目中未能稳定识别三个候选主题，请补充三个主题的标题和说明。']; state.waitingReason = '主题信息不足'; state.status = 'waiting_user'; stop = true; ok = false }
    else { state.openQuestions = ['请选择并确认一个主攻方向。']; state.waitingReason = '方向必须由用户确认'; state.status = 'waiting_user'; stop = true }
  } else if (action.tool === 'propose_creative_forms') {
    state.creativeOptions = await generateCreativeOptions(runtime)
    state.selectedCreativeIds = []
    state.artifactLanes = []
    state.primaryArtifactLaneId = ''
    state.artifacts.html = ''
    state.openQuestions = ['请选择一种或多种创作形式，再进入制作。']
    state.waitingReason = '创意 Agent 已生成候选，等待用户选择。'
    state.status = 'waiting_user'
    toolResult = { count: state.creativeOptions.length, options: state.creativeOptions.map(({ id, title, score }) => ({ id, title, score })) }
    stop = true
  } else if (action.tool === 'ask_user') {
    state.openQuestions = (Array.isArray(args.questions) ? args.questions : [args.question]).map(text).filter(Boolean).slice(0, 3)
    state.waitingReason = action.summary || '需要用户确认后继续'
    state.status = 'waiting_user'; toolResult = { questions: state.openQuestions }; stop = true
  } else if (action.tool === 'record_assumption') {
    const assumption = text(args.assumption)
    if (assumption && !state.assumptions.includes(assumption)) state.assumptions.push(assumption)
    toolResult = { recorded: assumption }
  } else if (action.tool === 'write_section') {
    const section = state.currentStep
    const latest = [...state.validationResults].reverse().find((item) => item.step === section)
    if (latest && !latest.ok && (state.retryCounts[section] || 0) >= 2) {
      state.openQuestions = latest.issues.slice(0, 3); state.waitingReason = '自动修订达到 2 次上限，需要用户决策（系统检查失败）。'; state.status = 'waiting_user'
      toolResult = { blocked: true, questions: state.openQuestions }; appendAction(state, action.tool, args, action.summary, toolResult, false)
      return { toolResult, stop: true }
    }
    const generated = await generateSection(runtime, section, Array.isArray(args.issues) && args.issues.length ? args.issues : latest?.issues || [])
    const previous = state.artifacts[section]
    const revising = typeof previous === 'string' ? Boolean(text(previous)) : Boolean(previous && Object.values(previous).some((value) => text(value)))
    state.lockedModules ||= []
    if (section === 'mindmap') {
      if (!state.lockedModules.includes('mindmap')) state.artifacts.mindmap = generated
    } else {
      state.artifacts[section] = Object.fromEntries(Object.entries(generated).map(([key, value]) => [key, state.lockedModules.includes(key) ? state.artifacts[section][key] : value]))
    }
    state.validationResults = state.validationResults.filter((item) => item.step !== section)
    if (section === 'mindmap' || section === 'plan') state.artifactStale = Boolean(state.artifacts.html || state.artifacts.images.length)
    state.retryCounts[section] = (state.retryCounts[section] || 0) + (revising ? 1 : 0)
    toolResult = { section, characters: typeof generated === 'string' ? generated.length : JSON.stringify(generated).length }
    nextAction = { tool: 'validate_step', arguments: { step: section }, summary: '校验当前步骤' }
  } else if (action.tool === 'build_artifact') {
    const latest = [...state.validationResults].reverse().find((item) => item.step === 'artifact')
    if (latest && !latest.ok && (state.retryCounts.artifact || 0) >= 2) {
      state.openQuestions = latest.issues.slice(0, 3); state.waitingReason = '作品自动修订达到 2 次上限，需要用户决策（系统检查失败）。'; state.status = 'waiting_user'
      toolResult = { blocked: true, questions: state.openQuestions }; appendAction(state, action.tool, args, action.summary, toolResult, false)
      return { toolResult, stop: true }
    }
    state.artifactLanes ||= []
    const requested = Array.isArray(args.creativeIds) ? args.creativeIds.map(text).filter(Boolean) : text(args.creativeId) ? [text(args.creativeId)] : []
    const pending = state.selectedCreativeIds?.filter((id) => !state.artifactLanes.some((lane) => lane.creativeId === id && lane.status === 'done')) || []
    const primaryLane = state.artifactLanes.find((lane) => lane.id === state.primaryArtifactLaneId)
    const creativeIds = [...new Set(requested.length ? requested : pending.length ? pending : primaryLane ? [primaryLane.creativeId] : state.selectedCreativeIds?.slice(0, 1) || [])]
    if (!creativeIds.length || creativeIds.some((id) => !state.creativeOptions?.some((item) => item.id === id))) {
      state.openQuestions = ['请先选择至少一种创作形式。']; state.waitingReason = '没有可制作的创作形式'; state.status = 'waiting_user'
      toolResult = { blocked: true, reason: state.waitingReason }; appendAction(state, action.tool, args, action.summary, toolResult, false); return { toolResult, stop: true }
    }
    const lanes = creativeIds.map((creativeId) => {
      const creative = state.creativeOptions.find((item) => item.id === creativeId)
      let lane = state.artifactLanes.find((item) => item.creativeId === creativeId)
      if (!lane) { lane = { id: crypto.randomUUID(), creativeId, title: creative.title, status: 'queued', versions: [], activeVersionId: '', error: '' }; state.artifactLanes.push(lane) }
      lane.status = 'queued'; lane.error = ''
      return lane
    })
    const revising = lanes.some((lane) => lane.versions.length > 0)
    const issues = Array.isArray(args.issues) && args.issues.length ? args.issues : latest?.issues || []
    const results = []
    let cursor = 0
    const worker = async () => {
      while (cursor < lanes.length) {
        const lane = lanes[cursor++]
        lane.status = 'running'
        try {
          const html = await generateArtifact(runtime, issues, lane.creativeId)
          const version = { id: crypto.randomUUID(), version: lane.versions.length + 1, html, prompt: text(args.prompt) || action.summary || 'Agent 初次制作', createdAt: now() }
          lane.versions.push(version); lane.activeVersionId = version.id; lane.status = 'done'; results.push({ laneId: lane.id, creativeId: lane.creativeId, version: version.version, bytes: bytes(html) })
          if (state.primaryArtifactLaneId === lane.id || (state.selectedCreativeIds.length === 1 && !state.primaryArtifactLaneId)) { state.primaryArtifactLaneId = lane.id; state.artifacts.html = html }
        } catch (error) { lane.status = error?.name === 'AbortError' ? 'cancelled' : 'failed'; lane.error = error instanceof Error ? error.message : '制作失败'; throw error }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, lanes.length) }, worker))
    state.artifacts.images = []
    state.validationResults = state.validationResults.filter((item) => item.step !== 'artifact')
    state.artifactStale = false
    state.artifacts.aiRecord = {
      introduction: `围绕 ${selectedOption(state)?.title || '已确认方向'} 的一页可执行面试方案。`, toolName: 'Codex',
      firstPrompt: state.firstPrompt, firstPromptSource: 'run_log',
      dissatisfaction: text(args.dissatisfaction) || '当前作品优先保证信息完整和可提交，互动深度与真实现场数据验证仍有限。',
      iterationLogic: text(args.iterationLogic) || '先锁定用户确认方向和边界，再生成最小 HTML；随后依据尺寸、结构和一致性检查进行局部修订。',
    }
    state.retryCounts.artifact = (state.retryCounts.artifact || 0) + (revising ? 1 : 0)
    toolResult = { format: 'html', concurrency: Math.min(2, lanes.length), lanes: results }
    nextAction = { tool: 'validate_step', arguments: { step: 'artifact' }, summary: '校验当前步骤' }
  } else if (action.tool === 'inspect_artifact') {
    toolResult = { htmlBytes: bytes(state.artifacts.html), completeHtml: /<!doctype\s+html/i.test(state.artifacts.html) && /<body[\s>]/i.test(state.artifacts.html), imageCount: state.artifacts.images.length, stale: state.artifactStale }
  } else if (action.tool === 'validate_step') {
    const deterministic = validateAgentStep(state, state.currentStep)
    state.validationResults = state.validationResults.filter((item) => !(item.step === state.currentStep && item.kind === 'deterministic')).concat(deterministic)
    let semantic = { step: state.currentStep, ok: true, issues: [], checkedAt: now(), kind: 'semantic' }
    if (deterministic.ok) {
      const reviewed = await semanticReview(runtime)
      semantic = { step: state.currentStep, ok: reviewed.ok, issues: reviewed.issues, checkedAt: now(), kind: 'semantic', summary: reviewed.summary }
      state.validationResults = state.validationResults.filter((item) => !(item.step === state.currentStep && item.kind === 'semantic')).concat(semantic)
    }
    toolResult = { deterministic, semantic }
    nextAction = fallbackAction(state)
  } else if (action.tool === 'advance_step') {
    const checks = state.validationResults.filter((item) => item.step === state.currentStep)
    if (!checks.length || checks.some((item) => !item.ok)) { toolResult = { advanced: false, reason: '当前步骤尚未通过全部检查' }; ok = false; nextAction = fallbackAction(state) }
    else {
      if (!state.completedSteps.includes(state.currentStep)) state.completedSteps.push(state.currentStep)
      const next = STEPS[STEPS.indexOf(state.currentStep) + 1]
      if (next) state.currentStep = next
      toolResult = { advanced: Boolean(next), currentStep: state.currentStep }
      nextAction = fallbackAction(state)
    }
  } else if (action.tool === 'finalize_delivery') {
    const results = STEPS.map((step) => validateAgentStep(state, step))
    const issues = results.flatMap((item) => item.issues)
    for (const step of STEPS.slice(1)) {
      const semantic = [...state.validationResults].reverse().find((item) => item.step === step && item.kind === 'semantic')
      if (!semantic?.ok) issues.push(`${step} 尚未通过审查 Agent 检查`)
    }
    state.validationResults = [...state.validationResults.filter((item) => item.kind === 'semantic'), ...results, { step: 'global', ok: !issues.length, issues, checkedAt: now(), kind: 'deterministic' }]
    if (issues.length) { state.status = 'failed'; state.waitingReason = `最终检查失败：${issues.slice(0, 3).join('；')}`; ok = false }
    else { state.completedSteps = [...STEPS]; state.status = 'completed'; state.finishedAt = now(); state.waitingReason = '' }
    toolResult = { completed: !issues.length, issues }; stop = true
  }
  appendAction(state, action.tool, args, action.summary, toolResult, ok)
  return { toolResult, stop, nextAction }
}

function publicRun(runtime) { return clone(runtime.state) }

export async function createAgentService(dataDir) {
  const file = path.join(dataDir, 'agent-runs.json')
  const runs = new Map()
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'))
    for (const state of saved) {
      if (state.status === 'running') { state.status = 'failed'; state.waitingReason = '本地服务重启，本轮已停止；可从最后一个工具结果恢复。' }
      runs.set(state.id, { state: normalizeState(state), controller: null, config: null, prompts: null })
    }
  } catch { /* first run */ }

  let persistTimer
  const persist = () => {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(async () => {
      await mkdir(dataDir, { recursive: true })
      await writeFile(file, JSON.stringify([...runs.values()].map((runtime) => runtime.state), null, 2), 'utf8')
    }, 100)
  }

  async function run(runtime) {
    let lastToolResult = null
    try {
      for (let index = 0; index < MAX_ACTIONS_PER_RESUME; index += 1) {
        if (runtime.controller.signal.aborted) throw new DOMException('用户已中断', 'AbortError')
        updateRemainingTime(runtime.state)
        const action = lastToolResult?.nextAction || await chooseAction(runtime, lastToolResult?.result || null)
        const executed = await executeTool(runtime, action)
        lastToolResult = { result: executed.toolResult, nextAction: executed.nextAction }
        persist()
        if (executed.stop) return
      }
      runtime.state.status = 'failed'
      runtime.state.waitingReason = `达到单轮 ${MAX_ACTIONS_PER_RESUME} 次动作上限，可检查轨迹后恢复。`
    } catch (error) {
      if (runtime.state.status !== 'paused') {
        runtime.state.status = error?.name === 'AbortError' ? 'cancelled' : 'failed'
        runtime.state.waitingReason = error instanceof Error ? error.message : 'Agent 运行失败'
      }
    } finally {
      runtime.controller = null; runtime.config = null; runtime.prompts = null; persist()
    }
  }

  function start(input) {
    if (!input?.state?.id || !input?.state?.projectId || !text(input.state.task)) throw new Error('缺少有效的 Agent Run 状态或完整题目')
    const existing = runs.get(input.state.id)
    if (existing?.state.status === 'running') throw new Error('该 Agent Run 正在运行')
    const state = normalizeState(clone(input.state))
    const resumedUserGate = existing?.state.status === 'waiting_user' && existing.state.currentStep === state.currentStep
    if (resumedUserGate) {
      state.retryCounts[state.currentStep] = 0
      state.validationResults = state.validationResults.filter((item) => item.step !== state.currentStep)
    }
    state.startedAt ||= now()
    if (state.pausedAt) state.accumulatedPauseMs += Math.max(0, Date.now() - Date.parse(state.pausedAt))
    state.finishedAt = null; state.pausedAt = null; state.status = 'running'; state.openQuestions = []; state.waitingReason = ''
    state.firstPrompt ||= state.task
    state.artifacts.aiRecord.firstPrompt = state.firstPrompt
    state.artifacts.aiRecord.firstPromptSource = 'run_log'
    state.artifacts.aiRecord.toolName = 'Codex'
    const runtime = { state, config: { baseUrl: input.baseUrl || '', apiKey: input.apiKey || '', model: input.model || '', temperature: input.temperature ?? 0.25, fastMode: input.fastMode === true }, prompts: { ...input.prompts, creative: input.prompts.creative || input.prompts.artifact }, controller: new AbortController() }
    runs.set(state.id, runtime); persist(); void run(runtime)
    return publicRun(runtime)
  }

  function get(id) { const runtime = runs.get(id); return runtime ? publicRun(runtime) : null }
  function cancel(id) {
    const runtime = runs.get(id)
    if (!runtime) return null
    runtime.controller?.abort()
    runtime.state.status = 'cancelled'; runtime.state.waitingReason = '用户已中断，可从已保存状态恢复。'
    appendAction(runtime.state, 'cancel', {}, '中断 Agent Run', { status: 'cancelled' }, true)
    persist(); return publicRun(runtime)
  }
  function pause(id) {
    const runtime = runs.get(id)
    if (!runtime) return null
    runtime.controller?.abort()
    runtime.state.status = 'paused'; runtime.state.pausedAt = now(); runtime.state.waitingReason = '计时与 Agent 已暂停。'
    appendAction(runtime.state, 'pause', {}, '暂停 Agent Run', { status: 'paused' }, true)
    persist(); return publicRun(runtime)
  }
  return { start, get, cancel, pause }
}
