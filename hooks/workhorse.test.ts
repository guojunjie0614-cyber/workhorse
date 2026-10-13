import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { argv, brief, lint, MESSAGES, panelLines } from './lib'
import type { PanelTask } from './lib'

test('hides codex-rescue and passes other agents through', async ($, on) => {
  const offered: string[] = []
  on('agent.offer', ($, e) => { offered.push(e.agent); return { isOffered: true } })
  for (const agent of ['codex:codex-rescue', 'codex:other', 'other:codex-rescue', 'Explore']) {
    const result = await $.agent.offer({ agent, description: '', source: 'plugin', provider: { plugin: 'codex', tier: 'user' } })
    expect(result).toEqual({ isOffered: agent !== 'codex:codex-rescue' })
  }
  expect(offered).toEqual(['codex:other', 'other:codex-rescue', 'Explore'])
})

function setup(on: On) {
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => { store[e.key] = e.value; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.delete', ($, e) => { delete store[e.key]; return { value: undefined } })
  const clock = mock.clock(on)
  const session = { id: 'session-1' }
  on('session.id', () => ({ value: session.id }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: 'mcp__workhorse__run' } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return { clock, store, session }
}

test('running band refreshes elapsed seconds without stop or logs buttons', async ($, on) => {
  const { clock, store } = setup(on)
  store['job:/jobs/patch'] = { name: 'patch', session: 'session-1', goal: 'fix', doneWhen: 'unit test', warnedStall: false, warnedTests: false }
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify([
      { name: 'patch', base: 'patch', round: 1, busy: '', busy_min: 0, path: '/jobs/patch', state: 'running', mode: 'code', started: 0, elapsed_min: 0, cmds: 4, tests: 1, idle_min: 2, activity: 'Editing parser', files: 2, step: 1, steps: 2 },
    ]) } }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  const ui = await $.ui.mount({ plugin: 'workhorse', component: 'AbovePrompt', surface: 'terminal', requestId: 'band', props: {
    hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {},
  } })
  expect(await ui.find({ type: 'Text', text: '  30s' })).toBeDefined()
  await clock.advance(35000)
  expect(await ui.find({ type: 'Text', text: '  1m05s' })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(calls).toHaveLength(2)
  await ui.unmount()
})

test('panel follows events live and disappears once every job is done', { options: { lang: 'en', done_linger_minutes: 0.01 } }, async ($, on) => {
  const { clock, store } = setup(on)
  on('fs.exists', () => ({ value: false }))
  let mtime = 1
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: mtime, isLink: false } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  for (const name of ['one', 'two']) {
    store[`job:/jobs/${name}`] = { name, session: 'session-1', goal: 'fix parser', doneWhen: 'unit test', warnedStall: false, warnedTests: false }
  }
  let activity = 'Editing parser'
  let done = false
  on('process.run', ($, e) => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify(
    ['one', 'two'].filter(name => e.argv.includes(name)).map(name => ({ name, base: name, round: 1, busy: '', busy_min: 0, exit: 0, path: `/jobs/${name}`, state: done || name === 'two' ? 'done' : 'running', mode: 'code', started: 0, cmds: 4, tests: 1, idle_min: 0, activity, files: 2 })),
  ) } }))
  on('fs.read', () => ({ value: 'Fixed parser' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  const ui = await $.ui.mount({ plugin: 'workhorse', component: 'AbovePrompt', surface: 'terminal', requestId: 'progress', props: {
    hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {},
  } })
  expect(await ui.find({ type: 'Text', text: '2 agents · 1 running · 1 done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '████' })).toBeUndefined()
  await clock.advance(250)
  activity = 'rg -n parse src'
  mtime = 2
  await clock.advance(250)
  expect(await ui.find({ type: 'Text', text: '│    rg -n parse src · 4 cmds · 2 files' })).toBeDefined()
  await clock.advance(250)
  expect(await ui.find({ type: 'Text', text: '1 agents · 1 running · 0 done' })).toBeDefined()
  done = true
  mtime = 3
  await clock.advance(250)
  expect(await ui.find({ type: 'Text', text: '2 agents · 1 running · 1 done' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '2 agents · 0 running · 2 done' })).toBeUndefined()
  await ui.unmount()
})

test('a session sees only its own jobs in the band', { options: { lang: 'en' } }, async ($, on) => {
  const { clock, store, session } = setup(on)
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  store['job:/jobs/mine'] = { name: 'mine', session: 'session-1', goal: 'fix parser', doneWhen: 'unit test', warnedStall: false, warnedTests: false }
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name: 'mine', base: 'mine', round: 1, busy: '', busy_min: 0, path: '/jobs/mine', state: 'running', mode: 'code', started: 0, cmds: 1, tests: 0, idle_min: 0, activity: 'x', files: 0 }]) } }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const mine = await $.ui.mount({ plugin: 'workhorse', component: 'AbovePrompt', surface: 'terminal', requestId: 'mine', props })
  expect(await mine.find({ type: 'Text', text: '1 agents · 1 running · 0 done' })).toBeDefined()
  await mine.unmount()
  session.id = 'session-2'
  const other = await $.ui.mount({ plugin: 'workhorse', component: 'AbovePrompt', surface: 'terminal', requestId: 'other', props })
  expect(await other.find({ type: 'Text', text: '1 agents · 1 running · 0 done' })).toBeUndefined()
  await other.unmount()
})

