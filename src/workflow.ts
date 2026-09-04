export type StepId = 'topics' | 'mindmap' | 'plan' | 'artifact' | 'retro'
export type RunStatus = 'idle' | 'running' | 'waiting_user' | 'paused' | 'failed' | 'completed' | 'cancelled'
export type ToolName = 'read_task' | 'read_workflow_state' | 'propose_direction' | 'propose_creative_forms' | 'ask_user' | 'write_section' | 'record_assumption' | 'build_artifact' | 'inspect_artifact' | 'validate_step' | 'advance_step' | 'finalize_delivery'

export type TopicOption = {
  id: string
  title: string
  description: string
  recommendationReason?: string
  reverseQuestion?: string
}

export type Decision = {
  optionId: string
  confirmedAt: string
  reason: string
  rejectedReasons: Record<string, string>
}

export type PlanFields = {
  persona: string
  pain: string
  path: string
  aiTool: string
  effect: string
  risk: string
}

export type RetroFields = {
  satisfied: string
  change: string
  extraTime: string
  interviewerQuestion: string
}

export type AiRecord = {
  introduction: string
  toolName: 'Codex'
  firstPrompt: string
  firstPromptSource: 'run_log'
  dissatisfaction: string
  iterationLogic: string
}

export type ImageArtifact = { id: string; name: string; type: string; size: number; dataUrl: string }
export type CreativeOption = {
  id: string
  title: string
  description: string
  difficulty: '低' | '中' | '高'
  estimatedMinutes: number
  tags: string[]
  risk: string
  fallback: string
  score: number
}
export type ArtifactVersion = { id: string; version: number; html: string; prompt: string; createdAt: string }
export type ArtifactLane = {
  id: string
  creativeId: string
  title: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  versions: ArtifactVersion[]
  activeVersionId: string
  error: string
}
export type ModelCall = {
  id: string
  agent: string
  title: string
  systemPrompt: string
  userPrompt: string
  output: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  updatedAt: string
  finishedAt?: string
  error?: string
}
export type ContentModuleId = 'mindmap' | keyof PlanFields | keyof RetroFields
export type ContentSnapshot = {
  id: string
  label: string
  createdAt: string
  mindmap: string
  plan: PlanFields
  retro: RetroFields
}
export type ValidationResult = { step: StepId | 'global'; ok: boolean; issues: string[]; checkedAt: string; kind: 'deterministic' | 'semantic' }
export type ActionRecord = {
  id: string
  at: string
  actor: 'agent' | 'user' | 'system'
  tool: ToolName | 'confirm_direction' | 'edit' | 'pause' | 'resume' | 'cancel'
  goal: string
  inputSummary: string
  resultSummary: string
  ok: boolean
}

export type PromptSet = {
  version: number
  orchestrator: string
  content: string
  creative: string
  artifact: string
  reviewer: string
}

export type AgentRun = {
  id: string
  projectId: string
  goal: string
  task: string
  currentStep: StepId
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  pausedAt: string | null
  accumulatedPauseMs: number
  remainingTime: number
  facts: string[]
  topicOptions: TopicOption[]
  recommendedOptionId: string
  decision: Decision | null
  assumptions: string[]
  openQuestions: string[]
  waitingReason: string
  creativeOptions: CreativeOption[]
  selectedCreativeIds: string[]
  artifactLanes: ArtifactLane[]
  primaryArtifactLaneId: string
  modelCalls: ModelCall[]
  lockedModules: ContentModuleId[]
  contentSnapshots: ContentSnapshot[]
  artifacts: {
    mindmap: string
    plan: PlanFields
    html: string
    images: ImageArtifact[]
    aiRecord: AiRecord
    retro: RetroFields
  }
  artifactStale: boolean
  validationResults: ValidationResult[]
  actionHistory: ActionRecord[]
  retryCounts: Partial<Record<StepId, number>>
  completedSteps: StepId[]
  promptVersion: number
  promptSnapshot: PromptSet
  firstPrompt: string
}

