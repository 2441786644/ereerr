import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAgentService, validateAgentStep } from '../agent-runner.mjs'
import { applyFastMode } from '../model-request.mjs'

const task = `校园活动两天后举行，场地只能容纳40人，材料仅够25套，预算只剩300元。TOPICS // 三选一A优先保住现场体验选 A 意味着限制入场人数并保证现场质量。B材料预算硬约束优先选 B 意味着围绕材料和预算重排执行。C快速补教学人力短板选 C 意味着训练助手并降低讲授依赖。NOTE // 最终交付需要说明取舍与一致性。`
const prompts = { version: 1, orchestrator: 'orchestrator', content: 'content', creative: 'creative', artifact: 'artifact', reviewer: 'reviewer' }

test('fast mode disables thinking for compatible and native DashScope requests', () => {
  const compatible = applyFastMode({ model: 'qwen-plus', messages: [] }, 'compatible', true)
  const dashscope = applyFastMode({ model: 'qwen-plus', parameters: { incremental_output: true } }, 'dashscope', true)
  assert.equal(compatible.enable_thinking, false)
  assert.equal(dashscope.parameters.enable_thinking, false)
  assert.equal(dashscope.parameters.incremental_output, true)
  assert.equal('enable_thinking' in applyFastMode({ model: 'other-model' }, 'compatible', false), false)
})

function freshState() {
  return {
    id: crypto.randomUUID(), projectId: crypto.randomUUID(), goal: '在25分钟内完成五步交付', task, currentStep: 'topics', status: 'idle',
    startedAt: null, finishedAt: null, pausedAt: null, accumulatedPauseMs: 0, remainingTime: 1500, facts: [], topicOptions: [], recommendedOptionId: '', decision: null,
    assumptions: [], openQuestions: [], waitingReason: '', artifacts: { mindmap: '', plan: { persona: '', pain: '', path: '', aiTool: '', effect: '', risk: '' }, html: '', images: [], aiRecord: { introduction: '', toolName: 'Codex', firstPrompt: '', firstPromptSource: 'run_log', dissatisfaction: '', iterationLogic: '' }, retro: { satisfied: '', change: '', extraTime: '', interviewerQuestion: '' } },
    artifactStale: false, validationResults: [], actionHistory: [], retryCounts: {}, completedSteps: [], promptVersion: 1, firstPrompt: '',
  }
}

async function waitForStop(service, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = service.get(id)
    if (state?.status !== 'running') return state
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Agent Run did not stop')
}