test('workhorse ToolUse draws the goal in a compact line', async ($, on) => {
  setup(on)
  const ui = await $.ui.mount({ plugin: 'workhorse', component: 'ToolUse', surface: 'terminal', requestId: 'call-1', props: {
    tool_use_id: 'call-1', tool: 'mcp__workhorse__run', input: { name: 'patch', goal: 'fix parser', mode: 'code', effort: 'high' },
    isRunning: true, isErrored: false, isInterrupted: false,
  } })
  expect(await ui.find({ type: 'Text', text: 'workhorse ▸ patch · code · high — fix parser' })).toBeDefined()
  await ui.unmount()
})

test('lint refuses absent completion criteria and banned phrases in instruction fields', async ($, on) => {
  setup(on)
  const missing = await $.tool.call({ tool: 'mcp__workhorse__run', goal: 'fix', context: '' })
  expect(missing.deny).toContain('done_when')
  const empty = await $.tool.call({ tool: 'mcp__workhorse__run', goal: 'fix', context: '', done_when: '  ' })
  expect(empty.deny).toContain('done_when')
  for (const field of ['goal', 'constraints', 'done_when']) {
    const banned = await $.tool.call({ tool: 'mcp__workhorse__run', goal: 'fix', context: '', done_when: 'unit test', [field]: 'BASELINE' })
    expect(banned.deny).toContain(field)
    for (const negation of ['不', '没', '无', '别', '勿', '禁止', 'no', 'not', "don't", 'without', 'avoid', 'skip']) {
      expect(lint({ goal: 'fix', context: '', done_when: 'unit test', [field]: `${negation} BASELINE` }, 'baseline')).toBeUndefined()
    }
  }
  expect(lint({ goal: '不12345baseline', context: '', done_when: 'unit test' }, 'baseline')).toBeUndefined()
  expect(lint({ goal: '不123456baseline', context: '', done_when: 'unit test' }, 'baseline')).toContain('goal')
  expect(lint({ goal: 'no baseline; baseline', context: '', done_when: 'unit test' }, 'baseline')).toContain('goal')
  expect(lint({ goal: 'notable baseline', context: '', done_when: 'unit test' }, 'baseline')).toContain('goal')
})

