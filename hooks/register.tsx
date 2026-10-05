import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Health, SessionRow, Sort, Tier } from '../types'
import {
  arrivals,
  buildRows,
  contextFromTail,
  isListed,
  isLive,
  isRegistryFile,
  isSeen,
  isSort,
  META_PATTERN,
  metaFromTranscript,
  orderRows,
  parseAlive,
  parseRecord,
  slugOf,
  TIERS,
} from './model'
import type { Meta, RegistryRecord, Seen } from './model'

const PANE = 'sessions'
const DEFAULT_WIDTH = 56
let finishedMs: number | undefined
const POLL_MS = 3000
// With the pane out of sight only every this many ticks poll, and lightly
// (the registry alone, enough to notice a session that needs you).
const HIDDEN_EVERY = 5
// Every this many polls the registry's pids are checked against `ps` even
// when the set of pids did not change.
const ALIVE_EVERY = 5
// A working session's context grows mid-turn: its transcript is read again
// this often, an idle one's only when its status moves.
const BUSY_REFRESH_MS = 30_000
// Values other sessions' sidebars may have written are read again this often.
const STORE_TTL_MS = 30_000
// How many sessions' transcripts are read at once.
const META_CONCURRENCY = 4
const TAIL_BYTES = '262144'
const BAR_CELLS = 8
// After a kill, how many seconds the process gets to exit before we say so.
const EXIT_CHECKS = 5
// Several sessions finishing together make one sound.
const SOUND_GAP_MS = 2000

const rows = atom({ plugin: 'session-tracker', key: 'rows' } as const, [])
const current = atom({ plugin: 'session-tracker', key: 'current' } as const, null)
const armedPid = atom({ plugin: 'session-tracker', key: 'armedPid' } as const, null)
const messagingPid = atom({ plugin: 'session-tracker', key: 'messagingPid' } as const, null)
const sort = atom({ plugin: 'session-tracker', key: 'sort' } as const, 'recent')
const isIdleOpen = atom({ plugin: 'session-tracker', key: 'isIdleOpen' } as const, false)
const isMuted = atom({ plugin: 'session-tracker', key: 'isMuted' } as const, false)
const health = atom({ plugin: 'session-tracker', key: 'health' } as const, null)
const SORTS: readonly Sort[] = ['recent', 'project']

const GLYPH: Record<Tier, string> = { waiting: '◆', done: '✓', busy: '●', idle: '○' }
const HEADING: Record<Tier, string> = {
  waiting: 'Needs you',
  done: 'Finished',
  busy: 'Working',
  idle: 'Idle',
}
// Theme keys, so each follows the person's light or dark theme.
const COLOR: Partial<Record<Tier, string>> = {
  waiting: 'warning',
  done: 'success',
  busy: 'suggestion',
}
const SELF_COLOR = 'claude'
const BRANCH_COLOR = 'autoAccept'
const TASK_COLOR = 'suggestion'
const PINNED_COLOR = 'permission'
// A Button's label takes no color of its own, so each sits on a tinted chip:
// theme backgrounds made to carry text, in light and dark alike.
const CHIP = {
  pin: 'memoryBackgroundColor',
  seen: 'diffAddedDimmed',
  message: 'bashMessageBackgroundColor',
  kill: 'diffRemovedDimmed',
  neutral: 'userMessageBackground',
} as const
const SOUND: Partial<Record<Tier, string>> = {
  waiting: 'sounds/attention.wav',
  done: 'sounds/finished.wav',
}

const barColor = (percent: number): string =>
  percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success'

type Held = Meta & { stamp: string; path: string | undefined }
type PollOptions = { isAliveDue?: boolean; isLight?: boolean }
type Cached<T> = { value: T; at: number }

// The module's own memory: rebuilt from disk after a hot reload.
const registry = new Map<string, { mtimeMs: number; record: RegistryRecord }>()
const metas = new Map<string, Held>()
const lastTiers = new Map<string, Tier>()
let alive: Map<number, string> | undefined
let aliveFor = ''
let ticks = 0
let published = ''
let configDirHeld: string | undefined
let selfIdHeld: string | undefined
let seenHeld: Cached<Seen> | undefined
let pinnedHeld: Cached<Set<string>> | undefined
let lastSoundAt = 0
let running: Promise<void> | undefined
let pending: PollOptions | undefined