test('offline Agent stops for direction confirmation, then completes the five-step tool loop', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    service.start({ state: initial, prompts, baseUrl: '', apiKey: '', model: '' })
    const waiting = await waitForStop(service, initial.id)
    assert.equal(waiting.status, 'waiting_user')
    assert.equal(waiting.topicOptions.length, 3)
    assert.equal(waiting.decision, null)

    const selected = waiting.topicOptions[0]
    const resumed = {
      ...waiting,
      currentStep: 'mindmap', status: 'idle', openQuestions: [], waitingReason: '', completedSteps: ['topics'],
      decision: { optionId: selected.id, confirmedAt: new Date().toISOString(), reason: '用户确认的选择理由', rejectedReasons: Object.fromEntries(waiting.topicOptions.slice(1).map((item) => [item.id, `不以 ${item.id} 为主目标的具体原因`])) },
    }
    service.start({ state: resumed, prompts, baseUrl: '', apiKey: '', model: '' })
    const creativeGate = await waitForStop(service, initial.id)
    assert.equal(creativeGate.status, 'waiting_user')
    assert.equal(creativeGate.currentStep, 'artifact')
    assert.equal(creativeGate.creativeOptions.length, 4)

    const selectedCreativeIds = creativeGate.creativeOptions.slice(0, 2).map((item) => item.id)
    service.start({ state: { ...creativeGate, selectedCreativeIds, status: 'idle', openQuestions: [], waitingReason: '' }, prompts, baseUrl: '', apiKey: '', model: '' })
    const primaryGate = await waitForStop(service, initial.id)
    assert.equal(primaryGate.status, 'waiting_user')
    assert.equal(primaryGate.artifactLanes.length, 2)
    assert.ok(primaryGate.artifactLanes.every((lane) => lane.status === 'done' && lane.versions.length === 1))

    const primary = primaryGate.artifactLanes[0]
    const active = primary.versions.find((version) => version.id === primary.activeVersionId)
    service.start({ state: { ...primaryGate, primaryArtifactLaneId: primary.id, artifacts: { ...primaryGate.artifacts, html: active.html }, status: 'idle', openQuestions: [], waitingReason: '' }, prompts, baseUrl: '', apiKey: '', model: '' })
    const completed = await waitForStop(service, initial.id)
    assert.equal(completed.status, 'completed')
    assert.deepEqual(completed.completedSteps, ['topics', 'mindmap', 'plan', 'artifact', 'retro'])
    assert.ok(completed.artifacts.mindmap.length <= 5000)
    assert.match(completed.artifacts.mindmap, /最犹豫/)
    assert.match(completed.artifacts.mindmap, /最不确定/)
    assert.match(completed.artifacts.mindmap, /25\s*分钟/)
    assert.match(completed.artifacts.mindmap, /一致性/)
    assert.doesNotMatch(completed.artifacts.mindmap, /最满意|最想改变|想问面试官/)
    assert.match(completed.artifacts.plan.aiTool, /Codex/)
    assert.match(completed.artifacts.html, /<!doctype html>/i)
    assert.equal(completed.artifacts.aiRecord.firstPrompt, task)
    assert.equal(completed.artifacts.aiRecord.firstPromptSource, 'run_log')
    assert.ok(completed.actionHistory.some((action) => action.tool === 'validate_step'))
    assert.ok(completed.actionHistory.some((action) => action.tool === 'finalize_delivery'))

    await new Promise((resolve) => setTimeout(resolve, 160))
    const restoredService = await createAgentService(directory)
    assert.equal(restoredService.get(initial.id)?.status, 'completed')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('artifact validator blocks HTML over 5 MB and more than 8 images', () => {
  const state = freshState()
  state.currentStep = 'artifact'
  state.firstPrompt = task
  state.artifacts.aiRecord = { introduction: '介绍', toolName: 'Codex', firstPrompt: task, firstPromptSource: 'run_log', dissatisfaction: '不足', iterationLogic: '迭代' }
  state.artifacts.html = `<!doctype html><html><body>${'x'.repeat(5 * 1024 * 1024)}</body></html>`
  assert.equal(validateAgentStep(state, 'artifact').ok, false)
  assert.match(validateAgentStep(state, 'artifact').issues.join('；'), /5 MB/)
  state.artifacts.html = ''
  state.artifacts.images = Array.from({ length: 9 }, (_, index) => ({ id: String(index), name: `${index}.png`, type: 'image/png', size: 1, dataUrl: '' }))
  assert.equal(validateAgentStep(state, 'artifact').ok, false)
  assert.match(validateAgentStep(state, 'artifact').issues.join('；'), /8 张/)
})

test('artifact validator detects a work product that omits the confirmed direction', () => {
  const state = freshState()
  state.currentStep = 'artifact'
  state.topicOptions = [{ id: 'A', title: '现场体验', description: '' }, { id: 'B', title: '材料预算', description: '' }, { id: 'C', title: '教学人力', description: '' }]
  state.decision = { optionId: 'A', confirmedAt: new Date().toISOString(), reason: '确认 A', rejectedReasons: { B: '不选 B', C: '不选 C' } }
  state.firstPrompt = task
  state.artifacts.aiRecord = { introduction: '介绍', toolName: 'Codex', firstPrompt: task, firstPromptSource: 'run_log', dissatisfaction: '不足', iterationLogic: '迭代' }
  state.artifacts.html = '<!doctype html><html><body><h1>材料预算方案</h1></body></html>'
  const validation = validateAgentStep(state, 'artifact')
  assert.equal(validation.ok, false)
  assert.match(validation.issues.join('；'), /主攻方向不一致/)
})

test('mindmap validator separates original self-explanation from final review fields', () => {
  const state = freshState()
  state.topicOptions = [{ id: 'A', title: '现场体验', description: '' }, { id: 'B', title: '材料预算', description: '' }, { id: 'C', title: '教学人力', description: '' }]
  state.decision = { optionId: 'A', confirmedAt: new Date().toISOString(), reason: '确认 A', rejectedReasons: { B: '不选 B', C: '不选 C' } }
  state.artifacts.mindmap = '# 冲突\n三类冲突及影响\n# 方向选择\n主攻 A 现场体验及选择理由，放弃 B、C 的反向理由\n# A4 执行方案\n下一步动作\n# 边界\n不做、不服务与关键前提\n# 自我说明\n最犹豫的取舍、最不确定的假设、额外 25 分钟优先改动\n# 一致性自证\n方向、交付和边界一致。'
  assert.equal(validateAgentStep(state, 'mindmap').ok, true)
  state.artifacts.mindmap += '\n最满意：内容完整。'
  const invalid = validateAgentStep(state, 'mindmap')
  assert.equal(invalid.ok, false)
  assert.match(invalid.issues.join('；'), /最终复盘专属内容/)
})

test('Agent records full prompts and exposes partial streamed model output', async () => {
  let requestCount = 0
  const requestBodies = []
  const upstream = createServer(async (request, response) => {
    requestCount += 1
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const output = requestCount === 1
      ? '{"tool":"propose_direction","arguments":{},"summary":"解析方向"}'
      : '{"tool":"ask_user","arguments":{"questions":["请选择主攻方向"]},"summary":"等待确认"}'
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: output.slice(0, 24) } }] })}\n\n`)
    setTimeout(() => { response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: output.slice(24) } }] })}\n\ndata: [DONE]\n\n`); response.end() }, 80)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-stream-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    service.start({ state: initial, prompts, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', model: 'test-model', fastMode: true })
    let sawPartial = false
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const call = service.get(initial.id)?.modelCalls?.[0]
      if (call?.status === 'running' && call.output.length > 0) { sawPartial = true; break }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(sawPartial, true)
    const waiting = await waitForStop(service, initial.id)
    assert.equal(waiting.status, 'waiting_user')
    assert.equal(waiting.modelCalls.length, 1)
    assert.ok(waiting.modelCalls.every((call) => call.status === 'completed'))
    assert.match(waiting.modelCalls[0].systemPrompt, /orchestrator/)
    assert.match(waiting.modelCalls[0].userPrompt, /当前可审计状态/)
    assert.match(waiting.modelCalls[0].output, /propose_direction/)
    assert.equal(requestBodies.length, 1)
    assert.ok(requestBodies.every((requestBody) => requestBody.enable_thinking === false))
  } finally {
    await new Promise((resolve) => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('deterministic post-write and validation transitions skip extra orchestrator calls', async () => {
  const requestBodies = []
  const upstream = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requestBodies.push(body)
    const systemPrompt = body.messages?.[0]?.content || ''
    const output = systemPrompt.includes('编排 Agent')
      ? '{"tool":"write_section","arguments":{"section":"mindmap"},"summary":"生成脑图"}'
      : '{"content":"不完整内容"}'
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: output } }] }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-deterministic-transition-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    initial.currentStep = 'mindmap'
    initial.topicOptions = [{ id: 'A', title: '现场体验', description: '' }, { id: 'B', title: '材料预算', description: '' }, { id: 'C', title: '教学人力', description: '' }]
    initial.decision = { optionId: 'A', confirmedAt: new Date().toISOString(), reason: '确认 A', rejectedReasons: { B: '不选 B', C: '不选 C' } }
    initial.retryCounts.mindmap = 2
    service.start({ state: initial, prompts, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', model: 'test-model' })
    const waiting = await waitForStop(service, initial.id)
    assert.equal(waiting.status, 'waiting_user')
    assert.equal(requestBodies.length, 2)
    assert.deepEqual(waiting.modelCalls.map((call) => call.agent), ['编排 Agent', '内容 Agent'])
    assert.deepEqual(waiting.actionHistory.slice(-2).map((action) => action.tool), ['validate_step', 'ask_user'])
  } finally {
    await new Promise((resolve) => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('successful advance uses a deterministic next action instead of re-asking the orchestrator', async () => {
  const requestBodies = []
  const upstream = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requestBodies.push(body)
    const userPrompt = body.messages?.[1]?.content || ''
    let output = '{}'
    if (userPrompt.includes('请选择唯一下一动作')) output = requestBodies.length === 1
      ? '{"tool":"advance_step","arguments":{},"summary":"进入下一步"}'
      : '{"tool":"advance_step","arguments":{},"summary":"重复进入下一步"}'
    else if (userPrompt.includes('只把会导致')) output = '{"ok":true,"issues":[],"summary":"通过"}'
    else if (userPrompt.includes('"persona"')) output = '{"persona":"参与者","pain":"痛点 A","path":"路径 A","aiTool":"Codex：保持口径一致","effect":"效果 A","risk":"风险 A"}'
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: output } }] }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-advance-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    initial.currentStep = 'mindmap'
    initial.topicOptions = [{ id: 'A', title: '现场体验', description: '' }, { id: 'B', title: '材料预算', description: '' }, { id: 'C', title: '教学人力', description: '' }]
    initial.decision = { optionId: 'A', confirmedAt: new Date().toISOString(), reason: '确认 A', rejectedReasons: { B: '不选 B', C: '不选 C' } }
    initial.artifacts.mindmap = '# 冲突\n三类冲突及影响\n# 方向\n主攻 A 现场体验，选择理由；放弃 B、C 的反向理由\n# A4\n执行方案与下一步动作\n# 边界\n不做、不服务谁与关键前提\n# 取舍\n最犹豫、最不确定，额外 25 分钟优先改动\n# 一致性\n一致性自证'
    initial.validationResults = [{ step: 'mindmap', ok: true, issues: [], checkedAt: new Date().toISOString(), kind: 'deterministic' }, { step: 'mindmap', ok: true, issues: [], checkedAt: new Date().toISOString(), kind: 'semantic' }]
    service.start({ state: initial, prompts, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', model: 'test-model' })
    const waiting = await waitForStop(service, initial.id)
    assert.equal(waiting.status, 'waiting_user')
    assert.equal(waiting.currentStep, 'artifact')
    assert.equal(waiting.actionHistory.filter((action) => action.tool === 'advance_step').length, 2)
    assert.equal(requestBodies.filter((body) => body.messages?.[1]?.content?.includes('请选择唯一下一动作')).length, 1)
    assert.equal(requestBodies.find((body) => body.messages?.[1]?.content?.includes('请选择唯一下一动作'))?.max_tokens, 1200)
  } finally {
    await new Promise((resolve) => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('offline direction gate can continue without typed reasons', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-direction-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    service.start({ state: initial, prompts, baseUrl: '', apiKey: '', model: '' })
    const waiting = await waitForStop(service, initial.id)
    const selected = waiting.topicOptions[0]
    const decision = { optionId: selected.id, confirmedAt: new Date().toISOString(), reason: `选择 ${selected.id} 作为主攻方向`, rejectedReasons: Object.fromEntries(waiting.topicOptions.slice(1).map((item) => [item.id, `暂不以 ${item.id} 为主目标`])) }
    service.start({ state: { ...waiting, decision, currentStep: 'mindmap', completedSteps: ['topics'], status: 'idle', openQuestions: [], waitingReason: '' }, prompts, baseUrl: '', apiKey: '', model: '' })
    const next = service.get(initial.id)
    assert.equal(next?.status, 'running')
    assert.ok(next?.decision?.reason)
    assert.equal(Object.keys(next?.decision?.rejectedReasons || {}).length, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('resuming a user gate clears the stale retry limit and step validation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-retry-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    service.start({ state: initial, prompts, baseUrl: '', apiKey: '', model: '' })
    const directionGate = await waitForStop(service, initial.id)
    const selected = directionGate.topicOptions[0]
    const blocked = {
      ...directionGate,
      currentStep: 'plan', status: 'waiting_user', waitingReason: '自动修订达到 2 次上限，需要用户决策（系统检查失败）。',
      decision: { optionId: selected.id, confirmedAt: new Date().toISOString(), reason: '确认主攻方向', rejectedReasons: { B: '不选 B', C: '不选 C' } },
      retryCounts: { plan: 2 },
      validationResults: [{ step: 'plan', ok: false, issues: ['人数口径冲突'], checkedAt: new Date().toISOString(), kind: 'semantic' }],
      artifacts: { ...directionGate.artifacts, mindmap: '# 已确认的上游脑图' },
    }
    service.start({ state: blocked, prompts, baseUrl: '', apiKey: '', model: '' })
    const actualGate = await waitForStop(service, initial.id)
    assert.equal(actualGate.status, 'waiting_user')
    assert.equal(actualGate.currentStep, 'plan')
    assert.equal(actualGate.retryCounts.plan, 2)

    service.start({ state: { ...actualGate, status: 'idle', openQuestions: [], assumptions: ['用户补充：采用唯一人数口径'] }, prompts, baseUrl: '', apiKey: '', model: '' })
    const resumed = service.get(initial.id)
    assert.equal(resumed.retryCounts.plan, 0)
    assert.equal(resumed.validationResults.some((item) => item.step === 'plan'), false)
    assert.equal(resumed.status, 'running')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('normalization migrates legacy passed issues into non-blocking review notes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-validation-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    initial.currentStep = 'plan'
    initial.validationResults = [{ step: 'mindmap', ok: true, issues: ['旧版 Reviewer 的优化建议'], summary: '已通过', checkedAt: new Date().toISOString(), kind: 'semantic' }]
    service.start({ state: initial, prompts, baseUrl: '', apiKey: '', model: '' })
    const normalized = service.get(initial.id)
    const review = normalized.validationResults[0]
    assert.equal(review.ok, true)
    assert.deepEqual(review.issues, [])
    assert.match(review.summary, /历史非阻断建议.*旧版 Reviewer 的优化建议/)
    service.cancel(initial.id)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('topic parser accepts option IDs on standalone lines', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-topic-lines-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    initial.task = `通用三选一题目\nTOPICS // 三选一\nA\n保住现场体验\n选 A 意味着优先质量。\nB\n控制材料预算\n选 B 意味着优先成本。\nC\n补足教学人力\n选 C 意味着优先复制教学。\nNOTE // 说明`
    service.start({ state: initial, prompts, baseUrl: '', apiKey: '', model: '' })
    const waiting = await waitForStop(service, initial.id)
    assert.equal(waiting.status, 'waiting_user')
    assert.equal(waiting.waitingReason, '方向推荐必须由模型返回有效的候选项。')
    assert.equal(waiting.recommendedOptionId, '')
    assert.deepEqual(waiting.topicOptions.map(({ id, title }) => ({ id, title })), [
      { id: 'A', title: '保住现场体验' },
      { id: 'B', title: '控制材料预算' },
      { id: 'C', title: '补足教学人力' },
    ])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('direction recommendation accepts optionId compatibility without falling back to A', async () => {
  let requestCount = 0
  const upstream = createServer((_request, response) => {
    requestCount += 1
    const output = requestCount === 1
      ? '{"tool":"propose_direction","arguments":{"optionId":"B","reason":"推荐 B，因为它最直接响应硬约束。"},"summary":"推荐 B"}'
      : '{"tool":"ask_user","arguments":{"questions":["请选择方向"]},"summary":"等待确认"}'
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: output } }] }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-recommendation-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    service.start({ state: initial, prompts, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', model: 'test-model' })
    const waiting = await waitForStop(service, initial.id)
    assert.equal(waiting.recommendedOptionId, 'B')
    assert.match(waiting.topicOptions.find((item) => item.id === 'B').recommendationReason, /推荐 B/)
    assert.equal(waiting.topicOptions.find((item) => item.id === 'A').recommendationReason, '')
  } finally {
    await new Promise((resolve) => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('topic parsing always exposes a recommendation before the user gate', async () => {
  let requestCount = 0
  const upstream = createServer(async (_request, response) => {
    requestCount += 1
    const output = requestCount === 1
      ? '{"tool":"ask_user","arguments":{"questions":["请选择方向"]},"summary":"等待确认"}'
      : '{"tool":"propose_direction","arguments":{"recommendedOptionId":"B","recommendationReason":"预算是当前最硬约束。"},"summary":"推荐 B"}'
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: output } }] }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-topic-recommendation-gate-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    initial.topicOptions = [
      { id: 'A', title: '现场体验', description: '保住现场体验' },
      { id: 'B', title: '材料预算', description: '控制材料预算' },
      { id: 'C', title: '教学人力', description: '补足教学人力' },
    ]
    service.start({ state: initial, prompts, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', model: 'test-model' })
    const waiting = await waitForStop(service, initial.id)
    assert.equal(waiting.status, 'waiting_user')
    assert.equal(waiting.recommendedOptionId, 'B')
    assert.match(waiting.topicOptions.find((item) => item.id === 'B').recommendationReason, /预算/)
    assert.equal(requestCount, 2)
  } finally {
    await new Promise((resolve) => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing model recommendation never defaults to option A', async () => {
  const upstream = createServer(async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: '{"tool":"ask_user","arguments":{"questions":["请选择方向"]},"summary":"等待确认"}' } }] }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-studio-no-default-topic-test-'))
  try {
    const service = await createAgentService(directory)
    const initial = freshState()
    initial.topicOptions = [{ id: 'A', title: '现场体验', description: '' }, { id: 'B', title: '材料预算', description: '' }, { id: 'C', title: '教学人力', description: '' }]
    service.start({ state: initial, prompts, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', model: 'test-model' })
    const waiting = await waitForStop(service, initial.id)
    assert.equal(waiting.status, 'waiting_user')
    assert.equal(waiting.recommendedOptionId, '')
    assert.match(waiting.waitingReason, /模型.*推荐/)
  } finally {
    await new Promise((resolve) => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