test('launch writes argv, stdin and job; completion delivers report and acceptance command', { options: { lang: 'en', poll_seconds: 1, report_max_chars: 6, keep_days: 7, skip_skills: '', test_pattern: 'unit' } }, async ($, on) => {
  const { clock, store } = setup(on)
  const calls: unknown[] = []
  const messages: string[] = []
  on('process.run', ($, e) => {
    calls.push(e)
    return { value: { exitCode: 0, stderr: '', stdout: e.argv[1] === '--detach'
      ? 'started patch /jobs/patch\n'
      : JSON.stringify([{ name: 'patch', path: '/jobs/patch', state: 'done' }]) } }
  })
  on('fs.read', ($, e) => {
    expect(e.path).toBe('/jobs/patch/report.txt')
    return { value: 'Fixed the parser' }
  })
  on('prompt.submit', ($, e) => { messages.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const input = { goal: 'fix parser', context: 'baseline.ts rejects input', constraints: 'only parser', done_when: 'npm run test:parser', name: 'patch', effort: 'xhigh', model: 'codex' }
  const result = await $.tool.call({ tool: 'mcp__workhorse__run', ...input })
  expect(result.result).toContain('patch')
  expect(calls[0]).toEqual({
    argv: [expect.stringMatching(/\/bin\/workhorse$/), '--detach', '-C', '/repo', '--code', '-n', 'patch', '-e', 'xhigh', '-m', 'codex'],
    init: { cwd: '/repo', env: { WORKHORSE_ALLOW_OPS: '1', WORKHORSE_LANG: 'en', WORKHORSE_KEEP_DAYS: '7', WORKHORSE_SKIP_SKILLS: '', WORKHORSE_TEST_PATTERN: 'unit' }, stdin: 'Goal: fix parser\nContext: baseline.ts rejects input\nConstraints: only parser\nDone when: npm run test:parser' },
  })
  expect(store).toEqual({ 'job:/jobs/patch': { name: 'patch', session: 'session-1', goal: input.goal, doneWhen: input.done_when, warnedStall: false, warnedTests: false } })
  expect(argv('/plugin', { ...input, resume: 'review', to_code: true }, '/repo')).toEqual(['/plugin/bin/workhorse', '--detach', '-r', 'review', '--code', '-e', 'xhigh', '-m', 'codex'])
  for (const mode of ['code', 'review', 'ops'] as const) {
    expect(argv('/plugin', { goal: 'fix', context: '', done_when: 'unit test', resume: 'job', mode, to_code: true }, '/repo')).toEqual(['/plugin/bin/workhorse', '--detach', '-r', 'job', `--${mode}`])
  }
  expect(argv('/plugin', { ...input, worktree: 'branch', mode: 'review' }, '/repo')).toEqual(['/plugin/bin/workhorse', '--detach', '-w', 'branch', '--review', '-n', 'patch', '-e', 'xhigh', '-m', 'codex'])
  await clock.advance(1000)
  expect(calls[1]).toEqual({ argv: [expect.stringMatching(/\/bin\/workhorse$/), '-s', 'patch'], init: { env: { WORKHORSE_ALLOW_OPS: '1', WORKHORSE_LANG: 'en', WORKHORSE_KEEP_DAYS: '7', WORKHORSE_SKIP_SKILLS: '', WORKHORSE_TEST_PATTERN: 'unit' } } })
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('workhorse: job patch finished\nFixed \nTruncated; full report: /jobs/patch/report.txt')
  expect(messages[0]).toContain(input.done_when)
  expect(store).toEqual({})
  expect(brief({ goal: 'fix', context: 'baseline.ts', done_when: 'unit test' })).toBe('Goal: fix\nContext: baseline.ts\nDone when: unit test')
  expect(await $.tool.check({ tool: 'mcp__workhorse__run', input: { mode: 'ops' } })).toEqual({ decision: 'ask', reason: 'ops job runs Codex with full access outside the repo' })
})

test('resuming an ops job asks first unless it becomes a code job', { options: { lang: 'en' } }, async ($, on) => {
  setup(on)
  on('process.run', ($, e) => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name: e.argv[2], mode: e.argv[2] === 'deploy' ? 'ops' : 'code' }]) } }))
  const ask = { decision: 'ask', reason: 'ops job runs Codex with full access outside the repo' }
  expect(await $.tool.check({ tool: 'mcp__workhorse__run', input: { resume: 'deploy' } })).toEqual(ask)
  expect(await $.tool.check({ tool: 'mcp__workhorse__run', input: { resume: 'deploy', to_code: true } })).toEqual({ decision: 'allow' })
  expect(await $.tool.check({ tool: 'mcp__workhorse__run', input: { resume: 'deploy', mode: 'review' } })).toEqual({ decision: 'allow' })
  expect(await $.tool.check({ tool: 'mcp__workhorse__run', input: { resume: 'patch', mode: 'ops', to_code: true } })).toEqual(ask)
  expect(await $.tool.check({ tool: 'mcp__workhorse__run', input: { resume: 'patch' } })).toEqual({ decision: 'allow' })
})

