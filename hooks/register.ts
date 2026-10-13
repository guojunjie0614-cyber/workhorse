import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { argv, brief, environment, FRAME_MS, jobRows, MS_PER_DAY, lint, messages, MS_PER_MINUTE, MS_PER_SECOND, panelLines, started, toolLine } from './lib'
import type { Input, Job, PanelTask, Status } from './lib'

async function refreshPane($: EngineInterface, options: PluginOptions) {
  const session = await $.session.id()
  const state = sessionState(session)
  const list = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-l'], { env: environment(options) })
  const prefix = `unread:${session}:`
  const unread = (await $.store.keys()).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
  state.recentJobs = jobRows(list.stdout, unread)
  if (!state.selectedJob && state.recentJobs.length) state.selectedJob = state.recentJobs[0]!.name
  state.jobOutput = list.stderr
  if (state.selectedJob) {
    const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-s', state.selectedJob], { env: environment(options) })
    const [status] = JSON.parse(result.stdout) as Status[]
    if (status!.state === 'done') {
      state.jobOutput = await $.fs.read(`${status!.path}/report.txt`)
    } else {
      const log = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-t', state.selectedJob], { env: environment(options) })
      state.jobOutput = log.stdout + log.stderr
    }
  }
  $.ui.invalidate('ui.render')
  return state.recentJobs.map(job => job.label).join('\n') + list.stderr
}

async function openPane($: EngineInterface, options: PluginOptions, name: string) {
  if (name) {
    const session = await $.session.id()
    sessionState(session).selectedJob = name
    await $.store.delete(`unread:${session}:${name}`)
  }
  const text = await refreshPane($, options)
  await $.ui.open({ id: 'workhorse', title: 'workhorse', focus: true })
  return text
}

// One module instance can serve several sessions, so all UI state is per session.
type SessionState = { statuses: PanelTask[]; ticking?: { cancel: () => void }; polling: boolean; pollAgain: boolean; seen: Map<string, string>; recentJobs: { name: string; label: string }[]; selectedJob: string; jobOutput: string }
const sessions = new Map<string, SessionState>()

function sessionState(id: string, reset = false): SessionState {
  let state = sessions.get(id)
  if (reset) state?.ticking?.cancel()
  if (!state || reset) {
    state = { statuses: [], polling: false, pollAgain: false, seen: new Map(), recentJobs: [], selectedJob: '', jobOutput: '' }
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
  const copy = messages(String(options.lang))
  const lingerMs = Number(options.done_linger_minutes) * MS_PER_MINUTE
  const reportMaxChars = Number(options.report_max_chars)
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
        const text = copy.familyTokens(job.name, status.family_tokens)
        await $.ui.toast(text)
        await $.prompt.submit({ text })
        job.warnedFamilyTokens = true
        await $.store.set(key, job)
      }
      if (status.state === 'missing') {
        if (!await $.store.get(key)) continue
        await $.prompt.submit({ text: copy.missing(job.name) })
        await $.store.delete(key)
      } else if (status.state === 'done' || status.state === 'dead') {
        const fullReport = status.state === 'done' ? await $.fs.read(`${status.path}/report.txt`) : ''
        const report = fullReport.slice(0, reportMaxChars) + (fullReport.length > reportMaxChars ? copy.truncated(status.path) : '')
        const reminder = status.cancelled
          ? copy.cancelledReminder(job.name)
          : status.state === 'dead'
          ? copy.deadReminder(job.name)
          : status.mode === 'review'
            ? copy.reviewReminder(status.base)
            : status.mode === 'ops'
              ? copy.opsReminder
              : copy.codeReminder(job.doneWhen, status.base)
        if (!await $.store.get(key)) continue
        await $.prompt.submit({ text: copy.finished(job.name, report, reminder) })
        await $.store.set(`unread:${session}:${job.name}`, now)
        await $.store.delete(key)
      } else if (status.state === 'running') {
        if (status.repeat >= Number(options.repeat_limit) && !job.warnedRepeat?.includes(status.repeat_cmd)) {
          const text = copy.repeated(job.name, status.repeat, status.repeat_cmd)
          await $.ui.toast(text)
          await $.prompt.submit({ text })
          job.warnedRepeat = [...(job.warnedRepeat ?? []), status.repeat_cmd]
          await $.store.set(key, job)
        }
        if (status.busy && status.busy_min >= Number(options.command_minutes) && job.warnedBusy !== status.busy) {
          const text = copy.longCommand(job.name, status.busy_min, status.busy)
          await $.ui.toast(text)
          await $.prompt.submit({ text })
          job.warnedBusy = status.busy
        }
        if (!status.busy && status.idle_min >= Number(options.stall_minutes) && !job.warnedStall) {
          job.warnedStall = true
          const text = copy.stalled(job.name, status.idle_min)
          await $.ui.toast(text)
          void $.prompt.submit({ text })
        }
        if (status.tests > Number(options.max_tests) && !job.warnedTests) {
          job.warnedTests = true
          const text = copy.excessTests(job.name, status.tests, Number(options.max_tests))
          await $.ui.toast(text)
          void $.prompt.submit({ text })
        }
        if (await $.store.get(key)) await $.store.set(key, job)
      }
    } catch (error) {
      await $.ui.toast(copy.statusError(job.name, String(error)))
    }
  }
}

