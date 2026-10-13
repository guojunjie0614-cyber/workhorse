import type { PluginOptions } from 'claude-code'

// Seconds between job status polls.
export const POLL_SECONDS = 30
// Minutes to keep finished jobs visible while other jobs run.
export const DONE_LINGER_MINUTES = 3
// Maximum terminal columns for each job goal.
export const GOAL_COLUMNS = 40
// Maximum report characters included in completion notices.
export const REPORT_MAX_CHARS = 6000

export const FRAME_MS = 250
export const SPINNER_FRAMES = Array.from('·✢✳✶✻✽')
export const MIN_GOAL_COLUMNS = 10
export const TOOL_LINE_GOAL_CHARS = 80
export const DEFAULT_TERMINAL_COLUMNS = 120
export const MS_PER_SECOND = 1000
export const SECONDS_PER_MINUTE = 60
export const MINUTES_PER_HOUR = 60
export const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE
export const TIME_DIGITS = 2
export const NEGATION_WINDOW = 5
export const NEGATIONS = ['不', '没', '无', '别', '勿', '禁止', '\\bno\\b', '\\bnot\\b', "\\bdon't\\b", '\\bwithout\\b', '\\bavoid\\b', '\\bskip\\b']

// The band keeps Claude's own agents-panel wording.
const PANEL_TEXT = {
  working: 'Working…',
  summary: (total: number, running: number, done: number, failed: number, cancelled: number) => `${total} agents · ${running} running · ${done} done${failed ? ` · ${failed} failed` : ''}${cancelled ? ` · ${cancelled} cancelled` : ''}`,
  states: { running: 'running', done: 'done', dead: 'dead', missing: 'missing', failed: 'failed', cancelled: 'cancelled' },
  busy: (minutes: number, command: string) => `running ${minutes}m: ${command}`,
  activity: (activity: string, cmds: number, files: number) => `${activity} · ${cmds} cmds · ${files} files`,
}

export const MESSAGES = {
  missing: (name: string) => `workhorse: job ${name} 记录已丢失`,
  truncated: (path: string) => `\n已截断，完整报告见 ${path}/report.txt`,
  deadReminder: (name: string) => `用 workhorse -t ${name} 看日志`,
  cancelledReminder: (name: string) => `任务已取消；用 workhorse -t ${name} 查看停止前的日志`,
  repeated: (name: string, repeat: number, command: string) => `workhorse: job ${name} 原地打转：相同命令和退出码已连续出现 ${repeat} 次：${command}；请检查执行方向，仅提醒，不会自动终止`,
  familyTokens: (name: string, tokens: number) => `workhorse: job ${name} 家族累计已使用 ${tokens} token；请检查剩余工作和预算`,
  reviewReminder: (base: string) => `核对结论和证据；要修复就用 resume ${base} + to_code 交回`,
  opsReminder: '核对产物和远端状态，不要重复执行部署',
  codeReminder: (doneWhen: string, base: string) => `对照 brief 读 diff，自己运行 ${doneWhen}；要修复就用 mcp__workhorse__run 工具 resume ${base} 交回`,
  finished: (name: string, report: string, reminder: string) => `workhorse: job ${name} 已结束\n${report}\n${reminder}`,
  stalled: (name: string, minutes: number) => `workhorse: job ${name} 已 ${minutes} 分钟无输出，用 workhorse -t ${name} 查看，卡住就 workhorse -k ${name} 后把 brief 缩小重派`,
  longCommand: (name: string, minutes: number, command: string) => `workhorse: job ${name} 的命令已运行 ${minutes} 分钟：${command}；用 workhorse -t ${name} 查看，仅提醒，不会自动终止`,
  excessTests: (name: string, tests: number, max: number) => `workhorse: job ${name} 已运行 ${tests} 次测试，超过 max_tests=${max}；用 workhorse -t ${name} 查看，停止重复测试，必要时 workhorse -k ${name} 后缩小 brief 重派`,
  statusError: (name: string, error: string) => `workhorse: job ${name} 状态处理失败：${error}`,
  runDescription: '让 Codex 启动一个后台 job，一个 job 只做一个改动。调用后立即返回，报告会以 workhorse 消息的形式送达，不要轮询。根因不明时先用 mode=review，再用 resume + to_code 转成修复。brief 里不要写 baseline 或全量测试。',
  effortDescription: '推理强度字符串；常用值为 low、medium、high。',
  killDescription: '终止一个 Codex 任务',
  killArgumentHint: '<任务名>',
  opsPermission: 'ops 任务让 Codex 在仓库外以完整权限运行',
  launched: (name: string) => `已启动 ${name}；报告会以 workhorse 消息送达，不要轮询。`,
  noRunning: '本会话没有运行中的 workhorse 任务。',
  multipleRunning: (names: string[]) => `本会话有多个运行中的任务，请用 /workhorse-kill <name> 指名：\n${names.join('\n')}`,
  missingDoneWhen: 'done_when 必须填写明确的完成条件',
  bannedPhrase: (field: string, phrase: string) => `${field} 含禁用词：${phrase}`,
  ...PANEL_TEXT,
  auto: '自动',
  defaultEffort: '默认',
}

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
  effort?: string
  model?: string
}

