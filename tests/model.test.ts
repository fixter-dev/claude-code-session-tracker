import { expect, test } from 'claude-code/testing'

import {
  arrivals,
  buildRows,
  contextFromTail,
  isListed,
  isLive,
  formatAge,
  formatTokens,
  shortModel,
  metaFromTranscript,
  orderRows,
  parseAlive,
  parseRecord,
  slugOf,
} from '../hooks/model'
import type { Meta, RegistryRecord } from '../hooks/model'

const NOW = 10_000_000
const record = (fields: Partial<RegistryRecord>): RegistryRecord => ({
  pid: 1,
  sessionId: 's1',
  cwd: '/Users/me/Projects/docs',
  name: 'docs-8f',
  nameSource: 'derived',
  kind: 'interactive',
  status: 'idle',
  waitingFor: '',
  statusUpdatedAt: NOW - 60_000,
  startedAt: NOW - 3_600_000,
  procStart: 'Fri Oct  2 10:00:00 2026',
  ...fields,
})

const META: Meta = { title: '', lastPrompt: '', task: '', branch: '', contextTokens: 0, model: '' }

test('a registry file parses, and a broken one is skipped', () => {
  const parsed = parseRecord(
    JSON.stringify({ pid: 42, sessionId: 'abc', cwd: '/x/docs', status: 'busy', startedAt: 5 }),
  )

  expect(parsed).toMatchObject({ pid: 42, sessionId: 'abc', status: 'busy', statusUpdatedAt: 5 })
  expect(parseRecord('{"pid": 4')).toBeUndefined()
  expect(['interactive', '', 'sdk'].map(kind => isListed(record({ kind })))).toEqual([true, true, false])
  expect(parseRecord('{"sessionId":"no-pid"}')).toBeUndefined()
})

test('the transcript folder is the cwd with every other character dashed', () => {
  expect(slugOf('/Users/me/Projects/luunai/docs')).toBe('-Users-me-Projects-luunai-docs')
})

test('the newest title and prompt win, and a cut line is ignored', () => {
  const lines = [
    '{"type":"ai-title","aiTitle":"Old"}',
    '{"type":"last-prompt","lastPrompt":"first"}',
    '{"type":"ai-title","aiTitle":"Monitoring env down"}',
    '{"type":"last-prompt","lastPrompt":"do the\\n pr"}',
    '{"type":"ai-title","aiTit',
  ].join('\n')

  expect(metaFromTranscript(lines)).toEqual({
    title: 'Monitoring env down',
    lastPrompt: 'do the pr',
    task: '',
  })
})

test('a task list replays to the task in progress out of the total', () => {
  const use = (name: string, input: object) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input }] } })
  const made = (id: string, subject: string) =>
    JSON.stringify({ type: 'user', toolUseResult: { task: { id, subject } } })
  const created = ['Explore', 'Design', 'Build'].flatMap((subject, index) => [
    use('TaskCreate', { subject, description: '', activeForm: `${subject}ing` }),
    made(String(index + 1), subject),
  ])
  const task = (...rows: string[]) => metaFromTranscript([...created, ...rows].join('\n')).task

  expect(task()).toBe('0/3 done')
  expect(
    task(
      use('TaskUpdate', { taskId: '1', status: 'completed' }),
      use('TaskUpdate', { taskId: '2', status: 'in_progress' }),
    ),
  ).toBe('2/3 Designing')
  expect(task(use('TaskUpdate', { taskId: '3', status: 'deleted' }))).toBe('0/2 done')
  expect(
    task(...['1', '2', '3'].map(taskId => use('TaskUpdate', { taskId, status: 'completed' }))),
  ).toBe('')
  expect(
    task(
      use('TodoWrite', {
        todos: [
          { content: 'a', status: 'completed', activeForm: 'A-ing' },
          { content: 'b', status: 'in_progress', activeForm: 'B-ing' },
        ],
      }),
    ),
  ).toBe('2/2 B-ing')
})

