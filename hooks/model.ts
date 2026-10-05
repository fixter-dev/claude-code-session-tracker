import type { SessionRow, Sort, Tier } from '../types'

// One ~/.claude/sessions/<pid>.json file, the fields the sidebar reads.
export type RegistryRecord = {
  pid: number
  sessionId: string
  cwd: string
  name: string
  nameSource: string
  kind: string
  status: string
  waitingFor: string
  statusUpdatedAt: number
  startedAt: number
  // When the process started, as `ps -o lstart=` prints it in UTC; the
  // registry's own pid-reuse guard, empty in an older record.
  procStart: string
}

// What a session's transcript and working copy say about it.
export type Meta = {
  title: string
  lastPrompt: string
  task: string
  branch: string
  contextTokens: number
  model: string
}

// Which finished turns the person has already dismissed: everything before
// `baseline`, and per session everything up to its `acked` time.
export type Seen = {
  baseline: number
  acked: Record<string, number>
}

export const TIERS: readonly Tier[] = ['waiting', 'done', 'busy', 'idle']

// The transcript rows the sidebar reads whole: the title and prompt
// bookkeeping, and every row that made or moved a task.
export const META_PATTERN =
  '^\\{"type":"(ai-title|last-prompt)"|"name":"(TodoWrite|TaskCreate|TaskUpdate)"|"toolUseResult":\\{"task":\\{"id"'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

export const isRegistryFile = (entry: { name: string; kind: string }): boolean =>
  entry.kind === 'file' && /^\d+\.json$/.test(entry.name)

export const parseRecord = (source: string): RegistryRecord | undefined => {
  let raw: unknown

  try {
    raw = JSON.parse(source)
  } catch {
    return undefined
  }

  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }

  const fields = raw as Record<string, unknown>
  const pid = number(fields.pid)
  const sessionId = text(fields.sessionId)

  if (pid <= 0 || sessionId === '') {
    return undefined
  }

  return {
    pid,
    sessionId,
    cwd: text(fields.cwd),
    name: text(fields.name),
    nameSource: text(fields.nameSource),
    kind: text(fields.kind),
    status: text(fields.status),
    waitingFor: text(fields.waitingFor),
    statusUpdatedAt: number(fields.statusUpdatedAt) || number(fields.startedAt),
    startedAt: number(fields.startedAt),
    procStart: text(fields.procStart),
  }
}

const squeeze = (value: string): string => value.trim().replace(/\s+/g, ' ')

// `ps -o pid=,lstart=` (run under TZ=UTC): each live pid and when it started.
export const parseAlive = (stdout: string): Map<number, string> => {
  const alive = new Map<number, string>()

  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)

    if (match) {
      alive.set(Number(match[1]), squeeze(match[2] ?? ''))
    }
  }

  return alive
}

// A registry file outlives its process, and a pid is reused: the session is
// live only while a process with its pid AND its start time runs.
export const isLive = (record: RegistryRecord, alive: ReadonlyMap<number, string>): boolean => {
  const started = alive.get(record.pid)

  if (started === undefined) {
    return false
  }

  return record.procStart === '' || squeeze(record.procStart) === started
}

// A turn must have ended since the session started: a session that was only
// opened carries its start time as its status time.
const TURN_MIN_MS = 2000

// Only sessions a person has open: a headless run (`claude -p`, as a status
// line's usage feeder starts every few minutes) registers too, and is not one.
export const isListed = (record: RegistryRecord): boolean =>
  record.kind === '' || record.kind === 'interactive'

export const isSeen = (value: unknown): value is Seen => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { baseline, acked } = value as Record<string, unknown>

  return typeof baseline === 'number' && typeof acked === 'object' && acked !== null
}

export const projectOf = (cwd: string): string =>
  cwd.split('/').filter(Boolean).at(-1) ?? cwd

// The folder under ~/.claude/projects a session started in `cwd` writes to.
export const slugOf = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

type Task = { subject: string; activeForm: string; status: string }

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

