import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createRoot } from 'react-dom/client'
import JSZip from 'jszip'
import {
  AlertTriangle, Bot, Check, ChevronRight, CircleDot, Clock3, Code2, Download, ExternalLink, FastForward, FileImage,
  History, Layers3, Lock, Pause, Play, Radio, RotateCcw, Settings, ShieldCheck, Sparkles, Square, Unlock, Upload, Workflow, X,
} from 'lucide-react'
import {
  COUNTDOWN_ENABLED, DEFAULT_PROMPTS, EMPTY_PLAN, STEP_META, STEP_ORDER, appendAction, createRun, extractFacts, formatTime, invalidateDownstream,
  normalizePrompts, normalizeRun, parseTopicOptions, remainingSeconds, validateAll, validateStep,
} from './workflow'
import type { AgentRun, AiRecord, ArtifactLane, ContentModuleId, ContentSnapshot, Decision, ImageArtifact, ModelCall, PlanFields, PromptSet, RetroFields, StepId, ValidationResult } from './workflow'
import { ApiCallsPanel, ImprovementPrompt, TaskBrief } from './restored-panels'
import type { VisibleCall } from './restored-panels'
import './styles.css'

type ApiConfig = { baseUrl: string; apiKey: string; model: string; temperature: number; fastMode: boolean }
type FrozenDelivery = { frozenAt: string; run: AgentRun; prompts: PromptSet }
type ApiJob = Omit<ModelCall, 'userPrompt'> & { prompt: string; projectId: string; runId?: string; resultKind?: string; targetId?: string }
type ProjectRecord = { id: string; name: string; run: AgentRun; frozen: FrozenDelivery | null; updatedAt: string }
type PatchScope = 'mindmap' | 'plan' | 'artifact'

const defaultApi: ApiConfig = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', temperature: 0.25, fastMode: false }
const storageKey = 'workflow-studio.v2'