test('ages read as now, minutes, hours, days', () => {
  expect(formatAge(20_000)).toBe('now')
  expect(formatAge(52 * 60_000)).toBe('52m')
  expect(formatAge(20 * 3_600_000)).toBe('20h')
  expect(formatAge(72 * 3_600_000)).toBe('3d')
})

test('rows sort waiting, finished, busy, idle, and leave this session out', () => {
  const seen = { baseline: NOW - 3_600_000, acked: { acked: NOW } }
  const metas = new Map<string, Meta>([
    ['done', { ...META, title: 'Monitoring env down', lastPrompt: 'do the pr', branch: 'fix/x' }],
  ])
  const built = buildRows(
    [
      record({ pid: 1, sessionId: 'old', statusUpdatedAt: NOW - 7_200_000 }),
      record({ pid: 2, sessionId: 'busy', status: 'busy' }),
      record({ pid: 3, sessionId: 'done', cwd: '/p/ingestion-service' }),
      record({ pid: 4, sessionId: 'wait', status: 'waiting', waitingFor: 'permission' }),
      record({ pid: 5, sessionId: 'acked' }),
      record({ pid: 6, sessionId: 'self', status: 'busy' }),
      record({ pid: 7, sessionId: 'named', name: 'my name', nameSource: 'user' }),
    ],
    metas,
    seen,
    NOW,
    'self',
  )

  expect(built.current?.pid).toBe(6)
  expect(built.rows.map(row => `${row.sessionId}:${row.tier}`)).toEqual([
    'wait:waiting',
    'done:done',
    'named:done',
    'busy:busy',
    'acked:idle',
    'old:idle',
  ])
  expect(built.rows[1]).toMatchObject({
    project: 'ingestion-service',
    title: 'Monitoring env down',
    branch: 'fix/x',
    age: '1m',
  })
  expect(built.rows[2]?.title).toBe('my name')

  // by project: one project's sessions together, state order kept among them
  const projects = buildRows(
    [
      record({ pid: 1, sessionId: 'a', cwd: '/p/sales' }),
      record({ pid: 2, sessionId: 'b', cwd: '/p/Docs', status: 'busy' }),
      record({ pid: 3, sessionId: 'c', cwd: '/p/docs' }),
      record({ pid: 4, sessionId: 'd', cwd: '/p/api', status: 'busy' }),
    ],
    metas,
    seen,
    NOW,
    'self',
  ).rows

  expect(projects.map(row => row.sessionId)).toEqual(['a', 'c', 'b', 'd'])
  expect(orderRows(projects, 'recent').map(row => row.sessionId)).toEqual(['a', 'c', 'b', 'd'])
  expect(orderRows(projects, 'project').map(row => row.sessionId)).toEqual(['d', 'c', 'b', 'a'])

  const pinned = buildRows([record({ sessionId: 'a' }), record({ pid: 2, sessionId: 'b' })], metas, seen, NOW, 'self', undefined, new Set(['b']))
  expect(pinned.rows.map(row => [row.sessionId, row.isPinned])).toEqual([['a', false], ['b', true]])
  expect(built.rows[5]?.title).toBe('docs-8f')
})