test('stall and excess-test warnings each notify only once', async ($, on) => {
  const { clock } = setup(on)
  const messages: string[] = []
  const toasts: string[] = []
  let busy = 'sleep 600'
  on('process.run', ($, e) => ({ value: { exitCode: 0, stderr: '', stdout: e.argv[1] === '--detach'
    ? 'started slow /jobs/slow\n'
    : JSON.stringify([{ name: 'slow', path: '/jobs/slow', state: 'running', elapsed_min: 12, idle_min: 10, busy, busy_min: 10, tests: busy ? 0 : 3 }]) } }))
  on('prompt.submit', ($, e) => { messages.push(e.text); return { text: e.text } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__workhorse__run', goal: 'fix', context: '', done_when: 'unit test' })
  await clock.advance(30000)
  expect(messages).toHaveLength(0)
  expect(toasts).toHaveLength(0)
  busy = ''
  await clock.advance(60000)
  expect(messages).toHaveLength(2)
  expect(toasts).toEqual(messages)
  expect(messages[0]).toContain('10 分钟无输出')
  expect(messages[1]).toContain('3 次测试')
})

test('long commands warn once per command text without terminating', { options: { command_minutes: 2 } }, async ($, on) => {
  const { clock, store } = setup(on)
  store['job:/jobs/slow'] = { name: 'slow', session: 'session-1', goal: 'fix', doneWhen: 'unit test', warnedStall: false, warnedTests: false }
  const messages: string[] = []
  const toasts: string[] = []
  let busy = 'sleep 600'
  let busyMinutes = 1
  on('process.run', ($, e) => {
    expect(e.argv[1]).toBe('-s')
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name: 'slow', path: '/jobs/slow', state: 'running', busy, busy_min: busyMinutes, idle_min: 10, tests: 0 }]) } }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.exists', () => ({ value: false }))
  on('prompt.submit', ($, e) => { messages.push(e.text); return { text: e.text } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  expect(messages).toHaveLength(0)
  busyMinutes = 2
  await clock.advance(60000)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('2 分钟：sleep 600')
  busy = 'sleep 900'
  await clock.advance(60000)
  expect(messages).toHaveLength(2)
  expect(messages[1]).toContain('sleep 900')
  expect(toasts).toEqual(messages)
  expect(store['job:/jobs/slow']).toMatchObject({ warnedBusy: 'sleep 900' })
})

test('failed completion submissions keep records until the next successful poll', async ($, on) => {
  const { clock, store } = setup(on)
  const states = ['done', 'dead', 'missing']
  for (const name of states) {
    store[`job:/jobs/${name}`] = { name, session: 'session-1', goal: 'fix', doneWhen: 'unit test', warnedStall: false, warnedTests: false }
  }
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify(states.map(state => ({ name: state, path: `/jobs/${state}`, state, mode: 'code', base: state }))) } }))
  on('fs.read', () => ({ value: 'Finished report' }))
  const messages: string[] = []
  let fail = true
  on('prompt.submit', ($, e) => {
    const name = states.find(state => e.text.includes(`job ${state} `))!
    expect(store[`job:/jobs/${name}`]).toBeDefined()
    if (fail) throw new Error('submit unavailable')
    messages.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  expect(Object.keys(store)).toEqual(states.map(name => `job:/jobs/${name}`))
  expect(messages).toHaveLength(0)
  fail = false
  await clock.advance(30000)
  expect(messages).toHaveLength(3)
  expect(store).toEqual({})
})

test('missing jobs are removed and a failed job does not block other jobs', async ($, on) => {
  const { clock, store } = setup(on)
  const messages: string[] = []
  const toasts: string[] = []
  Object.assign(store, Object.fromEntries(['lost', 'broken', 'ready'].map(name => [`job:/jobs/${name}`, {
    name, session: 'session-1', goal: 'fix', doneWhen: 'unit test', warnedStall: false, warnedTests: false,
  }])))
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify([
    { name: 'lost', path: null, state: 'missing' },
    { name: 'broken', path: '/jobs/broken', state: 'done' },
    { name: 'ready', path: '/jobs/ready', state: 'done' },
  ]) } }))
  on('fs.read', ($, e) => e.path === '/jobs/broken/report.txt'
    ? { deny: 'report unavailable' }
    : { value: 'Ready report' })
  on('prompt.submit', ($, e) => { messages.push(e.text); return { text: e.text } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  expect(messages).toHaveLength(2)
  expect(messages[0]).toContain('job lost 记录已丢失')
  expect(messages[1]).toContain('Ready report')
  expect(Object.keys(store)).toEqual(['job:/jobs/broken'])
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('broken')
})

