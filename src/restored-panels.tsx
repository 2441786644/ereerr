import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, History, RotateCcw, Sparkles, X } from 'lucide-react'
import type { AgentRun, ContentSnapshot, ModelCall } from './workflow'

export type VisibleCall = ModelCall & { source?: 'agent' | 'manual' }

function localizedAgentName(value: string) {
  return value
    .replace(/Orchestrator Agent/g, '编排 Agent').replace(/Decision Agent/g, '决策 Agent')
    .replace(/Creative Director Agent|Creative Agent/g, '创意 Agent').replace(/Content Agent/g, '内容 Agent')
    .replace(/Artifact Agent/g, '作品 Agent').replace(/Reviewer Agent/g, '审查 Agent')
}

export function ImprovementPrompt({ title, description, placeholder, quickPrompts, patching, snapshots, onPatch, onSnapshot, onRestore }: {
  title: string
  description: string
  placeholder: string
  quickPrompts: string[]
  patching: boolean
  onPatch: (prompt: string) => void
  onSnapshot?: () => void
  snapshots: ContentSnapshot[]
  onRestore: (snapshot: ContentSnapshot) => void
}) {
  const [patch, setPatch] = useState('')
  return <section className="panel improvement-prompt">
    <div className="panel-head"><div><span className="caption">页面改良 Prompt</span><h2>{title}</h2><p>{description}</p></div>{onSnapshot && <button className="outline-button" onClick={onSnapshot}><History size={13} />保存快照</button>}</div>
    <textarea value={patch} onChange={(event) => setPatch(event.target.value)} placeholder={placeholder} />
    <div className="quick-prompts"><span>快速提示</span>{quickPrompts.map((item) => <button key={item} onClick={() => setPatch(item)}>{item}</button>)}</div>
    <button className="primary-button" disabled={!patch.trim() || patching} onClick={() => onPatch(patch)}><Sparkles size={14} />{patching ? '流式生成中…' : '按点名模块生成补丁'}</button>
    {snapshots.length > 0 && <details className="prompt-snapshots"><summary>恢复文字快照（{snapshots.length}）</summary><div className="snapshot-list">{snapshots.slice().reverse().map((snapshot) => <article key={snapshot.id}><div><b>{snapshot.label}</b><small>{new Date(snapshot.createdAt).toLocaleString()}</small></div><button className="tiny-button" onClick={() => onRestore(snapshot)}><RotateCcw size={12} />恢复</button></article>)}</div></details>}
  </section>
}

export function TaskBrief({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false)
  const deliverables = useMemo(() => run.task.split(/[。\n]/).filter((item) => /交付|HTML|图片|Markdown|A4|复盘/.test(item)).slice(0, 8), [run.task])
  return <section className="task-brief"><button onClick={() => setOpen(!open)}><span>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}共享 TaskBrief</span><small>{run.facts.length} 条硬约束 · {run.assumptions.length} 条假设</small></button>{open && <div><b>硬约束</b>{run.facts.length ? <ul>{run.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul> : <p>尚未提取</p>}<b>交付要求</b>{deliverables.length ? <ul>{deliverables.map((item) => <li key={item}>{item}</li>)}</ul> : <p>尚未识别</p>}<b>用户确认</b><p>{run.decision ? `${run.decision.optionId} · ${run.decision.reason}` : '主攻方向尚未确认'}</p><b>显式假设</b>{run.assumptions.length ? <ul>{run.assumptions.map((item) => <li key={item}>{item}</li>)}</ul> : <p>无</p>}</div>}</section>
}

export function ApiCallsPanel({ calls, onClose }: { calls: VisibleCall[]; onClose: () => void }) {
  const [selectedId, setSelectedId] = useState(calls[0]?.id || '')
  useEffect(() => { if (!calls.some((item) => item.id === selectedId)) setSelectedId(calls[0]?.id || '') }, [calls, selectedId])
  const selected = calls.find((item) => item.id === selectedId) || calls[0]
  return <div className="calls-drawer">
    <header><div><span className="caption">API CALLS</span><h2>模型调用与流式输出</h2></div><button className="icon-button" onClick={onClose}><X size={15} /></button></header>
    <div className="calls-layout"><nav>{calls.map((call) => <button className={selected?.id === call.id ? 'active' : ''} key={call.id} onClick={() => setSelectedId(call.id)}><span className={`call-dot ${call.status}`} /><div><b>{localizedAgentName(call.agent)}</b><strong>{call.title}</strong><small>{new Date(call.startedAt).toLocaleTimeString()} · {call.status}</small></div></button>)}{!calls.length && <p>尚无模型调用</p>}</nav><main>{selected ? <><div className="call-meta"><span>{localizedAgentName(selected.agent)}</span><span>{selected.status}</span><span>{selected.output.length} 字</span></div><details open><summary>System Prompt</summary><pre>{selected.systemPrompt}</pre></details><details><summary>User Prompt</summary><pre>{selected.userPrompt}</pre></details><section className="stream-output"><b>Response {selected.status === 'running' && <i>流式接收中</i>}</b><pre>{selected.output || (selected.status === 'running' ? '等待首个内容块…' : '（无可见输出）')}</pre>{selected.error && <p>{selected.error}</p>}</section></> : <p>选择一次调用查看详情</p>}</main></div>
  </div>
}
