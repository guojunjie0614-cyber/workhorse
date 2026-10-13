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
  elapsed_min: number
  idle_min: number
  cmds: number
  tests: number
  tokens: number
  report: string
}

export function jobRows(output: string): { name: string; label: string }[] {
  return output.split('\n').filter(line => line.trim()).map(line => ({ name: line.trim().split(/\s+/)[0]!, label: line.trim() }))
}

export function statusLine(status: Status): string {
  return `${status.name} · ${status.mode} · ${status.elapsed_min}m · cmds ${status.cmds} · tests ${status.tests} · idle ${status.idle_min}m`
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
