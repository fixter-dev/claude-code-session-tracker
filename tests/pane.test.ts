import { expect, mock, test } from 'claude-code/testing'

const NOW = 1_800_000_000_000
const HOME = '/home/me'
const START = 'Fri Oct  2 10:00:00 2026'
const PANE = {
  plugin: 'session-tracker',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'sessions',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const session = (
  pid: number,
  sessionId: string,
  project: string,
  status: string,
  agoMs: number,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    pid,
    kind: 'interactive',
    sessionId,
    cwd: `/work/${project}`,
    name: `${project}-xx`,
    nameSource: 'derived',
    status,
    statusUpdatedAt: NOW - agoMs,
    startedAt: NOW - 86_400_000,
    procStart: START,
    ...extra,
  })

const ok = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(found => found.text)

test('the pane lists the other sessions, finished first, hiding the dead, headless and reused', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { seen: { baseline: NOW - 3_600_000, acked: {} } })
  mock.env(on, { HOME })

  const files: Record<string, { text: string; mtimeMs: number }> = {
    '101.json': { text: session(101, 'self', 'docs', 'busy', 1000), mtimeMs: 1 },
    '202.json': { text: session(202, 'finished', 'ingestion-service', 'idle', 120_000), mtimeMs: 1 },
    '303.json': { text: session(303, 'working', 'sales', 'busy', 5000), mtimeMs: 1 },
    '404.json': { text: session(404, 'stale', 'customer', 'idle', 7_200_000), mtimeMs: 1 },
    '505.json': { text: session(505, 'crashed', 'ghost', 'idle', 60_000), mtimeMs: 1 },
    '606.json': { text: session(606, 'headless', 'feeder-cwd', 'busy', 1000, { kind: 'sdk' }), mtimeMs: 1 },
    '707.json': { text: session(707, 'reused', 'zombie', 'idle', 60_000), mtimeMs: 1 },
    '808.json': { text: session(808, 'opened', 'fresh', 'idle', 60_000, { startedAt: NOW - 60_000 }), mtimeMs: 1 },
  }
  // pid 707 runs again as another process: a different start time
  const alive = new Map<number, string>([
    [101, START],
    [202, START],
    [303, START],
    [404, START],
    [606, START],
    [707, 'Sat Oct  3 09:00:00 2026'],
    [808, START],
  ])
  const killed: string[] = []
  const played: string[] = []
  const sent: string[] = []
  const toasts: string[] = []
  let isShown = true

  on('session.id', () => ({ value: 'self' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.send', ($, e) => {
    sent.push(e.text)

    return { isDelivered: true as const }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({
    value: [{ id: 'sessions', title: 'Sessions', isShown, isFocused: false, isPlaced: true }],
  }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('audio.play', ($, e) => {
    played.push('asset' in e.clip ? (e.clip.asset ?? '') : '')

    return { value: undefined }
  })
  on('fs.list', () => ({
    value: Object.entries(files).map(([name, file]) => ({
      name,
      kind: 'file' as const,
      size: 1,
      mtimeMs: file.mtimeMs,
      isLink: false,
    })),
  }))
  on('fs.read', ($, e) => ({ value: files[e.path.split('/').at(-1) ?? '']?.text ?? '' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', ($, e) => {
    const [command, ...args] = e.argv

    if (command === 'ps' && args.includes('pid=,lstart=')) {
      expect(e.init?.env?.TZ).toBe('UTC')

      return ok([...alive].map(([pid, started]) => ` ${pid} ${started}`).join('\n'))
    }

    if (command === 'ps') {
      const pid = Number(args.at(-1))

      return alive.has(pid) ? ok(String(pid)) : ok('', 1)
    }

    if (command === 'grep' && (args.at(-1) ?? '').includes('working')) {
      return ok(
        [
          '{"type":"user","toolUseResult":{"task":{"id":"1","subject":"Explore"}}}',
          '{"type":"user","toolUseResult":{"task":{"id":"2","subject":"Build"}}}',
          '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"TaskUpdate","input":{"taskId":"1","status":"completed"}}]}}',
          '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b","name":"TaskUpdate","input":{"taskId":"2","status":"in_progress"}}]}}',
        ].join('\n'),
      )
    }

    if (command === 'grep') {
      return ok(
        (args.at(-1) ?? '').includes('finished')
          ? '{"type":"ai-title","aiTitle":"Monitoring env down"}\n{"type":"last-prompt","lastPrompt":"do the pr"}'
          : '',
      )
    }

    if (command === 'tail') {
      return ok(
        '{"type":"assistant","message":{"model":"claude-fable-5-1","usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":312000}}}',
      )
    }

    if (command === 'git') {
      return ok('fix/memory\n')
    }

    if (command === 'kill') {
      killed.push(args.join(' '))
      alive.delete(Number(args.at(-1)))

      return ok('')
    }

    return ok('')
  })

  await $.session.start({ cwd: '/work/docs', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  const shown = (await texts(ui)).map(line => line.trim())
  const order = ['ingestion-service', 'sales'].map(name => shown.findIndex(line => line.includes(name)))

  // this session on top, the rest by tier; the crashed, headless, reused-pid
  // and never-prompted sessions are hidden or idle
  expect(shown.some(line => line.includes('docs')), 'check 1').toBe(true)
  expect(order.every(index => index >= 0), 'check 2').toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  for (const hidden of ['ghost', 'feeder-cwd', 'zombie']) {
    expect(shown.some(line => line.includes(hidden)), 'check 3').toBe(false)
  }
  expect(shown.some(line => line.includes('Finished (1)')), 'check 4').toBe(true)
  expect(shown.some(line => line.includes('Idle (2)')), 'check 5').toBe(true)
  expect(shown).toContain('Monitoring env down')
  expect(shown.some(line => line.includes('do the pr')), 'check 6').toBe(true)
  expect(shown.some(line => line.includes('312k')), 'check 7').toBe(true)
  expect(shown.some(line => line.includes('31%')), 'check 8').toBe(true)
  expect(shown.some(line => line.startsWith('context')), 'check 9').toBe(true)
  expect(shown).toContain('fable 5.1')
  expect(shown).toContain('2/2 Build')
  expect(await ui.find({ key: 'kill-101' })).toBeUndefined()
  // idle is collapsed until shown
  expect(shown.some(line => line.includes('customer')), 'check 10').toBe(false)
  await ui.press({ key: 'idle-toggle' })
  expect((await texts(ui)).some(line => line.includes('customer')), 'check 11').toBe(true)
  // nothing played on the first load
  expect(played).toEqual([])

  // a working session finishing is announced once, with a sound
  files['303.json'] = { text: session(303, 'working', 'sales', 'idle', 0), mtimeMs: 2 }
  await clock.advance(3000)
  expect(played).toEqual(['sounds/finished.wav'])
  expect(toasts.some(line => line.startsWith('sales: finished')), 'check 12').toBe(true)
  expect((await texts(ui)).some(line => line.includes('Finished (2)')), 'check 13').toBe(true)
  await ui.press({ key: 'sound' })
  files['404.json'] = { text: session(404, 'stale', 'customer', 'waiting', 0, { waitingFor: 'permission: Bash' }), mtimeMs: 2 }
  await clock.advance(3000)
  expect(played).toHaveLength(1)
  expect((await texts(ui)).some(line => line.includes('waiting: permission: Bash')), 'check 14').toBe(true)

  // a message goes to the session by id
  await ui.press({ key: 'message-202' })
  await ui.input({ key: 'message-202', text: 'continue please' })
  expect(sent).toEqual(['continue please'])
  expect(toasts.at(-1)).toBe('Sent to ingestion-service: continue please')

  // the first press only arms; nothing dies until the confirm, and the toast
  // waits for the process to go
  await ui.press({ key: 'kill-303' })
  expect(killed).toEqual([])
  await ui.press({ key: 'yes-303' })
  expect(killed).toEqual(['-TERM 303'])
  expect(toasts.some(line => line.startsWith('Closed sales')), 'check 15').toBe(false)
  await clock.advance(1000)
  expect(toasts.some(line => line.startsWith('Closed sales')), 'check 16').toBe(true)
  expect((await texts(ui)).some(line => line.includes('sales')), 'check 17').toBe(false)

  // "seen" drops a finished session back among the idle ones (customer is
  // waiting now, so idle is the never-prompted one and this one)
  await ui.press({ key: 'seen-202' })
  const cleared = await texts(ui)
  expect(cleared.some(line => line.includes('Finished')), 'check 18').toBe(false)
  expect(cleared.some(line => line.includes('Idle (2)')), 'check 19').toBe(true)

  // a pin lifts a session into its own group above the rest, and back
  await ui.press({ key: 'pin-404' })
  const pinned = await texts(ui)
  expect(pinned.some(line => line.includes('Pinned (1)')), 'check 20').toBe(true)
  expect(pinned.findIndex(line => line.includes('customer'))).toBeLessThan(
    pinned.findIndex(line => line.includes('Idle (2)')),
  )
  await ui.press({ key: 'pin-404' })
  expect((await texts(ui)).some(line => line.includes('Pinned')), 'check 21').toBe(false)

  // by project: no group headings, the rows alphabetical
  await ui.press({ key: 'sort-project' })
  const flat = await texts(ui)
  expect(flat.some(line => line.includes('Idle (')), 'check 22').toBe(false)
  expect(flat.findIndex(line => line.includes('customer'))).toBeLessThan(
    flat.findIndex(line => line.includes('ingestion-service')),
  )
  await ui.press({ key: 'sort-recent' })

  // with the pane hidden only every fifth tick polls, and lightly
  isShown = false
  const before = toasts.length
  files['808.json'] = { text: session(808, 'opened', 'fresh', 'busy', 0), mtimeMs: 2 }
  await clock.advance(3000)
  files['808.json'] = { text: session(808, 'opened', 'fresh', 'idle', 0), mtimeMs: 3 }
  await clock.advance(12_000)
  expect(toasts.slice(before).some(line => line.startsWith('fresh: finished')), 'check 23').toBe(true)

  await ui.unmount()
})

test('a refresh that fails is shown in the pane and cleared by the next one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  mock.env(on, { HOME })
  let isBroken = true

  on('session.id', () => ({ value: 'self' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'sessions', title: 'Sessions', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.list', () =>
    isBroken ? { deny: 'ENOENT: sessions folder missing' } : { value: [] },
  )

  await $.session.start({ cwd: '/work/docs', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  expect((await texts(ui)).some(line => line.includes('refresh failed') && line.includes('ENOENT')), 'check 24').toBe(true)

  isBroken = false
  await ui.press({ key: 'refresh' })
  const after = await texts(ui)
  expect(after.some(line => line.includes('refresh failed')), 'check 25').toBe(false)
  expect(after.some(line => line.includes('No other sessions open')), 'check 26').toBe(true)

  await ui.unmount()
})