export const STEP_ORDER: StepId[] = ['topics', 'mindmap', 'plan', 'artifact', 'retro']
export const COUNTDOWN_ENABLED = false
export const STEP_META: Record<StepId, { number: string; label: string; description: string }> = {
  topics: { number: '01', label: '三选一主题', description: '解析候选方向并确认主攻项' },
  mindmap: { number: '02', label: '思考脑图', description: '覆盖原题关键要求并可扩展，Markdown ≤ 5000 字' },
  plan: { number: '03', label: '方案六要素', description: '画像、痛点、路径、工具、效果、风险' },
  artifact: { number: '04', label: '作品与 AI 记录', description: 'HTML 或图片及真实使用记录' },
  retro: { number: '05', label: '最终复盘', description: '一致性检查、冻结与导出' },
}

export const EMPTY_PLAN: PlanFields = { persona: '', pain: '', path: '', aiTool: '', effect: '', risk: '' }
export const EMPTY_RETRO: RetroFields = { satisfied: '', change: '', extraTime: '', interviewerQuestion: '' }

export const DEFAULT_PROMPTS: PromptSet = {
  version: 3,
  orchestrator: `你是 Workflow Studio 的编排 Agent。你的职责是根据当前可审计状态选择下一项工具动作，而不是一次性回答整道题。\n事实、用户确认、Agent 建议和假设必须分开。不得替用户确认三选一方向，不得擅自更换已确认方向。\n每轮只返回一个 JSON 对象：{"tool":"工具名","arguments":{...},"summary":"简短决策说明"}。不得输出代码围栏或隐藏思维过程。\n第一步 topics 在已有三个候选方向但 recommendedOptionId 为空时，必须调用 propose_direction，并在 arguments 中返回有效的 recommendedOptionId 和 recommendationReason；禁止直接调用 ask_user，也不得自行把 A、B 或 C 当作推荐。\n优先读取状态；信息不足且会改变主方向时使用 ask_user（最多 3 个问题）；否则记录显式假设。每步先生成、再 validate_step，通过后才能 advance_step。校验指出内容互相矛盾时，先以原题事实和用户已确认方向为准局部修订，不得并列保留互斥口径；最多修订失败步骤 2 次。剩余时间少于 5 分钟时降低作品复杂度，但不得删除必答项。`,
  content: `你是内容 Agent，只生成被指定的文字步骤。完整原题是事实来源；已确认方向是不可变决策；假设必须显式标注。相同人数、资源、服务边界和执行方式在所有模块中只能使用一组相容口径，不得把备选方案写成已确定事实。\n思考脑图应覆盖原题关键任务，包含但不限于：1. 三类关键冲突及影响；2. 主攻方向、选择理由，以及放弃另外两个方向的具体反向理由；3. 可执行的一页 A4 方案；4. 不做什么、不服务谁、关键前提；5. 最犹豫的取舍、最不确定的假设、额外 25 分钟优先改动；6. 主攻方向、交付内容和明确不做事项的一致性自证。不得在脑图中写最终复盘专属的“最满意、最想改变、想问面试官”。可根据题目增加事实清单、决策原则、成功指标、行动时间线、风险触发条件及其他有助理解和执行的节点。Markdown 不超过 5000 字。\n方案六要素固定为用户画像、核心痛点、解决路径、AI 工具选型、预期效果、风险应对，其中 AI 工具必须是 Codex 并说明本次选择原因。\n最终复盘固定为最满意、最想改变、再给 25 分钟、想问面试官。只返回指定 schema 的 JSON，不得擅自改变方向或虚构事实。`,
  creative: `你是创意 Agent。主攻方向已经由用户确认，不得重新选择方向。请基于该方向提出 4 种明显不同、能在剩余时间内完成的作品表达形式，并给出难度、预计分钟数、互动标签、主要风险、降级方案和 0-100 分评分。只返回约定 JSON，不输出说明或隐藏思维过程。`,
  artifact: `你是作品 Agent。根据已确认方向、思考脑图、六要素和用户选定的创作形式，生成一个可直接交付的单文件 HTML。不得引入外部资源，不得改变事实、主方向或明确不做的取舍。页面应适合一页 A4 打印并具备清楚的下一步动作。只输出完整 HTML，不要代码围栏。`,
  reviewer: `你是审查 Agent。只检查当前步骤及已经确认的上游内容，不检查尚未开始的下游步骤。检查覆盖度、事实约束、方向、反向理由、边界和作品一致性，不得重写全文。只有会导致事实错误、方向冲突、人数/资源口径冲突、边界冲突或无法执行的问题才可放入 issues 并令 ok=false；措辞优化和可选增强写入 summary，不得阻断步骤。发现互斥口径时必须指出具体模块和冲突值。只返回 JSON：{"ok":boolean,"issues":["可定位的阻断问题"],"summary":"非阻断建议或简短结论"}。不要输出隐藏思维过程。`,
}

