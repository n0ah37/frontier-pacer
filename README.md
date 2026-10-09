# frontier-pacer

A Claude Code mod that draws one line above the prompt, so the figures you would otherwise open `/usage` for are always in view:

```
ctx 143K  $4.21  active 17m 6s  cache ◕ 50:00  5h ◑ 62% +13%  empty in 1h 30m  7d ◑ 44% −6%
```

## What it shows

- **ctx**: the number of tokens in the context window, such as 143K (one decimal below 100K).
- **$**: the session's API-equivalent cost, cache reads and writes included, formatted as `/usage` formats it.
- **active**: how long the model has worked in this session, the sum of each turn's duration, the running turn included.
- **cache**: a countdown to when the prompt cache expires (5 minutes or 1 hour, read from the last response). It holds at full while Claude is responding, turns red in its last tenth (the last 6 minutes of an hour, the last 30 seconds of 5 minutes) and reads `expired` after that.
- **5h, 7d and per-model weekly limits**: a ring per plan window with the percentage used as `/usage` shows it, read from the usage endpoint `/usage` reads, shared by all your sessions. When that reading is a few minutes old, a newer response's rate-limit headers stand in. A window whose reset time has passed reads 0% until the next reading. Beside it is the pace: how far ahead (`+13%`, red) or behind (`−6%`, green) you are of an even burn through the window. When you are off pace, it estimates when the window runs out.

It stays on one line: when the window is too narrow, it leaves out the active time, then the cost, the time-to-empty, any per-model week and the context, in that order. `/pace` hides the band for the session and brings it back (`/pace off`, `/pace on`).

The desktop Code tab draws real rings; the terminal draws ○◔◑◕● glyphs. The pace model follows [CodexBar](https://github.com/steipete/CodexBar) by Peter Steinberger: the delta is actual minus expected use, with stages at 2, 6 and 12 points.

## Requirements

Claude Code with mods (the `hooks/hooks.json` `modules` entry), on macOS or Linux. The Active time and the cache lifetime read the transcript with `sh`, `awk`, `tail` and `ps`; where those are missing, as on Windows without a POSIX shell, Active counts only turns seen since the mod loaded and the cache lifetime is inferred from your plan.

## Install

Add it from the plugin directory: `/plugin`, then **Discover**, or from the directory on claude.ai. To try it from a clone first:

```bash
claude --plugin-dir ./frontier-pacer
```

The band appears in sessions started after the install.

## What it runs, reads and sends

Everything the mod touches, in full:

- **Network**: it calls `GET https://api.anthropic.com/api/oauth/usage`, the endpoint `/usage` reads, to get the plan percentages: after a response or once a minute while idle, at most once a minute across all your sessions. It sends Claude Code's `User-Agent` (`claude-code/<version>`), which the endpoint requires: without it every request is refused with a 429 and an hour's `Retry-After`. After a 429 every session waits for its `Retry-After` or 5 minutes, whichever is longer, doubling with each 429 in a row up to an hour. The request carries the session's own Claude login through the engine's `$.session.authorize()`. The mod never sees or stores the token. Nothing is sent anywhere else. While it is refused, the rate-limit headers of each response keep the figures current.
- **Files**: it reads the current session's transcript under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`). It reads only the last 1 MiB to learn the cache lifetime and only the row timestamps to rebuild the Active time after a restart. It writes no files.
- **Processes**: it runs these programs, each with arguments written in the source, and nothing else:
  - `/bin/sh -c` with a one-line loop that looks for `<session id>.jsonl` under `projects/` and prints its path, since the engine does not expose the transcript path;
  - `tail -c 1048576 <transcript>` to read the end of the transcript for the cache lifetime of the last response;
  - `awk` with a fixed program over the transcript that prints two lines per turn, the prompt's time and the time of the last work after it (`P <time>`, `A <time>`), for the Active time;
  - `/bin/sh -c` with a one-line loop that walks up the parent processes with `ps -o comm=` and `ps -o etime=` until it finds `claude`, to learn when this Claude Code process started, so Active counts only turns run by this process, as the app's own usage panel does.
  The output of these programs is only parsed into numbers for the band. The mod never runs a command it receives from the network, the model or the conversation.
- **Commands**: it adds `/pace`, which only hides or shows the band.
- **Hooks**: it observes `session.start`, `session.measure`, `turn.start`, `turn.step`, `turn.complete`, `PostModelSwitch` and `session.end` and passes each one on unchanged with `next(e)`, so it alters no setting, instruction, prompt, tool or response. Its one drawing hook, `ui.render` on `AbovePrompt`, adds the band, and its `command.run` hook answers only `/pace`.
- **Storage**: the newest reading of each plan window (its percentage, reset time and when it was read), when a session last asked the endpoint, and any 429 wait are kept in the plugin's own store, a JSON file Claude Code keeps under its configuration directory, so every session shows the same, newest figures. Everything else lives in the session's state only.

## Tests

```bash
claude plugin test .
```

## License

MIT. The pace model is ported from CodexBar, also MIT; its notice is in [LICENSE](LICENSE).