export const register: Register = (on, options) => {
  const copy = messages(String(options.lang))
  on('agent.offer', ($, e, next) => {
    if (options.hide_codex_rescue && e.agent === 'codex:codex-rescue') return { isOffered: false }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    sessionState(await $.session.id(), true)
    // Unread marks are written per session and outlive it; drop them with the job history.
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (key.startsWith('unread:') && !(now - Number(await $.store.get(key)) < Number(options.keep_days) * MS_PER_DAY)) await $.store.delete(key)
    }
    await $.tool.register({
      name: 'run',
      description: copy.runDescription,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string' }, context: { type: 'string' }, done_when: { type: 'string' },
          constraints: { type: 'string' }, mode: { type: 'string', enum: ['code', 'review', 'ops'], default: 'code' },
          dir: { type: 'string' }, worktree: { type: 'string' }, name: { type: 'string' }, resume: { type: 'string' },
          to_code: { type: 'boolean' }, effort: { type: 'string', description: copy.effortDescription }, model: { type: 'string' },
        },
        required: ['goal', 'context', 'done_when'],
      },
    })
    await $.command.register({ name: 'workhorse-jobs', description: copy.jobsDescription, argumentHint: copy.jobsArgumentHint, immediate: true })
    await $.command.register({ name: 'workhorse-kill', description: copy.killDescription, argumentHint: copy.killArgumentHint, immediate: true })
    $.clock.every(Number(options.poll_seconds) * MS_PER_SECOND, () => pollOnce($, options))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    const lines = panelLines(sessionState(await $.session.id()).statuses, now, options, e.props.bodyColumns)
    if (!lines.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: lines.map(line => Text({ wrap: 'truncate-end', children: line.map(segment => Text({ color: 'text', ...segment })) })) })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'workhorse') return next(e)
    const { recentJobs, selectedJob, jobOutput } = sessionState(await $.session.id())
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [
      ...recentJobs.map(job => Button({ key: `select:${job.name}`, label: `${job.name === selectedJob ? '▸ ' : ''}${job.label}`, onPress: () => {} })),
      Box({ flexDirection: 'row', gap: 1, children: [
        Button({ key: 'refresh', label: copy.refresh, onPress: () => {} }),
      ] }),
      Text({ color: 'text', bold: true, children: selectedJob }),
      Text({ color: 'text', children: jobOutput }),
    ] })
  })

  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.props.tool !== 'mcp__workhorse__run') return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ color: 'text', wrap: 'truncate-end', children: toolLine(e.props.input as Input, String(options.lang)) })
  })

  on('ui.press', { plugin: 'workhorse' }, async ($, e, next) => {
    if (e.element.startsWith('select:')) {
      const session = await $.session.id()
      const name = e.element.slice('select:'.length)
      sessionState(session).selectedJob = name
      await $.store.delete(`unread:${session}:${name}`)
      await refreshPane($, options)
    } else if (e.element === 'refresh') {
      await refreshPane($, options)
    } else {
      return next(e)
    }
    return { element: e.element }
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
      ? { decision: 'ask', reason: copy.opsPermission }
      : { decision: 'allow' }
  })

  on('tool.call', { tool: 'mcp__workhorse__run' }, async ($, e) => {
    const { tool, tool_use_id, agentId, ...args } = e
    const input = args as Input
    const deny = lint(input, String(options.banned_phrases), String(options.lang))
    if (deny) return { deny }
    const cwd = input.dir || await $.session.cwd()
    const result = await $.process.run(argv($.plugin.root, input, cwd), { cwd, env: environment(options), stdin: brief(input) })
    if (result.exitCode !== 0) return { result: result.stderr }
    const job = started(result.stdout)
    await $.store.set(`job:${job.path}`, { name: job.name, session: await $.session.id(), goal: input.goal, doneWhen: input.done_when, warnedStall: false, warnedTests: false })
    void pollOnce($, options)
    const lines = result.stdout.split('\n')
    const warnings = lines.slice(lines.findIndex(line => line.startsWith('started ')) + 1).filter(line => line.startsWith('warning:'))
    return { result: [copy.launched(job.name), ...warnings].join('\n') }
  })

  on('command.run', { command: 'workhorse-jobs' }, async ($, e) => {
    return { text: await openPane($, options, e.args.trim()) }
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
      if (!names.length) return { text: copy.noRunning }
      const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-s', ...names], { env: environment(options) })
      const running = (JSON.parse(result.stdout) as Status[]).filter(status => status.state === 'running')
      if (!running.length) return { text: copy.noRunning }
      if (running.length > 1) return { text: copy.multipleRunning(running.map(status => status.name)) }
      name = running[0]!.name
    }
    const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-k', name], { env: environment(options) })
    return { text: result.stdout + result.stderr }
  })
}
