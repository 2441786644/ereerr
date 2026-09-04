import http from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { createAgentService } from './agent-runner.mjs'
import { applyFastMode } from './model-request.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(root, 'dist')
const dataDir = path.join(root, '.flowforge')
const jobFile = path.join(dataDir, 'jobs.json')
const jobs = new Map()
let persistTimer
const maxJobs = 200
const maxJobAge = 7 * 24 * 60 * 60 * 1000
const port = Number(process.env.PORT || 4173)
const agentService = await createAgentService(dataDir)

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function body(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 12 * 1024 * 1024) throw new Error('请求体超过 12MB 限制')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function publicJob(job) {
  const { controller, apiKey, reasoningOutput: _reasoningOutput, ...safe } = job
  return safe
}

function upstreamConfig(baseUrl) {
  const base = baseUrl.trim().replace(/\/$/, '')
  const parsed = new URL(base)
  const nativeDashScope = /\/api\/v1$/.test(parsed.pathname)
  if (nativeDashScope) return { mode: 'dashscope', url: `${base}/services/aigc/text-generation/generation` }
  if (/\/services\/aigc\/text-generation\/generation$/.test(parsed.pathname)) return { mode: 'dashscope', url: base }
  return { mode: 'compatible', url: /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions` }
}

async function testUpstream(input) {
  if (!input.apiKey || !input.baseUrl || !input.model) throw new Error('请完整填写 Base URL、API Key 和模型名')
  const config = upstreamConfig(input.baseUrl)
  const parsed = new URL(config.url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Base URL 必须是无内嵌凭证的 HTTP(S) 地址')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  const requestBody = applyFastMode(config.mode === 'dashscope'
    ? { model: input.model, input: { messages: [{ role: 'system', content: [{ text: '这是连通性测试。' }] }, { role: 'user', content: [{ text: '只回复 OK' }] }] }, parameters: { result_format: 'message' } }
    : { model: input.model, temperature: 0, stream: false, max_tokens: 8, messages: [{ role: 'system', content: '这是连通性测试。' }, { role: 'user', content: '只回复 OK' }] }, config.mode, input.fastMode)
  try {
    const response = await fetch(config.url, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` }, body: JSON.stringify(requestBody) })
    const raw = await response.text()
    if (!response.ok) throw new Error(`上游 HTTP ${response.status}：${raw.slice(0, 280) || response.statusText}`)
    let data
    try { data = JSON.parse(raw) } catch { throw new Error('上游返回了非 JSON 响应，请检查 Base URL 是否指向 API 端点') }
    const content = textFromValue(data?.choices?.[0]?.message?.content ?? data?.output?.choices?.[0]?.message?.content ?? data?.output?.text ?? data?.text)
    return { ok: true, message: content ? `连接成功：${content.slice(0, 80)}` : '连接成功，上游已返回有效 JSON', endpoint: config.url, mode: config.mode, model: input.model }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('连接超时（30 秒），请检查网络、Base URL 或服务商状态')
    throw error
  } finally { clearTimeout(timeout) }
}

function textFromValue(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => textFromValue(item?.text ?? item?.content ?? item)).join('')
  return value && typeof value === 'object' ? textFromValue(value.text ?? value.content ?? '') : ''
}

function partsFromChunk(data) {
  const choice = data?.choices?.[0]
  const outputChoice = data?.output?.choices?.[0]
  const delta = choice?.delta || {}
  const openAiMessage = choice?.message || {}
  const nativeMessage = outputChoice?.message || {}
  return {
    content: [
      delta.content,
      openAiMessage.content,
      nativeMessage.content,
      data?.output?.text,
      data?.text,
    ].map(textFromValue).join(''),
    reasoning: [
      delta.reasoning_content,
      delta.reasoningContent,
      openAiMessage.reasoning_content,
      openAiMessage.reasoningContent,
      nativeMessage.reasoning_content,
      nativeMessage.reasoningContent,
    ].map(textFromValue).join(''),
  }
}

function persistJobs() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(async () => {
    await mkdir(dataDir, { recursive: true })
    await writeFile(jobFile, JSON.stringify([...jobs.values()].map(publicJob), null, 2), 'utf8')
  }, 150)
}

function cleanupJobs() {
  const before = jobs.size
  const cutoff = Date.now() - maxJobAge
  for (const [id, job] of jobs) if (job.status !== 'running' && job.updatedAt < cutoff) jobs.delete(id)
  const removable = [...jobs.values()].filter((job) => job.status !== 'running').sort((a, b) => a.updatedAt - b.updatedAt)
  while (jobs.size > maxJobs && removable.length) jobs.delete(removable.shift().id)
  return jobs.size !== before
}

