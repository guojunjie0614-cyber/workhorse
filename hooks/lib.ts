import type { PluginOptions } from 'claude-code'

export type Input = {
  goal: string
  context: string
  done_when: string
  constraints?: string
  mode?: 'code' | 'review' | 'ops'
  dir?: string
  worktree?: string
  name?: string
  resume?: string
  to_code?: boolean
  effort?: 'low' | 'medium' | 'high'
  model?: string
}

export type Job = {
  name: string
  session: string
  goal: string
  doneWhen: string
  warnedStall: boolean
  warnedTests: boolean
}

export type Status = {
  name: string
  mode: string
  path: string
  state: 'running' | 'done' | 'dead' | 'missing'
  exit: number | null
  started: number
  elapsed_min: number
  idle_min: number
  cmds: number
  activity: string
  files: number
  step: number
  steps: number
  tests: number
  tokens: number
  report: string
}

export function jobRows(output: string): { name: string; label: string }[] {
  return output.split('\n').filter(line => line.trim()).map(line => ({ name: line.trim().split(/\s+/)[0]!, label: line.trim() }))
}

export type PanelTask = Status & { goal: string; completedAt?: number }
type Segment = { children: string; color?: 'claude' | 'success' | 'error' | 'inactive'; dimColor?: boolean }

export function panelLines(tasks: PanelTask[], now: number): Segment[][] {
  const visible = tasks.filter(task => task.state !== 'missing' && (task.completedAt === undefined || now - task.completedAt < 180000))
  if (!visible.length) return []
  const frame = Math.floor(now / 250)
  const star = Array.from('·✢✳✶✻✽')[frame % 6]!
  const running = visible.filter(task => task.state === 'running').length
  const done = visible.filter(task => task.state === 'done').length
  const failed = visible.filter(task => task.state === 'dead').length
  return [
    [{ children: `${star} Working…`, color: 'claude' }],
    [{ children: `${visible.length} agents · ${running} running · ${done} done${failed ? ` · ${failed} failed` : ''}`, dimColor: true }],
    ...visible.flatMap((task, index) => taskLines(task, now, frame, star, index === visible.length - 1, Math.max(...visible.map(t => width(t.name))))),
  ]
}

function width(text: string): number {
  return Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0)! >= 0x1100 ? 2 : 1), 0)
}

function pad(text: string, columns: number): string {
  let out = ''
  for (const char of text) {
    if (width(out + char) > columns) break
    out += char
  }
  return out + ' '.repeat(columns - width(out))
}

function taskLines(status: PanelTask, now: number, frame: number, star: string, last: boolean, nameWidth: number): Segment[][] {
  const seconds = Math.floor((status.completedAt ?? now) / 1000 - status.started)
  const minutes = Math.floor(seconds / 60)
  const elapsed = seconds < 60 ? `${seconds}s`
    : minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
      : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
  const progress = status.state === 'done' ? 1 : status.steps > 0 ? status.step / status.steps : undefined
  const filled = progress === undefined ? 4 : Math.round(progress * 20)
  const offset = progress === undefined ? 16 - Math.abs(frame % 32 - 16) : 0
  const failed = status.state === 'dead'
  return [
    [
      { children: last ? '└─ ' : '├─ ' },
      { children: status.state === 'running' ? star : failed ? '✗' : '✓', color: failed ? 'error' : status.state === 'done' ? 'success' : 'claude' },
      { children: ` ${pad(status.name, nameWidth)}  ${pad(status.goal, 24)}  ` },
      { children: '░'.repeat(offset), color: 'inactive' },
      { children: '█'.repeat(filled), color: 'claude' },
      { children: '░'.repeat(20 - offset - filled), color: 'inactive' },
      { children: ` ${progress === undefined ? '…' : `${Math.round(progress * 100)}%`} ` },
      { children: failed ? 'failed' : status.state, color: failed ? 'error' : 'claude' },
      { children: ` · ${elapsed}` },
    ],
    [{ children: `${last ? '   ' : '│  '}  ${status.state === 'running' && status.steps > 0 ? `Step ${status.step}/${status.steps} · ` : ''}${status.activity} · ${status.cmds} cmds · ${status.files} files`, dimColor: true }],
  ]
}

export function toolLine(input: Input): string {
  return `workhorse ▸ ${input.name || input.resume || 'auto'} · ${input.mode ?? 'code'} · ${input.effort ?? 'default'} — ${Array.from(input.goal).slice(0, 80).join('').replace(/\s+/g, ' ')}`
}

export function lint(input: Input, banned: string): string | undefined {
  if (!input.done_when?.trim()) return 'done_when 必须填写明确的完成条件'
  for (const phrase of banned.split(',').map(s => s.trim()).filter(Boolean)) {
    for (const field of ['goal', 'constraints', 'done_when'] as const) {
      if ((input[field] ?? '').toLowerCase().includes(phrase.toLowerCase())) return `${field} 含禁用词：${phrase}`
    }
  }
}

export function brief(input: Input): string {
  return `Goal: ${input.goal}\nContext: ${input.context}\n${input.constraints ? `Constraints: ${input.constraints}\n` : ''}Done when: ${input.done_when}`
}

export function argv(root: string, input: Input, cwd: string): string[] {
  const args = [`${root}/bin/workhorse`, '--detach']
  if (input.resume) {
    args.push('-r', input.resume)
    if (input.to_code) args.push('--code')
  } else {
    args.push(...(input.worktree ? ['-w', input.worktree] : ['-C', input.dir || cwd]))
    args.push(`--${input.mode ?? 'code'}`)
    if (input.name) args.push('-n', input.name)
  }
  if (input.effort) args.push('-e', input.effort)
  if (input.model) args.push('-m', input.model)
  return args
}

export function environment(options: PluginOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['model_code', 'model_review', 'model_ops', 'effort_code', 'effort_review', 'effort_ops', 'fast_match', 'disable_mcp', 'lang']) {
    if (options[key] !== '') env[`WORKHORSE_${key.toUpperCase()}`] = String(options[key])
  }
  env.WORKHORSE_ALLOW_OPS = options.allow_ops ? '1' : '0'
  return env
}

export function started(output: string): { name: string; path: string } {
  const match = /^started (\S+) (.+)$/m.exec(output)!
  return { name: match[1]!, path: match[2]! }
}