export type Job = {
  name: string
  session: string
  goal: string
  doneWhen: string
  warnedStall: boolean
  warnedTests: boolean
  warnedBusy?: string
  warnedRepeat?: string[]
  warnedFamilyTokens?: boolean
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
  idle_min: number
  cmds: number
  activity: string
  files: number
  tests: number
  cancelled: boolean
  repeat: number
  repeat_cmd: string
  family_tokens: number
}

export type PanelTask = Status & { goal: string; completedAt?: number }
type Segment = { children: string; color?: 'claude' | 'success' | 'error' | 'inactive'; dimColor?: boolean }

export function panelLines(tasks: PanelTask[], now: number, columns = DEFAULT_TERMINAL_COLUMNS): Segment[][] {
  const visible = tasks.filter(task => task.state !== 'missing' && (task.completedAt === undefined || now - task.completedAt < DONE_LINGER_MINUTES * MS_PER_MINUTE))
  if (!visible.some(task => task.state === 'running')) return []
  const frame = Math.floor(now / FRAME_MS)
  const star = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!
  const running = visible.filter(task => task.state === 'running').length
  const nameWidth = Math.max(...visible.map(task => width(taskName(task))))
  const rows = visible.map((task, index) => taskLines(task, now, star, index === visible.length - 1, nameWidth))
  const remainingColumns = Math.min(...rows.map(([line]) => columns - line!.reduce((sum, segment) => sum + width(segment.children), 0)))
  const goalWidth = Math.max(MIN_GOAL_COLUMNS, Math.min(Math.max(...visible.map(task => width(headline(task.goal)))), GOAL_COLUMNS, remainingColumns))
  const done = visible.filter(task => !task.cancelled && task.state === 'done' && task.exit === 0).length
  const failed = visible.filter(task => !task.cancelled && (task.state === 'dead' || (task.state === 'done' && task.exit !== 0))).length
  const cancelled = visible.filter(task => task.cancelled).length
  return [
    [{ children: `${star} ${MESSAGES.working}`, color: 'claude' }],
    [{ children: MESSAGES.summary(visible.length, running, done, failed, cancelled), dimColor: true }],
    ...visible.flatMap((task, index) => taskLines(task, now, star, index === visible.length - 1, nameWidth, fit(headline(task.goal), goalWidth))),
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

// The band shows a goal's first clause; the full goal stays in the brief and the report.
function headline(text: string): string {
  return oneLine(text).split(/\s*[：:（(。；;]/)[0]!.trim() || oneLine(text)
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

function taskLines(status: PanelTask, now: number, star: string, last: boolean, nameWidth: number, goal = ''): Segment[][] {
  const seconds = Math.floor((status.completedAt ?? now) / MS_PER_SECOND - status.started)
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
  const elapsed = seconds < SECONDS_PER_MINUTE ? `${seconds}s`
    : minutes < MINUTES_PER_HOUR ? `${minutes}m${String(seconds % SECONDS_PER_MINUTE).padStart(TIME_DIGITS, '0')}s`
      : `${Math.floor(minutes / MINUTES_PER_HOUR)}h${String(minutes % MINUTES_PER_HOUR).padStart(TIME_DIGITS, '0')}m`
  const failed = !status.cancelled && (status.state === 'dead' || (status.state === 'done' && status.exit !== 0))
  return [
    [
      { children: last ? '└─ ' : '├─ ' },
      { children: status.cancelled ? '·' : status.state === 'running' ? star : failed ? '✗' : '✓', color: status.cancelled ? 'inactive' : failed ? 'error' : status.state === 'done' ? 'success' : 'claude' },
      { children: ` ${pad(taskName(status), nameWidth)}  ${goal}  ` },
      { children: pad(MESSAGES.states[status.cancelled ? 'cancelled' : failed ? 'failed' : status.state], Math.max(...Object.values(MESSAGES.states).map(width))), color: status.cancelled ? 'inactive' : failed ? 'error' : 'claude' },
      { children: `  ${elapsed}` },
    ],
    [{ children: `${last ? '   ' : '│  '}  ${MESSAGES.activity(status.busy ? MESSAGES.busy(status.busy_min, status.busy) : status.activity, status.cmds, status.files)}`, dimColor: true }],
  ]
}

export function toolLine(input: Input): string {
  return `workhorse ▸ ${input.name || input.resume || MESSAGES.auto} · ${input.mode ?? 'code'} · ${input.effort ?? MESSAGES.defaultEffort} — ${Array.from(input.goal).slice(0, TOOL_LINE_GOAL_CHARS).join('').replace(/\s+/g, ' ')}`
}

export function lint(input: Input, banned: string): string | undefined {
  const negation = new RegExp(`(?:${NEGATIONS.join('|')}).{0,${NEGATION_WINDOW}}$`, 'i')
  if (!input.done_when?.trim()) return MESSAGES.missingDoneWhen
  for (const phrase of banned.split(',').map(s => s.trim()).filter(Boolean)) {
    for (const field of ['goal', 'constraints', 'done_when'] as const) {
      const text = (input[field] ?? '').toLowerCase()
      let index = text.indexOf(phrase.toLowerCase())
      while (index !== -1) {
        if (!negation.test(text.slice(0, index))) return MESSAGES.bannedPhrase(field, phrase)
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

export const ENVIRONMENT_OPTIONS = {
  model_code: 'WORKHORSE_MODEL_CODE',
  model_review: 'WORKHORSE_MODEL_REVIEW',
  model_ops: 'WORKHORSE_MODEL_OPS',
  effort_code: 'WORKHORSE_EFFORT_CODE',
  effort_review: 'WORKHORSE_EFFORT_REVIEW',
  effort_ops: 'WORKHORSE_EFFORT_OPS',
  fast_match: 'WORKHORSE_FAST_MATCH',
  disable_mcp: 'WORKHORSE_DISABLE_MCP',
  allow_ops: 'WORKHORSE_ALLOW_OPS',
  keep_days: 'WORKHORSE_KEEP_DAYS',
  skip_skills: 'WORKHORSE_SKIP_SKILLS',
}

export function environment(options: PluginOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, variable] of Object.entries(ENVIRONMENT_OPTIONS)) {
    if (options[key] !== '' || key === 'skip_skills') env[variable] = typeof options[key] === 'boolean' ? (options[key] ? '1' : '0') : String(options[key])
  }
  return env
}

export function started(output: string): { name: string; path: string } {
  const match = /^started (\S+) (.+)$/m.exec(output)!
  return { name: match[1]!, path: match[2]! }
}