export function createRun(projectId: string, task = '', promptSnapshot: PromptSet = DEFAULT_PROMPTS): AgentRun {
  return {
    id: crypto.randomUUID(), projectId, goal: '在全局 25 分钟内完成五步面试交付', task, currentStep: 'topics', status: 'idle',
    startedAt: null, finishedAt: null, pausedAt: null, accumulatedPauseMs: 0, remainingTime: 25 * 60,
    facts: [], topicOptions: [], recommendedOptionId: '', decision: null, assumptions: [], openQuestions: [], waitingReason: '',
    creativeOptions: [], selectedCreativeIds: [], artifactLanes: [], primaryArtifactLaneId: '', modelCalls: [], lockedModules: [], contentSnapshots: [],
    artifacts: {
      mindmap: '', plan: { ...EMPTY_PLAN }, html: '', images: [],
      aiRecord: { introduction: '', toolName: 'Codex', firstPrompt: '', firstPromptSource: 'run_log', dissatisfaction: '', iterationLogic: '' },
      retro: { ...EMPTY_RETRO },
    },
    artifactStale: false, validationResults: [], actionHistory: [], retryCounts: {}, completedSteps: [], promptVersion: promptSnapshot.version, promptSnapshot: structuredClone(promptSnapshot), firstPrompt: '',
  }
}

export function normalizePrompts(value?: Partial<PromptSet>): PromptSet {
  const normalized = { ...DEFAULT_PROMPTS, ...value, version: value?.version || DEFAULT_PROMPTS.version }
  if (!value || normalized.version >= DEFAULT_PROMPTS.version) return normalized
  const roleNames = (prompt: string) => prompt
    .replace(/Orchestrator Agent/g, '编排 Agent').replace(/Creative Director Agent|Creative Agent/g, '创意 Agent')
    .replace(/Content Agent/g, '内容 Agent').replace(/Artifact Agent/g, '作品 Agent').replace(/Reviewer Agent/g, '审查 Agent')
  return {
    ...normalized,
    version: DEFAULT_PROMPTS.version,
    orchestrator: `${roleNames(normalized.orchestrator)}\n\n【当前版本补充规则】校验发现互斥口径时，以原题事实、用户已确认方向和已通过上游为准局部修订；只有自动修订两次仍失败时才询问用户。`,
    content: `${roleNames(normalized.content)}\n\n【当前版本规则，优先于旧规则】思考脑图应覆盖原题关键任务，包含但不限于：1. 三类冲突及影响；2. 主攻方向、选择理由和两个放弃项的反向理由；3. 一页 A4 方案；4. 不做什么、不服务谁和关键前提；5. 最犹豫取舍、最不确定假设和额外 25 分钟优先改动；6. 一致性自证。可根据题目增加其他必要节点。不得混入最终复盘专属的“最满意、最想改变、想问面试官”。每个数字和资源策略只能保留一套最终口径；局部修订不得擅自换成另一套方案。`,
    creative: roleNames(normalized.creative), artifact: roleNames(normalized.artifact), reviewer: `${roleNames(normalized.reviewer)}\n\n【当前版本补充规则】只检查当前步骤和已确认上游；只有事实、方向、人数/资源、边界或可执行性矛盾才能阻断，措辞优化和可选增强不得放入 issues。`,
  }
}

