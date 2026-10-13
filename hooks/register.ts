import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { argv, brief, environment, DONE_LINGER_MINUTES, FRAME_MS, lint, MESSAGES, MS_PER_MINUTE, MS_PER_SECOND, panelLines, POLL_SECONDS, REPORT_MAX_CHARS, started, toolLine } from './lib'
import type { Input, Job, PanelTask, Status } from './lib'

// One module instance can serve several sessions, so all UI state is per session.
type SessionState = { statuses: PanelTask[]; ticking?: { cancel: () => void }; polling: boolean; pollAgain: boolean; seen: Map<string, string> }
const sessions = new Map<string, SessionState>()

function sessionState(id: string, reset = false): SessionState {
  let state = sessions.get(id)
  if (reset) state?.ticking?.cancel()
  if (!state || reset) {
    state = { statuses: [], polling: false, pollAgain: false, seen: new Map() }
    sessions.set(id, state)
  }
  return state
}

async function pollOnce($: EngineInterface, options: PluginOptions) {
  const state = sessionState(await $.session.id())
  if (state.polling) {
    state.pollAgain = true
    return
  }
  state.polling = true
  try {
    do {
      state.pollAgain = false
      await poll($, options, state)
    } while (state.pollAgain)
  } catch (error) {
    state.ticking?.cancel()
    state.ticking = undefined
    throw error
  } finally {
    state.polling = false
  }
}

async function poll($: EngineInterface, options: PluginOptions, state: SessionState) {
  const lingerMs = DONE_LINGER_MINUTES * MS_PER_MINUTE
  const session = await $.session.id()
  const now = await $.clock.now()
  const owned: [string, Job][] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('job:')) continue
    const job = await $.store.get(key) as Job | undefined
    if (job?.session === session) owned.push([key, job])
  }
  if (!owned.length) {
    state.statuses = state.statuses.filter(status => status.completedAt !== undefined && now - status.completedAt < lingerMs)
    state.ticking?.cancel()
    state.ticking = undefined
    $.ui.invalidate('ui.render')
    return
  }
  const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-s', ...owned.map(([, job]) => job.name)], { env: environment(options) })
  const polled = JSON.parse(result.stdout) as Status[]
  const fresh = polled.filter(status => status.state !== 'missing').map(status => ({
    ...status,
    goal: owned.find(([, job]) => job.name === status.name)![1].goal,
    completedAt: status.state === 'done' || status.state === 'dead'
      ? state.statuses.find(previous => previous.name === status.name)?.completedAt ?? now
      : undefined,
  }))
  state.statuses = [
    ...state.statuses.flatMap(previous => {
      const current = fresh.find(status => status.name === previous.name)
      if (current) return [current]
      return previous.completedAt !== undefined && now - previous.completedAt < lingerMs ? [previous] : []
    }),
    ...fresh.filter(status => !state.statuses.some(previous => previous.name === status.name)),
  ]
  $.ui.invalidate('ui.render')
  if (polled.some(status => status.state === 'running')) {
    state.ticking ??= $.clock.every(FRAME_MS, async () => {
      $.ui.invalidate('ui.render')
      for (const status of state.statuses) {
        if (status.state !== 'running') continue
        const stat = await $.fs.stat(`${status.path}/events.jsonl`).catch(() => undefined)
        const mark = stat && `${stat.mtimeMs}:${stat.size}`
        const changed = mark !== undefined && mark !== state.seen.get(status.name)
        if (mark) state.seen.set(status.name, mark)
        if (changed || await $.fs.exists(`${status.path}/report.txt`)) {
          void pollOnce($, options)
          return
        }
      }
    })
  } else {
    state.ticking?.cancel()
    state.ticking = undefined
  }
  for (const [key, job] of owned) {
    try {
      const status = polled.find(s => s.name === job.name)!
      if (status.family_tokens >= Number(options.family_tokens_warn) && !job.warnedFamilyTokens) {
        const text = MESSAGES.familyTokens(job.name, status.family_tokens)
        await $.ui.toast(text)
        await $.prompt.submit({ text })
        job.warnedFamilyTokens = true
        await $.store.set(key, job)
      }
      if (status.state === 'missing') {
        if (!await $.store.get(key)) continue
        await $.prompt.submit({ text: MESSAGES.missing(job.name) })
        await $.store.delete(key)
      } else if (status.state === 'done' || status.state === 'dead') {
        const fullReport = status.state === 'done' ? await $.fs.read(`${status.path}/report.txt`) : ''
        const report = fullReport.slice(0, REPORT_MAX_CHARS) + (fullReport.length > REPORT_MAX_CHARS ? MESSAGES.truncated(status.path) : '')
        const reminder = status.cancelled
          ? MESSAGES.cancelledReminder(job.name)
          : status.state === 'dead'
          ? MESSAGES.deadReminder(job.name)
          : status.mode === 'review'
            ? MESSAGES.reviewReminder(status.base)
            : status.mode === 'ops'
              ? MESSAGES.opsReminder
              : MESSAGES.codeReminder(job.doneWhen, status.base)
        if (!await $.store.get(key)) continue
        await $.prompt.submit({ text: MESSAGES.finished(job.name, report, reminder) })
        await $.store.delete(key)
      } else if (status.state === 'running') {
        if (status.repeat >= Number(options.repeat_limit) && !job.warnedRepeat?.includes(status.repeat_cmd)) {
          const text = MESSAGES.repeated(job.name, status.repeat, status.repeat_cmd)
          await $.ui.toast(text)
          await $.prompt.submit({ text })
          job.warnedRepeat = [...(job.warnedRepeat ?? []), status.repeat_cmd]
          await $.store.set(key, job)
        }
        if (status.busy && status.busy_min >= Number(options.command_minutes) && job.warnedBusy !== status.busy) {
          const text = MESSAGES.longCommand(job.name, status.busy_min, status.busy)
          await $.ui.toast(text)
          await $.prompt.submit({ text })
          job.warnedBusy = status.busy
        }
        if (!status.busy && status.idle_min >= Number(options.stall_minutes) && !job.warnedStall) {
          job.warnedStall = true
          const text = MESSAGES.stalled(job.name, status.idle_min)
          await $.ui.toast(text)
          void $.prompt.submit({ text })
        }
        if (status.tests > Number(options.max_tests) && !job.warnedTests) {
          job.warnedTests = true
          const text = MESSAGES.excessTests(job.name, status.tests, Number(options.max_tests))
          await $.ui.toast(text)
          void $.prompt.submit({ text })
        }
        if (await $.store.get(key)) await $.store.set(key, job)
      }
    } catch (error) {
      await $.ui.toast(MESSAGES.statusError(job.name, String(error)))
    }
  }
}