function readLocal<T>(key: string, fallback: T): T { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback } catch { return fallback } }
function writeLocal(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Keep the in-memory run if browser storage is unavailable or full. */ } }
function readSession<T>(key: string, fallback: T): T { try { const raw = sessionStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback } catch { return fallback } }
function writeSession(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* API configuration is optional. */ } }
function byteLabel(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(2)} MB` }
function localizedAgentText(value: string) { return value.replace(/Orchestrator Agent/g, '编排 Agent').replace(/Decision Agent/g, '决策 Agent').replace(/Creative Director Agent|Creative Agent/g, '创意 Agent').replace(/Content Agent/g, '内容 Agent').replace(/Artifact Agent/g, '作品 Agent').replace(/Reviewer Agent/g, '审查 Agent') }
function compactText(value: string, limit = 220) { const clean = localizedAgentText(value).replace(/\s+/g, ' ').trim(); return clean.length > limit ? `${clean.slice(0, limit)}…` : clean }
function parseRecord(value: string): Record<string, unknown> | null { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null } catch { return null } }
const toolLabels: Record<string, string> = {
  read_task: '读取完整题目', read_workflow_state: '读取当前状态', propose_direction: '解析三个候选方向', ask_user: '请求用户确认',
  confirm_direction: '确认主攻方向', propose_creative_forms: '生成创作形式', write_section: '生成或修订文字', record_assumption: '记录显式假设',
  build_artifact: '生成或修订作品', inspect_artifact: '检查作品文件', validate_step: '检查当前步骤', advance_step: '进入下一步骤',
  finalize_delivery: '完成最终交付', edit: '用户修改内容', pause: '暂停运行', cancel: '中断运行',
}
function actionStep(action: AgentRun['actionHistory'][number]): StepId | null {
  const source = `${action.goal} ${action.inputSummary}`
  if (/mindmap|脑图/.test(source)) return 'mindmap'
  if (/plan|六要素/.test(source)) return 'plan'
  if (/artifact|作品|创作形式|HTML/.test(source)) return 'artifact'
  if (/retro|复盘|最终交付/.test(source)) return 'retro'
  if (action.tool === 'propose_direction' || action.tool === 'confirm_direction' || /topics|三选一|候选方向/.test(source)) return 'topics'
  return null
}
function actionResult(action: AgentRun['actionHistory'][number]) {
  const result = parseRecord(action.resultSummary)
  if (!result) return compactText(action.resultSummary || (action.ok ? '已完成' : '未完成'))
  if (typeof result.count === 'number') return `已生成 ${result.count} 项${result.recommendedOptionId ? `，推荐 ${result.recommendedOptionId}` : ''}`
  if (typeof result.characters === 'number') return `已写入 ${result.characters} 字${result.section ? `（${result.section}）` : ''}`
  if (result.blocked) return `未执行：${String(result.reason || '当前状态不允许该动作')}`
  if (result.advanced) return `检查已通过，进入 ${String(result.currentStep || '下一步')}`
  if (result.completed !== undefined) return result.completed ? '五步检查通过，交付完成' : `最终检查未通过：${Array.isArray(result.issues) ? result.issues.length : 0} 项问题`
  const deterministic = result.deterministic as Record<string, unknown> | undefined
  const semantic = result.semantic as Record<string, unknown> | undefined
  if (deterministic || semantic) {
    const failures = [deterministic, semantic].filter((item) => item && item.ok === false)
    const suggestions = [deterministic, semantic].flatMap((item) => item?.ok === true && Array.isArray(item.issues) ? item.issues : [])
    return failures.length ? `检查未通过：${failures.flatMap((item) => Array.isArray(item?.issues) ? item.issues : []).length} 项需要修订` : suggestions.length ? `检查通过，另有 ${suggestions.length} 条非阻断建议` : '确定性与语义检查通过'
  }
  if (Array.isArray(result.questions)) return '已暂停，等待用户确认后继续'
  return action.ok ? '动作已完成并写入状态' : '动作未完成，详细原因见技术记录'
}
function download(name: string, content: BlobPart, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url) }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '未知错误' }
function parseJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  try { const parsed = JSON.parse(cleaned); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null } catch { return null }
}
function latestValidation(run: AgentRun, step: StepId) { return [...run.validationResults].reverse().find((item) => item.step === step) }
function stripImageData(run: AgentRun): AgentRun { return { ...run, artifacts: { ...run.artifacts, images: run.artifacts.images.map((image) => ({ ...image, dataUrl: '' })) } } }
function mergeServerRun(local: AgentRun, remote: AgentRun): AgentRun {
  const localImages = new Map(local.artifacts.images.map((image) => [image.id, image]))
  return { ...remote, artifacts: { ...remote.artifacts, images: remote.artifacts.images.map((image) => ({ ...image, dataUrl: localImages.get(image.id)?.dataUrl || image.dataUrl })) } }
}

function App() {
  const initialProject = useRef(crypto.randomUUID())
  const [projects, setProjects] = useState<ProjectRecord[]>(() => {
    const saved = readLocal<ProjectRecord[]>(`${storageKey}.projects`, [])
    if (saved.length) return saved.map((project) => ({ ...project, run: normalizeRun(project.run, DEFAULT_PROMPTS), frozen: project.frozen || null }))
    const legacy = normalizeRun(readLocal(`${storageKey}.run`, createRun(initialProject.current, '', DEFAULT_PROMPTS)), DEFAULT_PROMPTS)
    return [{ id: legacy.projectId || initialProject.current, name: '未命名项目', run: legacy, frozen: readLocal(`${storageKey}.frozen`, null), updatedAt: new Date().toISOString() }]
  })
  const [activeProjectId, setActiveProjectId] = useState(() => projects[0]?.id || initialProject.current)
  const [run, setRun] = useState<AgentRun>(() => projects[0]?.run || createRun(initialProject.current, '', DEFAULT_PROMPTS))
  const [prompts, setPrompts] = useState<PromptSet>(() => normalizePrompts(readLocal(`${storageKey}.prompts`, DEFAULT_PROMPTS)))
  const [api, setApi] = useState<ApiConfig>(() => ({ ...defaultApi, ...readLocal<Omit<ApiConfig, 'apiKey'>>(`${storageKey}.api`, defaultApi), apiKey: readSession(`${storageKey}.apiKey`, '') }))
  const [viewStep, setViewStep] = useState<StepId>(() => readLocal(`${storageKey}.viewStep`, 'topics'))
  const [selectedDraft, setSelectedDraft] = useState(run.decision?.optionId || '')
  const [decisionReason, setDecisionReason] = useState(run.decision?.reason || '')
  const [rejectedReasons, setRejectedReasons] = useState<Record<string, string>>(run.decision?.rejectedReasons || {})
  const [answer, setAnswer] = useState('')
  const [notice, setNotice] = useState('粘贴完整题目后启动 Agent；三选一方向必须由你确认。')
  const [showApi, setShowApi] = useState(false)
  const [showPrompts, setShowPrompts] = useState(false)
  const [showTrace, setShowTrace] = useState(false)
  const [showCalls, setShowCalls] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const [manualCalls, setManualCalls] = useState<ApiJob[]>([])
  const [patchingScopes, setPatchingScopes] = useState<Partial<Record<PatchScope, boolean>>>({})
  const [creativeDraft, setCreativeDraft] = useState<string[]>(run.selectedCreativeIds)
  const [frozen, setFrozen] = useState<FrozenDelivery | null>(() => readLocal(`${storageKey}.frozen`, null))
  const [clock, setClock] = useState(() => remainingSeconds(run))
  const pollBusy = useRef(false)

  useEffect(() => { writeLocal(`${storageKey}.run`, run) }, [run])
  useEffect(() => { writeLocal(`${storageKey}.projects`, projects) }, [projects])
  useEffect(() => {
    setProjects((current) => current.map((project) => project.id === run.projectId ? { ...project, run, frozen, updatedAt: new Date().toISOString() } : project))
  }, [run, frozen])
  useEffect(() => { writeLocal(`${storageKey}.prompts`, prompts) }, [prompts])
  useEffect(() => { writeLocal(`${storageKey}.viewStep`, viewStep) }, [viewStep])
  useEffect(() => { writeLocal(`${storageKey}.frozen`, frozen) }, [frozen])
  useEffect(() => { const { apiKey: _secret, ...safe } = api; writeLocal(`${storageKey}.api`, safe); writeSession(`${storageKey}.apiKey`, api.apiKey) }, [api])
  useEffect(() => { setCreativeDraft(run.selectedCreativeIds) }, [run.selectedCreativeIds.join('|')])
  useEffect(() => {
    let cancelled = false
    fetch(`/api/agent-runs/${encodeURIComponent(run.id)}`).then((response) => response.ok ? response.json() : null).then((remote: AgentRun | null) => {
      if (cancelled || !remote) return
      const localTime = Date.parse(run.actionHistory.at(-1)?.at || run.startedAt || '') || 0
      const remoteTime = Date.parse(remote.actionHistory.at(-1)?.at || remote.startedAt || '') || 0
      if (remoteTime >= localTime) setRun((current) => mergeServerRun(current, normalizeRun(remote, prompts)))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [run.id])
  useEffect(() => {
    let closed = false
    fetch(`/api/jobs?projectId=${encodeURIComponent(run.projectId)}`).then((response) => response.ok ? response.json() : []).then((jobs: ApiJob[]) => { if (!closed) setManualCalls(jobs) }).catch(() => undefined)
    return () => { closed = true }
  }, [run.projectId])
  useEffect(() => {
    if (!COUNTDOWN_ENABLED) { setClock(25 * 60); return }
    const timer = window.setInterval(() => {
      const next = remainingSeconds(run)
      setClock(next)
      if (COUNTDOWN_ENABLED && next === 0 && run.status === 'running') setNotice('25 分钟已到。现有内容仍保留，请立即完成检查并导出。')
    }, 500)
    setClock(remainingSeconds(run))
    return () => window.clearInterval(timer)
  }, [run])
  useEffect(() => {
    if (run.status !== 'running') return
    let stopped = false
    const applyRemote = (remote: AgentRun) => {
      if (stopped) return
      setRun((current) => mergeServerRun(current, normalizeRun(remote, prompts)))
      if (remote.status !== 'running') { setViewStep(remote.currentStep); setNotice(remote.status === 'completed' ? 'Agent 已完成五步并通过最终确定性检查。' : remote.waitingReason || `Agent 状态：${remote.status}`) }
    }
    const stream = new EventSource(`/api/agent-runs/${encodeURIComponent(run.id)}/stream`)
    stream.onmessage = (event) => { try { applyRemote(JSON.parse(event.data) as AgentRun) } catch { /* ignore malformed local event */ } }
    stream.onerror = () => {
      stream.close()
      if (pollBusy.current) return
      pollBusy.current = true
      fetch(`/api/agent-runs/${encodeURIComponent(run.id)}`).then((response) => response.ok ? response.json() : null).then((remote) => { if (remote) applyRemote(remote as AgentRun) }).catch(() => undefined).finally(() => { pollBusy.current = false })
    }
    return () => { stopped = true; stream.close() }
  }, [run.id, run.status])

  const checks = useMemo(() => validateAll(run), [run])
  const finalReady = checks.every((item) => item.ok) && run.status === 'completed'
  const timerClass = COUNTDOWN_ENABLED ? (clock <= 60 ? 'danger' : clock <= 5 * 60 ? 'warning' : '') : ''
  function updateRun(mutator: (current: AgentRun) => AgentRun) { setRun((current) => mutator(current)) }

  async function startStreamingJob(input: { agent: string; title: string; systemPrompt: string; userPrompt: string; resultKind: string; targetId?: string }) {
    if (!api.apiKey) throw new Error('请先配置并验证 API，才能运行局部生成。')
    const response = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: run.projectId, runId: run.id, baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model, temperature: api.temperature, fastMode: api.fastMode, prompt: input.userPrompt, systemPrompt: input.systemPrompt, agent: input.agent, title: input.title, resultKind: input.resultKind, targetId: input.targetId }) })
    const initial = await response.json() as ApiJob & { error?: string }
    if (!response.ok) throw new Error(initial.error || `模型任务启动失败（HTTP ${response.status}）`)
    setManualCalls((current) => [...current.filter((item) => item.id !== initial.id), initial]); setShowCalls(true)
    return await new Promise<string>((resolve, reject) => {
      const stream = new EventSource(`/api/jobs/${initial.id}/stream`)
      stream.onmessage = (event) => {
        try {
          const job = JSON.parse(event.data) as ApiJob
          setManualCalls((current) => [...current.filter((item) => item.id !== job.id), job])
          if (job.status === 'completed') { stream.close(); resolve(job.output) }
          else if (job.status === 'failed' || job.status === 'cancelled') { stream.close(); reject(new Error(job.error || `模型任务${job.status}`)) }
        } catch { /* wait for the next valid event */ }
      }
      stream.onerror = () => { stream.close(); fetch(`/api/jobs/${initial.id}`).then((result) => result.json()).then((job: ApiJob) => job.status === 'completed' ? resolve(job.output) : reject(new Error(job.error || '流式连接中断'))).catch(reject) }
    })
  }

  async function startAgent(source = run) {
    if (!source.task.trim()) { setNotice('请先粘贴完整题目。'); return }
    const activePrompts = source.startedAt && source.promptSnapshot ? source.promptSnapshot : structuredClone(prompts)
    const prepared: AgentRun = {
      ...source,
      facts: extractFacts(source.task), promptVersion: activePrompts.version, promptSnapshot: activePrompts, remainingTime: remainingSeconds(source),
      firstPrompt: source.firstPrompt || source.task,
      artifacts: { ...source.artifacts, aiRecord: { ...source.artifacts.aiRecord, toolName: 'Codex', firstPrompt: source.firstPrompt || source.task, firstPromptSource: 'run_log' } },
      status: 'running', waitingReason: '', openQuestions: [],
    }
    setRun(prepared); setNotice(api.apiKey ? 'Agent 正在读取状态并选择下一项工具动作…' : 'Agent 正在离线工具模式运行；配置 API 后可启用语义生成与审查。')
    try {
      const response = await fetch('/api/agent-runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: stripImageData(prepared), prompts: activePrompts, ...api }) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || `启动失败（HTTP ${response.status}）`)
      setRun((current) => mergeServerRun(current, normalizeRun(payload as AgentRun, activePrompts)))
    } catch (error) {
      setRun((current) => ({ ...current, status: 'failed', waitingReason: errorMessage(error) }))
      setNotice(`Agent 启动失败：${errorMessage(error)}`)
    }
  }

  async function pauseAgent() {
    if (run.status !== 'running') return
    await fetch(`/api/agent-runs/${run.id}/pause`, { method: 'POST' }).catch(() => undefined)
    const pausedAt = new Date().toISOString()
    updateRun((current) => appendAction({ ...current, status: 'paused', pausedAt, waitingReason: '计时与 Agent 已暂停。' }, { actor: 'user', tool: 'pause', goal: '暂停 Agent Run', inputSummary: '', resultSummary: '已暂停', ok: true }))
    setNotice('Agent 与全局计时已暂停，可从当前状态继续。')
  }

  async function cancelAgent() {
    await fetch(`/api/agent-runs/${run.id}/cancel`, { method: 'POST' }).catch(() => undefined)
    updateRun((current) => appendAction({ ...current, status: 'cancelled', waitingReason: '用户已中断，可恢复。' }, { actor: 'user', tool: 'cancel', goal: '中断 Agent Run', inputSummary: '', resultSummary: '已中断', ok: true }))
    setNotice('本轮已中断，已完成的工具结果仍然保留。')
  }

  function resumeAgent() {
    let next = run
    if (run.pausedAt) next = { ...run, accumulatedPauseMs: run.accumulatedPauseMs + Math.max(0, Date.now() - Date.parse(run.pausedAt)), pausedAt: null, status: 'idle' }
    void startAgent(next)
  }

  function runAgentForStep(step: StepId) {
    let next = run.pausedAt ? { ...run, accumulatedPauseMs: run.accumulatedPauseMs + Math.max(0, Date.now() - Date.parse(run.pausedAt)), pausedAt: null } : run
    const stepIndex = STEP_ORDER.indexOf(step)
    const firstIncomplete = STEP_ORDER.slice(0, stepIndex + 1).find((candidate) => !next.completedSteps.includes(candidate)) || step
    next = { ...next, currentStep: firstIncomplete, status: 'idle', finishedAt: null, waitingReason: '', retryCounts: { ...next.retryCounts, [firstIncomplete]: 0 }, completedSteps: next.completedSteps.filter((item) => STEP_ORDER.indexOf(item) < STEP_ORDER.indexOf(firstIncomplete)), validationResults: next.validationResults.filter((item) => item.step === 'global' ? false : STEP_ORDER.indexOf(item.step as StepId) < STEP_ORDER.indexOf(firstIncomplete)) }
    void startAgent(next)
  }

  function newProject() {
    setShowProjects(true)
  }

  function changeTask(task: string) {
    if (run.startedAt) return
    const options = parseTopicOptions(task)
    updateRun((current) => ({ ...current, task, facts: extractFacts(task), topicOptions: options, recommendedOptionId: '', decision: null, selectedCreativeIds: [], creativeOptions: [], artifactLanes: [], primaryArtifactLaneId: '', artifacts: { ...current.artifacts, html: '', images: [] }, artifactStale: false }))
    setSelectedDraft(''); setDecisionReason(''); setRejectedReasons({})
  }

  function resetProjectView(next: AgentRun, nextFrozen: FrozenDelivery | null) {
    setRun(normalizeRun(next, prompts)); setFrozen(nextFrozen); setActiveProjectId(next.projectId); setViewStep('topics'); setSelectedDraft(next.decision?.optionId || ''); setDecisionReason(next.decision?.reason || ''); setRejectedReasons(next.decision?.rejectedReasons || {}); setCreativeDraft(next.selectedCreativeIds); setManualCalls([])
  }

  function selectProject(project: ProjectRecord) {
    if (run.status === 'running' && run.id !== project.run.id) void fetch(`/api/agent-runs/${run.id}/cancel`, { method: 'POST' }).catch(() => undefined)
    resetProjectView(project.run, project.frozen); setShowProjects(false); setNotice(`已切换到项目「${project.name}」。`)
  }

  function createManagedProject(name: string) {
    const id = crypto.randomUUID(); const fresh = createRun(id, '', prompts); const project: ProjectRecord = { id, name: name.trim() || `项目 ${projects.length + 1}`, run: fresh, frozen: null, updatedAt: new Date().toISOString() }
    setProjects((current) => [...current, project]); resetProjectView(fresh, null); setShowProjects(false); setNotice(`已创建项目「${project.name}」。`)
  }

  function renameProject(id: string, name: string) {
    const nextName = name.trim(); if (!nextName) return
    setProjects((current) => current.map((project) => project.id === id ? { ...project, name: nextName, updatedAt: new Date().toISOString() } : project)); setNotice('项目名称已更新。')
  }

  function deleteProject(id: string) {
    if (projects.length <= 1) { setNotice('至少保留一个项目。'); return }
    const target = projects.find((project) => project.id === id); if (!target) return
    if (!window.confirm(`确定删除项目「${target.name}」吗？该项目的题目、Run 和作品都会被移除。`)) return
    if (target.run.status === 'running') void fetch(`/api/agent-runs/${target.run.id}/cancel`, { method: 'POST' }).catch(() => undefined)
    const remaining = projects.filter((project) => project.id !== id); setProjects(remaining)
    if (id === activeProjectId) selectProject(remaining[0])
    setNotice(`项目「${target.name}」已删除。`)
  }

  async function confirmDecision() {
    const selected = run.topicOptions.find((item) => item.id === selectedDraft)
    const rejected = run.topicOptions.filter((item) => item.id !== selectedDraft)
    if (!selected) { setNotice('请先选择一个主攻方向。'); return }
    const changed = Boolean(run.decision && run.decision.optionId !== selectedDraft)
    const fallbackReason = `选择 ${selected.id}「${selected.title}」：先解决它直接对应的核心约束，能在当前资源和时限内形成最小可执行闭环；其余问题作为降级措施处理。`
    const baseReason = decisionReason.trim() || fallbackReason
    const baseRejectedReasons = Object.fromEntries(rejected.map((item) => [item.id, rejectedReasons[item.id]?.trim() || `不以 ${item.id}「${item.title}」为主目标：它会分散当前有限的时间、资源或执行能力，先保留为补充或降级方案。`]))
    const decision: Decision = { optionId: selectedDraft, confirmedAt: new Date().toISOString(), reason: baseReason, rejectedReasons: baseRejectedReasons }
    let next = changed ? invalidateDownstream(run, 'topics') : run
    next = { ...next, decision, currentStep: 'mindmap', completedSteps: Array.from(new Set([...next.completedSteps, 'topics'])), status: 'idle', openQuestions: [], waitingReason: '', artifactStale: changed && Boolean(next.artifacts.html || next.artifacts.images.length) ? true : next.artifactStale,
      creativeOptions: changed ? [] : next.creativeOptions, selectedCreativeIds: changed ? [] : next.selectedCreativeIds, artifactLanes: changed ? [] : next.artifactLanes, primaryArtifactLaneId: changed ? '' : next.primaryArtifactLaneId }
    next = appendAction(next, { actor: 'user', tool: 'confirm_direction', goal: '确认唯一主攻方向', inputSummary: `${selected.id} ${selected.title}`, resultSummary: changed ? '方向已改变，下游内容已标记为需复核' : '方向已确认', ok: true })
    setRun(next); setViewStep('mindmap'); setNotice(api.apiKey ? '方向已确认，正在结合你的理由优化表达…' : '方向已确认，空白理由已自动补全；Agent 将继续。')
    if (api.apiKey) {
      try {
        const output = await startStreamingJob({
          agent: '决策 Agent', title: '优化方向选择理由', resultKind: 'decision_reason',
          systemPrompt: '你是面试决策表达编辑。用户已确认的 optionId 不可改变。结合用户原始理由和题目事实，优化主攻理由及另外两个方向的反向理由。只返回 JSON：{"reason":"...","rejectedReasons":{"方向ID":"..."}}。不得虚构题目事实，不输出隐藏思维过程。',
          userPrompt: `【完整原题】\n${run.task}\n\n【用户确认方向】\n${JSON.stringify({ optionId: selected.id, title: selected.title })}\n\n【用户填写或自动补全的主攻理由】\n${baseReason}\n\n【用户填写或自动补全的反向理由】\n${JSON.stringify(baseRejectedReasons)}\n\n请让表达更具体、可执行，并保留明确取舍。`,
        })
        const parsed = parseJsonObject(output)
        const optimizedReason = typeof parsed?.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : baseReason
        const optimizedRejected = Object.fromEntries(rejected.map((item) => [item.id, typeof (parsed?.rejectedReasons as Record<string, unknown> | undefined)?.[item.id] === 'string' && String((parsed?.rejectedReasons as Record<string, unknown>)[item.id]).trim() ? String((parsed?.rejectedReasons as Record<string, unknown>)[item.id]).trim() : baseRejectedReasons[item.id]]))
        next = { ...next, decision: { ...decision, reason: optimizedReason, rejectedReasons: optimizedRejected } }
        setRun(next); setNotice('方向理由已结合你的输入优化，主攻方向保持不变。')
      } catch (error) {
        setNotice(`理由优化失败，已保留当前理由并继续：${errorMessage(error)}`)
      }
    }
    void startAgent(next)
  }

  function answerQuestions() {
    if (!answer.trim()) return
    let next: AgentRun = { ...run, assumptions: [...run.assumptions, `用户补充：${answer.trim()}`], openQuestions: [], waitingReason: '', status: 'idle', retryCounts: { ...run.retryCounts, [run.currentStep]: 0 }, validationResults: run.validationResults.filter((item) => item.step !== run.currentStep) }
    next = appendAction(next, { actor: 'user', tool: 'edit', goal: '回答 Agent 的高价值问题', inputSummary: answer.trim(), resultSummary: '补充已写入显式上下文', ok: true })
    setAnswer(''); setRun(next); void startAgent(next)
  }

  function editMindmap(value: string) {
    updateRun((current) => ({ ...invalidateDownstream({ ...current, artifacts: { ...current.artifacts, mindmap: value } }, 'mindmap'), currentStep: 'mindmap' }))
  }
  function editPlan(key: keyof PlanFields, value: string) {
    updateRun((current) => ({ ...invalidateDownstream({ ...current, artifacts: { ...current.artifacts, plan: { ...current.artifacts.plan, [key]: value } }, artifactStale: Boolean(current.artifacts.html || current.artifacts.images.length) }, 'plan'), currentStep: 'plan' }))
  }
  function editAiRecord(key: keyof AiRecord, value: string) {
    if (key === 'toolName' || key === 'firstPrompt' || key === 'firstPromptSource') return
    updateRun((current) => ({ ...invalidateDownstream({ ...current, artifacts: { ...current.artifacts, aiRecord: { ...current.artifacts.aiRecord, [key]: value } } }, 'artifact'), currentStep: 'artifact' }))
  }
  function editRetro(key: keyof RetroFields, value: string) { updateRun((current) => ({ ...invalidateDownstream({ ...current, artifacts: { ...current.artifacts, retro: { ...current.artifacts.retro, [key]: value } } }, 'retro'), currentStep: 'retro' })) }

  function toggleModuleLock(id: ContentModuleId) {
    updateRun((current) => ({ ...current, lockedModules: current.lockedModules.includes(id) ? current.lockedModules.filter((item) => item !== id) : [...current.lockedModules, id] }))
  }

  function saveContentSnapshot(scope: 'mindmap' | 'plan') {
    updateRun((current) => ({ ...current, contentSnapshots: [...current.contentSnapshots, { id: crypto.randomUUID(), label: `${STEP_META[scope].label} V${current.contentSnapshots.length + 1}`, createdAt: new Date().toISOString(), mindmap: current.artifacts.mindmap, plan: structuredClone(current.artifacts.plan), retro: structuredClone(current.artifacts.retro) }].slice(-20) }))
    setNotice(`已保存${STEP_META[scope].label}快照。`)
  }

  function restoreContentSnapshot(snapshot: ContentSnapshot, scope: 'mindmap' | 'plan') {
    updateRun((current) => {
      const artifacts = scope === 'mindmap' ? { ...current.artifacts, mindmap: snapshot.mindmap } : { ...current.artifacts, plan: structuredClone(snapshot.plan) }
      return { ...invalidateDownstream({ ...current, artifacts }, scope), currentStep: scope }
    })
    setNotice(`已恢复 ${snapshot.label} 中的${STEP_META[scope].label}；下游内容已标记为需复核。`)
  }

  async function patchStepModules(scope: PatchScope, instruction: string) {
    setPatchingScopes((current) => ({ ...current, [scope]: true }))
    try {
      const contracts: Record<PatchScope, string> = {
        mindmap: '当前页面只有“思考脑图”模块，对应 mindmap。严格返回 {"mindmap":"修改后的完整 Markdown"}。',
        plan: '当前页面模块与字段：用户画像=plan.persona；核心痛点=plan.pain；解决路径=plan.path；AI 工具选型=plan.aiTool；预期效果=plan.effect；风险应对=plan.risk。严格返回 {"plan":{...}}，只包含用户点名的字段。',
        artifact: '当前页面可改模块：最终 HTML 作品=html；一句话介绍=aiRecord.introduction；不满意之处=aiRecord.dissatisfaction；迭代逻辑=aiRecord.iterationLogic。严格返回 {"html":"完整单文件 HTML","aiRecord":{...}}，只包含用户点名的字段；AI 工具名称和首条提示词不可修改。',
      }
      const currentModules = scope === 'mindmap' ? { mindmap: run.artifacts.mindmap } : scope === 'plan' ? { plan: run.artifacts.plan } : { html: run.artifacts.html, aiRecord: run.artifacts.aiRecord }
      const patchRole = scope === 'artifact' ? '你是作品局部改良 Agent，只按用户点名模块修订当前作品或 AI 使用记录。' : run.promptSnapshot.content
      const output = await startStreamingJob({ agent: scope === 'artifact' ? '作品 Agent' : '内容 Agent', title: `改良 ${STEP_META[scope].label}`, systemPrompt: `${patchRole}\n你会收到当前页面的局部修改 Prompt。${contracts[scope]}没有点名的模块不得返回，不得改变原题事实、用户确认方向或已声明边界，不得输出代码围栏或隐藏思维过程。`, userPrompt: `【原题事实】\n${run.task}\n\n【用户确认】\n${JSON.stringify(run.decision)}\n\n【显式假设】\n${JSON.stringify(run.assumptions)}\n\n【当前页面模块】\n${JSON.stringify(currentModules)}\n\n【用户修改 Prompt】\n${instruction}`, resultKind: `${scope}_patch` })
      const parsed = parseJsonObject(output)
      const planPatch = parsed?.plan && typeof parsed.plan === 'object' ? parsed.plan as Record<string, unknown> : {}
      const aiRecordPatch = parsed?.aiRecord && typeof parsed.aiRecord === 'object' ? parsed.aiRecord as Record<string, unknown> : {}
      const nextMindmap = typeof parsed?.mindmap === 'string' ? parsed.mindmap.trim() : ''
      const planKeys = (Object.keys(EMPTY_PLAN) as (keyof PlanFields)[]).filter((key) => typeof planPatch[key] === 'string' && String(planPatch[key]).trim())
      const allowedPlanKeys = planKeys.filter((key) => !run.lockedModules.includes(key))
      const mindmapAllowed = Boolean(nextMindmap) && !run.lockedModules.includes('mindmap')
      const aiRecordKeys = (['introduction', 'dissatisfaction', 'iterationLogic'] as (keyof AiRecord)[]).filter((key) => typeof aiRecordPatch[key] === 'string' && String(aiRecordPatch[key]).trim())
      const nextHtml = typeof parsed?.html === 'string' ? parsed.html.trim() : ''
      if (nextHtml && (!/<!doctype\s+html/i.test(nextHtml) || new Blob([nextHtml]).size > 5 * 1024 * 1024)) throw new Error('作品补丁必须是一个不超过 5 MB 的完整单文件 HTML。')
      if (scope === 'mindmap' && !mindmapAllowed) throw new Error('未返回可用的思考脑图，或该模块已锁定。')
      if (scope === 'plan' && !allowedPlanKeys.length) throw new Error('未识别到可更新的六要素模块，或目标模块均已锁定。')
      if (scope === 'artifact' && !nextHtml && !aiRecordKeys.length) throw new Error('未识别到可更新的作品或 AI 使用记录模块。')
      updateRun((current) => {
        const plan = { ...current.artifacts.plan }; allowedPlanKeys.forEach((key) => { plan[key] = String(planPatch[key]).trim() })
        const aiRecord = { ...current.artifacts.aiRecord }; aiRecordKeys.forEach((key) => { aiRecord[key] = String(aiRecordPatch[key]).trim() as never })
        let lanes = current.artifactLanes
        if (nextHtml && current.primaryArtifactLaneId) lanes = current.artifactLanes.map((lane) => {
          if (lane.id !== current.primaryArtifactLaneId) return lane
          const version = { id: crypto.randomUUID(), version: lane.versions.length + 1, html: nextHtml, prompt: instruction, createdAt: new Date().toISOString() }
          return { ...lane, status: 'done', versions: [...lane.versions, version], activeVersionId: version.id }
        })
        const changed = { ...current, artifactLanes: lanes, artifacts: { ...current.artifacts, mindmap: mindmapAllowed ? nextMindmap : current.artifacts.mindmap, plan, html: nextHtml || current.artifacts.html, images: nextHtml ? [] : current.artifacts.images, aiRecord }, artifactStale: false }
        return invalidateDownstream(changed, scope)
      })
      const aiLabels: Partial<Record<keyof AiRecord, string>> = { introduction: '一句话介绍', dissatisfaction: '不满意之处', iterationLogic: '迭代逻辑' }
      const changedLabels = [mindmapAllowed ? '思考脑图' : '', ...allowedPlanKeys.map((key) => planLabels[key]), nextHtml ? '最终 HTML 作品' : '', ...aiRecordKeys.map((key) => aiLabels[key] || key)].filter(Boolean)
      setNotice(`已自动匹配并更新：${changedLabels.join('、')}`)
    } catch (error) { setNotice(`局部改写失败：${errorMessage(error)}`) }
    finally { setPatchingScopes((current) => ({ ...current, [scope]: false })) }
  }

  function applyLocalValidation(step: StepId) {
    const validation = validateStep(run, step)
    updateRun((current) => ({ ...current, validationResults: [...current.validationResults.filter((item) => !(item.step === step && item.kind === 'deterministic')), validation] }))
    setNotice(validation.ok ? `${STEP_META[step].label}通过确定性检查。语义一致性由审查 Agent 在继续运行时完成。` : validation.issues.join('；'))
  }

  function uploadHtml(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file) return
    if (file.type && file.type !== 'text/html' && !file.name.toLowerCase().endsWith('.html')) { setNotice('只能上传 HTML 文件。'); return }
    if (file.size > 5 * 1024 * 1024) {
      const validation: ValidationResult = { step: 'artifact', ok: false, issues: [`${file.name} 为 ${byteLabel(file.size)}，超过 5 MB 限制`], checkedAt: new Date().toISOString(), kind: 'deterministic' }
      updateRun((current) => ({ ...current, validationResults: [...current.validationResults.filter((item) => !(item.step === 'artifact' && item.kind === 'deterministic')), validation] }))
      setNotice(validation.issues[0]); return
    }
    const reader = new FileReader()
    reader.onload = () => updateRun((current) => ({ ...invalidateDownstream({ ...current, artifacts: { ...current.artifacts, html: String(reader.result || ''), images: [] }, artifactStale: false }, 'artifact'), currentStep: 'artifact' }))
    reader.readAsText(file)
  }

  function uploadImages(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files || [])]; event.target.value = ''
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp']); const issues: string[] = []
    if (files.length > 8) issues.push(`选择了 ${files.length} 张图片，超过 8 张限制`)
    files.forEach((file) => { if (!allowed.has(file.type)) issues.push(`${file.name} 不是 PNG/JPG/WebP`) })
    if (issues.length) {
      const validation: ValidationResult = { step: 'artifact', ok: false, issues, checkedAt: new Date().toISOString(), kind: 'deterministic' }
      updateRun((current) => ({ ...current, validationResults: [...current.validationResults.filter((item) => !(item.step === 'artifact' && item.kind === 'deterministic')), validation] })); setNotice(issues.join('；')); return
    }
    Promise.all(files.map((file) => new Promise<ImageArtifact>((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name, type: file.type, size: file.size, dataUrl: String(reader.result || '') }); reader.readAsDataURL(file)
    }))).then((images) => updateRun((current) => ({ ...invalidateDownstream({ ...current, artifacts: { ...current.artifacts, images, html: '' }, artifactStale: false }, 'artifact'), currentStep: 'artifact' }))).catch((error) => setNotice(`图片读取失败：${errorMessage(error)}`))
  }

  function openHtmlPreview(html: string) {
    if (!html) return
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
    window.open(url, '_blank', 'noopener,noreferrer'); window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  function openPreview() { openHtmlPreview(run.artifacts.html) }

  function confirmCreativeFormats() {
    if (!creativeDraft.length) { setNotice('请至少选择一种创作形式。'); return }
    const lanes: ArtifactLane[] = creativeDraft.map((creativeId) => {
      const existing = run.artifactLanes.find((lane) => lane.creativeId === creativeId)
      const creative = run.creativeOptions.find((item) => item.id === creativeId)
      return existing || { id: crypto.randomUUID(), creativeId, title: creative?.title || creativeId, status: 'queued', versions: [], activeVersionId: '', error: '' }
    })
    let next: AgentRun = { ...run, selectedCreativeIds: [...creativeDraft], artifactLanes: lanes, primaryArtifactLaneId: '', artifacts: { ...run.artifacts, html: '', images: [] }, artifactStale: false, status: 'idle', openQuestions: [], waitingReason: '', currentStep: 'artifact' }
    next = appendAction(next, { actor: 'user', tool: 'edit', goal: '确认创作形式', inputSummary: creativeDraft.join(', '), resultSummary: `建立 ${lanes.length} 条制作赛道`, ok: true })
    setRun(next); setNotice('创作形式已确认，Agent 将以最多两路并发制作。'); void startAgent(next)
  }

  function generateCreativeFormats() {
    let next: AgentRun = { ...run, currentStep: 'artifact', status: 'idle', openQuestions: [], waitingReason: '', creativeOptions: [], selectedCreativeIds: [], artifactLanes: [], primaryArtifactLaneId: '', artifacts: { ...run.artifacts, html: '', images: [] }, artifactStale: false }
    next = appendAction(next, { actor: 'user', tool: 'edit', goal: run.creativeOptions.length ? '重新生成创作形式' : '生成创作形式', inputSummary: '', resultSummary: '交给创意 Agent', ok: true })
    setRun(next); setCreativeDraft([]); void startAgent(next)
  }

  function selectLaneVersion(laneId: string, versionId: string) {
    updateRun((current) => {
      const lanes = current.artifactLanes.map((lane) => lane.id === laneId ? { ...lane, activeVersionId: versionId } : lane)
      const lane = lanes.find((item) => item.id === laneId); const version = lane?.versions.find((item) => item.id === versionId)
      return { ...current, artifactLanes: lanes, artifacts: current.primaryArtifactLaneId === laneId && version ? { ...current.artifacts, html: version.html, images: [] } : current.artifacts, artifactStale: false }
    })
  }

  function selectPrimaryLane(laneId: string) {
    const lane = run.artifactLanes.find((item) => item.id === laneId); const version = lane?.versions.find((item) => item.id === lane.activeVersionId)
    if (!lane || !version) { setNotice('该赛道尚无可用版本。'); return }
    let next: AgentRun = { ...run, primaryArtifactLaneId: laneId, artifacts: { ...run.artifacts, html: version.html, images: [] }, artifactStale: false, status: 'idle', openQuestions: [], waitingReason: '', currentStep: 'artifact' }
    next = appendAction(next, { actor: 'user', tool: 'edit', goal: '指定最终主作品', inputSummary: lane.title, resultSummary: `采用 V${version.version}`, ok: true })
    setRun(next); setNotice(`已将「${lane.title}」V${version.version} 设为主作品，继续一致性检查。`); void startAgent(next)
  }

  function freezeDelivery() {
    const currentChecks = validateAll(run)
    if (run.status !== 'completed' || currentChecks.some((item) => !item.ok)) { setNotice('冻结失败：必须先由 Agent 完成最终检查，且所有确定性检查通过。'); return }
    const snapshot = { frozenAt: new Date().toISOString(), run: structuredClone(run), prompts: structuredClone(run.promptSnapshot || prompts) }
    setFrozen(snapshot); setNotice('已冻结不可变交付快照。后续草稿改动不会进入本次导出。')
  }

  async function exportDelivery() {
    if (!frozen) { setNotice('请先冻结通过最终检查的版本。'); return }
    const source = frozen.run; const zip = new JSZip()
    const markdown = [
      '# 面试解题交付', `\n## 1. 三选一主题\n\n主攻：${source.decision?.optionId} ${source.topicOptions.find((item) => item.id === source.decision?.optionId)?.title || ''}\n\n选择理由：${source.decision?.reason || ''}\n\n放弃理由：${JSON.stringify(source.decision?.rejectedReasons || {}, null, 2)}`,
      `\n## 2. 思考脑图\n\n${source.artifacts.mindmap}`, `\n## 3. 方案六要素\n\n${Object.entries(source.artifacts.plan).map(([key, value]) => `### ${key}\n\n${value}`).join('\n\n')}`,
      `\n## 4. AI 使用记录\n\n${Object.entries(source.artifacts.aiRecord).map(([key, value]) => `- ${key}: ${value}`).join('\n')}`,
      `\n## 5. 最终复盘\n\n${Object.entries(source.artifacts.retro).map(([key, value]) => `### ${key}\n\n${value}`).join('\n\n')}`,
    ].join('\n')
    zip.file('完整答案.md', markdown)
    if (source.artifacts.html) zip.file('作品/主作品.html', source.artifacts.html)
    source.artifactLanes.forEach((lane) => lane.versions.forEach((version) => zip.file(`作品/创意赛道/${lane.title.replace(/[\\/:*?"<>|]/g, '-')}/V${version.version}.html`, version.html)))
    source.artifacts.images.forEach((image, index) => { const base64 = image.dataUrl.split(',')[1]; if (base64) zip.file(`作品/${index + 1}-${image.name}`, base64, { base64: true }) })
    zip.file('AI使用记录.json', JSON.stringify(source.artifacts.aiRecord, null, 2)); zip.file('Agent执行记录.json', JSON.stringify(source.actionHistory, null, 2)); zip.file('检查结果.json', JSON.stringify(source.validationResults, null, 2))
    zip.file('创意形式与作品版本.json', JSON.stringify({ options: source.creativeOptions, selectedCreativeIds: source.selectedCreativeIds, primaryArtifactLaneId: source.primaryArtifactLaneId, lanes: source.artifactLanes.map((lane) => ({ ...lane, versions: lane.versions.map(({ html: _html, ...version }) => version) })) }, null, 2))
    zip.file('版本信息.json', JSON.stringify({ frozenAt: frozen.frozenAt, runId: source.id, projectId: source.projectId, promptVersion: source.promptVersion, completedSteps: source.completedSteps }, null, 2)); zip.file('Agent提示词.json', JSON.stringify(frozen.prompts, null, 2))
    const blob = await zip.generateAsync({ type: 'blob' }); download('workflow-studio-delivery.zip', blob, 'application/zip')
  }

  const runControls = run.status === 'running'
    ? <><button className="icon-button" title="暂停" onClick={pauseAgent}><Pause size={15} /></button><button className="icon-button danger-icon" title="中断" onClick={cancelAgent}><Square size={14} /></button></>
    : run.startedAt && run.status !== 'completed' ? <button className="outline-button" onClick={resumeAgent}><Play size={14} />恢复 Agent</button> : null

  const visibleCalls: VisibleCall[] = [...run.modelCalls.map((call) => ({ ...call, source: 'agent' as const })), ...manualCalls.map((call) => ({ ...call, userPrompt: call.prompt, source: 'manual' as const }))].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1
    if (a.status !== 'running' && b.status === 'running') return 1
    return Date.parse(b.startedAt) - Date.parse(a.startedAt)
  })
  const fastModeLocked = run.status === 'running' || visibleCalls.some((call) => call.status === 'running')
  const activeProjectName = projects.find((project) => project.id === activeProjectId)?.name || '未命名项目'
  const improvementScope = (['mindmap', 'plan', 'artifact'] as PatchScope[]).includes(viewStep as PatchScope) ? viewStep as PatchScope : null
  const promptCopy: Record<PatchScope, { title: string; description: string; placeholder: string; quickPrompts: string[] }> = {
    mindmap: { title: '改良思考脑图', description: '只会修改 STEP 2 的脑图，不会触碰方案字段或作品。', placeholder: '例如：修改“一页 A4 方案”和“关键前提”，统一人数与材料口径。', quickPrompts: ['补齐原题关键要求', '统一执行口径', '压缩到 3000 字'] },
    plan: { title: '改良方案六要素', description: '点名一个或多个六要素字段，返回后自动匹配到对应文本框。', placeholder: '例如：修改“解决路径、预期效果和风险应对”，统一为 40 人两人一组、不轮换。', quickPrompts: ['强化解决路径', '量化预期效果', '补充风险触发条件'] },
    artifact: { title: '改良作品与 AI 记录', description: '可点名最终 HTML、作品一句话介绍、不满意之处或迭代逻辑。', placeholder: '例如：修改“最终 HTML 和迭代逻辑”，让主作品更易扫描并保持现有方向。', quickPrompts: ['优化最终 HTML', '改写一句话介绍', '补全迭代逻辑'] },
  }
  const pageImprovementPrompt = improvementScope ? <ImprovementPrompt {...promptCopy[improvementScope]} patching={Boolean(patchingScopes[improvementScope])} snapshots={improvementScope === 'artifact' ? [] : run.contentSnapshots} onPatch={(instruction) => patchStepModules(improvementScope, instruction)} onSnapshot={improvementScope === 'artifact' ? undefined : () => saveContentSnapshot(improvementScope)} onRestore={(snapshot) => { if (improvementScope !== 'artifact') restoreContentSnapshot(snapshot, improvementScope) }} /> : null

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Workflow size={18} /></span><div><strong>Workflow Studio</strong><span>Agent 工作台</span></div><span className="active-project">{activeProjectName}</span></div><div className="top-actions"><span className={`global-timer ${timerClass} ${!COUNTDOWN_ENABLED ? 'disabled' : ''}`}><Clock3 size={14} />{COUNTDOWN_ENABLED ? formatTime(clock) : '计时未启用'}</span>{runControls}<button type="button" className={`ghost-button fast-mode-button ${api.fastMode ? 'active' : ''}`} aria-label="快速模式" aria-pressed={api.fastMode} disabled={fastModeLocked} title={fastModeLocked ? '模型调用进行中，结束后可切换快速模式' : api.fastMode ? '快速模式已开启，后续模型调用将关闭思考' : '开启快速模式，后续模型调用将关闭思考'} onClick={() => { setApi({ ...api, fastMode: !api.fastMode }); setNotice(api.fastMode ? '快速模式已关闭。' : '快速模式已开启，后续模型调用将关闭思考。') }}><FastForward size={14} /><span>快速模式</span></button><button className={`icon-button calls-button ${visibleCalls.some((call) => call.status === 'running') ? 'live' : ''}`} title="API Calls" onClick={() => setShowCalls(true)}><Radio size={15} /><i>{visibleCalls.length}</i></button><button className="icon-button" title="Agent 提示词" onClick={() => setShowPrompts(true)}><Sparkles size={15} /></button><button className="icon-button" title="API 设置" onClick={() => setShowApi(true)}><Settings size={15} /></button><button className="ghost-button" title="项目管理" onClick={newProject}><RotateCcw size={14} />项目</button></div></header>
    <div className="workspace">
      <aside className="sidebar"><span className="caption">INTERVIEW FLOW</span><nav>{STEP_ORDER.map((step) => { const meta = STEP_META[step]; const active = viewStep === step; const complete = run.completedSteps.includes(step); return <button key={step} className={`step-link ${active ? 'active' : ''} ${complete ? 'complete' : ''}`} onClick={() => setViewStep(step)}><span>{complete ? <Check size={13} /> : meta.number}</span><div><b>{meta.label}</b><small>{meta.description}</small></div><ChevronRight size={13} /></button> })}</nav><TaskBrief run={run} /><div className="sidebar-foot"><StatusBadge status={run.status} /><button className="trace-button" onClick={() => setShowTrace(!showTrace)}><History size={13} />{showTrace ? '收起执行轨迹' : '查看执行轨迹'}</button></div></aside>
      <main className="main-panel">
        <div className="page-head"><div><span className="caption">STEP {STEP_META[viewStep].number} / 05</span><h1>{STEP_META[viewStep].label}</h1><p>{STEP_META[viewStep].description}</p></div><span className="prompt-version">PROMPT V{run.promptVersion || prompts.version}</span></div>
        {notice && <div className="notice"><CircleDot size={13} />{notice}</div>}
        {run.status === 'waiting_user' && run.openQuestions.length > 0 && viewStep === run.currentStep && viewStep !== 'topics' && viewStep !== 'artifact' && <QuestionGate questions={run.openQuestions} reason={run.waitingReason} answer={answer} setAnswer={setAnswer} onSubmit={answerQuestions} />}
        {viewStep === 'topics' && <TopicsStep run={run} onTask={changeTask} onStart={() => startAgent()} selectedDraft={selectedDraft} setSelectedDraft={setSelectedDraft} decisionReason={decisionReason} setDecisionReason={setDecisionReason} rejectedReasons={rejectedReasons} setRejectedReasons={setRejectedReasons} onConfirm={confirmDecision} />}
        {viewStep === 'mindmap' && <><MindmapStep run={run} onChange={editMindmap} onToggleLock={() => toggleModuleLock('mindmap')} onValidate={() => applyLocalValidation('mindmap')} onAgent={() => runAgentForStep('mindmap')} />{pageImprovementPrompt}</>}
        {viewStep === 'plan' && <><PlanStep run={run} onChange={editPlan} onToggleLock={toggleModuleLock} onValidate={() => applyLocalValidation('plan')} onAgent={() => runAgentForStep('plan')} />{pageImprovementPrompt}</>}
        {viewStep === 'artifact' && <><ArtifactStep run={run} creativeDraft={creativeDraft} setCreativeDraft={setCreativeDraft} onConfirmCreative={confirmCreativeFormats} onGenerateCreative={generateCreativeFormats} onContinue={() => runAgentForStep('artifact')} onSelectPrimary={selectPrimaryLane} onSelectVersion={selectLaneVersion} onHtml={uploadHtml} onImages={uploadImages} onOpen={openPreview} onOpenLane={openHtmlPreview} onDownload={() => download('interview-artifact.html', run.artifacts.html, 'text/html;charset=utf-8')} onAiRecord={editAiRecord} onValidate={() => applyLocalValidation('artifact')} />{pageImprovementPrompt}</>}
        {viewStep === 'retro' && <RetroStep run={run} checks={checks} onChange={editRetro} onAgent={() => runAgentForStep('retro')} onValidate={() => applyLocalValidation('retro')} frozen={frozen} onFreeze={freezeDelivery} onExport={exportDelivery} finalReady={finalReady} />}
        {showTrace && <ExecutionTrace run={run} />}
      </main>
      <aside className="agent-rail"><div className="rail-title"><span className="caption">实时 Agent</span><Bot size={15} /></div><div className="agent-goal"><small>当前目标</small><b>{run.goal}</b></div><AgentState run={run} /><div className="rail-section"><small>最近工具动作</small>{run.actionHistory.slice(-5).reverse().map((action) => <div className="tool-row" key={action.id}><span className={action.ok ? 'ok' : 'bad'}>{action.ok ? <Check size={11} /> : <X size={11} />}</span><div><b>{action.tool}</b><small>{localizedAgentText(action.resultSummary)}</small></div></div>)}{!run.actionHistory.length && <p>尚未执行工具</p>}</div><div className="rail-section"><small>最近检查</small>{run.validationResults.slice(-4).reverse().map((item, index) => <div className={`validation-mini ${item.ok ? 'ok' : 'bad'}`} key={`${item.step}-${item.kind}-${index}`}>{item.step} · {item.kind}<b>{item.ok ? '通过' : `${item.issues.length} 项`}</b></div>)}</div></aside>
    </div>{showApi && <ApiModal api={api} setApi={setApi} onClose={() => setShowApi(false)} />}{showPrompts && <PromptModal prompts={prompts} onSave={(next) => { setPrompts({ ...next, version: prompts.version + 1 }); setShowPrompts(false); setNotice(`提示词已保存为 V${prompts.version + 1}，只影响后续 Agent Run。`) }} onClose={() => setShowPrompts(false)} />}{showCalls && <ApiCallsPanel calls={visibleCalls} onClose={() => setShowCalls(false)} />}{showProjects && <ProjectModal projects={projects} activeProjectId={activeProjectId} onSelect={selectProject} onCreate={createManagedProject} onRename={renameProject} onDelete={deleteProject} onClose={() => setShowProjects(false)} />}</div>
}

