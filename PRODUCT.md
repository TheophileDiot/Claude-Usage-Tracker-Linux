# Product

<!-- impeccable:product-schema 1 -->

## Platform

Native Linux desktop, GNOME Shell 46 through 51. Developed on GNOME Shell 46 and 50; 47-49 and 51 are declared but untested.

## Stack

GJS ES modules using GNOME Shell, St, Clutter, Gio, GLib, and Soup. No bundled runtime or package-manager dependencies.

## Users

One local Claude Code user who wants quota state visible without opening a terminal or browser.

## Product Purpose

Show live Claude conversation context plus session, weekly/model, and extra-usage limits in Claude Code and the GNOME top panel. Success means the user can read current pressure without leaving the active session.

## Positioning

Read-only reuse of the user's existing Claude Code login: no duplicate sign-in, token rotation, synthetic inference request, or credential storage.

## Operating Context

Runs as a Claude Code statusline and a GNOME Shell extension. The statusline uses session JSON supplied on stdin; the panel reads Claude Code credentials from the configured local Claude directory and requests usage from Anthropic over HTTPS.

## Capabilities and Constraints

- Single Claude Code account.
- Developed on GNOME Shell 46 and 50; 47-49 and 51 are declared but untested.
- Claude Code skin with directory, branch, effort, profile, context tokens, 5-hour/7-day limits, reset times, and extra-usage cost. Optional line breaks and wrap to terminal width; optional idle refresh interval (0-600 seconds, 0 disables).
- Read-only OAuth credentials; expired access tokens prompt a Claude Code refresh when the refresh token is still valid, otherwise `claude auth login`.
- Usage-limit resets are used through Claude Code: a header action opens `claude /limit-reset` in a terminal. The extension never calls the reset endpoint, which rejects clients other than Claude Code.
- Panel and popup bars colour at 70%/90% (or by projected usage, or one chosen colour) and carry a pace marker tick at the elapsed share of the 5-hour or 7-day window. Reset times can show time left, clock time or both; the panel can add a compact reset countdown.
- Notifications: 75/90/95% toggles, custom thresholds, and a 5-hour window reset notice. Usage refreshes after resume from suspend and when the network returns.
- Popup freshness: "Updated N min ago" while open, and "Refresh failed N times" from the second consecutive failure.
- Thirty days of local history (percentages and the reset time of each window; 5-minute samples for 7 days, thinned to hourly beyond), charted at 5h / 24h / 7d / 30d scales in the popup. Preferences list the last 20 completed windows per metric, export JSON or CSV, and clear the history behind a confirmation.
- Optional global shortcuts (open popup, refresh, open preferences; none set by default).
- Optional Claude service status row (off by default): a public, unauthenticated GET of `https://status.claude.com/api/v2/status.json` at most every 5 minutes, only while enabled.
- No browser login, multi-profile switching, API Console billing, activity HUD, updater, localization, telemetry (the opt-in status row is a status poll that carries nothing of the user's), auto-start session, or other providers (see [Codex Usage Monitor](https://github.com/TheophileDiot/Codex-Usage-Tracker-Linux)).

## Brand Commitments

Retain the Claude Usage Tracker name, orange pulse icon, and compact macOS quota-card hierarchy with upstream attribution. GNOME owns panel interaction, typography, focus, and accessibility behavior.

## Evidence on Hand

- macOS source and visual reference: <https://github.com/hamed-elfayome/Claude-Usage-Tracker>.
- GNOME Shell foundation: <https://github.com/Haletran/claude-usage-extension>.

## Product Principles

- Credentials stay read-only and memory-only.
- Last good data remains useful when the network fails.
- Dynamic API limits beat hard-coded model assumptions.
- Native GNOME lifecycle and controls beat extra frameworks.

## Accessibility & Inclusion

Keyboard-accessible actions, descriptive control labels, percentage text alongside color, GNOME text scaling, and visible loading/error/stale states.
