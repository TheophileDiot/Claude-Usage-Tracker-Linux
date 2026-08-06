# Interface Direction

The popup keeps the compact dark quota-card hierarchy of the original macOS tracker while using native GNOME panel behavior and controls.

- 310 px popover with account and freshness state first, then quota cards and the 24-hour chart.
- Near-black `#111412` surface, Claude orange `#f28c28`, and green/amber/red quota states.
- Percentage text always accompanies color; reset times and stale/error states remain explicit.
- Header actions are keyboard-focusable icon buttons with accessible names.
- GNOME typography and text scaling are inherited; no bundled fonts or web UI runtime.
- Preferences use native Libadwaita rows and controls.

The top panel stays deliberately compact: optional icon plus text, progress bar, or both. Dynamic API limits become cards without changing the fixed shell layout.

The Claude Code skin reproduces the macOS statusline: a single row of `directory │ ⎇ branch │ model │ profile │ Ctx: n% │ Usage: n% ▓▓┃░░ → Reset: 4:15 PM`, with weekly and extra-usage segments available. Usage carries a ten-level gradient and a pace marker — a `┃` at the elapsed-time position whose distance from the fill edge shows burn rate, colored across six projected-usage tiers. Four color modes match the mac app: Multi-Color, Greyscale, Single Color, and Per Element. `NO_COLOR` disables decoration entirely.

Two deliberate departures from the mac app: usage comes from the `rate_limits` Claude Code already supplies on stdin rather than an injected session key, and a line break can be placed before any segment for narrow terminals. Preferences carry a Claude Code page mirroring the mac app's tab, including a live preview rendered by the skin itself.