function TopicsStep({ run, onTask, onStart, selectedDraft, setSelectedDraft, decisionReason, setDecisionReason, rejectedReasons, setRejectedReasons, onConfirm }: { run: AgentRun; onTask: (value: string) => void; onStart: () => void; selectedDraft: string; setSelectedDraft: (value: string) => void; decisionReason: string; setDecisionReason: (value: string) => void; rejectedReasons: Record<string, string>; setRejectedReasons: (value: Record<string, string>) => void; onConfirm: () => void }) {
  const analyzing = run.currentStep === 'topics' && run.status === 'running' && !run.decision?.confirmedAt
  const confirmed = Boolean(run.decision?.confirmedAt)
  return <div className="stack"><section className="panel task-panel"><div className="panel-head"><div><span className="caption">SOURCE TASK</span><h2>完整题目</h2></div><span>{run.task.length} 字</span></div><textarea className="task-input" value={run.task} disabled={Boolean(run.startedAt)} onChange={(event) => onTask(event.target.value)} placeholder="粘贴完整题目、三个主题、规则和交付限制…" />{!run.startedAt && <button className="primary-button" disabled={!run.task.trim()} onClick={onStart}><Sparkles size={15} />启动 Agent 解析</button>}{run.startedAt && <p className="field-note">题目已写入本次 Run 的事实区。新题目请使用右上角“新建”。</p>}</section>{analyzing && <section className="panel topic-analyzing"><span><Sparkles size={18} /></span><div><h2>等待 AI 分析题目</h2><p>正在提取三个候选方向并比较硬约束，完成后再显示选项。</p></div></section>}{!analyzing && run.topicOptions.length === 3 && <section className="topic-entry"><div className="section-heading"><div><span className="caption">THREE-WAY DECISION</span><h2>三选一入口 · 选择主攻方向</h2><p>三个大按钮来自题目原文；Agent 只能建议，最终由你确认。</p></div><span className={confirmed ? 'confirmed-tag' : 'proposal-tag'}>{confirmed ? '方向已确认' : '待用户确认'}</span></div><div className="topic-grid">{run.topicOptions.map((option) => <button className={`topic-card ${selectedDraft === option.id ? 'selected' : ''}`} key={option.id} onClick={() => setSelectedDraft(option.id)}><span className="topic-id">{option.id}</span><div><h3>{option.title}</h3><p>{option.description}</p>{run.recommendedOptionId === option.id && <b className="recommended">Agent 推荐</b>}{confirmed && run.decision?.optionId === option.id && <b className="confirmed-choice">用户已确认</b>}</div></button>)}</div></section>}{!analyzing && selectedDraft && <section className="panel decision-panel"><div className="section-heading"><div><span className="caption">HUMAN DECISION GATE</span><h2>{confirmed ? '主攻方向已确认' : '确认主攻方向'}</h2></div><span className={confirmed ? 'confirmed-tag' : 'proposal-tag'}>{confirmed ? '用户已确认' : '需要用户确认'}</span></div><label>为什么选择 {selectedDraft}<textarea value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} placeholder="结合本场景硬约束说明选择原因…" /></label>{run.topicOptions.filter((item) => item.id !== selectedDraft).map((item) => <label key={item.id}>为什么不以 {item.id}「{item.title}」为主目标<small>{item.reverseQuestion}</small><textarea value={rejectedReasons[item.id] || ''} onChange={(event) => setRejectedReasons({ ...rejectedReasons, [item.id]: event.target.value })} placeholder="说明它在本场景下为何不能成为主目标…" /></label>)}<button className="primary-button" onClick={onConfirm}><Check size={15} />{confirmed ? '更新方向并继续' : '确认唯一方向并继续'}</button></section>}</div>
}

