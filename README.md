# Claude Code Session Tracker

An unofficial [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that opens a sidebar listing every Claude Code session open on your machine, the ones that need you first. It tells you when another session finishes or waits on you, and lets you message or close a session without switching to it.

![Claude Code 2.1.289+](https://img.shields.io/badge/Claude%20Code-2.1.289%2B-d97757)
![Mods API: early access](https://img.shields.io/badge/mods%20API-early%20access-orange)
![Unofficial](https://img.shields.io/badge/status-unofficial-lightgrey)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

> [!IMPORTANT]
> **Fullscreen mode is recommended.** It docks the list as a sidebar with mouse clicks. Run `/tui fullscreen` once, or start a single session with `CLAUDE_CODE_NO_FLICKER=1 claude`. In the default layout the list sits above the prompt instead.

## Install

You need Claude Code 2.1.289 or later, with mods available to your account. See [Check whether mods can load](https://code.claude.com/docs/en/plugins/mods/troubleshoot#check-whether-mods-can-load).

From your shell:

```sh
claude plugin marketplace add fixter-dev/claude-code-session-tracker
claude plugin install session-tracker@claude-code-session-tracker
```

To update later, run `claude plugin update session-tracker@claude-code-session-tracker`.

To try it for one session without installing:

```sh
git clone https://github.com/fixter-dev/claude-code-session-tracker
claude --plugin-dir ./claude-code-session-tracker
```

## Use

Run `/sessions` to open the sidebar. In the fullscreen layout on a wide terminal it also opens by itself.

The current session is pinned at the top. The others are grouped, most recent first:

| Group | Meaning |
| --- | --- |
| Needs you | Waiting on a permission prompt or a question, with the reason |
| Finished | Ended a turn in the last few hours and not yet dismissed |
| Working | Mid-turn |
| Idle | Everything else; collapsed until you press `show` |

Each row shows the project, the session's title, its context use (`context ▰▰▱▱▱▱▱▱ 312k 31%`) and model, and, for a working session with a task list, the task it is on. Needs-you and Finished rows also show the branch and your last prompt.

Per row:

- `pin` keeps the session in a Pinned group at the top, across restarts.
- `seen` dismisses a Finished session to Idle; `clear` does that for the whole group.
- `message` sends a line to that session, which its Claude picks up as a prompt.
- `kill` closes the session after a yes/no confirm.

`Sort:` switches between the grouped view and one flat list by project. When another session comes to need you or finishes, you get a toast and a short sound; `sound on/off` mutes it. `refresh` re-reads everything now, and any failure to do so is shown in the pane.

## Settings

Both are rows in `/config`.

| Setting | Default | What it does |
| --- | --- | --- |
| Sidebar width | 56 | Columns the sidebar opens at when docked. Dragging its edge wins. |
| Finished for how long | 4 | Hours a finished session stays under Finished before it counts as idle. |

## Notes

- **Only this machine.** It reads the session registry and transcripts under `~/.claude`, so sessions running in the cloud never appear. Headless runs (`claude -p`) are hidden.
- **Context percentages are partly inferred.** A transcript does not record the model's window, so sessions on this session's model use its window, anything past 200k tokens is taken as a 1M window, and the rest show tokens only.
- **Finished is a guess.** The mod cannot tell whether you looked at a terminal, so a session stays Finished until you dismiss it, it works again, or the hours run out.
- **Pins, dismissals and the sort order are shared** by every session on the machine, under `~/.claude/plugins/store/`.
- **Early access API.** Mods can change between Claude Code releases, so an update may break this one.
- **macOS first.** Sounds play through `afplay`, so there is none on Linux or Windows; `ps`, `grep`, `tail` and `git` are expected on the PATH.
- **Unofficial.** This project is not affiliated with or endorsed by Anthropic.

## License

[MIT](LICENSE)