export const register: Register = (on, options) => {
  on('agent.offer', ($, e, next) => {
    if (options.hide_codex_rescue && e.agent === 'codex:codex-rescue') return { isOffered: false }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    sessionState(await $.session.id(), true)
    await $.tool.register({
      name: 'run',
      description: MESSAGES.runDescription,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string' }, context: { type: 'string' }, done_when: { type: 'string' },
          constraints: { type: 'string' }, mode: { type: 'string', enum: ['code', 'review', 'ops'], default: 'code' },
          dir: { type: 'string' }, worktree: { type: 'string' }, name: { type: 'string' }, resume: { type: 'string' },
          to_code: { type: 'boolean' }, effort: { type: 'string', description: MESSAGES.effortDescription }, model: { type: 'string' },
        },
        required: ['goal', 'context', 'done_when'],
      },
    })
    await $.command.register({ name: 'workhorse-kill', description: MESSAGES.killDescription, argumentHint: MESSAGES.killArgumentHint, immediate: true })
    $.clock.every(POLL_SECONDS * MS_PER_SECOND, () => pollOnce($, options))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    const lines = panelLines(sessionState(await $.session.id()).statuses, now, e.props.bodyColumns)
    if (!lines.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: lines.map(line => Text({ wrap: 'truncate-end', children: line.map(segment => Text({ color: 'text', ...segment })) })) })
  })

  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.props.tool !== 'mcp__workhorse__run') return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ color: 'text', wrap: 'truncate-end', children: toolLine(e.props.input as Input) })
  })

  on('tool.check', { tool: 'mcp__workhorse__run' }, async ($, e) => {
    const input = e.input as Input
    let mode: string | undefined = input.mode ?? (input.to_code ? 'code' : undefined)
    if (!mode && input.resume) {
      // Fail closed: when the resumed job's mode can't be read, ask as for ops.
      const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-s', input.resume], { env: environment(options) })
      try {
        mode = (JSON.parse(result.stdout) as Status[])[0]?.mode ?? 'ops'
      } catch {
        mode = 'ops'
      }
    }
    return mode === 'ops'
      ? { decision: 'ask', reason: MESSAGES.opsPermission }
      : { decision: 'allow' }
  })

  on('tool.call', { tool: 'mcp__workhorse__run' }, async ($, e) => {
    const { tool, tool_use_id, agentId, ...args } = e
    const input = args as Input
    const deny = lint(input, String(options.banned_phrases))
    if (deny) return { deny }
    const cwd = input.dir || await $.session.cwd()
    const result = await $.process.run(argv($.plugin.root, input, cwd), { cwd, env: environment(options), stdin: brief(input) })
    if (result.exitCode !== 0) return { result: result.stderr }
    const job = started(result.stdout)
    await $.store.set(`job:${job.path}`, { name: job.name, session: await $.session.id(), goal: input.goal, doneWhen: input.done_when, warnedStall: false, warnedTests: false })
    void pollOnce($, options)
    const lines = result.stdout.split('\n')
    const warnings = lines.slice(lines.findIndex(line => line.startsWith('started ')) + 1).filter(line => line.startsWith('warning:'))
    return { result: [MESSAGES.launched(job.name), ...warnings].join('\n') }
  })

  on('command.run', { command: 'workhorse-kill' }, async ($, e) => {
    let name = e.args.trim()
    if (!name) {
      const session = await $.session.id()
      const names: string[] = []
      for (const key of await $.store.keys()) {
        if (!key.startsWith('job:')) continue
        const job = await $.store.get(key) as Job
        if (job.session === session) names.push(job.name)
      }
      if (!names.length) return { text: MESSAGES.noRunning }
      const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-s', ...names], { env: environment(options) })
      const running = (JSON.parse(result.stdout) as Status[]).filter(status => status.state === 'running')
      if (!running.length) return { text: MESSAGES.noRunning }
      if (running.length > 1) return { text: MESSAGES.multipleRunning(running.map(status => status.name)) }
      name = running[0]!.name
    }
    const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-k', name], { env: environment(options) })
    return { text: result.stdout + result.stderr }
  })
}