function isLocalRequest(req) {
  const hostname = (req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '')
  if (!['localhost', '127.0.0.1'].includes(hostname)) return false
  const origin = req.headers.origin
  if (!origin) return true
  try { return ['localhost', '127.0.0.1'].includes(new URL(origin).hostname) && Number(new URL(origin).port) === port } catch { return false }
}

function streamJob(res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  let lastPayload = ''
  let closed = false
  let updateTimer
  let heartbeatTimer
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(updateTimer)
    clearInterval(heartbeatTimer)
    if (!res.writableEnded) res.end()
  }
  const send = () => {
    if (closed || res.writableEnded) return close()
    const payload = JSON.stringify(publicJob(job))
    if (payload !== lastPayload) {
      lastPayload = payload
      res.write(`data: ${payload}\n\n`)
    }
    if (['completed', 'failed', 'cancelled'].includes(job.status)) close()
  }
  res.on('close', close)
  updateTimer = setInterval(send, 80)
  heartbeatTimer = setInterval(() => { if (!closed && !res.writableEnded) res.write(': keepalive\n\n') }, 15000)
  send()
}

function streamAgentRun(res, id) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders?.()
  let lastPayload = ''; let closed = false
  const close = () => { if (closed) return; closed = true; clearInterval(updateTimer); clearInterval(heartbeatTimer); if (!res.writableEnded) res.end() }
  const send = () => {
    const run = agentService.get(id)
    if (!run) { if (!res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify({ error: 'Agent Run 不存在' })}\n\n`); return close() }
    const payload = JSON.stringify(run)
    if (payload !== lastPayload && !res.writableEnded) { lastPayload = payload; res.write(`data: ${payload}\n\n`) }
    if (run.status !== 'running') close()
  }
  res.on('close', close)
  const updateTimer = setInterval(send, 80)
  const heartbeatTimer = setInterval(() => { if (!closed && !res.writableEnded) res.write(': keepalive\n\n') }, 15000)
  send()
}

try {
  const saved = JSON.parse(await readFile(jobFile, 'utf8'))
  for (const item of saved) jobs.set(item.id, { ...item, reasoningOutput: '', status: item.status === 'running' ? 'cancelled' : item.status, error: item.status === 'running' ? '本地服务重启，流式连接已中断' : item.error })
  cleanupJobs()
  persistJobs()
} catch { /* first run */ }

async function runJob(job) {
  try {
    const body = applyFastMode(job.mode === 'dashscope'
      ? { model: job.model, input: { messages: [{ role: 'system', content: [{ text: job.systemPrompt || '你是严谨的面试方案编辑，只返回可直接使用的中文内容。' }] }, { role: 'user', content: [{ text: job.prompt }] }] }, parameters: { incremental_output: true } }
      : { model: job.model, temperature: job.temperature, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: job.systemPrompt || '你是严谨的面试方案编辑，只返回可直接使用的中文内容。' }, { role: 'user', content: job.prompt }] }, job.mode, job.fastMode)
    const response = await fetch(job.url, {
      method: 'POST', signal: job.controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${job.apiKey}`, ...(job.mode === 'dashscope' ? { 'X-DashScope-SSE': 'enable' } : {}) },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`)
    const type = response.headers.get('content-type') || ''
    if (type.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n'); buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue
          try {
            const parts = partsFromChunk(JSON.parse(data))
            job.output += parts.content
            // Hidden model reasoning is intentionally discarded; only auditable actions are persisted.
          } catch { /* ignore malformed event */ }
        }
        job.updatedAt = Date.now()
        persistJobs()
      }
    } else {
      const data = await response.json()
      const parts = partsFromChunk(data)
      job.output = parts.content
      job.reasoningOutput = ''
    }
    job.status = 'completed'; job.updatedAt = Date.now(); persistJobs()
  } catch (error) {
    job.status = error?.name === 'AbortError' ? 'cancelled' : 'failed'
    job.error = error instanceof Error ? error.message : '未知错误'; job.updatedAt = Date.now(); persistJobs()
  }
}

async function serveFile(reqPath, res) {
  const clean = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '')
  let file = path.resolve(dist, clean)
  if (!file.startsWith(path.resolve(dist))) return json(res, 403, { error: 'forbidden' })
  try { if (!(await stat(file)).isFile()) throw new Error('not file') } catch { file = path.join(dist, 'index.html') }
  const ext = path.extname(file)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
  res.end(await readFile(file))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname.startsWith('/api/') && !isLocalRequest(req)) return json(res, 403, { error: '仅允许本机同源访问' })
  if (url.pathname === '/api/test-connection' && req.method === 'POST') {
    try { return json(res, 200, await testUpstream(await body(req))) }
    catch (error) { return json(res, 502, { ok: false, error: error instanceof Error ? error.message : 'API 连接测试失败' }) }
  }
  if (url.pathname === '/api/agent-runs' && req.method === 'POST') {
    try {
      const input = await body(req)
      if (!input.prompts?.orchestrator || !input.prompts?.content || !input.prompts?.artifact || !input.prompts?.reviewer) return json(res, 400, { error: '缺少版本化 Agent 提示词' })
      if (input.apiKey && (!input.baseUrl || !input.model)) return json(res, 400, { error: '配置 API Key 后必须同时提供 Base URL 和模型名' })
      return json(res, 202, agentService.start(input))
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Agent Run 启动失败' }) }
  }
  const agentStreamMatch = url.pathname.match(/^\/api\/agent-runs\/([^/]+)\/stream$/)
  if (agentStreamMatch && req.method === 'GET') return streamAgentRun(res, agentStreamMatch[1])
  const agentRunMatch = url.pathname.match(/^\/api\/agent-runs\/([^/]+)(?:\/(pause|cancel))?$/)
  if (agentRunMatch) {
    const run = agentRunMatch[2] === 'pause' && req.method === 'POST'
      ? agentService.pause(agentRunMatch[1])
      : agentRunMatch[2] === 'cancel' && req.method === 'POST'
        ? agentService.cancel(agentRunMatch[1])
        : req.method === 'GET' && !agentRunMatch[2]
          ? agentService.get(agentRunMatch[1])
          : null
    return run ? json(res, 200, run) : json(res, 404, { error: 'Agent Run 不存在或方法不受支持' })
  }
  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    const projectId = url.searchParams.get('projectId')
    if (cleanupJobs()) persistJobs()
    return json(res, 200, [...jobs.values()].filter((job) => !projectId || job.projectId === projectId).map(publicJob))
  }
  if (url.pathname === '/api/jobs' && req.method === 'POST') {
    try {
      const input = await body(req)
      if (!input.projectId || !input.apiKey || !input.baseUrl || !input.model || !input.prompt) return json(res, 400, { error: '缺少项目 ID、API 配置或 Prompt' })
      const config = upstreamConfig(input.baseUrl)
      const parsedBase = new URL(config.url)
      if (!['http:', 'https:'].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password) return json(res, 400, { error: 'Base URL 必须是无内嵌凭证的 HTTP(S) 地址' })
      const job = { id: crypto.randomUUID(), projectId: input.projectId, runId: input.runId || null, resultKind: input.resultKind || 'generic', targetId: input.targetId || null, agent: input.agent || 'Agent', title: input.title || '模型调用', prompt: input.prompt, systemPrompt: input.systemPrompt || '', output: '', reasoningOutput: '', error: '', status: 'running', startedAt: Date.now(), updatedAt: Date.now(), url: config.url, mode: config.mode, apiKey: input.apiKey, model: input.model, temperature: input.temperature ?? 0.4, fastMode: input.fastMode === true, controller: new AbortController() }
      jobs.set(job.id, job); cleanupJobs(); persistJobs(); runJob(job); return json(res, 202, publicJob(job))
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : '请求格式错误' }) }
  }
  const streamMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/stream$/)
  if (streamMatch && req.method === 'GET') {
    const job = jobs.get(streamMatch[1])
    if (!job) return json(res, 404, { error: '任务不存在' })
    return streamJob(res, job)
  }
  const match = url.pathname.match(/^\/api\/jobs\/([^/]+)(\/cancel)?$/)
  if (match) {
    const job = jobs.get(match[1]); if (!job) return json(res, 404, { error: '任务不存在' })
    if (match[2] && req.method === 'POST') { job.controller?.abort(); if (!job.controller && job.status === 'running') job.status = 'cancelled'; persistJobs(); return json(res, 200, publicJob(job)) }
    if (req.method === 'GET') return json(res, 200, publicJob(job))
  }
  return serveFile(url.pathname, res)
})

server.listen(port, '127.0.0.1', () => console.log(`Workflow Studio: http://localhost:${port}/`))
