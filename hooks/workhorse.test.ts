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
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: 'mcp__workhorse__cx' } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return { clock, store }
}

test('running band draws job metrics and stop invokes cx -k', async ($, on) => {
  const { clock, store } = setup(on)
  store.jobs = { '/jobs/patch': { name: 'patch', session: 'session-1', goal: 'fix', doneWhen: 'unit test', warnedStall: false, warnedTests: false } }
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    return { value: { exitCode: 0, stderr: '', stdout: e.argv[1] === '-k' ? 'stopped patch' : JSON.stringify([
      { name: 'patch', path: '/jobs/patch', state: 'running', mode: 'code', elapsed_min: 5, cmds: 4, tests: 1, idle_min: 2 },
    ]) } }
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(30000)
  const ui = await $.ui.mount({ plugin: 'workhorse', component: 'AbovePrompt', surface: 'terminal', requestId: 'band', props: {
    hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {},
  } })
  expect(await ui.find({ type: 'Text', text: 'patch · code · 5m · cmds 4 · tests 1 · idle 2m' })).toBeDefined()
  await ui.press({ key: 'stop:patch' })
  expect(calls[1]).toEqual([expect.stringMatching(/\/bin\/cx$/), '-k', 'patch'])
  await ui.unmount()
})

test('cx ToolUse draws the goal in a compact line', async ($, on) => {
  setup(on)
  const ui = await $.ui.mount({ plugin: 'workhorse', component: 'ToolUse', surface: 'terminal', requestId: 'call-1', props: {
    tool_use_id: 'call-1', tool: 'mcp__workhorse__cx', input: { name: 'patch', goal: 'fix parser', mode: 'code', effort: 'high' },
    isRunning: true, isErrored: false, isInterrupted: false,
  } })
  expect(await ui.find({ type: 'Text', text: 'cx ▸ patch · code · high — fix parser' })).toBeDefined()
  await ui.unmount()
})

test('lint refuses absent completion criteria and banned phrases in instruction fields', async ($, on) => {
  setup(on)
  const missing = await $.tool.call({ tool: 'mcp__workhorse__cx', goal: 'fix', context: '' })
  expect(missing.deny).toContain('done_when')
  const empty = await $.tool.call({ tool: 'mcp__workhorse__cx', goal: 'fix', context: '', done_when: '  ' })
  expect(empty.deny).toContain('done_when')
  for (const field of ['goal', 'constraints', 'done_when']) {
    const banned = await $.tool.call({ tool: 'mcp__workhorse__cx', goal: 'fix', context: '', done_when: 'unit test', [field]: 'BASELINE' })
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
  const result = await $.tool.call({ tool: 'mcp__workhorse__cx', ...input })
  expect(result.result).toContain('patch')
  expect(calls[0]).toEqual({
    argv: [expect.stringMatching(/\/bin\/cx$/), '--detach', '-C', '/repo', '--code', '-n', 'patch', '-e', 'high', '-m', 'codex'],
    init: { cwd: '/repo', env: { CX_ALLOW_OPS: '1' }, stdin: 'Goal: fix parser\nContext: baseline.ts rejects input\nConstraints: only parser\nDone when: npm run test:parser' },
  })
  expect(store.jobs).toEqual({ '/jobs/patch': { name: 'patch', session: 'session-1', goal: input.goal, doneWhen: input.done_when, warnedStall: false, warnedTests: false } })
  expect(argv('/plugin', { ...input, resume: 'review', to_code: true }, '/repo')).toEqual(['/plugin/bin/cx', '--detach', '-r', 'review', '--code', '-e', 'high', '-m', 'codex'])
  expect(argv('/plugin', { ...input, worktree: 'branch', mode: 'review' }, '/repo')).toEqual(['/plugin/bin/cx', '--detach', '-w', 'branch', '--review', '-n', 'patch', '-e', 'high', '-m', 'codex'])
  await clock.advance(30000)
  expect(calls[1]).toEqual({ argv: [expect.stringMatching(/\/bin\/cx$/), '-s', 'patch'], init: { env: { CX_ALLOW_OPS: '1' } } })
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('Fixed the parser')
  expect(messages[0]).toContain(input.done_when)
  expect(store.jobs).toEqual({})
  expect(brief({ goal: 'fix', context: 'baseline.ts', done_when: 'unit test' })).toBe('Goal: fix\nContext: baseline.ts\nDone when: unit test')
  expect(await $.tool.check({ tool: 'mcp__workhorse__cx', input: { mode: 'ops' } })).toEqual({ decision: 'ask', reason: 'ops job runs Codex with full access outside the repo' })
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
  await $.tool.call({ tool: 'mcp__workhorse__cx', goal: 'fix', context: '', done_when: 'unit test' })
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
  store.jobs = Object.fromEntries(['lost', 'broken', 'ready'].map(name => [`/jobs/${name}`, {
    name, session: 'session-1', goal: 'fix', doneWhen: 'unit test', warnedStall: false, warnedTests: false,
  }]))
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
  expect(Object.keys(store.jobs as object)).toEqual(['/jobs/broken'])
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('broken')
})