function StepActions({ run, step, onValidate, onAgent }: { run: AgentRun; step: StepId; onValidate: () => void; onAgent: () => void }) { const validation = latestValidation(run, step); return <div className="step-actions"><ValidationBadge validation={validation} /><button className="outline-button" onClick={onValidate}><ShieldCheck size={14} />确定性检查</button><button className="primary-button" disabled={run.status === 'running'} onClick={onAgent}><Sparkles size={14} />{validation?.ok ? '继续 Agent' : '让 Agent 修订'}</button></div> }
function MindmapStep({ run, onChange, onToggleLock, onValidate, onAgent }: { run: AgentRun; onChange: (value: string) => void; onToggleLock: () => void; onValidate: () => void; onAgent: () => void }) { const count = run.artifacts.mindmap.length; const locked = run.lockedModules.includes('mindmap'); return <div className="stack"><section className="panel editor-panel"><div className="panel-head"><div><span className="caption">MARKDOWN</span><h2>原题思考脑图</h2></div><div className="editor-tools"><span className={count > 5000 ? 'limit bad' : 'limit'}>{count} / 5000</span><button type="button" className={`tiny-button field-lock ${locked ? 'locked' : ''}`} title={locked ? '解锁脑图改良' : '锁定脑图，防止 Prompt 改写'} onClick={onToggleLock}>{locked ? <Lock size={12} /> : <Unlock size={12} />}</button></div></div><textarea className="large-editor" value={run.artifacts.mindmap} onChange={(event) => onChange(event.target.value)} placeholder="等待内容 Agent 生成，或直接使用 Markdown 编辑…" /><div className="requirements"><span>包含原题关键要求</span><span>可按题目补充其他必要节点</span></div></section><StepActions run={run} step="mindmap" onValidate={onValidate} onAgent={onAgent} /></div> }