// Replays one transcript row onto the task list: a TodoWrite replaces it, a
// TaskCreate's result adds a task under the id it was given, a TaskUpdate
// moves one.
const applyTaskRow = (
  row: Record<string, unknown>,
  tasks: Map<string, Task>,
  forms: Map<string, string>,
): void => {
  if (row.isSidechain === true) {
    return
  }

  const created = record(record(row.toolUseResult).task)

  if (row.type === 'user' && typeof created.id === 'string' && !tasks.has(created.id)) {
    const subject = text(created.subject)

    tasks.set(created.id, {
      subject,
      activeForm: forms.get(subject) ?? '',
      status: text(created.status) || 'pending',
    })
  }

  const content = record(row.message).content

  if (row.type !== 'assistant' || !Array.isArray(content)) {
    return
  }

  for (const block of content.map(record)) {
    const input = record(block.input)

    if (block.type !== 'tool_use') {
      continue
    }

    if (block.name === 'TaskCreate') {
      forms.set(text(input.subject), text(input.activeForm))
    }

    if (block.name === 'TaskUpdate') {
      const held = tasks.get(text(input.taskId))

      if (input.status === 'deleted') {
        tasks.delete(text(input.taskId))
      } else if (held) {
        held.subject = text(input.subject) || held.subject
        held.activeForm = text(input.activeForm) || held.activeForm
        held.status = text(input.status) || held.status
      }
    }

    if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
      tasks.clear()
      input.todos.map(record).forEach((todo, index) => {
        tasks.set(String(index), {
          subject: text(todo.content),
          activeForm: text(todo.activeForm),
          status: text(todo.status),
        })
      })
    }
  }
}

const taskLine = (tasks: ReadonlyMap<string, Task>): string => {
  const all = [...tasks.values()]
  const done = all.filter(task => task.status === 'completed').length

  if (all.length === 0 || done === all.length) {
    return ''
  }

  const active = all.find(task => task.status === 'in_progress')

  return active
    ? `${done + 1}/${all.length} ${active.activeForm || active.subject}`
    : `${done}/${all.length} done`
}

// The newest title and prompt among the transcript's bookkeeping lines, and
// where its task list stands.
export const metaFromTranscript = (
  lines: string,
): Pick<Meta, 'title' | 'lastPrompt' | 'task'> => {
  let title = ''
  let lastPrompt = ''
  const tasks = new Map<string, Task>()
  const forms = new Map<string, string>()

  for (const line of lines.split('\n')) {
    if (line === '') {
      continue
    }

    try {
      const row = JSON.parse(line) as Record<string, unknown>

      if (row.type === 'ai-title') {
        title = text(row.aiTitle) || title
      }

      if (row.type === 'last-prompt') {
        lastPrompt = text(row.lastPrompt) || lastPrompt
      }

      applyTaskRow(row, tasks, forms)
    } catch {
      // a line cut short mid-write: the next poll reads it whole
    }
  }

  return { title, lastPrompt: lastPrompt.replace(/\s+/g, ' ').trim(), task: taskLine(tasks) }
}

// The context the session's last response was answered over, read from the
// transcript's tail: the newest main-thread assistant row that has a usage.
export const contextFromTail = (
  tail: string,
): Pick<Meta, 'contextTokens' | 'model'> => {
  const lines = tail.split('\n')

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''

    if (!line.includes('"usage"')) {
      continue
    }

    try {
      const row = JSON.parse(line) as Record<string, unknown>
      const message = row.message as Record<string, unknown> | undefined
      const usage = message?.usage as Record<string, unknown> | undefined

      if (row.type !== 'assistant' || row.isSidechain === true || !usage) {
        continue
      }

      // an error row the engine wrote itself: no model answered it
      if (text(message?.model).startsWith('<')) {
        continue
      }

      return {
        contextTokens:
          number(usage.input_tokens) +
          number(usage.cache_creation_input_tokens) +
          number(usage.cache_read_input_tokens),
        model: text(message?.model),
      }
    } catch {
      // the tail's first line is cut mid-row
    }
  }

  return { contextTokens: 0, model: '' }
}

