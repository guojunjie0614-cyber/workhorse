import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { argv, brief } from './lib'

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
      { name: 'patch', path: '/jobs/patch', state: 'running', mode: 'code', started: 0, elapsed_min: 0, cmds: 4, tests: 1, idle_min: 2, activity: 'Editing parser', files: 2, step: 1, steps: 2 },
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

test('panel follows events live and disappears once every job is done', async ($, on) => {
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
    ['one', 'two'].filter(name => e.argv.includes(name)).map(name => ({ name, path: `/jobs/${name}`, state: done || name === 'two' ? 'done' : 'running', mode: 'code', started: 0, cmds: 4, tests: 1, idle_min: 0, activity, files: 2 })),
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
  done = true
  mtime = 3
  await clock.advance(250)
  expect(await ui.find({ type: 'Text', text: '2 agents · 1 running · 1 done' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '2 agents · 0 running · 2 done' })).toBeUndefined()
  await ui.unmount()
})

test('a session sees only its own jobs in the band', async ($, on) => {
  const { clock, store, session } = setup(on)
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  store['job:/jobs/mine'] = { name: 'mine', session: 'session-1', goal: 'fix parser', doneWhen: 'unit test', warnedStall: false, warnedTests: false }
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name: 'mine', path: '/jobs/mine', state: 'running', mode: 'code', started: 0, cmds: 1, tests: 0, idle_min: 0, activity: 'x', files: 0 }]) } }))
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
  }
})

test('launch writes argv, stdin and job; completion delivers report and acceptance command', async ($, on) => {
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
  const input = { goal: 'fix parser', context: 'baseline.ts rejects input', constraints: 'only parser', done_when: 'npm run test:parser', name: 'patch', effort: 'high' as const, model: 'codex' }
  const result = await $.tool.call({ tool: 'mcp__workhorse__run', ...input })
  expect(result.result).toContain('patch')
  expect(calls[0]).toEqual({
    argv: [expect.stringMatching(/\/bin\/workhorse$/), '--detach', '-C', '/repo', '--code', '-n', 'patch', '-e', 'high', '-m', 'codex'],
    init: { cwd: '/repo', env: { WORKHORSE_ALLOW_OPS: '1' }, stdin: 'Goal: fix parser\nContext: baseline.ts rejects input\nConstraints: only parser\nDone when: npm run test:parser' },
  })
  expect(store).toEqual({ 'job:/jobs/patch': { name: 'patch', session: 'session-1', goal: input.goal, doneWhen: input.done_when, warnedStall: false, warnedTests: false } })
  expect(argv('/plugin', { ...input, resume: 'review', to_code: true }, '/repo')).toEqual(['/plugin/bin/workhorse', '--detach', '-r', 'review', '--code', '-e', 'high', '-m', 'codex'])
  expect(argv('/plugin', { ...input, worktree: 'branch', mode: 'review' }, '/repo')).toEqual(['/plugin/bin/workhorse', '--detach', '-w', 'branch', '--review', '-n', 'patch', '-e', 'high', '-m', 'codex'])
  await clock.advance(30000)
  expect(calls[1]).toEqual({ argv: [expect.stringMatching(/\/bin\/workhorse$/), '-s', 'patch'], init: { env: { WORKHORSE_ALLOW_OPS: '1' } } })
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('Fixed the parser')
  expect(messages[0]).toContain(input.done_when)
  expect(store).toEqual({})
  expect(brief({ goal: 'fix', context: 'baseline.ts', done_when: 'unit test' })).toBe('Goal: fix\nContext: baseline.ts\nDone when: unit test')
  expect(await $.tool.check({ tool: 'mcp__workhorse__run', input: { mode: 'ops' } })).toEqual({ decision: 'ask', reason: 'ops job runs Codex with full access outside the repo' })
})

test('resuming an ops job asks first unless it becomes a code job', async ($, on) => {
  setup(on)
  on('process.run', ($, e) => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name: e.argv[2], mode: e.argv[2] === 'deploy' ? 'ops' : 'code' }]) } }))
  const ask = { decision: 'ask', reason: 'ops job runs Codex with full access outside the repo' }
  expect(await $.tool.check({ tool: 'mcp__workhorse__run', input: { resume: 'deploy' } })).toEqual(ask)
  expect(await $.tool.check({ tool: 'mcp__workhorse__run', input: { resume: 'deploy', to_code: true } })).toEqual({ decision: 'allow' })
  expect(await $.tool.check({ tool: 'mcp__workhorse__run', input: { resume: 'patch' } })).toEqual({ decision: 'allow' })
})

test('stall and excess-test warnings each notify only once', async ($, on) => {
  const { clock } = setup(on)
  const messages: string[] = []
  const toasts: string[] = []
  on('process.run', ($, e) => ({ value: { exitCode: 0, stderr: '', stdout: e.argv[1] === '--detach'
    ? 'started slow /jobs/slow\n'
    : JSON.stringify([{ name: 'slow', path: '/jobs/slow', state: 'running', elapsed_min: 12, idle_min: 10, tests: 3 }]) } }))
  on('prompt.submit', ($, e) => { messages.push(e.text); return { text: e.text } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__workhorse__run', goal: 'fix', context: '', done_when: 'unit test' })
  await clock.advance(60000)
  expect(messages).toHaveLength(2)
  expect(toasts).toEqual(messages)
  expect(messages[0]).toContain('10 分钟无输出')
  expect(messages[1]).toContain('3 次测试')
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
    { name: 'review.2', path: '/jobs/review.2', state: 'done', mode: 'review' },
  ]) } }))
  on('fs.read', () => ({ value: 'Review evidence' }))
  on('prompt.submit', ($, e) => {
    expect(store['job:/jobs/review.2']).toBeUndefined()
    messages.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  await clock.advance(30000)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('核对结论和证据；要修复就用 resume + to_code 交回')
  expect(messages[0]).not.toContain('自己运行')
  expect(Object.keys(store)).toEqual(['job:/jobs/other'])
})