const planLabels: Record<keyof PlanFields, string> = { persona: '用户画像', pain: '核心痛点', path: '解决路径', aiTool: 'AI 工具选型', effect: '预期效果', risk: '风险应对' }
function PlanStep({ run, onChange, onToggleLock, onValidate, onAgent }: { run: AgentRun; onChange: (key: keyof PlanFields, value: string) => void; onToggleLock: (key: keyof PlanFields) => void; onValidate: () => void; onAgent: () => void }) { return <div className="stack"><div className="field-grid">{(Object.keys(planLabels) as (keyof PlanFields)[]).map((key) => { const locked = run.lockedModules.includes(key); return <label className={`panel field-card ${locked ? 'locked' : ''}`} key={key}><span className="field-title">{planLabels[key]}<button type="button" className={`tiny-button field-lock ${locked ? 'locked' : ''}`} title={locked ? `解锁${planLabels[key]}` : `锁定${planLabels[key]}，防止 Prompt 改写`} onClick={onToggleLock.bind(null, key)}>{locked ? <Lock size={12} /> : <Unlock size={12} />}</button></span>{key === 'aiTool' && <small>必须明确写 Codex 及本次选择原因</small>}<textarea value={run.artifacts.plan[key]} onChange={(event) => onChange(key, event.target.value)} /></label> })}</div><StepActions run={run} step="plan" onValidate={onValidate} onAgent={onAgent} /></div> }

