# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
make test          # full suite: both runtimes + strict schema compile
make pack          # runs test, then writes dist/<UUID>.shell-extension.zip
```

Single test files (same order the Makefile uses):

```bash
gjs -m tests/test-usage.js          # pure-JS usage/history/notification logic
node tests/test-statusline.js       # skin rendering + schema/DEFAULTS contract
glib-compile-schemas schemas        # required before test-skin.js
gjs -m tests/test-skin.js           # GSettings -> statusline-config.txt projection
```

Tests are plain scripts with `assert`/`throw` — no framework, no runner flags, no per-case
filtering. A test either prints `… checks passed` or exits non-zero.

Install/verify locally:

```bash
gnome-extensions install --force dist/claude-usage-tracker@theophilediot.github.io.shell-extension.zip
# X11: Alt+F2, r, Enter. Wayland: log out and back in.
gnome-extensions enable claude-usage-tracker@theophilediot.github.io
gnome-extensions prefs claude-usage-tracker@theophilediot.github.io
journalctl -f -o cat /usr/bin/gnome-shell   # extension logs (console.error output)
```

`make pack` only ships files listed as `--extra-source` in the Makefile. A new runtime file that
isn't added there is missing from the zip while still working from the source tree.

## Two runtimes, one repo

| File | Runtime | Loaded by |
| --- | --- | --- |
| `extension.js`, `prefs.js`, `skin.js`, `usage.js` | GJS, ES modules, `gi://` imports | GNOME Shell / prefs process |
| `statusline.js` | Node.js 18+, CommonJS, zero deps | Claude Code, as the `statusLine` command |
| `tests/test-usage.js`, `tests/test-skin.js` | GJS | `gjs -m` |
| `tests/test-statusline.js` | Node | `node` |

`statusline.js` is the only non-GJS file and must stay that way: no `import`, no `gi://`, no
packages, no network, no writes. Shell code never imports it — `prefs.js` runs it as a
subprocess to render the live preview, and Claude Code runs it as a command. Its `main()`
swallows every error on purpose: a statusline must never disturb a Claude session.

## Data flow

Two independent paths that meet only through files in `~/.claude` (or `$CLAUDE_CONFIG_DIR`):

- **Panel** — `extension.js` reads Claude Code's OAuth token from `.credentials.json`
  (memory-only, never persisted), GETs `https://api.anthropic.com/api/oauth/usage`, and passes
  the body through `normalizeUsage()` in `usage.js`. That produces the ordered metric list used
  for cards, panel readout, notifications, the 24-hour chart
  (`$XDG_STATE_HOME/claude-usage-tracker/history.json`), and the skin cache.
- **Skin** — Claude Code pipes session JSON (including `rate_limits`) to `statusline.js` on
  stdin. It renders from stdin plus `statusline-config.txt`, falling back to
  `.statusline-usage-cache` for the start of a session, for extra-usage cost, and for weekly
  usage. Claude Code's stdin `rate_limits` only ever carries `five_hour` and `seven_day`, and
  the API no longer fills `seven_day` on every plan — it reports the weekly window per model in
  `limits[]` — so `writeUsageCache()` falls back to the first `model:*` metric and the panel is
  the skin's only weekly source.

Files the extension writes, all `0600`: `~/.claude/statusline-config.txt`,
`~/.claude/.statusline-usage-cache`, and the history JSON.

## The config-file contract

The skin cannot read GSettings, so settings are projected into `~/.claude/statusline-config.txt`
as `KEY=value` lines using the **macOS tracker's key names and format** — the file stays
readable and hand-editable for people coming from that app. Three places must agree, and two
tests enforce it:

1. `schemas/…gschema.xml` — the `statusline-*` key and its default.
2. `skin.js` — `BOOLEAN_KEYS` / `STRING_KEYS` map the GSettings key to the uppercase file key.
3. `statusline.js` — `DEFAULTS` holds the same uppercase key with the same default, and the
   render path consumes it.

