# Claude Usage Tracker for Linux

An unofficial Linux port of [Claude Usage Tracker](https://github.com/hamed-elfayome/Claude-Usage-Tracker) for macOS, combining its Claude Code statusline and visual direction with a GNOME Shell foundation adapted from [Claude Code Usage](https://github.com/Haletran/claude-usage-extension). It adds active model-specific limits, notifications, a local usage chart with 5-hour to 30-day scales, and a shortcut to Claude Code's usage-limit resets.

```
my-project │ ⎇ main │ high │ Ctx: 23% │ Usage: 34% ▓▓▓░░░░┃░░ → Reset: 11:48 AM
```

The `┃` is the pace marker: it sits at the elapsed position in the window, so the gap between it and the filled bar is the burn rate. Its color runs across six tiers of projected end-of-window usage — comfortable, on track, warming, pressing, critical, runaway.

![Claude Usage Tracker icon](claude-usage.svg)

## Requirements

- GNOME Shell 46 through 51. Developed on GNOME Shell 46 and 50; 47-49 and 51 are declared but untested.
- Claude Code signed in with `claude auth login`
- Node.js 22 or newer for the Claude Code statusline
- GJS, `glib-compile-schemas`, and `gnome-extensions`

`node` must be on the PATH of the shell Claude Code runs the statusline from; nvm users should check that shell loads their Node environment.

## Install From Source

1. Clone the repository and build the package. `make pack` runs the tests first.

   ```bash
   git clone https://github.com/TheophileDiot/Claude-Usage-Tracker-Linux.git
   cd Claude-Usage-Tracker-Linux
   make pack
   ```

   The archive is written to `dist/claude-usage-tracker@theophilediot.github.io.shell-extension.zip`.

2. Install the extension.

   ```bash
   gnome-extensions install --force dist/claude-usage-tracker@theophilediot.github.io.shell-extension.zip
   ```

3. Restart GNOME Shell so it discovers the extension.

   - GNOME 46-49 on X11: press `Alt` + `F2`, type `r`, then press `Enter`.
   - Otherwise: log out and back in.

4. Enable the extension and open its settings.

   ```bash
   gnome-extensions enable claude-usage-tracker@theophilediot.github.io
   gnome-extensions prefs claude-usage-tracker@theophilediot.github.io
   ```

The UUID differs from `claude-code-usage@haletran.com`, so both extensions can remain installed while you verify this port. Disable the previous extension only when ready:

```bash
gnome-extensions disable claude-code-usage@haletran.com
```

## Panel and popup

The top panel shows a `5h` and a `7d` readout; the popup adds a card per limit and a usage chart. Everything below is set on the **Panel** page of the preferences, except the history tools, which have their own **History** page.

- **Colours** — bars turn amber at 70% and red at 90%, as in the macOS app. **Colour by: Pace** colours a bar by the usage projected to the end of its window instead, once 15% of the window has passed. **Single colour** paints every bar one colour (default `#00BFFF`).
- **Pace marker** — a thin tick on each bar at the elapsed share of the 5-hour or 7-day window, coloured by projected end-of-window usage in the skin's six tiers. It is hidden until enough of the window has elapsed (9 minutes, or 50 minutes for a weekly window), and in **Remaining** mode it mirrors to the other side of the bar. The accessible name of each bar states the projection in words.
- **Reset time** — time left (`Resets in 1h 5m`), clock time (`Resets at 4:15 PM`, `Resets Tue 4:15 PM`), or both. The clock follows GNOME's 12/24-hour setting unless you override it.
- **Reset countdown** — optionally add the time left (`2h`, `45m`) to the `5h` panel readout.
- **Notifications** — the 75, 90 and 95% toggles, plus **Custom thresholds** (a comma list such as `60, 85`; values outside 1-100 are ignored), plus a notification when the 5-hour window resets after use.
- **Freshness** — the popup says `Updated 5 min ago`, kept current while it is open. From the second failed refresh in a row it says `Refresh failed 2 times`, with the cached values still shown.
- **Chart scales** — the popup chart switches between 5 hours (15-minute buckets), 24 hours (hours), 7 days (6-hour buckets) and 30 days (days). The choice is remembered. Each bucket shows its newest sample.
- **Shortcuts** — optional global shortcuts to open the popup, refresh, and open preferences, set under **Shortcuts** with a capture dialog (Backspace clears, Escape cancels). None are set by default, and a shortcut needs Ctrl, Alt or Super.
- **Claude status** — off by default. **Show Claude status** adds a row with the current status of [status.claude.com](https://status.claude.com), a dot coloured by severity and the page's own description; activating it opens the status page. If the page cannot be reached the row hides.
- **Wake and network** — a refresh runs about 5 seconds after resume from suspend or when the network returns, unless a `Retry-After` hold is active.

## History

The **History** page of the preferences works on the stored samples:

- **Records** — the last 20 completed session and weekly windows, newest first, with each window's peak usage. A window completes when the panel sees its reset time change, so history recorded by an older version has no records until a window ends after the upgrade.
- **Export JSON / Export CSV** — saves the samples as stored, or as `timestamp_iso,metric_id,percent` rows, to a file only you can read (`0600`).
- **Clear history** — after a confirmation, deletes every sample. Preferences record the clear time, and the extension drops everything at or before it and rewrites the file, including when you clear while the extension is disabled.

Samples are kept for 30 days. The last 7 days keep one every 5 minutes; older ones are thinned to the highest value per metric and hour, without merging across a window reset.

## Enable the Claude Code skin

Open preferences, go to the **Claude Code** page, and press **Install**. That writes the `statusLine` entry into `~/.claude/settings.json`, keeping a timestamped backup of the previous file. **Remove** takes it out again and leaves the rest of the file untouched.

To wire it up by hand instead:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$HOME/.local/share/gnome-shell/extensions/claude-usage-tracker@theophilediot.github.io/statusline.js\""
  }
}
```

Claude Code sends context and subscription rate-limit data directly to the statusline script; it does not make an API request or read credentials. The skin appears on the next Claude interaction or in a new session. Rate limits appear after Claude receives its first API response, and the panel's cache covers the gap before then.

The **Statusline refresh interval** preference sets `statusLine.refreshInterval` (0 disables it; 1-600 seconds re-runs the command while idle). Press **Install** or **Reinstall** after changing it; each click keeps the timestamped backup. The optional `padding` field can be set by hand for horizontal spacing.

### Configuring the skin

The Claude Code preferences page mirrors the macOS app's tab, with a live preview rendered by the skin itself:

- **Components** — directory, git branch, effort level, profile, context (as a percentage or a token count). Effort appears when Claude Code reports it for the active model.
- **Session usage** — progress bar, pace marker, pace marker colors, reset time.
- **Weekly usage** — its own bar, pace marker, and reset time; plus extra-usage cost.
- **Labels** — the `Ctx:`, `Usage:`, `Reset:`, and `Weekly:` prefixes, and 24-hour reset times.
- **Colours** — Multi-Color, Greyscale, Single Color, or Per Element with a color for each segment.
- **Layout** — a line break before context, usage, or weekly; optional **Wrap to terminal width** starts a new line before a segment exceeds `COLUMNS`. Both default off. Segments remain whole, even if one exceeds the width.

Settings are projected into `~/.claude/statusline-config.txt` using the same key names and format the macOS app writes, so that file stays readable and hand-editable. Preferences overwrite it. `NO_COLOR=1` disables ANSI decoration regardless of the color mode.

Profile is off by default, matching the macOS app — enable it only if you want your account or organisation name on screen.

## Privacy

The GNOME extension reads the existing Claude Code OAuth token from `$CLAUDE_CONFIG_DIR` or `~/.claude` and holds it only in memory for the usage request. The statusline receives session JSON on stdin and never reads the token. Neither component writes credentials, makes inference requests, or sends telemetry.

The only other host the extension contacts is `status.claude.com`, and only while **Show Claude status** is on (it is off by default). That is a public GET of the Statuspage JSON, at most every 5 minutes, with no token, no cookies, and nothing from your account.

Unlike the macOS app, no session key is ever written into the statusline script. macOS injects one into `~/.claude/fetch-claude-usage.swift` so the script can call the API itself; here Claude Code supplies the rate limits directly, so there is nothing to inject.

Files written, all `0600`:

- `$XDG_STATE_HOME/claude-usage-tracker/history.json` — thirty days of percentages for the chart, plus the reset time of each window they belong to (what the records are derived from). Removing it clears the chart and the records.
- `~/.claude/statusline-config.txt` — skin settings, projected from preferences.
- `~/.claude/.statusline-usage-cache` — last panel refresh, so the skin can show extra-usage cost and cover the start of a session.

## Limit resets

The reset button in the popup header (the revert arrow, labelled “Use a limit reset in Claude Code” on hover) runs `claude /limit-reset` in a terminal. Claude Code checks whether you have a reset, and asks you to confirm before it uses one. Anthropic's reset endpoint only accepts requests from Claude Code, so the extension cannot show or use resets itself. On an account without resets, Claude Code reports that none is available or that the command is unknown.

The button uses the first terminal it finds: `xdg-terminal-exec`, Ptyxis, Console, GNOME Terminal, then `x-terminal-emulator`. Claude Code starts in `$CLAUDE_CONFIG_DIR` or `~/.claude`, so it asks whether you trust that folder the first time only. Your home folder would ask on every click, because Claude Code never remembers trust for it.

## Troubleshooting

- Missing Claude Code login: run `claude auth login` with a Pro, Max or Ultra account. An API key alone cannot supply panel quotas.
- Expired access token with a valid refresh token: start Claude Code once to renew it; otherwise run `claude auth login`.
- Rate limited: scheduled refreshes honour `Retry-After`; the error shows the next attempt time. Manual refresh can still try.
- Cached values remain visible during network or service failures.
- Developed on GNOME Shell 46 and 50; 47-49 and 51 are declared but untested.

## Related projects

If you also use Codex, see
[Codex Usage Monitor](https://github.com/TheophileDiot/Codex-Usage-Tracker-Linux)
for account quotas, activity and recent sessions in your GNOME panel, plus a native
footer editor.

For a self-hosted Grafana view across coding tools, see
[AI CLI Observability](https://github.com/TheophileDiot/ai-cli-observability).

This project is unofficial and is not affiliated with or endorsed by Anthropic. See [NOTICE](NOTICE) for upstream attribution.
