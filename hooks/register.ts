import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { argv, brief, environment, jobRows, lint, panelLines, started, toolLine } from './lib'
import type { Input, Job, PanelTask, Status } from './lib'

async function refreshPane($: EngineInterface, options: PluginOptions) {
  const state = sessionState(await $.session.id())
  const list = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-l'], { env: environment(options) })
  state.recentJobs = jobRows(list.stdout)
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
  return list.stdout + list.stderr
}

async function openPane($: EngineInterface, options: PluginOptions) {
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
  const session = await $.session.id()
  const now = await $.clock.now()
  const owned: [string, Job][] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('job:')) continue
    const job = await $.store.get(key) as Job | undefined
    if (job?.session === session) owned.push([key, job])
  }
  if (!owned.length) {
    state.statuses = state.statuses.filter(status => status.completedAt !== undefined && now - status.completedAt < 180000)
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
      return previous.completedAt !== undefined && now - previous.completedAt < 180000 ? [previous] : []
    }),
    ...fresh.filter(status => !state.statuses.some(previous => previous.name === status.name)),
  ]
  $.ui.invalidate('ui.render')
  if (polled.some(status => status.state === 'running')) {
    state.ticking ??= $.clock.every(250, async () => {
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
      if (status.state === 'missing') {
        if (!await $.store.get(key)) continue
        await $.store.delete(key)
        void $.prompt.submit({ text: `workhorse: job ${job.name} 记录已丢失` })
      } else if (status.state === 'done' || status.state === 'dead') {
        const fullReport = status.state === 'done' ? await $.fs.read(`${status.path}/report.txt`) : ''
        const report = fullReport.slice(0, 6000) + (fullReport.length > 6000 ? `\n已截断，完整报告见 ${status.path}/report.txt` : '')
        const reminder = status.state === 'dead'
          ? `用 workhorse -t ${job.name} 看日志`
          : status.mode === 'review'
            ? `核对结论和证据；要修复就用 resume ${status.base} + to_code 交回`
            : status.mode === 'ops'
              ? '核对产物和远端状态，不要重复执行部署'
              : `对照 brief 读 diff，自己运行 ${job.doneWhen}；要修复就用 mcp__workhorse__run 工具 resume ${status.base} 交回`
        if (!await $.store.get(key)) continue
        await $.store.delete(key)
        void $.prompt.submit({ text: `workhorse: job ${job.name} finished\n${report}\n${reminder}` })
      } else if (status.state === 'running') {
        if (!status.busy && status.idle_min >= Number(options.stall_minutes) && !job.warnedStall) {
          job.warnedStall = true
          const text = `workhorse: job ${job.name} 已 ${status.idle_min} 分钟无输出，用 workhorse -t ${job.name} 查看，卡住就 workhorse -k ${job.name} 后把 brief 缩小重派`
          await $.ui.toast(text)
          void $.prompt.submit({ text })
        }
        if (status.tests > Number(options.max_tests) && !job.warnedTests) {
          job.warnedTests = true
          const text = `workhorse: job ${job.name} 已运行 ${status.tests} 次测试，超过 max_tests=${options.max_tests}；用 workhorse -t ${job.name} 查看，停止重复测试，必要时 workhorse -k ${job.name} 后缩小 brief 重派`
          await $.ui.toast(text)
          void $.prompt.submit({ text })
        }
        if (await $.store.get(key)) await $.store.set(key, job)
      }
    } catch (error) {
      await $.ui.toast(`workhorse: job ${job.name} 状态处理失败：${String(error)}`)
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
      description: '让 Codex 启动一个后台 job，一个 job 只做一个改动。调用后立即返回，报告会以 workhorse 消息的形式送达，不要轮询。根因不明时先用 mode=review，再用 resume + to_code 转成修复。brief 里不要写 baseline 或全量测试。',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string' }, context: { type: 'string' }, done_when: { type: 'string' },
          constraints: { type: 'string' }, mode: { type: 'string', enum: ['code', 'review', 'ops'], default: 'code' },
          dir: { type: 'string' }, worktree: { type: 'string' }, name: { type: 'string' }, resume: { type: 'string' },
          to_code: { type: 'boolean' }, effort: { type: 'string', enum: ['low', 'medium', 'high'] }, model: { type: 'string' },
        },
        required: ['goal', 'context', 'done_when'],
      },
    })
    await $.command.register({ name: 'workhorse-jobs', description: 'Open and list Codex jobs', immediate: true })
    await $.command.register({ name: 'workhorse-kill', description: 'Kill a Codex job', argumentHint: '<name>', immediate: true })
    $.clock.every(30000, () => pollOnce($, options))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    const lines = panelLines(sessionState(await $.session.id()).statuses, now, e.props.bodyColumns)
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
        Button({ key: 'refresh', label: '刷新', onPress: () => {} }),
      ] }),
      Text({ color: 'text', bold: true, children: selectedJob }),
      Text({ color: 'text', children: jobOutput }),
    ] })
  })

  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.props.tool !== 'mcp__workhorse__run') return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ color: 'text', wrap: 'truncate-end', children: toolLine(e.props.input as Input) })
  })

  on('ui.press', { plugin: 'workhorse' }, async ($, e, next) => {
    if (e.element.startsWith('select:')) {
      sessionState(await $.session.id()).selectedJob = e.element.slice(7)
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
      ? { decision: 'ask', reason: 'ops job runs Codex with full access outside the repo' }
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
    return { result: [`started ${job.name}; 报告会以 workhorse 消息送达，不要轮询。`, ...warnings].join('\n') }
  })

  on('command.run', { command: 'workhorse-jobs' }, async $ => {
    return { text: await openPane($, options) }
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
      if (!names.length) return { text: '本会话没有运行中的 workhorse 任务。' }
      const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-s', ...names], { env: environment(options) })
      const running = (JSON.parse(result.stdout) as Status[]).filter(status => status.state === 'running')
      if (!running.length) return { text: '本会话没有运行中的 workhorse 任务。' }
      if (running.length > 1) return { text: `本会话有多个运行中的任务，请用 /workhorse-kill <name> 指名：\n${running.map(status => status.name).join('\n')}` }
      name = running[0]!.name
    }
    const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-k', name], { env: environment(options) })
    return { text: result.stdout + result.stderr }
  })
}
