# Product

<!-- impeccable:product-schema 1 -->

## Platform

Native Linux desktop: Ubuntu 24.04 with GNOME Shell 46; declared compatible with 47 and 48.

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
- GNOME Shell 46 is the development and test target; 47 and 48 are declared but untested.
- Two-line Claude Code skin with directory, branch, model, effort, profile, context tokens, 5-hour/7-day limits, reset countdowns, and extra-usage percentage.
- Read-only OAuth credentials; expired credentials send the user back to `claude auth login`.
- Seven days of local percentage-only history, visualized as a 24-hour mini chart.
- No browser login, multi-profile switching, API Console billing, activity HUD, updater, localization, or telemetry.

## Brand Commitments

Retain the Claude Usage Tracker name, orange pulse icon, and compact macOS quota-card hierarchy with upstream attribution. GNOME owns panel interaction, typography, focus, and accessibility behavior.

## Evidence on Hand

- macOS source and visual reference: `hamed-elfayome/Claude-Usage-Tracker`.
- Proven GNOME 46 extension base: locally installed `claude-code-usage@haletran.com`.
- Live Claude OAuth usage response confirmed on this system without exposing credentials or usage values.

## Product Principles

- Credentials stay read-only and memory-only.
- Last good data remains useful when the network fails.
- Dynamic API limits beat hard-coded model assumptions.
- Native GNOME lifecycle and controls beat extra frameworks.

## Accessibility & Inclusion

Keyboard-accessible actions, descriptive control labels, percentage text alongside color, GNOME text scaling, and visible loading/error/stale states.