function ArtifactStep({ run, creativeDraft, setCreativeDraft, onConfirmCreative, onGenerateCreative, onContinue, onSelectPrimary, onSelectVersion, onHtml, onImages, onOpen, onOpenLane, onDownload, onAiRecord, onValidate }: { run: AgentRun; creativeDraft: string[]; setCreativeDraft: (value: string[]) => void; onConfirmCreative: () => void; onGenerateCreative: () => void; onContinue: () => void; onSelectPrimary: (laneId: string) => void; onSelectVersion: (laneId: string, versionId: string) => void; onHtml: (event: ChangeEvent<HTMLInputElement>) => void; onImages: (event: ChangeEvent<HTMLInputElement>) => void; onOpen: () => void; onOpenLane: (html: string) => void; onDownload: () => void; onAiRecord: (key: keyof AiRecord, value: string) => void; onValidate: () => void }) {
  const htmlBytes = new Blob([run.artifacts.html]).size
  return <div className="stack"><section className="creative-studio"><div className="section-heading"><div><span className="caption">CREATIVE DIRECTOR</span><h2>基于已确认方向选择创作形式</h2><p>主攻方向不变；这里选择如何表达和交付。</p></div><button className="primary-button" disabled={run.status === 'running'} onClick={onGenerateCreative}><Sparkles size={14} />{run.creativeOptions.length ? '重新生成候选' : '生成 4 种创作形式'}</button></div>{run.creativeOptions.length > 0 && <><div className="creative-grid">{[...run.creativeOptions].sort((a, b) => b.score - a.score).map((option) => { const selected = creativeDraft.includes(option.id); return <button className={`creative-card ${selected ? 'selected' : ''}`} key={option.id} onClick={() => setCreativeDraft(selected ? creativeDraft.filter((id) => id !== option.id) : [...creativeDraft, option.id])}><div><span className="score">{option.score}</span><span>{option.difficulty}难度 · {option.estimatedMinutes} 分钟</span></div><h3>{option.title}</h3><p>{option.description}</p><div className="creative-tags">{option.tags.map((tag) => <i key={tag}>{tag}</i>)}</div><dl><dt>风险</dt><dd>{option.risk}</dd><dt>降级</dt><dd>{option.fallback}</dd></dl></button> })}</div><div className="creative-confirm"><span>已选 {creativeDraft.length} 项，可同时保留多个赛道比较。</span><button className="primary-button" disabled={!creativeDraft.length || run.status === 'running'} onClick={onConfirmCreative}><Layers3 size={14} />确认形式并开始制作</button></div></>}</section>{run.artifactLanes.length > 0 && <section className="production-studio"><div className="section-heading"><div><span className="caption">PRODUCTION LANES</span><h2>并行制作与版本</h2><p>最多 2 路同时生成；页面下方的改良 Prompt 会为主作品新建版本，不覆盖旧稿。</p></div><span className="source-tag">2 并发 / {run.artifactLanes.length} 赛道</span></div><div className="lane-list">{run.artifactLanes.map((lane) => <ArtifactLaneCard key={lane.id} lane={lane} primary={run.primaryArtifactLaneId === lane.id} onPrimary={() => onSelectPrimary(lane.id)} onVersion={(versionId) => onSelectVersion(lane.id, versionId)} onOpen={(html) => onOpenLane(html)} />)}</div></section>}<section className="panel artifact-panel"><div className="section-heading"><div><span className="caption">FINAL DELIVERABLE</span><h2>最终主作品</h2></div>{run.artifactStale ? <span className="error-tag">文字已变更，需同步</span> : run.primaryArtifactLaneId ? <span className="confirmed-tag">用户已指定</span> : null}</div><div className="artifact-toolbar"><label className="outline-button upload-button"><Upload size={14} />上传 HTML<input type="file" accept=".html,text/html" onChange={onHtml} /></label><span>或</span><label className="outline-button upload-button"><FileImage size={14} />上传图片<input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={onImages} /></label></div>{run.artifacts.html && <div className="artifact-preview-wrap"><iframe title="作品预览" sandbox="allow-scripts" srcDoc={run.artifacts.html} /><div><span>{byteLabel(htmlBytes)} / 5 MB</span><button className="tiny-button" onClick={onOpen}>新窗口预览</button><button className="tiny-button" onClick={onDownload}><Download size={12} />下载</button></div></div>}{run.artifacts.images.length > 0 && <div className="image-grid">{run.artifacts.images.map((image) => <figure key={image.id}><img src={image.dataUrl} alt={image.name} /><figcaption>{image.name}<span>{byteLabel(image.size)}</span></figcaption></figure>)}</div>}<p className="field-note">最终交付仍为二选一：1 个 ≤ 5 MB 的单文件 HTML，或最多 8 张 PNG/JPG/WebP。其他赛道作为探索版本进入项目包。</p></section><section className="panel ai-record"><div className="panel-head"><div><span className="caption">AI USAGE RECORD</span><h2>AI 使用记录</h2></div><span className="source-tag">首条提示词来自 Run 日志</span></div><label>一句话介绍<input value={run.artifacts.aiRecord.introduction} onChange={(event) => onAiRecord('introduction', event.target.value)} /></label><div className="two-columns"><label>AI 工具名称<input readOnly value="Codex" /></label><label>首条提示词<textarea readOnly value={run.artifacts.aiRecord.firstPrompt} /></label></div><label>不满意之处<textarea value={run.artifacts.aiRecord.dissatisfaction} onChange={(event) => onAiRecord('dissatisfaction', event.target.value)} /></label><label>迭代逻辑<textarea value={run.artifacts.aiRecord.iterationLogic} onChange={(event) => onAiRecord('iterationLogic', event.target.value)} /></label></section><StepActions run={run} step="artifact" onValidate={onValidate} onAgent={onContinue} /></div>
}

