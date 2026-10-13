import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { argv, brief, environment, lint, started } from './lib'
import type { Input, Job, Status } from './lib'

async function poll($: EngineInterface, options: PluginOptions) {
  const session = await $.session.id()
  const jobs = (await $.store.get('jobs') ?? {}) as Record<string, Job>
  const owned = Object.entries(jobs).filter(([, job]) => job.session === session)
  if (!owned.length) {
    await $.ui.status(undefined)
    return
  }
  const result = await $.process.run([`${$.plugin.root}/bin/cx`, '-s', ...owned.map(([, job]) => job.name)], { env: environment(options) })
  const statuses = JSON.parse(result.stdout) as Status[]
  const running: string[] = []
  for (const [path, job] of owned) {
    try {
      const status = statuses.find(s => s.name === job.name)!
      if (status.state === 'missing') {
        const current = (await $.store.get('jobs')) as Record<string, Job>
        delete current[path]
        await $.store.set('jobs', current)
        void $.prompt.submit({ text: `workhorse: job ${job.name} 记录已丢失` })
      } else if (status.state === 'done' || status.state === 'dead') {
        const report = status.state === 'done' ? (await $.fs.read(`${path}/report.txt`)).slice(0, 6000) : ''
        const reminder = status.state === 'dead'
          ? `用 cx -t ${job.name} 看日志`
          : `对照 brief 读 diff，自己运行 ${job.doneWhen}；要修复就用 cx 工具 resume ${job.name} 交回`
        void $.prompt.submit({ text: `workhorse: job ${job.name} finished\n${report}\n${reminder}` })
        const current = (await $.store.get('jobs')) as Record<string, Job>
        delete current[path]
        await $.store.set('jobs', current)
      } else if (status.state === 'running') {
        running.push(`${job.name} ${status.elapsed_min}m tests ${status.tests}`)
        if (status.idle_min >= Number(options.stall_minutes) && !job.warnedStall) {
          job.warnedStall = true
          const text = `workhorse: job ${job.name} 已 ${status.idle_min} 分钟无输出，用 cx -t ${job.name} 查看，卡住就 cx -k ${job.name} 后把 brief 缩小重派`
          await $.ui.toast(text)
          void $.prompt.submit({ text })
        }
        if (status.tests > Number(options.max_tests) && !job.warnedTests) {
          job.warnedTests = true
          const text = `workhorse: job ${job.name} 已运行 ${status.tests} 次测试，超过 max_tests=${options.max_tests}；用 cx -t ${job.name} 查看，停止重复测试，必要时 cx -k ${job.name} 后缩小 brief 重派`
          await $.ui.toast(text)
          void $.prompt.submit({ text })
        }
        const current = (await $.store.get('jobs')) as Record<string, Job>
        current[path] = job
        await $.store.set('jobs', current)
      }
    } catch (error) {
      await $.ui.toast(`workhorse: job ${job.name} 状态处理失败：${String(error)}`)
    }
  }
  await $.ui.status(running.length ? running.join('\n') : undefined)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'cx',
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
    await $.command.register({ name: 'cx-jobs', description: 'List Codex jobs', immediate: true })
    await $.command.register({ name: 'cx-kill', description: 'Kill a Codex job', argumentHint: '<name>', immediate: true })
    $.clock.every(30000, () => poll($, options))
    return next(e)
  })

  on('tool.check', { tool: 'mcp__workhorse__cx' }, ($, e) => (e.input as Input).mode === 'ops'
    ? { decision: 'ask', reason: 'ops job runs Codex with full access outside the repo' }
    : { decision: 'allow' })

  on('tool.call', { tool: 'mcp__workhorse__cx' }, async ($, e) => {
    const { tool, tool_use_id, agentId, ...args } = e
    const input = args as Input
    const deny = lint(input, String(options.banned_phrases))
    if (deny) return { deny }
    const cwd = input.dir || await $.session.cwd()
    const result = await $.process.run(argv($.plugin.root, input, cwd), { cwd, env: environment(options), stdin: brief(input) })
    if (result.exitCode !== 0) return { result: result.stderr }
    const job = started(result.stdout)
    const jobs = (await $.store.get('jobs') ?? {}) as Record<string, Job>
    jobs[job.path] = { name: job.name, session: await $.session.id(), goal: input.goal, doneWhen: input.done_when, warnedStall: false, warnedTests: false }
    await $.store.set('jobs', jobs)
    return { result: `started ${job.name}; 报告会以 workhorse 消息送达，不要轮询。` }
  })

  on('command.run', { command: 'cx-jobs' }, async $ => {
    const result = await $.process.run([`${$.plugin.root}/bin/cx`, '-l'], { env: environment(options) })
    return { text: result.stdout + result.stderr }
  })
  on('command.run', { command: 'cx-kill' }, async ($, e) => {
    const result = await $.process.run([`${$.plugin.root}/bin/cx`, '-k', e.args.trim()], { env: environment(options) })
    return { text: result.stdout + result.stderr }
  })
}
