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
  base: string
  round: number
  busy: string
  busy_min: number
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
  tests: number
  tokens: number
  report: string
}

export function jobRows(output: string): { name: string; label: string }[] {
  return output.split('\n').filter(line => line.trim()).map(line => ({ name: line.trim().split(/\s+/)[0]!, label: line.trim() }))
}

export type PanelTask = Status & { goal: string; completedAt?: number }
type Segment = { children: string; color?: 'claude' | 'success' | 'error' | 'inactive'; dimColor?: boolean }

export function panelLines(tasks: PanelTask[], now: number, columns = 120): Segment[][] {
  const visible = tasks.filter(task => task.state !== 'missing' && (task.completedAt === undefined || now - task.completedAt < 180000))
  if (!visible.some(task => task.state === 'running')) return []
  const frame = Math.floor(now / 250)
  const star = Array.from('·✢✳✶✻✽')[frame % 6]!
  const running = visible.filter(task => task.state === 'running').length
  const nameWidth = Math.max(...visible.map(task => width(taskName(task))))
  // Tree, star, gaps, state and elapsed take nameWidth + 25 cells; the goal gets the rest.
  const goalWidth = Math.max(10, Math.min(Math.max(...visible.map(task => width(oneLine(task.goal)))), columns - nameWidth - 25))
  const done = visible.filter(task => task.state === 'done' && task.exit === 0).length
  const failed = visible.filter(task => task.state === 'dead' || (task.state === 'done' && task.exit !== 0)).length
  return [
    [{ children: `${star} Working…`, color: 'claude' }],
    [{ children: `${visible.length} agents · ${running} running · ${done} done${failed ? ` · ${failed} failed` : ''}`, dimColor: true }],
    ...visible.flatMap((task, index) => taskLines(task, now, star, index === visible.length - 1, nameWidth, goalWidth)),
  ]
}

const wide = [[0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd]]

function charWidth(char: string): number {
  const code = char.codePointAt(0)!
  if (code < 0x20 || (code >= 0x300 && code <= 0x36f) || code === 0x200b) return 0
  return wide.some(([low, high]) => code >= low! && code <= high!) ? 2 : 1
}

function width(text: string): number {
  return Array.from(text).reduce((sum, char) => sum + charWidth(char), 0)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function fit(text: string, columns: number): string {
  const line = oneLine(text)
  return width(line) > columns ? pad(line, columns - 1) + '…' : pad(line, columns)
}

function pad(text: string, columns: number): string {
  let out = ''
  for (const char of text.replace(/\s+/g, ' ')) {
    if (width(out + char) > columns) break
    out += char
  }
  return out + ' '.repeat(columns - width(out))
}

function taskName(status: Status): string {
  return status.base + (status.round > 1 ? ` #${status.round}` : '')
}

function taskLines(status: PanelTask, now: number, star: string, last: boolean, nameWidth: number, goalWidth: number): Segment[][] {
  const seconds = Math.floor((status.completedAt ?? now) / 1000 - status.started)
  const minutes = Math.floor(seconds / 60)
  const elapsed = seconds < 60 ? `${seconds}s`
    : minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
      : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
  const failed = status.state === 'dead' || (status.state === 'done' && status.exit !== 0)
  return [
    [
      { children: last ? '└─ ' : '├─ ' },
      { children: status.state === 'running' ? star : failed ? '✗' : '✓', color: failed ? 'error' : status.state === 'done' ? 'success' : 'claude' },
      { children: ` ${pad(taskName(status), nameWidth)}  ${fit(status.goal, goalWidth)}  ` },
      { children: (failed ? 'failed' : status.state).padEnd(7), color: failed ? 'error' : 'claude' },
      { children: `  ${elapsed}` },
    ],
    [{ children: `${last ? '   ' : '│  '}  ${status.busy ? `running ${status.busy_min}m: ${status.busy}` : status.activity} · ${status.cmds} cmds · ${status.files} files`, dimColor: true }],
  ]
}

export function toolLine(input: Input): string {
  return `workhorse ▸ ${input.name || input.resume || 'auto'} · ${input.mode ?? 'code'} · ${input.effort ?? 'default'} — ${Array.from(input.goal).slice(0, 80).join('').replace(/\s+/g, ' ')}`
}

export function lint(input: Input, banned: string): string | undefined {
  if (!input.done_when?.trim()) return 'done_when 必须填写明确的完成条件'
  for (const phrase of banned.split(',').map(s => s.trim()).filter(Boolean)) {
    for (const field of ['goal', 'constraints', 'done_when'] as const) {
      const text = (input[field] ?? '').toLowerCase()
      let index = text.indexOf(phrase.toLowerCase())
      while (index !== -1) {
        if (!/(?:不|没|无|别|勿|禁止|\b(?:no|not|don't|without|avoid|skip)\b).{0,5}$/i.test(text.slice(0, index))) return `${field} 含禁用词：${phrase}`
        index = text.indexOf(phrase.toLowerCase(), index + phrase.length)
      }
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
    if (input.mode) args.push(`--${input.mode}`)
    else if (input.to_code) args.push('--code')
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