const configDir = async ($: EngineInterface): Promise<string> => {
  if (configDirHeld === undefined) {
    const override = await $.env.get('CLAUDE_CONFIG_DIR')
    configDirHeld = override || `${(await $.env.get('HOME')) ?? ''}/.claude`
  }

  return configDirHeld
}

const selfId = async ($: EngineInterface): Promise<string> => {
  selfIdHeld ??= await $.session.id()

  return selfIdHeld
}

const loadRegistry = async ($: EngineInterface, dir: string): Promise<void> => {
  const entries = (await $.fs.list(`${dir}/sessions`)).filter(isRegistryFile)
  const names = new Set(entries.map(entry => entry.name))

  for (const name of registry.keys()) {
    if (!names.has(name)) {
      registry.delete(name)
    }
  }

  await Promise.all(
    entries.map(async entry => {
      if (registry.get(entry.name)?.mtimeMs === entry.mtimeMs) {
        return
      }

      const source = await $.fs.read(`${dir}/sessions/${entry.name}`).catch(() => '')
      const record = parseRecord(source)

      if (record) {
        registry.set(entry.name, { mtimeMs: entry.mtimeMs, record })
      } else {
        registry.delete(entry.name)
      }
    }),
  )
}

const records = (): RegistryRecord[] =>
  [...registry.values()].map(held => held.record).filter(isListed)

const liveRecords = (): RegistryRecord[] =>
  records().filter(record => alive === undefined || isLive(record, alive))

// Which registered pids run, and since when: a pid that `ps` lists with
// another start time is a reused one, not the session.
const loadAlive = async ($: EngineInterface, isDue: boolean): Promise<void> => {
  const pids = records()
    .map(record => record.pid)
    .sort((a, b) => a - b)
    .join(',')

  if (!isDue && pids === aliveFor) {
    return
  }

  aliveFor = pids

  if (pids === '') {
    alive = new Map()

    return
  }

  try {
    const { stdout } = await $.process.run(['ps', '-o', 'pid=,lstart=', '-p', pids], {
      env: { TZ: 'UTC' },
    })
    alive = parseAlive(stdout)
  } catch {
    // no `ps` here: trust the registry
    alive = undefined
  }
}

const loadSeen = async ($: EngineInterface, now: number): Promise<Seen> => {
  if (seenHeld && now - seenHeld.at < STORE_TTL_MS) {
    return seenHeld.value
  }

  const held = await $.store.get('seen')
  const seen: Seen = isSeen(held) ? { acked: held.acked } : { acked: {} }

  seenHeld = { value: seen, at: now }

  return seen
}

const saveSeen = async ($: EngineInterface, seen: Seen, now: number): Promise<void> => {
  seenHeld = { value: seen, at: now }
  await $.store.set('seen', seen)
}

// The pinned sessions' ids, kept across sessions: a pinned session that is
// closed and resumed later is still pinned.
const loadPinned = async ($: EngineInterface, now: number): Promise<Set<string>> => {
  if (pinnedHeld && now - pinnedHeld.at < STORE_TTL_MS) {
    return pinnedHeld.value
  }

  const held = await $.store.get('pinned').catch(() => undefined)
  const pinned = new Set(
    Array.isArray(held) ? held.filter((id): id is string => typeof id === 'string') : [],
  )
  pinnedHeld = { value: pinned, at: now }

  return pinned
}

const savePinned = async ($: EngineInterface, pinned: Set<string>, now: number): Promise<void> => {
  pinnedHeld = { value: pinned, at: now }
  await $.store.set('pinned', [...pinned])
}

const findTranscript = async (
  $: EngineInterface,
  dir: string,
  record: RegistryRecord,
): Promise<string | undefined> => {
  const file = `${record.sessionId}.jsonl`
  const expected = `${dir}/projects/${slugOf(record.cwd)}/${file}`

  if (await $.fs.exists(expected).catch(() => false)) {
    return expected
  }

  // The session moved since it started (a worktree, a /cd): look it up by id.
  const found = await $.process
    .run(['find', `${dir}/projects`, '-maxdepth', '2', '-name', file])
    .catch(() => undefined)

  return found?.stdout.split('\n').find(line => line !== '')
}

