# Claude Usage Tracker for Linux

An unofficial Linux port of [Claude Usage Tracker](https://github.com/hamed-elfayome/Claude-Usage-Tracker) for macOS, combining its Claude Code statusline and visual direction with a GNOME Shell foundation adapted from [Claude Code Usage](https://github.com/Haletran/claude-usage-extension). It adds active model-specific limits, notifications, and a local 24-hour chart.

```
my-project │ ⎇ main │ Opus 5 │ Ctx: 23% │ Usage: 34% ▓▓▓░░░░┃░░ → Reset: 11:48 AM
```

The `┃` is the pace marker: it sits at the elapsed position in the window, so the gap between it and the filled bar is the burn rate. Its color runs across six tiers of projected end-of-window usage — comfortable, on track, warming, pressing, critical, runaway.

![Claude Usage Tracker icon](claude-usage.svg)

## Requirements

- GNOME Shell 46 through 50 (developed and tested on 46)
- Claude Code signed in with `claude auth login`
- Node.js 18 or newer for the Claude Code statusline
- GJS, `glib-compile-schemas`, and `gnome-extensions`

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

   - X11: press `Alt` + `F2`, type `r`, then press `Enter`.
   - Wayland: log out and back in.

4. Enable the extension and open its settings.

   ```bash
   gnome-extensions enable claude-usage-tracker@theophilediot.github.io
   gnome-extensions prefs claude-usage-tracker@theophilediot.github.io
   ```

The UUID differs from `claude-code-usage@haletran.com`, so both extensions can remain installed while you verify this port. Disable the previous extension only when ready:

```bash
gnome-extensions disable claude-code-usage@haletran.com
```

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

Two optional `statusLine` fields are worth knowing about: `padding` adds horizontal spacing, and `refreshInterval` re-runs the command every N seconds so reset times and pace markers stay current while the session is idle.

### Configuring the skin

The Claude Code preferences page mirrors the macOS app's tab, with a live preview rendered by the skin itself:

- **Components** — directory, git branch, model, profile, context (as a percentage or a token count).
- **Session usage** — progress bar, pace marker, pace marker colors, reset time.
- **Weekly usage** — its own bar, pace marker, and reset time; plus extra-usage cost.
- **Labels** — the `Ctx:`, `Usage:`, `Reset:`, and `Weekly:` prefixes, and 24-hour reset times.
- **Colours** — Multi-Color, Greyscale, Single Color, or Per Element with a color for each segment.
- **Layout** — a line break before context, usage, or weekly. macOS renders a single line, which is the default.

Settings are projected into `~/.claude/statusline-config.txt` using the same key names and format the macOS app writes, so that file stays readable and hand-editable. Preferences overwrite it. `NO_COLOR=1` disables ANSI decoration regardless of the color mode.

Profile is off by default, matching the macOS app — enable it only if you want your account or organisation name on screen.

## Privacy

The GNOME extension reads the existing Claude Code OAuth token from `$CLAUDE_CONFIG_DIR` or `~/.claude` and holds it only in memory for the usage request. The statusline receives session JSON on stdin and never reads the token. Neither component writes credentials, makes inference requests, or sends telemetry.

Unlike the macOS app, no session key is ever written into the statusline script. macOS injects one into `~/.claude/fetch-claude-usage.swift` so the script can call the API itself; here Claude Code supplies the rate limits directly, so there is nothing to inject.

Files written, all `0600`:

- `$XDG_STATE_HOME/claude-usage-tracker/history.json` — seven days of percentages for the chart. Removing it clears the chart.
- `~/.claude/statusline-config.txt` — skin settings, projected from preferences.
- `~/.claude/.statusline-usage-cache` — last panel refresh, so the skin can show extra-usage cost and cover the start of a session.

## Troubleshooting

- “Credentials not found/expired”: run `claude auth login`.
- Cached values remain visible during network or service failures.
- Developed and tested on GNOME Shell 46. It declares 46-50 because no breaking
  extension API it uses changed across those releases, but 47-50 are untested;
  please open an issue if something misbehaves there.

This project is unofficial and is not affiliated with or endorsed by Anthropic. See [NOTICE](NOTICE) for upstream attribution.
