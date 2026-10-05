export type Tier = 'waiting' | 'done' | 'busy' | 'idle'

// How the list is ordered: by state then recency under group headings, or
// one flat list by project name.
export type Sort = 'recent' | 'project'

export type SessionRow = {
  pid: number
  sessionId: string
  project: string
  title: string
  tier: Tier
  age: string
  waitingFor: string
  branch: string
  lastPrompt: string
  // Input tokens the session's last response was answered over, as `312k`;
  // empty before its first response.
  context: string
  // That over the model's window, 0 to 100; null when the window is unknown.
  contextPercent: number | null
  // The model that answered last, short: `fable 5.1`; empty before a response.
  model: string
  // Where a working session stands in its task list, as `3/7 Running tests`;
  // empty with no list, or with every task done.
  task: string
  // Pinned rows sit in a group of their own above every other.
  isPinned: boolean
}

// The last refresh that failed, shown in the pane until one succeeds.
export type Health = {
  error: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-tracker': {
      rows: SessionRow[]
      current: SessionRow | null
      // The row whose kill awaits its yes or no.
      armedPid: number | null
      // The row whose message field is open.
      messagingPid: number | null
      sort: Sort
      isIdleOpen: boolean
      isMuted: boolean
      health: Health | null
    }
  }
}