test('two polls sharing a store submit a done review job only once', async ($, on) => {
  const { clock, store } = setup(on)
  const messages: string[] = []
  store['job:/jobs/review.2'] = { name: 'review.2', session: 'session-1', goal: 'review', doneWhen: '给出结论和证据', warnedStall: false, warnedTests: false }
  store['job:/jobs/other'] = { name: 'other', session: 'session-2', goal: 'fix', doneWhen: 'unit test', warnedStall: false, warnedTests: false }
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify([
    { name: 'review.2', base: 'review', path: '/jobs/review.2', state: 'done', mode: 'review' },
  ]) } }))
  on('fs.read', () => ({ value: 'Review evidence' }))
  on('prompt.submit', ($, e) => {
    expect(store['job:/jobs/review.2']).toBeDefined()
    messages.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  await clock.advance(30000)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('核对结论和证据；要修复就用 resume review + to_code 交回')
  expect(messages[0]).not.toContain('自己运行')
  expect(Object.keys(store)).toEqual(['job:/jobs/other'])
})

test('panel shows failed exits, family rounds and busy commands', () => {
  const task: PanelTask = { name: 'patch.2', base: 'patch', round: 2, busy: 'sleep 600', busy_min: 10, path: '/jobs/patch.2', state: 'running', mode: 'code', exit: null, started: 0, elapsed_min: 10, idle_min: 10, cmds: 4, activity: 'Editing parser', files: 2, tests: 0, tokens: 0, cancelled: false, repeat: 0, repeat_cmd: '', family_tokens: 0, report: '', goal: 'fix' }
  const lines = panelLines([
    task,
    { ...task, name: 'failed', base: 'failed', round: 1, state: 'done', exit: 1, busy: '' },
    { ...task, name: 'ok', base: 'ok', round: 1, state: 'done', exit: 0, busy: '' },
    { ...task, name: 'dead', base: 'dead', round: 1, state: 'dead', busy: '' },
  ], 600000, { lang: 'en', done_linger_minutes: 3, goal_columns: 40 })
  expect(lines[1]![0]!.children).toBe('4 agents · 1 running · 1 done · 2 failed')
  expect(lines[2]![2]!.children).toContain('patch #2')
  expect(lines[3]![0]!.children).toContain('running 10m: sleep 600')
  expect(lines[4]![1]).toEqual({ children: '✗', color: 'error' })
  expect(lines[4]![2]!.children).not.toContain('#1')
  expect(lines[4]![3]).toEqual({ children: 'failed   ', color: 'error' })
  expect(lines[5]![0]!.children).toContain('Editing parser · 4 cmds · 2 files')
})

test('kill without a name selects only running jobs owned by this session', async ($, on) => {
  const { store } = setup(on)
  const calls: string[][] = []
  let running = ['one', 'two']
  for (const name of ['one', 'two', 'done', 'other']) {
    store[`job:/jobs/${name}`] = { name, session: name === 'other' ? 'session-2' : 'session-1' }
  }
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    return { value: { exitCode: 0, stderr: '', stdout: e.argv[1] === '-k' ? `killed ${e.argv[2]}` : JSON.stringify(e.argv.slice(2).map(name => ({ name, state: running.includes(name) ? 'running' : 'done' }))) } }
  })
  const multiple = await $.command.run({ command: 'workhorse-kill', args: '' })
  expect(multiple.text).toContain('one\ntwo')
  expect(calls).toEqual([[expect.stringMatching(/\/bin\/workhorse$/), '-s', 'one', 'two', 'done']])
  running = ['two']
  expect((await $.command.run({ command: 'workhorse-kill', args: ' ' })).text).toBe('killed two')
  expect(calls[2]).toEqual([expect.stringMatching(/\/bin\/workhorse$/), '-k', 'two'])
  running = []
  expect((await $.command.run({ command: 'workhorse-kill', args: '' })).text).toContain('没有运行中')
  for (const name of ['one', 'two', 'done']) delete store[`job:/jobs/${name}`]
  const count = calls.length
  expect((await $.command.run({ command: 'workhorse-kill', args: '' })).text).toContain('没有运行中')
  expect(calls).toHaveLength(count)
  expect((await $.command.run({ command: 'workhorse-kill', args: 'other' })).text).toBe('killed other')
})