export function normalizeRun(value: Partial<AgentRun> | null | undefined, promptSnapshot: PromptSet = DEFAULT_PROMPTS): AgentRun {
  const preservedSnapshot = value?.promptSnapshot ? { ...promptSnapshot, ...value.promptSnapshot, version: value.promptSnapshot.version || promptSnapshot.version } : normalizePrompts(promptSnapshot)
  const base = createRun(value?.projectId || crypto.randomUUID(), value?.task || '', preservedSnapshot)
  if (!value) return base
  return {
    ...base,
    ...value,
    facts: value.facts || [], topicOptions: value.topicOptions || [], assumptions: value.assumptions || [], openQuestions: value.openQuestions || [],
    creativeOptions: value.creativeOptions || [], selectedCreativeIds: value.selectedCreativeIds || [], artifactLanes: value.artifactLanes || [],
    primaryArtifactLaneId: value.primaryArtifactLaneId || '', modelCalls: value.modelCalls || [], lockedModules: value.lockedModules || [], contentSnapshots: value.contentSnapshots || [],
    artifacts: {
      ...base.artifacts,
      ...value.artifacts,
      plan: { ...base.artifacts.plan, ...value.artifacts?.plan },
      aiRecord: { ...base.artifacts.aiRecord, ...value.artifacts?.aiRecord },
      retro: { ...base.artifacts.retro, ...value.artifacts?.retro },
      images: value.artifacts?.images || [],
    },
    validationResults: value.validationResults || [], actionHistory: value.actionHistory || [], completedSteps: value.completedSteps || [], retryCounts: value.retryCounts || {},
    promptSnapshot: structuredClone(preservedSnapshot),
  }
}

export function remainingSeconds(run: AgentRun, now = Date.now()) {
  if (!COUNTDOWN_ENABLED) return 25 * 60
  if (!run.startedAt) return 25 * 60
  const endpoint = run.finishedAt ? Date.parse(run.finishedAt) : run.pausedAt ? Date.parse(run.pausedAt) : now
  return Math.max(0, 25 * 60 - Math.floor((endpoint - Date.parse(run.startedAt) - run.accumulatedPauseMs) / 1000))
}

export function formatTime(seconds: number) {
  const safe = Math.max(0, seconds)
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

export function extractFacts(task: string) {
  return task.split(/[\n。；;]/).map((item) => item.trim()).filter((item) => item && /\d|必须|不能|不得|仅|只剩|只能|限制|以内|最多|至少/.test(item)).slice(0, 16)
}

export function parseTopicOptions(task: string): TopicOption[] {
  const topicBlock = (task.match(/TOPICS\s*\/\/([\s\S]*?)(?:NOTE\s*\/\/|$)/i)?.[1] || task).trim()
  const letterMatches = [...topicBlock.matchAll(/([ABC])(?=[\u4e00-\u9fff])([^]*?)(?=[ABC](?=[\u4e00-\u9fff])|$)/g)]
  if (letterMatches.length === 3) {
    return letterMatches.map((match) => {
      const text = match[2].trim()
      const marker = text.search(/选\s*[ABC]\s*意味着|选择该方向意味着|意味着/)
      const title = (marker > 0 ? text.slice(0, marker) : text.split(/[。；\n]/)[0]).trim().slice(0, 36)
      return { id: match[1], title: title || `方向 ${match[1]}`, description: text }
    })
  }
  const lines = topicBlock.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const blocks: { id: string; content: string[] }[] = []
  for (const line of lines) {
    const standalone = line.match(/^(?:[-*]\s*)?([ABC]|[1-3])$/)
    const inline = line.match(/^(?:[-*]\s*)?([ABC]|[1-3])(?:[.、:：)）]\s*|\s+)(.+)$/)
    const marker = standalone?.[1] || inline?.[1]
    if (marker) blocks.push({ id: marker, content: inline?.[2] ? [inline[2]] : [] })
    else if (blocks.length) blocks.at(-1)?.content.push(line)
  }
  if (blocks.length === 3 && new Set(blocks.map((block) => block.id)).size === 3) {
    return blocks.map((block) => {
      const description = block.content.join('\n').trim()
      const choiceMarker = description.search(new RegExp(`选\\s*${block.id}\\s*意味着|选择该方向意味着|意味着`))
      const title = (choiceMarker > 0 ? description.slice(0, choiceMarker) : description.split(/[。；\n]/)[0]).trim().slice(0, 36)
      return { id: block.id, title: title || `方向 ${block.id}`, description }
    })
  }
  const numbered = lines.map((line) => line.match(/^(?:[-*]\s*)?(?:([ABC])|([1-3]))[.、:：)）\s]+(.+)$/)).filter(Boolean)
  if (numbered.length >= 3) return numbered.slice(0, 3).map((match, index) => ({ id: match?.[1] || match?.[2] || String(index + 1), title: match?.[3].split(/[。；]/)[0].slice(0, 36) || `方向 ${index + 1}`, description: match?.[3] || '' }))
  return []
}