`tests/test-statusline.js` parses the gschema XML and asserts every `statusline-*` key matches
`DEFAULTS` by name, type, and value (`PROFILE_NAME` is the one exception — the panel supplies
it). `tests/test-skin.js` asserts `SKIN_KEYS.length` equals the projected key count. So adding a
skin option means four edits — schema, `skin.js` map, `statusline.js` DEFAULTS + rendering,
`prefs.js` row — and the tests fail loudly if you forget one.

Config values are stripped of `"`, `\`, and newlines on write and quote-trimmed on read; a value
must never be able to inject a second `KEY=` line (tested).

## Invariants worth knowing before editing

- **Upstream fidelity.** `statusline.js` is a port of the macOS app's
  `statusline-command.sh`: component order, the ten-level `GRADIENT`, the six-tier `PACE`
  spectrum, the marker position math, and the four color modes all mirror it. Only three
  departures are intentional and documented in the file header + `DESIGN.md`: usage comes from
  stdin `rate_limits` instead of an injected session key, `NO_COLOR` also suppresses reset
  sequences, and `LINE_BREAK` can split the row. Don't add a fourth silently.
- **Untrusted values are terminal-bound.** Branch names, directory names, and model names go
  straight to a terminal; `clean()` strips C0/C1 controls and bidi overrides. Anything new that
  reaches the output must go through it (there's a hostile-input test).
- **Shell lifecycle.** `destroy()` must clear every timeout, idle source, cancellable, Soup
  session, and signal handler; `prefs.js` must cancel the preview subprocess on `close-request`.
  Leaked sources survive disable/enable and are the recurring bug class here.
- **No synchronous I/O in shell code.** `extension.js` imports `skin.js`, so every read there
  goes through `loadTextAsync()` and every write through `writeTextAsync()`; sync I/O blocks the
  compositor and EGO review flags it. `~/.claude.json` is the reason reads matter — it carries
  Claude Code's project history and grows without bound, so the account label is read once at
  enable and cached, never per refresh. `writeTextAsync()` writes with `PRIVATE` and chmods to
  0600, and treats cancellation as success because the only canceller is `disable()`. The sync
  `settings.json` helpers (`install`, `remove`, `isInstalled`) live in `prefs.js` because
  preferences runs in its own process; do not move them back into `skin.js`.
- **Bar geometry is scaled by hand.** St multiplies CSS pixels by
  `St.ThemeContext.scale_factor`, `Clutter.Actor.set_width()`/`set_height()` do not. Every fill
  sized in `extension.js` is measured against a track sized in `stylesheet.css`, so the
  `CARD_TRACK_WIDTH` / `PANEL_TRACK_WIDTH` / `HISTORY_BAR_HEIGHT` constants carry the CSS value
  and are multiplied by the scale factor at use; unscaled, a fill tops out at 1/scale of its
  track on HiDPI. Changing one of those CSS lengths means changing its constant.
- **Dynamic limits over hard-coded models.** `normalizeUsage()` handles both the legacy
  `five_hour`/`seven_day_*` fields and the current `limits[]` array, keys models off
  `scope.model`, and throws when a payload yields nothing usable (fail closed, cached data stays
  on screen). Extra usage arrives twice — the flat `extra_usage` block and a newer `spend`
  object holding the same figures as minor units — so `extraUsageFrom()` prefers `extra_usage`
  while both are sent and falls back to `spend` for the payload that drops it.
- **Cached data stays useful.** Network and auth failures show the last good values with a stale
  state, never a blank panel.
- **No dependencies, no bundler, no build step** beyond `glib-compile-schemas` and
  `gnome-extensions pack`. Keep it that way.

## Docs that are contracts

`PRODUCT.md` (scope, users, constraints; carries an `impeccable:product-schema` marker) and
`DESIGN.md` (interface direction, popover geometry, palette, skin layout) describe intended
behavior. Behavior changes that contradict them should update them in the same change.
`NOTICE` carries upstream MIT attribution and must survive any packaging change.

Commit subjects: imperative, sentence case, no `type:` prefix (recent history; older commits use
Conventional Commits).