// `claude-fable-5-1` reads `fable 5.1`, `claude-haiku-4-5-20251001` `haiku 4.5`.
export const shortModel = (model: string): string =>
  model
    .replace(/^claude-/, '')
    .replace(/\[.*\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-(\d+)$/, ' $1')

export const formatTokens = (tokens: number): string => {
  if (tokens <= 0) {
    return ''
  }

  if (tokens < 1000) {
    return String(tokens)
  }

  return tokens < 999_500
    ? `${Math.round(tokens / 1000)}k`
    : `${(tokens / 1_000_000).toFixed(1)}M`
}

const STANDARD_WINDOW = 200_000
const LONG_WINDOW = 1_000_000

// A transcript does not record its model's window: a session on this
// session's model has this session's window, and one already past the
// standard window must be on the long one. Otherwise unknown.
const windowOf = (
  meta: Meta | undefined,
  selfMeta: Meta | undefined,
  selfWindow: number | undefined,
): number | undefined => {
  if (meta === undefined || meta.contextTokens <= 0) {
    return undefined
  }

  if (selfWindow !== undefined && meta.model !== '' && meta.model === selfMeta?.model) {
    return Math.max(selfWindow, meta.contextTokens > STANDARD_WINDOW ? LONG_WINDOW : 0)
  }

  return meta.contextTokens > STANDARD_WINDOW ? LONG_WINDOW : undefined
}

export const formatAge = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)

  if (minutes < 1) {
    return 'now'
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

export const DEFAULT_FINISHED_MS = 4 * 3_600_000

// Finished is for turns that ended recently and were not dismissed: an old
// one is just idle.
export const tierOf = (
  record: RegistryRecord,
  seen: Seen,
  now: number,
  finishedMs = DEFAULT_FINISHED_MS,
): Tier => {
  if (record.status === 'waiting') {
    return 'waiting'
  }

  if (record.status === 'busy') {
    return 'busy'
  }

  const seenAt = Math.max(seen.baseline, seen.acked[record.sessionId] ?? 0)
  const hasTurn = record.statusUpdatedAt - record.startedAt > TURN_MIN_MS
  const isRecent = now - record.statusUpdatedAt < finishedMs

  return hasTurn && isRecent && record.statusUpdatedAt > seenAt ? 'done' : 'idle'
}

// A name the person or a peer gave wins; then the transcript's own title; the
// registry's derived name (`docs-8f`) only when there is nothing better.
const titleOf = (record: RegistryRecord, meta: Meta | undefined): string => {
  const isNamed = record.nameSource === 'user' || record.nameSource === 'peer'

  if (isNamed && record.name !== '') {
    return record.name
  }

  return meta?.title || record.name || record.sessionId.slice(0, 8)
}

// The sessions that just moved into a state worth a notice (waiting or done),
// judged against the tiers last published; a session never seen before is not
// one, so a fresh load stays quiet.
export const arrivals = (
  before: ReadonlyMap<string, Tier>,
  rows: readonly SessionRow[],
): SessionRow[] =>
  rows.filter(row => {
    const was = before.get(row.sessionId)

    return was !== undefined && was !== row.tier && (row.tier === 'waiting' || row.tier === 'done')
  })

export const isSort = (value: unknown): value is Sort =>
  value === 'recent' || value === 'project'

// `rows` arrive by state then recency; by project, sessions of one project
// sit together and keep that order among themselves.
export const orderRows = (rows: readonly SessionRow[], sort: Sort): SessionRow[] =>
  sort === 'recent'
    ? [...rows]
    : rows
        .map((row, index) => ({ row, index }))
        .sort(
          (a, b) =>
            a.row.project.localeCompare(b.row.project, undefined, { sensitivity: 'base' }) ||
            a.index - b.index,
        )
        .map(({ row }) => row)

export const buildRows = (
  records: readonly RegistryRecord[],
  metas: ReadonlyMap<string, Meta>,
  seen: Seen,
  now: number,
  selfId: string,
  selfWindow?: number,
  pinned: ReadonlySet<string> = new Set(),
  finishedMs = DEFAULT_FINISHED_MS,
): { current: SessionRow | null; rows: SessionRow[] } => {
  const selfMeta = metas.get(selfId)
  const stamps = new Map(records.map(r => [r.sessionId, r.statusUpdatedAt]))
  const all = records.map((record): SessionRow => {
    const meta = metas.get(record.sessionId)
    const tier = tierOf(record, seen, now, finishedMs)
    const window = windowOf(meta, selfMeta, selfWindow)
    const tokens = meta?.contextTokens ?? 0

    return {
      pid: record.pid,
      sessionId: record.sessionId,
      project: projectOf(record.cwd),
      title: titleOf(record, meta),
      tier,
      age: formatAge(now - record.statusUpdatedAt),
      waitingFor: record.waitingFor,
      branch: meta?.branch ?? '',
      lastPrompt: meta?.lastPrompt ?? '',
      context: formatTokens(tokens),
      model: shortModel(meta?.model ?? ''),
      contextPercent:
        window === undefined ? null : Math.min(100, Math.round((tokens / window) * 100)),
      task: tier === 'busy' || tier === 'waiting' ? (meta?.task ?? '') : '',
      isPinned: pinned.has(record.sessionId),
    }
  })
  const rows = all
    .filter(row => row.sessionId !== selfId)
    .sort(
      (a, b) =>
        TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) ||
        (stamps.get(b.sessionId) ?? 0) - (stamps.get(a.sessionId) ?? 0) ||
        a.pid - b.pid,
    )

  return { current: all.find(row => row.sessionId === selfId) ?? null, rows }
}