function hasText(value: string) { return value.trim().length > 0 }
function result(step: StepId | 'global', issues: string[], kind: ValidationResult['kind'] = 'deterministic'): ValidationResult {
  return { step, ok: issues.length === 0, issues, checkedAt: new Date().toISOString(), kind }
}

export function validateStep(run: AgentRun, step: StepId): ValidationResult {
  const issues: string[] = []
  if (step === 'topics') {
    if (run.topicOptions.length !== 3) issues.push('必须解析出且仅解析出三个候选主题')
    if (!run.decision?.confirmedAt) issues.push('主攻方向尚未由用户确认')
    if (run.decision && !run.topicOptions.some((item) => item.id === run.decision?.optionId)) issues.push('确认方向不在当前候选主题中')
  }
  if (step === 'mindmap') {
    const text = run.artifacts.mindmap
    if (!hasText(text)) issues.push('思考脑图为空')
    if (text.length > 5000) issues.push(`思考脑图为 ${text.length} 字，超过 5000 字限制`)
    const requirements: [RegExp, string][] = [
      [/冲突/, '缺少三类关键冲突及影响'], [/主攻|选择理由/, '缺少主攻方向和选择理由'], [/放弃|反向理由/, '缺少另外两个方向的反向理由'],
      [/A4|执行方案|下一步动作/, '缺少可执行的一页 A4 方案'], [/不做|不服务|边界|关键前提/, '缺少明确不做、不服务对象或关键前提'],
      [/犹豫|不确定/, '缺少最犹豫取舍或最不确定假设'], [/25\s*分钟|额外时间|优先改/, '缺少额外 25 分钟的优先改动'],
      [/一致性/, '缺少一致性自证'],
    ]
    requirements.forEach(([pattern, message]) => { if (!pattern.test(text)) issues.push(message) })
    if (/最满意|最想改变|想问面试官/.test(text)) issues.push('思考脑图混入了最终复盘专属内容')
    const selected = run.topicOptions.find((item) => item.id === run.decision?.optionId)
    if (selected && !text.includes(selected.id) && !text.includes(selected.title)) issues.push('思考脑图没有引用用户已确认的主攻方向')
  }
  if (step === 'plan') {
    const fields: [keyof PlanFields, string][] = [['persona', '用户画像'], ['pain', '核心痛点'], ['path', '解决路径'], ['aiTool', 'AI 工具选型'], ['effect', '预期效果'], ['risk', '风险应对']]
    fields.forEach(([key, label]) => { if (!hasText(run.artifacts.plan[key])) issues.push(`${label}为空`) })
    if (!/Codex/i.test(run.artifacts.plan.aiTool)) issues.push('AI 工具选型必须明确为 Codex')
    if (/^\s*Codex\s*$/i.test(run.artifacts.plan.aiTool)) issues.push('AI 工具选型需要说明选择 Codex 的原因')
    const selected = run.topicOptions.find((item) => item.id === run.decision?.optionId)
    const combined = Object.values(run.artifacts.plan).join('\n')
    if (selected && !combined.includes(selected.id) && !combined.includes(selected.title)) issues.push('方案六要素没有引用用户已确认的主攻方向')
  }
  if (step === 'artifact') {
    const { html, images, aiRecord } = run.artifacts
    if (run.creativeOptions.length < 3) issues.push('尚未生成多种创作形式')
    if (!run.selectedCreativeIds.length) issues.push('尚未由用户确认创作形式')
    if (html && images.length) issues.push('HTML 与图片只能选择一种交付形式')
    if (!html && images.length === 0) issues.push('尚未提供 HTML 或图片作品')
    if (html) {
      const bytes = new Blob([html]).size
      if (bytes > 5 * 1024 * 1024) issues.push('HTML 超过 5 MB 限制')
      if (!/<!doctype\s+html/i.test(html) || !/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) issues.push('HTML 不是完整的单文件文档')
    }
    if (images.length > 8) issues.push('图片超过 8 张限制')
    images.forEach((image) => { if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type)) issues.push(`${image.name} 不是 PNG/JPG/WebP`) })
    if (!hasText(aiRecord.introduction)) issues.push('缺少作品一句话介绍')
    if (aiRecord.toolName !== 'Codex') issues.push('AI 工具名称必须为 Codex')
    if (!hasText(aiRecord.firstPrompt) || aiRecord.firstPromptSource !== 'run_log' || aiRecord.firstPrompt !== run.firstPrompt) issues.push('首条提示词必须来自本次 Run 的真实记录')
    if (!hasText(aiRecord.dissatisfaction)) issues.push('缺少不满意之处')
    if (!hasText(aiRecord.iterationLogic)) issues.push('缺少迭代逻辑')
    if (run.artifactStale) issues.push('文字或方向已改变，作品需要重新同步')
    const selected = run.topicOptions.find((item) => item.id === run.decision?.optionId)
    if (selected && html && !html.includes(selected.id) && !html.includes(selected.title)) issues.push('HTML 作品与用户已确认的主攻方向不一致')
  }
  if (step === 'retro') {
    const fields: [keyof RetroFields, string][] = [['satisfied', '最满意的地方'], ['change', '最想改变的地方'], ['extraTime', '再给 25 分钟会做什么'], ['interviewerQuestion', '想问面试官什么']]
    fields.forEach(([key, label]) => { if (!hasText(run.artifacts.retro[key])) issues.push(`${label}为空`) })
  }
  return result(step, issues)
}