test('repeated commands warn at the configured limit once per command without killing', { options: { repeat_limit: 4 } }, async ($, on) => {
  const { clock, store } = setup(on)
  store['job:/jobs/loop'] = { name: 'loop', session: 'session-1', goal: 'fix', doneWhen: 'unit test' }
  let repeat = 3
  let command = 'check a'
  const messages: string[] = []
  const toasts: string[] = []
  on('process.run', ($, e) => {
    expect(e.argv[1]).toBe('-s')
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name: 'loop', path: '/jobs/loop', state: 'running', repeat, repeat_cmd: command }]) } }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.exists', () => ({ value: false }))
  on('prompt.submit', ($, e) => { messages.push(e.text); return { text: e.text } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  expect(messages).toHaveLength(0)
  repeat = 4
  await clock.advance(60000)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('4 次：check a')
  command = 'check b'
  await clock.advance(30000)
  command = 'check a'
  await clock.advance(30000)
  expect(messages).toHaveLength(2)
  expect(toasts).toEqual(messages)
  expect(store['job:/jobs/loop']).toMatchObject({ warnedRepeat: ['check a', 'check b'] })
})

test('family tokens warn once per job at the configured threshold including completion', { options: { family_tokens_warn: 100, lang: 'en' } }, async ($, on) => {
  const { clock, store } = setup(on)
  for (const name of ['one', 'two']) store[`job:/jobs/${name}`] = { name, session: 'session-1', goal: 'fix', doneWhen: 'unit test' }
  let tokens = 99
  const messages: string[] = []
  const toasts: string[] = []
  on('process.run', ($, e) => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify(e.argv.slice(2).map(name => ({ name, base: 'family', path: `/jobs/${name}`, state: name === 'two' && tokens >= 100 ? 'done' : 'running', family_tokens: tokens }))) } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: 'Report' }))
  on('prompt.submit', ($, e) => { messages.push(e.text); return { text: e.text } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  expect(messages).toHaveLength(0)
  tokens = 100
  await clock.advance(60000)
  expect(toasts).toHaveLength(2)
  expect(toasts[0]).toContain('job one family has used 100 tokens')
  expect(toasts[1]).toContain('job two family has used 100 tokens')
  expect(messages).toHaveLength(3)
  expect(store['job:/jobs/one']).toMatchObject({ warnedFamilyTokens: true })
})

test('cancelled jobs use inactive state and cancellation reminders instead of failed counts', async ($, on) => {
  const { clock, store } = setup(on)
  const task: PanelTask = { name: 'cancel', base: 'cancel', round: 1, path: '/jobs/cancel', state: 'done', cancelled: true, exit: 1, mode: 'code', started: 0, elapsed_min: 0, idle_min: 0, busy: '', busy_min: 0, cmds: 0, activity: '', files: 0, tests: 0, tokens: 0, family_tokens: 0, repeat: 0, repeat_cmd: '', report: '', goal: 'fix' }
  const lines = panelLines([task, { ...task, name: 'live', state: 'running', cancelled: false }], 30000, { lang: 'en', done_linger_minutes: 3, goal_columns: 40 })
  expect(lines[1]![0]!.children).toBe('2 agents · 1 running · 0 done · 1 cancelled')
  expect(lines[2]![3]).toEqual({ children: 'cancelled', color: 'inactive' })
  expect(lines[2]![1]!.color).toBe('inactive')
  expect(MESSAGES.en.cancelledReminder('cancel')).toContain('Job cancelled')
  store['job:/jobs/cancel'] = { name: 'cancel', session: 'session-1', goal: 'fix', doneWhen: 'unit test' }
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify([task]) } }))
  on('fs.read', () => ({ value: 'Stopped report' }))
  const messages: string[] = []
  on('prompt.submit', ($, e) => { messages.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain(MESSAGES.zh.cancelledReminder('cancel'))
  expect(messages[0]).not.toContain('自己运行')
  expect(store).toEqual({})
})