// Reads a session's title, last prompt, context and branch again when its
// status moved, and on a slow beat while it works. The branch is read only
// for the rows that show it.
const refreshMeta = async (
  $: EngineInterface,
  dir: string,
  record: RegistryRecord,
  tier: Tier,
  now: number,
): Promise<boolean> => {
  const held = metas.get(record.sessionId)
  const beat = record.status === 'busy' ? Math.floor(now / BUSY_REFRESH_MS) : 0
  const wantsBranch = tier === 'waiting' || tier === 'done'
  const stamp = `${record.statusUpdatedAt}:${beat}:${wantsBranch ? 'b' : ''}`

  if (held?.stamp === stamp) {
    return false
  }

  const path = held?.path ?? (await findTranscript($, dir, record))
  const [lines, tail, git] = await Promise.all([
    path === undefined
      ? undefined
      : $.process.run(['grep', '-a', '-E', META_PATTERN, path]).catch(() => undefined),
    path === undefined
      ? undefined
      : $.process.run(['tail', '-c', TAIL_BYTES, path]).catch(() => undefined),
    wantsBranch
      ? $.process
          .run(['git', '-C', record.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
          .catch(() => undefined)
      : undefined,
  ])
  const branch = git?.exitCode === 0 ? git.stdout.trim() : ''
  const context = contextFromTail(tail?.stdout ?? '')

  metas.set(record.sessionId, {
    ...metaFromTranscript(lines?.stdout ?? ''),
    // a response pushed out of the tail by a huge tool result keeps its figure
    ...(context.contextTokens > 0 ? context : { contextTokens: held?.contextTokens ?? 0, model: held?.model ?? '' }),
    branch: wantsBranch ? (branch === 'HEAD' ? '' : branch) : (held?.branch ?? ''),
    stamp,
    path,
  })

  return true
}

// Runs `work` over `items`, at most `limit` at a time.
const inBatches = async <T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = []

  for (let index = 0; index < items.length; index += limit) {
    results.push(...(await Promise.all(items.slice(index, index + limit).map(work))))
  }

  return results
}

const setHealth = async ($: EngineInterface, next: Health | null): Promise<void> => {
  await update($, health, held =>
    held?.error === next?.error ? held : next,
  )
}

// A toast, and a sound unless muted, for each session that just came to need
// you or finished; one sound per burst.
const notify = async ($: EngineInterface, arrived: readonly SessionRow[], now: number): Promise<void> => {
  if (arrived.length === 0) {
    return
  }

  for (const row of arrived) {
    $.ui.toast(
      `${row.project}: ${row.tier === 'waiting' ? 'needs you' : 'finished'} · ${row.title}`,
      { timeoutMs: 6000 },
    )
  }

  const muted = await read($, isMuted)
  const asset = SOUND[arrived.some(row => row.tier === 'waiting') ? 'waiting' : 'done']

  if (muted || asset === undefined || now - lastSoundAt < SOUND_GAP_MS) {
    return
  }

  lastSoundAt = now
  await $.audio.play({ asset }).catch(error => {
    $.ui.log(`session-tracker: sound failed: ${String(error)}`, { to: 'debug' })
  })
}

const publish = async ($: EngineInterface, seen: Seen, now: number): Promise<void> => {
  const usage = await $.session.usage().catch(() => undefined)
  const built = buildRows(
    liveRecords(),
    metas,
    seen,
    now,
    await selfId($),
    usage?.context.window,
    await loadPinned($, now),
    finishedMs,
  )
  const arrived = arrivals(lastTiers, built.rows)

  lastTiers.clear()
  for (const row of built.rows) {
    lastTiers.set(row.sessionId, row.tier)
  }

  const json = JSON.stringify(built)

  if (json !== published) {
    published = json
    await update($, rows, () => built.rows)
    await update($, current, () => built.current)
    await update($, armedPid, pid => (built.rows.some(row => row.pid === pid) ? pid : null))
    await update($, messagingPid, pid => (built.rows.some(row => row.pid === pid) ? pid : null))
  }

  await notify($, arrived, now)
}

const pollOnce = async ($: EngineInterface, options: PollOptions): Promise<void> => {
  const now = await $.clock.now()
  const dir = await configDir($)

  await loadRegistry($, dir)
  await loadAlive($, options.isAliveDue === true)

  const seen = await loadSeen($, now)

  // First what the registry alone says, then again once the titles are in.
  await publish($, seen, now)

  if (options.isLight) {
    return
  }

  const live = liveRecords()
  const tierOf = new Map([...lastTiers])
  const byUrgency = [...live].sort(
    (a, b) =>
      TIERS.indexOf(tierOf.get(a.sessionId) ?? 'idle') -
      TIERS.indexOf(tierOf.get(b.sessionId) ?? 'idle'),
  )
  const changed = await inBatches(byUrgency, META_CONCURRENCY, record =>
    refreshMeta($, dir, record, tierOf.get(record.sessionId) ?? 'idle', now),
  )

  for (const id of metas.keys()) {
    if (!live.some(record => record.sessionId === id)) {
      metas.delete(id)
    }
  }

  if (changed.some(Boolean)) {
    await publish($, seen, now)
  }
}

// One poll at a time. A poll asked for while one runs is folded into one more
// run right after it, and every caller's promise settles once that has run.
const poll = ($: EngineInterface, options: PollOptions = {}): Promise<void> => {
  if (running) {
    pending = {
      isAliveDue: (pending?.isAliveDue ?? false) || options.isAliveDue === true,
      isLight: (pending?.isLight ?? true) && options.isLight === true,
    }

    return running
  }

  running = (async () => {
    let next: PollOptions | undefined = options

    while (next) {
      try {
        await pollOnce($, next)
        await setHealth($, null)
      } catch (error) {
        $.ui.log(`session-tracker: refresh failed: ${String(error)}`, { to: 'debug' })
        await setHealth($, { error: String(error), at: await $.clock.now() })
      }

      next = pending
      pending = undefined
    }
  })().finally(() => {
    running = undefined
  })

  return running
}

const isPaneShown = async ($: EngineInterface): Promise<boolean> =>
  (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)

const markSeen = async ($: EngineInterface, sessionIds: readonly string[]): Promise<void> => {
  const now = await $.clock.now()
  const seen = await loadSeen($, now)
  const known = new Set(records().map(record => record.sessionId))
  const kept = Object.entries(seen.acked).filter(([id]) => known.size === 0 || known.has(id))
  const acked = Object.fromEntries([...kept, ...sessionIds.map(id => [id, now] as const)])

  await saveSeen($, { acked }, now)
  await poll($)
}

const togglePin = async ($: EngineInterface, sessionId: string): Promise<void> => {
  const now = await $.clock.now()
  const pinned = new Set(await loadPinned($, now))

  if (!pinned.delete(sessionId)) {
    pinned.add(sessionId)
  }

  await savePinned($, pinned, now)
  await poll($)
}

const setSort = async ($: EngineInterface, next: Sort): Promise<void> => {
  await update($, sort, () => next)
  await $.store.set('sort', next)
}

// The state scanner wants each atom named where it is read, so one toggle each.
const toggleIdleOpen = async ($: EngineInterface): Promise<void> => {
  const next = !(await read($, isIdleOpen))
  await update($, isIdleOpen, () => next)
  await $.store.set('idleOpen', next)
}

const toggleMuted = async ($: EngineInterface): Promise<void> => {
  const next = !(await read($, isMuted))
  await update($, isMuted, () => next)
  await $.store.set('muted', next)
}

const sendMessage = async ($: EngineInterface, row: SessionRow, text: string): Promise<void> => {
  await update($, messagingPid, () => null)

  if (text.trim() === '') {
    return
  }

  const sent = await $.session
    .send({ to: { sessionId: row.sessionId }, text: text.trim() })
    .catch(error => ({ isDelivered: false as const, reason: String(error) }))

  $.ui.toast(
    sent.isDelivered
      ? `Sent to ${row.project}: ${text.trim()}`
      : `Not sent to ${row.project}: ${sent.reason}`,
  )
}

// Says whether the killed process is gone, checking once a second for a while.
const watchExit = ($: EngineInterface, row: SessionRow, checksLeft: number): void => {
  $.clock.after(1000, () => {
    void (async () => {
      const check = await $.process.run(['ps', '-o', 'pid=', '-p', String(row.pid)]).catch(() => undefined)
      const isGone = check === undefined || check.exitCode !== 0 || check.stdout.trim() === ''

      if (isGone) {
        $.ui.toast(`Closed ${row.project} (pid ${row.pid})`)
        await poll($, { isAliveDue: true })
      } else if (checksLeft > 1) {
        watchExit($, row, checksLeft - 1)
      } else {
        $.ui.toast(`${row.project} (pid ${row.pid}) has not exited yet; it is still listed`)
        await poll($, { isAliveDue: true })
      }
    })()
  })
}

const killSession = async ($: EngineInterface, row: SessionRow): Promise<void> => {
  await update($, armedPid, () => null)
  await poll($, { isAliveDue: true })

  const record = liveRecords().find(one => one.pid === row.pid)

  if (record === undefined || record.sessionId === (await selfId($))) {
    $.ui.toast(`Not killing pid ${row.pid}: it is no longer another live session`)

    return
  }

  const killed = await $.process.run(['kill', '-TERM', String(row.pid)]).catch(() => undefined)

  if (killed?.exitCode !== 0) {
    $.ui.toast(`Could not signal pid ${row.pid}: ${killed?.stderr.trim() || 'kill failed'}`)

    return
  }

  watchExit($, row, EXIT_CHECKS)
}

const loadStoredFlags = async ($: EngineInterface): Promise<void> => {
  const [kept, idle, muted] = await Promise.all([
    $.store.get('sort').catch(() => undefined),
    $.store.get('idleOpen').catch(() => undefined),
    $.store.get('muted').catch(() => undefined),
  ])

  if (isSort(kept)) {
    await update($, sort, () => kept)
  }

  await update($, isIdleOpen, () => idle === true)
  await update($, isMuted, () => muted === true)
}

export const register: Register = (on, options) => {
  // The width is a request: a width the person dragged the dock to wins.
  const width = typeof options.width === 'number' && options.width >= 24 ? options.width : DEFAULT_WIDTH
  const paneArgs = { id: PANE, title: 'Sessions', columns: Math.round(width), rows: 14 } as const
  finishedMs =
    typeof options.finishedHours === 'number' && options.finishedHours > 0
      ? options.finishedHours * 3_600_000
      : undefined

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'sessions',
        description: 'Show every open Claude Code session in a sidebar',
      })
    } catch (error) {
      await setHealth($, { error: `/sessions not registered: ${String(error)}`, at: 0 })
    }

    await loadStoredFlags($)

    // A desktop session may not count as interactive; anything that draws
    // somewhere gets the sidebar and its refreshes. Only a bare `-p` run is out.
    if (e.isInteractive || e.surface !== null) {
      void $.ui.open(paneArgs)
      void poll($, { isAliveDue: true })
      $.clock.every(POLL_MS, () => {
        ticks += 1
        void (async () => {
          if (await isPaneShown($)) {
            await poll($, { isAliveDue: ticks % ALIVE_EVERY === 0 })
          } else if (ticks % HIDDEN_EVERY === 0) {
            await poll($, { isAliveDue: true, isLight: true })
          }
        })()
      })
    }

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open(paneArgs)
    await poll($, { isAliveDue: true })

    return { text: 'Sessions sidebar opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Input = 'Input' in table ? table.Input : undefined
    const list = await read($, rows)
    const self = await read($, current)
    const armed = await read($, armedPid)
    const messaging = await read($, messagingPid)
    const order = await read($, sort)
    const idleOpen = await read($, isIdleOpen)
    const muted = await read($, isMuted)
    const problem = await read($, health)
    const doneIds = list.filter(row => row.tier === 'done').map(row => row.sessionId)
    const pinnedRows = orderRows(list.filter(row => row.isPinned), order)
    const rest = list.filter(row => !row.isPinned)

    const drawContext = (row: SessionRow) => {
      if (row.context === '') {
        return null
      }

      const percent = row.contextPercent
      const filled = percent === null ? 0 : Math.max(1, Math.round((percent / 100) * BAR_CELLS))

      return (
        <Box justifyContent="space-between">
          <Box flexShrink={0}>
            <Text dimColor>{'  '}context </Text>
            {percent !== null && <Text color={barColor(percent)}>{'▰'.repeat(filled)}</Text>}
            {percent !== null && <Text dimColor>{'▱'.repeat(BAR_CELLS - filled)} </Text>}
            <Text>{row.context}</Text>
            {percent !== null && <Text color={barColor(percent)}> {percent}%</Text>}
          </Box>
          <Text dimColor wrap="truncate-end">
            {' '}
            {row.model}
          </Text>
        </Box>
      )
    }

    const chip = (color: string, control: JSX.Element) => <Box backgroundColor={color}>{control}</Box>

    const drawActions = (row: SessionRow) => (
      <Box flexWrap="wrap" columnGap={1} paddingLeft={2}>
        {chip(
          CHIP.pin,
          <Button
            key={`pin-${row.pid}`}
            label={row.isPinned ? '★ unpin' : '☆ pin'}
            onPress={() => void togglePin($, row.sessionId)}
          />,
        )}
        {row.tier === 'done' &&
          chip(
            CHIP.seen,
            <Button
              key={`seen-${row.pid}`}
              label="✓ seen"
              onPress={() => void markSeen($, [row.sessionId])}
            />,
          )}
        {Input !== undefined &&
          chip(
            CHIP.message,
            <Button
              key={`message-${row.pid}`}
              label="✉ message"
              onPress={() => void update($, messagingPid, () => row.pid)}
            />,
          )}
        {chip(
          CHIP.kill,
          <Button
            key={`kill-${row.pid}`}
            label="✕ kill"
            onPress={() => void update($, armedPid, () => row.pid)}
          />,
        )}
      </Box>
    )

    const drawConfirm = (row: SessionRow) => (
      <Box flexWrap="wrap" columnGap={1} paddingLeft={2}>
        <Text color="error">
          {row.tier === 'busy' ? 'It is still working. Kill anyway?' : 'Kill this session?'}
        </Text>
        {chip(
          CHIP.kill,
          <Button key={`yes-${row.pid}`} label="yes" onPress={() => void killSession($, row)} />,
        )}
        {chip(
          CHIP.neutral,
          <Button
            key={`no-${row.pid}`}
            label="no"
            onPress={() => void update($, armedPid, () => null)}
          />,
        )}
      </Box>
    )

    const drawMessage = (row: SessionRow) =>
      Input === undefined ? null : (
        <Box flexDirection="column" paddingLeft={2}>
          <Input
            key={`message-${row.pid}`}
            placeholder={`message to ${row.project}, Enter sends`}
            submitLabel="send"
            autoFocus
            onSubmit={value => void sendMessage($, row, value)}
          />
          {chip(
            CHIP.neutral,
            <Button
              key={`cancel-${row.pid}`}
              label="cancel"
              onPress={() => void update($, messagingPid, () => null)}
            />,
          )}
        </Box>
      )

    const drawRow = (row: SessionRow, index: number) => (
      <Box flexDirection="column" marginTop={index === 0 ? 0 : 1}>
        <Box justifyContent="space-between">
          <Text bold wrap="truncate-end" dimColor={row.tier === 'idle'} color={COLOR[row.tier]}>
            {GLYPH[row.tier]} {row.project}
            {row.isPinned ? ' ★' : ''}
          </Text>
          <Box flexShrink={0}>
            <Text dimColor> {row.age}</Text>
          </Box>
        </Box>
        <Text wrap="truncate-end" dimColor={row.tier === 'idle'}>
          {'  '}
          {row.title}
        </Text>
        {drawContext(row)}
        {row.task !== '' && (
          <Box>
            <Text dimColor>{'  '}task </Text>
            <Text wrap="truncate-end" color={TASK_COLOR}>
              {row.task}
            </Text>
          </Box>
        )}
        {row.tier === 'waiting' && row.waitingFor !== '' && (
          <Text wrap="truncate-end" color="warning">
            {'  '}waiting: {row.waitingFor}
          </Text>
        )}
        {(row.tier === 'waiting' || row.tier === 'done') && row.branch !== '' && (
          <Text wrap="truncate-end" color={BRANCH_COLOR}>
            {'  '}⎇ {row.branch}
          </Text>
        )}
        {(row.tier === 'waiting' || row.tier === 'done') && row.lastPrompt !== '' && (
          <Text wrap="truncate-end" dimColor italic>
            {'  '}› {row.lastPrompt}
          </Text>
        )}
        {armed === row.pid
          ? drawConfirm(row)
          : messaging === row.pid
            ? drawMessage(row)
            : drawActions(row)}
      </Box>
    )

    const drawTier = (tier: Tier) => {
      const members = rest.filter(row => row.tier === tier)
      const isCollapsed = tier === 'idle' && !idleOpen

      if (members.length === 0) {
        return null
      }

      return (
        <Box flexDirection="column" marginTop={1}>
          <Box justifyContent="space-between" marginBottom={isCollapsed ? 0 : 1}>
            <Text bold dimColor={tier === 'idle'} color={COLOR[tier]}>
              {HEADING[tier]} ({members.length})
            </Text>
            {tier === 'done' && (
              <Button
                key="seen-all"
                label="clear"
                plain
                dimColor
                onPress={() => void markSeen($, members.map(row => row.sessionId))}
              />
            )}
            {tier === 'idle' && (
              <Button
                key="idle-toggle"
                label={idleOpen ? 'hide' : 'show'}
                plain
                dimColor
                onPress={() => void toggleIdleOpen($)}
              />
            )}
          </Box>
          {!isCollapsed && members.map(drawRow)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>This session</Text>
        <Text bold wrap="truncate-end" color={SELF_COLOR}>
          ▸ {self?.project ?? '…'}
        </Text>
        {self !== null && (
          <Text wrap="truncate-end">
            {'  '}
            {self.title}
          </Text>
        )}
        {self !== null && drawContext(self)}
        <Box flexWrap="wrap" columnGap={1} marginTop={1}>
          <Button
            key="refresh"
            label="↻ refresh"
            onPress={() => void poll($, { isAliveDue: true })}
          />
          <Button
            key="sound"
            label={muted ? '🔕 sound off' : '🔔 sound on'}
            onPress={() => void toggleMuted($)}
          />
        </Box>
        {problem !== null && (
          <Text wrap="wrap" color="error">
            refresh failed: {problem.error}
          </Text>
        )}
        {list.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No other sessions open.</Text>
          </Box>
        )}
        {list.length > 0 && (
          <Box justifyContent="space-between" marginTop={1}>
            <Box columnGap={1}>
              <Text dimColor>Sort:</Text>
              {SORTS.map(one => (
                <Button
                  key={`sort-${one}`}
                  label={one}
                  variant={one === order ? 'primary' : 'secondary'}
                  dimColor={one !== order}
                  onPress={() => void setSort($, one)}
                />
              ))}
            </Box>
            {order === 'project' && doneIds.length > 0 && (
              <Button
                key="seen-all"
                label="clear"
                plain
                dimColor
                onPress={() => void markSeen($, doneIds)}
              />
            )}
          </Box>
        )}
        {pinnedRows.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box marginBottom={1}>
              <Text bold color={PINNED_COLOR}>
                ★ Pinned ({pinnedRows.length})
              </Text>
            </Box>
            {pinnedRows.map(drawRow)}
          </Box>
        )}
        {order === 'recent' && TIERS.map(drawTier)}
        {order === 'project' && rest.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {pinnedRows.length > 0 && (
              <Box marginBottom={1}>
                <Text bold dimColor>
                  Others ({rest.length})
                </Text>
              </Box>
            )}
            {orderRows(rest, order).map(drawRow)}
          </Box>
        )}
      </Box>
    )
  })
}