export function validateAll(run: AgentRun) {
  const results = STEP_ORDER.map((step) => validateStep(run, step))
  const globalIssues: string[] = []
  const selected = run.topicOptions.find((item) => item.id === run.decision?.optionId)
  if (selected && run.artifacts.mindmap && !run.artifacts.mindmap.includes(selected.id) && !run.artifacts.mindmap.includes(selected.title)) globalIssues.push('主攻方向与思考脑图不一致')
  if (run.artifactStale) globalIssues.push('作品不是基于最新文字和方向生成')
  return [...results, result('global', globalIssues)]
}

export function invalidateDownstream(run: AgentRun, from: StepId): AgentRun {
  const index = STEP_ORDER.indexOf(from)
  const invalid = new Set(STEP_ORDER.slice(index))
  return {
    ...run,
    completedSteps: run.completedSteps.filter((step) => !invalid.has(step)),
    artifactStale: index < STEP_ORDER.indexOf('artifact') && Boolean(run.artifacts.html || run.artifacts.images.length || run.artifactLanes.length),
    validationResults: run.validationResults.filter((item) => item.step === 'global' ? false : !invalid.has(item.step as StepId)),
    status: run.status === 'completed' ? 'idle' : run.status,
    finishedAt: null,
  }
}

export function appendAction(run: AgentRun, action: Omit<ActionRecord, 'id' | 'at'>): AgentRun {
  return { ...run, actionHistory: [...run.actionHistory, { ...action, id: crypto.randomUUID(), at: new Date().toISOString() }] }
}

export function isStepAccessible(run: AgentRun, step: StepId) {
  const target = STEP_ORDER.indexOf(step)
  const current = STEP_ORDER.indexOf(run.currentStep)
  return target <= current || run.completedSteps.includes(step)
}
