import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { argv, brief, environment, jobRows, lint, started, statusLine, toolLine } from './lib'
import type { Input, Job, Status } from './lib'

let statuses: Status[] = []
let recentJobs: { name: string; label: string }[] = []
let selectedJob = ''
let jobOutput = ''

async function refreshPane($: EngineInterface, options: PluginOptions) {
  const list = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-l'], { env: environment(options) })
  recentJobs = jobRows(list.stdout)
  if (!selectedJob && recentJobs.length) selectedJob = recentJobs[0]!.name
  jobOutput = list.stderr
  if (selectedJob) {
    const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-s', selectedJob], { env: environment(options) })
    const [status] = JSON.parse(result.stdout) as Status[]
    if (status!.state === 'done') {
      jobOutput = await $.fs.read(`${status!.path}/report.txt`)
    } else {
      const log = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-t', selectedJob], { env: environment(options) })
      jobOutput = log.stdout + log.stderr
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

async function stopJob($: EngineInterface, options: PluginOptions, name: string) {
  const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-k', name], { env: environment(options) })
  await $.ui.toast(result.stdout + result.stderr)
}

async function poll($: EngineInterface, options: PluginOptions) {
  const session = await $.session.id()
  const owned: [string, Job][] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('job:')) continue
    const job = await $.store.get(key) as Job | undefined
    if (job?.session === session) owned.push([key, job])
  }
  if (!owned.length) {
    statuses = []
    $.ui.invalidate('ui.render')
    return
  }
  const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-s', ...owned.map(([, job]) => job.name)], { env: environment(options) })
  const polled = JSON.parse(result.stdout) as Status[]
  statuses = polled
  $.ui.invalidate('ui.render')
  for (const [key, job] of owned) {
    try {
      const status = polled.find(s => s.name === job.name)!
      if (status.state === 'missing') {
        if (!await $.store.get(key)) continue
        await $.store.delete(key)
        void $.prompt.submit({ text: `workhorse: job ${job.name} 记录已丢失` })
      } else if (status.state === 'done' || status.state === 'dead') {
        const report = status.state === 'done' ? (await $.fs.read(`${key.slice(4)}/report.txt`)).slice(0, 6000) : ''
        const reminder = status.state === 'dead'
          ? `用 workhorse -t ${job.name} 看日志`
          : status.mode === 'review'
            ? '核对结论和证据；要修复就用 resume + to_code 交回'
            : `对照 brief 读 diff，自己运行 ${job.doneWhen}；要修复就用 mcp__workhorse__run 工具 resume ${job.name} 交回`
        if (!await $.store.get(key)) continue
        await $.store.delete(key)
        void $.prompt.submit({ text: `workhorse: job ${job.name} finished\n${report}\n${reminder}` })
      } else if (status.state === 'running') {
        if (status.idle_min >= Number(options.stall_minutes) && !job.warnedStall) {
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
    let polling = false
    $.clock.every(30000, async () => {
      if (polling) return
      polling = true
      try {
        await poll($, options)
      } finally {
        polling = false
      }
    })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    const running = statuses.filter(status => status.state === 'running')
    if (!running.length) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: running.map(status => Box({
      flexDirection: 'row', gap: 1, children: [
        Text({ color: status.idle_min >= Number(options.stall_minutes) || status.tests > Number(options.max_tests) ? 'error' : 'text', children: statusLine(status) }),
        Button({ key: `logs:${status.name}`, label: '日志', onPress: () => {} }),
        Button({ key: `stop:${status.name}`, label: '停止', onPress: () => {} }),
      ],
    })) })
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== 'workhorse') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [
      ...recentJobs.map(job => Button({ key: `select:${job.name}`, label: `${job.name === selectedJob ? '▸ ' : ''}${job.label}`, onPress: () => {} })),
      Box({ flexDirection: 'row', gap: 1, children: [
        Button({ key: 'refresh', label: '刷新', onPress: () => {} }),
        ...(selectedJob ? [Button({ key: `stop:${selectedJob}`, label: '停止', onPress: () => {} })] : []),
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
    if (e.element.startsWith('logs:')) {
      selectedJob = e.element.slice(5)
      await openPane($, options)
    } else if (e.element.startsWith('select:')) {
      selectedJob = e.element.slice(7)
      await refreshPane($, options)
    } else if (e.element.startsWith('stop:')) {
      await stopJob($, options, e.element.slice(5))
      if (e.component === 'Pane') await refreshPane($, options)
    } else if (e.element === 'refresh') {
      await refreshPane($, options)
    } else {
      return next(e)
    }
    return { element: e.element }
  })

  on('tool.check', { tool: 'mcp__workhorse__run' }, ($, e) => (e.input as Input).mode === 'ops'
    ? { decision: 'ask', reason: 'ops job runs Codex with full access outside the repo' }
    : { decision: 'allow' })

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
    return { result: `started ${job.name}; 报告会以 workhorse 消息送达，不要轮询。` }
  })

  on('command.run', { command: 'workhorse-jobs' }, async $ => {
    return { text: await openPane($, options) }
  })
  on('command.run', { command: 'workhorse-kill' }, async ($, e) => {
    const result = await $.process.run([`${$.plugin.root}/bin/workhorse`, '-k', e.args.trim()], { env: environment(options) })
    return { text: result.stdout + result.stderr }
  })
}