function ArtifactLaneCard({ lane, primary, onPrimary, onVersion, onOpen }: { lane: ArtifactLane; primary: boolean; onPrimary: () => void; onVersion: (id: string) => void; onOpen: (html: string) => void }) {
  const active = lane.versions.find((item) => item.id === lane.activeVersionId) || lane.versions.at(-1)
  return <article className={`artifact-lane ${primary ? 'primary' : ''}`}><header><div><b>{lane.title}</b><span className={`lane-status ${lane.status}`}>{lane.status === 'queued' ? '排队中' : lane.status === 'running' ? '制作中' : lane.status === 'done' ? '已完成' : lane.status}</span></div>{primary && <span className="confirmed-tag">主作品</span>}</header>{active ? <iframe title={`${lane.title} V${active.version}`} sandbox="allow-scripts" srcDoc={active.html} /> : <div className="lane-placeholder">{lane.status === 'running' ? '正在流式生成，可在 API Calls 查看正文…' : '等待制作任务'}</div>}<div className="lane-version-row"><span>版本</span>{lane.versions.map((version) => <button className={active?.id === version.id ? 'active' : ''} key={version.id} onClick={() => onVersion(version.id)}>V{version.version}</button>)}<button className="tiny-button" title="新标签页查看作品" aria-label={`新标签页查看${lane.title}`} disabled={!active?.html} onClick={() => active && onOpen(active.html)}><ExternalLink size={12} />查看效果</button><button className="outline-button primary-select" disabled={!active || primary} onClick={onPrimary}>{primary ? '当前主作品' : '设为主作品'}</button></div>{lane.error && <p className="lane-error">{lane.error}</p>}</article>
}

const retroLabels: Record<keyof RetroFields, string> = { satisfied: '最满意的地方', change: '最想改变的地方', extraTime: '再给 25 分钟会做什么', interviewerQuestion: '想问面试官什么' }
function RetroStep({ run, checks, onChange, onAgent, onValidate, frozen, onFreeze, onExport, finalReady, showFields = true }: { run: AgentRun; checks: ValidationResult[]; onChange: (key: keyof RetroFields, value: string) => void; onAgent: () => void; onValidate: () => void; frozen: FrozenDelivery | null; onFreeze: () => void; onExport: () => void; finalReady: boolean; showFields?: boolean }) { return <div className="stack">{showFields && <div className="field-grid retro-grid">{(Object.keys(retroLabels) as (keyof RetroFields)[]).map((key) => <label className="panel field-card" key={key}><span>{retroLabels[key]}</span><textarea value={run.artifacts.retro[key]} onChange={(event) => onChange(key, event.target.value)} /></label>)}</div>}<StepActions run={run} step="retro" onValidate={onValidate} onAgent={onAgent} /><section className="panel final-review"><div className="section-heading"><div><span className="caption">FINAL GATE</span><h2>五步交付检查</h2></div><span className={finalReady ? 'confirmed-tag' : 'error-tag'}>{finalReady ? '可以冻结' : '尚未通过'}</span></div><div className="check-list">{checks.map((item, index) => <div key={`${item.step}-${index}`} className={item.ok ? 'check ok' : 'check bad'}><span>{item.ok ? <Check size={14} /> : <X size={14} />}</span><b>{item.step}</b><p>{item.ok ? '通过' : item.issues.join('；')}</p></div>)}</div><div className="export-actions"><button className="primary-button" disabled={!finalReady} onClick={onFreeze}><ShieldCheck size={14} />{frozen ? '重新冻结' : '冻结最终版本'}</button><button className="outline-button" disabled={!frozen} onClick={onExport}><Download size={14} />导出完整项目包</button>{frozen && <small>冻结于 {new Date(frozen.frozenAt).toLocaleString()}</small>}</div></section></div> }