test('context is the newest main-thread response, against a known window', () => {
  const usage = (tokens: number, extra = '') =>
    `{"type":"assistant"${extra},"message":{"model":"m1","usage":{"input_tokens":2,"cache_creation_input_tokens":8,"cache_read_input_tokens":${tokens}}}}`
  const tail = ['cut-mid-row"usage"}', usage(100_000), usage(311_990), usage(5, ',"isSidechain":true')].join('\n')

  expect(contextFromTail(tail)).toEqual({ contextTokens: 312_000, model: 'm1' })
  expect(contextFromTail('')).toEqual({ contextTokens: 0, model: '' })
  expect([0, 950, 312_000, 1_240_000].map(formatTokens)).toEqual(['', '950', '312k', '1.2M'])
  expect(contextFromTail([usage(100_000), usage(0).replace('"m1"', '"<synthetic>"')].join('\n'))).toEqual({
    contextTokens: 100_010,
    model: 'm1',
  })
  expect(
    ['claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-opus-5-5[1m]', ''].map(shortModel),
  ).toEqual(['fable 5.1', 'haiku 4.5', 'opus 5.5', ''])

  const metas = new Map<string, Meta>([
    ['self', { ...META, contextTokens: 100_000, model: 'm1' }],
    ['same', { ...META, contextTokens: 500_000, model: 'm1' }],
    ['other', { ...META, contextTokens: 150_000, model: 'm2' }],
    ['long', { ...META, contextTokens: 300_000, model: 'm2' }],
  ])
  const built = buildRows(
    ['self', 'same', 'other', 'long', 'fresh'].map((sessionId, pid) => record({ pid: pid + 1, sessionId })),
    metas,
    { baseline: NOW, acked: {} },
    NOW,
    'self',
    1_000_000,
  )
  const context = Object.fromEntries(
    [built.current, ...built.rows].map(row => [row?.sessionId, [row?.context, row?.contextPercent]]),
  )

  expect(context).toEqual({
    self: ['100k', 10],
    same: ['500k', 50],
    other: ['150k', null],
    long: ['300k', 30],
    fresh: ['', null],
  })
})

test('a turn that finished long ago is idle, within the window finished', () => {
  // a real epoch time, so hours ago stay positive
  const T = 1_800_000_000_000
  const seen = { baseline: T - 48 * 3_600_000, acked: {} }
  const rowsFor = (hoursAgo: number, finishedMs?: number) =>
    buildRows(
      [record({ sessionId: 'x', startedAt: T - 72 * 3_600_000, statusUpdatedAt: T - hoursAgo * 3_600_000 })],
      new Map(),
      seen,
      T,
      'self',
      undefined,
      new Set(),
      finishedMs,
    ).rows[0]?.tier

  expect(rowsFor(1)).toBe('done')
  expect(rowsFor(19)).toBe('idle')
  expect(rowsFor(19, 24 * 3_600_000)).toBe('done')
})

test('a session that was only opened is idle, not finished', () => {
  const seen = { baseline: NOW - 3_600_000, acked: {} }
  const opened = record({ sessionId: 'new', startedAt: NOW - 60_000, statusUpdatedAt: NOW - 60_000 })
  const turned = record({ sessionId: 'old', startedAt: NOW - 600_000, statusUpdatedAt: NOW - 60_000 })

  expect(buildRows([opened, turned], new Map(), seen, NOW, 'self').rows.map(row => row.tier)).toEqual([
    'done',
    'idle',
  ])
})

test('a pid is live only with the start time the registry recorded', () => {
  const alive = parseAlive(' 101 Fri Oct  2 10:00:00 2026   \n  202 Sat Oct  3 09:00:00 2026\n')

  expect([...alive]).toEqual([
    [101, 'Fri Oct 2 10:00:00 2026'],
    [202, 'Sat Oct 3 09:00:00 2026'],
  ])
  expect(isLive(record({ pid: 101 }), alive)).toBe(true)
  expect(isLive(record({ pid: 202 }), alive)).toBe(false)
  expect(isLive(record({ pid: 202, procStart: '' }), alive)).toBe(true)
  expect(isLive(record({ pid: 303 }), alive)).toBe(false)
})

test('arrivals are sessions that moved into waiting or finished', () => {
  const seen = { baseline: NOW - 3_600_000, acked: {} }
  const { rows } = buildRows(
    [
      record({ pid: 1, sessionId: 'a', status: 'waiting' }),
      record({ pid: 2, sessionId: 'b' }),
      record({ pid: 3, sessionId: 'c', status: 'busy' }),
      record({ pid: 4, sessionId: 'd' }),
    ],
    new Map(),
    seen,
    NOW,
    'self',
  )
  const before = new Map<string, 'waiting' | 'done' | 'busy' | 'idle'>([
    ['a', 'busy'],
    ['b', 'busy'],
    ['c', 'idle'],
  ])

  expect(arrivals(before, rows).map(row => row.sessionId)).toEqual(['a', 'b'])
  expect(arrivals(new Map(), rows)).toEqual([])
})