function QuestionGate({ questions, reason, answer, setAnswer, onSubmit }: { questions: string[]; reason: string; answer: string; setAnswer: (value: string) => void; onSubmit: () => void }) { const validationFailure = /修订.*上限|检查失败|校验/.test(reason); return <section className={`question-gate ${validationFailure ? 'validation-failure' : ''}`}><AlertTriangle size={17} /><div><b>{validationFailure ? '系统检查未通过，需要你决策' : 'Agent 等待用户确认'}</b>{reason && <small>{reason}</small>}{questions.map((question) => <p key={question}>{question}</p>)}<textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={validationFailure ? '说明采用哪组事实或取舍；Agent 将据此局部修订…' : '输入补充信息；内容会作为用户确认写入上下文…'} /><button className="primary-button" onClick={onSubmit}>提交并继续</button></div></section> }
function ValidationBadge({ validation }: { validation?: ValidationResult }) { return validation ? <span className={`validation-badge ${validation.ok ? 'ok' : 'bad'}`}>{validation.ok ? <Check size={13} /> : <X size={13} />}{validation.ok ? '检查通过' : `${validation.issues.length} 项问题`}</span> : <span className="validation-badge">尚未检查</span> }
function StatusBadge({ status }: { status: AgentRun['status'] }) { const labels: Record<AgentRun['status'], string> = { idle: '待启动', running: '运行中', waiting_user: '等待用户', paused: '已暂停', failed: '失败', completed: '已完成', cancelled: '已中断' }; return <span className={`status-badge ${status}`}><i />{labels[status]}</span> }
function AgentState({ run }: { run: AgentRun }) { return <div className="agent-state-card"><StatusBadge status={run.status} /><small>当前步骤</small><b>{STEP_META[run.currentStep].label}</b>{run.waitingReason && <p>{localizedAgentText(run.waitingReason)}</p>}<span>{COUNTDOWN_ENABLED ? `剩余 ${formatTime(remainingSeconds(run))}` : '全局计时未启用'}</span></div> }
function ExecutionTrace({ run }: { run: AgentRun }) {
  return <section className="panel execution-trace">
    <div className="panel-head"><div><span className="caption">可审计执行记录</span><h2>Agent 每一步做了什么</h2><p>默认展示人能读懂的摘要；原始工具输入和结果仍可展开查看。</p></div><span>{run.actionHistory.length} 个动作</span></div>
    <div className="trace-summary"><span>目标：{run.goal}</span><span>当前：{STEP_META[run.currentStep].label}</span><span>状态：<StatusBadge status={run.status} /></span></div>
    <div className="trace-list">{run.actionHistory.map((action, index) => {
      const step = actionStep(action)
      const next = run.actionHistory[index + 1]
      return <article className={action.ok ? 'ok' : 'bad'} key={action.id}>
        <div className="trace-index">{String(index + 1).padStart(2, '0')}</div>
        <div className="trace-body">
          <header><span className={`trace-actor ${action.actor}`}>{action.actor === 'user' ? '用户' : 'Agent'}</span>{step && <span className="trace-step">STEP {STEP_META[step].number} · {STEP_META[step].label}</span>}<time>{new Date(action.at).toLocaleTimeString()}</time><span className={action.ok ? 'trace-state ok' : 'trace-state bad'}>{action.ok ? '完成' : '受阻'}</span></header>
          <h3>{toolLabels[action.tool] || action.tool}</h3>
          <dl><dt>做了什么</dt><dd>{toolLabels[action.tool] || action.tool}</dd><dt>为什么</dt><dd>{compactText(action.goal)}</dd><dt>结果</dt><dd>{actionResult(action)}</dd><dt>下一步</dt><dd>{next ? toolLabels[next.tool] || next.tool : run.status === 'waiting_user' ? '等待用户确认后继续' : run.status === 'completed' ? '交付已完成' : '等待下一项动作'}</dd></dl>
          <details><summary>查看技术记录</summary><div><b>工具</b><code>{action.tool}</code><b>输入摘要</b><pre>{localizedAgentText(action.inputSummary || '无')}</pre><b>工具结果</b><pre>{localizedAgentText(action.resultSummary || '无')}</pre></div></details>
        </div>
      </article>
    })}{!run.actionHistory.length && <p className="empty-trace">尚无执行记录，启动 Agent 后会按时间顺序显示。</p>}</div>
  </section>
}

function ProjectModal({ projects, activeProjectId, onSelect, onCreate, onRename, onDelete, onClose }: { projects: ProjectRecord[]; activeProjectId: string; onSelect: (project: ProjectRecord) => void; onCreate: (name: string) => void; onRename: (id: string, name: string) => void; onDelete: (id: string) => void; onClose: () => void }) {
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState('')
  const [editingName, setEditingName] = useState('')
  return <div className="modal-backdrop"><section className="project-modal panel"><div className="panel-head"><div><span className="caption">PROJECTS</span><h2>项目管理</h2><p>每个项目拥有独立题目、Run、作品和导出快照。</p></div><button className="icon-button" onClick={onClose}><X size={15} /></button></div><div className="project-create"><input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && newName.trim()) { onCreate(newName); setNewName('') } }} placeholder="新项目名称" /><button className="primary-button" disabled={!newName.trim()} onClick={() => { onCreate(newName); setNewName('') }}>新建项目</button></div><div className="project-list">{projects.map((project) => <article className={project.id === activeProjectId ? 'active' : ''} key={project.id}><button className="project-select" onClick={() => onSelect(project)}><span className="project-dot" /><div><b>{project.name}</b><small>{project.run.task ? `${project.run.task.slice(0, 46)}${project.run.task.length > 46 ? '…' : ''}` : '尚未粘贴题目'} · {project.run.status}</small></div></button>{editingId === project.id ? <div className="project-edit"><input autoFocus value={editingName} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { onRename(project.id, editingName); setEditingId('') } }} /><button className="tiny-button" onClick={() => { onRename(project.id, editingName); setEditingId('') }}><Check size={12} /></button><button className="tiny-button" onClick={() => setEditingId('')}><X size={12} /></button></div> : <div className="project-actions"><button className="tiny-button" onClick={() => { setEditingId(project.id); setEditingName(project.name) }}>重命名</button><button className="tiny-button danger" disabled={projects.length <= 1} onClick={() => onDelete(project.id)}>删除</button></div>}</article>)}</div><div className="modal-actions"><button className="outline-button" onClick={onClose}>关闭</button></div></section></div>
}

function ApiModal({ api, setApi, onClose }: { api: ApiConfig; setApi: (api: ApiConfig) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(api); const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'bad'; message: string }>({ state: 'idle', message: '' })
  const resetTest = () => setTest({ state: 'idle', message: '' })
  async function testConnection() {
    if (!draft.baseUrl.trim() || !draft.apiKey.trim() || !draft.model.trim()) { setTest({ state: 'bad', message: '请完整填写 Base URL、API Key 和模型名' }); return }
    setTest({ state: 'running', message: '正在请求上游 API…' })
    try {
      const response = await fetch('/api/test-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })
      const result = await response.json() as { ok?: boolean; message?: string; error?: string; endpoint?: string }
      if (!response.ok || !result.ok) throw new Error(result.error || `连接失败（HTTP ${response.status}）`)
      setTest({ state: 'ok', message: `${result.message}${result.endpoint ? ` · ${result.endpoint}` : ''}` })
    } catch (error) { setTest({ state: 'bad', message: errorMessage(error) }) }
  }
  return <div className="modal-backdrop"><section className="modal panel"><div className="panel-head"><div><span className="caption">MODEL CONNECTION</span><h2>API 设置</h2></div><button className="icon-button" onClick={onClose}><X size={15} /></button></div><p className="field-note">API Key 仅保存在当前浏览器会话，并只在运行期间进入服务端内存；不会写入 Run 或导出包。</p><label>Base URL<input value={draft.baseUrl} onChange={(event) => { setDraft({ ...draft, baseUrl: event.target.value }); resetTest() }} placeholder="例如 https://api.openai.com/v1" /></label><label>API Key<input type="password" value={draft.apiKey} onChange={(event) => { setDraft({ ...draft, apiKey: event.target.value }); resetTest() }} /></label><label>模型<input value={draft.model} onChange={(event) => { setDraft({ ...draft, model: event.target.value }); resetTest() }} /></label><label>温度 <span>{draft.temperature.toFixed(2)}</span><input type="range" min="0" max="1" step="0.05" value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} /></label>{test.message && <p className={`test-result ${test.state}`}>{test.message}</p>}<div className="modal-actions"><button className="ghost-button" disabled={test.state === 'running'} onClick={testConnection}>{test.state === 'running' ? '测试中…' : '测试连接'}</button><button className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={test.state !== 'ok'} onClick={() => { setApi(draft); onClose() }}>保存已验证配置</button></div></section></div>
}

function PromptModal({ prompts, onSave, onClose }: { prompts: PromptSet; onSave: (value: PromptSet) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(prompts); const fields: [keyof Omit<PromptSet, 'version'>, string, string][] = [['orchestrator', '编排 Agent', '选择下一动作并管理五步状态'], ['content', '内容 Agent', '生成或局部修订步骤 2、3、5'], ['creative', '创意 Agent', '围绕已确认方向提出多种创作形式'], ['artifact', '作品 Agent', '按所选形式生成或修订作品'], ['reviewer', '审查 Agent', '检查覆盖度和跨步骤一致性']]
  return <div className="modal-backdrop"><section className="prompt-modal panel"><div className="panel-head"><div><span className="caption">VERSIONED PROMPTS</span><h2>提示词工作台 · V{prompts.version}</h2><p>保存后生成新版本，只影响后续 Run；当前 Run 保留启动时的版本号。</p></div><button className="icon-button" onClick={onClose}><X size={15} /></button></div><div className="prompt-grid">{fields.map(([key, label, help]) => <label key={key}><span>{label}</span><small>{help}</small><textarea value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></label>)}</div><div className="modal-actions"><button className="ghost-button" onClick={() => setDraft({ ...DEFAULT_PROMPTS, version: prompts.version })}>恢复默认内容</button><button className="outline-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => onSave(draft)}>保存为 V{prompts.version + 1}</button></div></section></div>
}

createRoot(document.getElementById('root')!).render(<App />)
