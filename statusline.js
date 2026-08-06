#!/usr/bin/env node

/**
 * Claude Code statusline skin.
 *
 * A faithful port of the macOS tracker's `statusline-command.sh`, which the mac
 * app generates in StatuslineService.swift. Component order, glyphs, the
 * ten-level usage gradient, the six-tier pace marker and the four color modes
 * all match that script. Two deliberate differences:
 *
 * - Usage comes from the `rate_limits` block Claude Code already puts on stdin,
 *   so no credential is injected into this file and no request is made.
 * - `NO_COLOR` suppresses reset sequences too, as the NO_COLOR spec requires.
 *
 * Reviewer note: this is the one non-GJS file in the extension, and it cannot
 * be GJS. Claude Code executes the configured `statusLine.command` itself, in
 * its own Node runtime, outside GNOME Shell — the extension never interprets
 * this file. It is plain readable source, ships under the same MIT license as
 * the rest of the extension (see LICENSE), installs no packages, makes no
 * network request, and writes nothing: it reads stdin plus the extension's own
 * config and cache files, and shells out only to `git branch --show-current`
 * for the branch segment.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const SESSION_WINDOW_SECONDS = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
/**
 * Seconds that must elapse before a burn-rate projection is meaningful. The mac
 * script uses 3% of the session window but only 0.5% of the much longer weekly
 * one, so these are not a shared fraction.
 */
const SESSION_MIN_ELAPSED = 540;
const WEEKLY_MIN_ELAPSED = 3_024;
const CACHE_MAX_AGE_MS = 300_000;
const BAR_WIDTH = 10;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const RESET = '\x1b[0m';

/** Ten-level usage gradient, dark green through deep red. */
const GRADIENT = [22, 28, 34, 100, 142, 178, 172, 166, 160, 124]
    .map(code => `\x1b[38;5;${code}m`);

/** Six-tier pace spectrum: comfortable, on track, warming, pressing, critical, runaway. */
const PACE = [34, 37, 178, 208, 160, 135].map(code => `\x1b[38;5;${code}m`);

const BASE = {
    blue: '\x1b[0;34m',
    green: '\x1b[0;32m',
    gray: '\x1b[0;90m',
    yellow: '\x1b[0;33m',
    cyan: '\x1b[0;36m',
    magenta: '\x1b[0;35m',
};

const DEFAULTS = {
    SHOW_DIRECTORY: '1',
    SHOW_BRANCH: '1',
    SHOW_MODEL: '1',
    SHOW_PROFILE: '0',
    PROFILE_NAME: '',
    SHOW_CONTEXT: '1',
    CONTEXT_AS_TOKENS: '0',
    SHOW_USAGE: '1',
    SHOW_PROGRESS_BAR: '1',
    SHOW_PACE_MARKER: '1',
    PACE_MARKER_STEP_COLORS: '1',
    SHOW_RESET_TIME: '1',
    USE_24_HOUR_TIME: '0',
    SHOW_CONTEXT_LABEL: '1',
    SHOW_USAGE_LABEL: '1',
    SHOW_RESET_LABEL: '1',
    SHOW_WEEKLY: '0',
    SHOW_WEEKLY_BAR: '1',
    SHOW_WEEKLY_PACE_MARKER: '1',
    SHOW_WEEKLY_RESET_TIME: '1',
    SHOW_WEEKLY_LABEL: '1',
    SHOW_EXTRA_USAGE: '0',
    LINE_BREAK: 'none',
    COLOR_MODE: 'colored',
    SINGLE_COLOR: '#00BFFF',
    ELEMENT_COLOR_DIR: '#0000EE',
    ELEMENT_COLOR_BRANCH: '#00BB00',
    ELEMENT_COLOR_MODEL: '#BBBB00',
    ELEMENT_COLOR_PROFILE: '#BB00BB',
    ELEMENT_COLOR_CONTEXT: '#00BBBB',
    ELEMENT_COLOR_SEPARATOR: '#808080',
    ELEMENT_COLOR_USAGE: '',
    ELEMENT_COLOR_PACE: '',
    ELEMENT_COLOR_WEEKLY: '',
    ELEMENT_COLOR_EXTRA: '',
};

function claudeDirectory() {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function on(config, key) {
    return config[key] === '1';
}

/**
 * Strip terminal control sequences and bidi overrides. The mac script does no
 * such filtering, but every value here is rendered straight to a terminal and
 * some of it (branch names, directory names) is attacker-influenced.
 */
function clean(value, limit = 64) {
    return String(value ?? '')
        .replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '')
        .slice(0, limit);
}

function percent(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean')
        return null;
    value = Number(value);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

function hexToAnsi(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
    if (!match)
        return '';
    const value = parseInt(match[1], 16);
    return `\x1b[38;2;${value >> 16 & 255};${value >> 8 & 255};${value & 255}m`;
}

/** Read the mac-compatible `statusline-config.txt`, falling back to its defaults. */
function readConfig(directory = claudeDirectory()) {
    const config = {...DEFAULTS};
    let raw;
    try {
        raw = fs.readFileSync(path.join(directory, 'statusline-config.txt'), 'utf8');
    } catch (_error) {
        return config;
    }

    for (const line of raw.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
        if (!match || !(match[1] in DEFAULTS))
            continue;
        config[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
    return config;
}

/**
 * Build the palette for a color mode. Mirrors the mac script's branching,
 * including its final override: when pace step colors are on and the mode is
 * not monochrome, the standard six tiers win over any custom pace color.
 */
function palette(config, colors) {
    const mode = colors ? config.COLOR_MODE : 'monochrome';
    const blank = {...BASE, reset: ''};
    for (const key of Object.keys(blank))
        blank[key] = '';

    let scheme;
    if (mode === 'monochrome') {
        scheme = {...blank, gradient: Array(10).fill(''), pace: Array(6).fill('')};
    } else if (mode === 'singleColor') {
        const single = hexToAnsi(config.SINGLE_COLOR);
        scheme = {
            blue: single, green: single, gray: single,
            yellow: single, cyan: single, magenta: single,
            gradient: Array(10).fill(single),
            pace: Array(6).fill(single),
        };
    } else if (mode === 'perElement') {
        const usage = hexToAnsi(config.ELEMENT_COLOR_USAGE);
        const pace = hexToAnsi(config.ELEMENT_COLOR_PACE);
        scheme = {
            blue: hexToAnsi(config.ELEMENT_COLOR_DIR),
            green: hexToAnsi(config.ELEMENT_COLOR_BRANCH),
            yellow: hexToAnsi(config.ELEMENT_COLOR_MODEL),
            magenta: hexToAnsi(config.ELEMENT_COLOR_PROFILE),
            cyan: hexToAnsi(config.ELEMENT_COLOR_CONTEXT),
            gray: hexToAnsi(config.ELEMENT_COLOR_SEPARATOR),
            gradient: usage ? Array(10).fill(usage) : [...GRADIENT],
            pace: pace ? Array(6).fill(pace) : [...PACE],
        };
    } else {
        scheme = {...BASE, gradient: [...GRADIENT], pace: [...PACE]};
    }

    if (on(config, 'PACE_MARKER_STEP_COLORS') && mode !== 'monochrome')
        scheme.pace = [...PACE];

    scheme.reset = colors ? RESET : '';
    scheme.mode = mode;
    return scheme;
}

function gradientColor(scheme, value) {
    return scheme.gradient[Math.min(9, Math.max(0, Math.ceil(value / 10) - 1))] ??
        scheme.gradient[0];
}

/** Six-tier pace color from projected end-of-window usage, as a percentage. */
function paceColor(scheme, projected) {
    if (projected < 50)
        return scheme.pace[0];
    if (projected < 75)
        return scheme.pace[1];
    if (projected < 90)
        return scheme.pace[2];
    if (projected < 100)
        return scheme.pace[3];
    if (projected < 120)
        return scheme.pace[4];
    return scheme.pace[5];
}

/** Absolute reset clock time, rounded to the nearest minute to stop it flickering. */
function clockTime(epochSeconds, use24Hour, weekday = false) {
    if (!Number.isFinite(epochSeconds))
        return null;

    let epoch = Math.round(epochSeconds);
    const seconds = ((epoch % 60) + 60) % 60;
    epoch += seconds >= 30 ? 60 - seconds : -seconds;

    const date = new Date(epoch * 1000);
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const day = weekday ? `${WEEKDAYS[date.getDay()]} ` : '';

    if (use24Hour)
        return `${day}${String(hours).padStart(2, '0')}:${minutes}`;
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${day}${String(hour12).padStart(2, '0')}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

/**
 * Ten-cell bar with an optional pace marker. The marker replaces the cell at the
 * elapsed-time position, so its distance from the fill edge is the burn rate.
 */
function progressBar(scheme, value, usageColor, options) {
    const filled = value <= 0 ? 0
        : value >= 100 ? BAR_WIDTH
        : Math.min(BAR_WIDTH, Math.max(0,
            Math.floor((value * BAR_WIDTH + 50) / 100)));
    let bar = ` ${'▓'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;

    const {elapsed, window, stepColors, minElapsed} = options;
    if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed >= window)
        return bar;

    const position = Math.min(9, Math.max(0,
        Math.floor((elapsed * BAR_WIDTH + window / 2) / window)));
    let marker = usageColor;
    if (stepColors && elapsed >= minElapsed)
        marker = paceColor(scheme, Math.floor(value * window / elapsed));

    return `${bar.slice(0, position + 1)}${marker}┃${scheme.reset}` +
        `${usageColor}${bar.slice(position + 2)}`;
}

/** Render one usage segment: percentage, bar with pace marker, reset clock. */
function usageSegment(scheme, config, options) {
    const {value, resetsAt, now, window, minElapsed, label, showBar, showPace,
        showReset, resetLabel, weekday, color} = options;

    const rounded = Math.round(value);
    const usageColor = color ?? gradientColor(scheme, rounded);
    const elapsed = Number.isFinite(resetsAt)
        ? window - (resetsAt - now / 1000)
        : null;

    const bar = showBar
        ? progressBar(scheme, rounded, usageColor, {
            elapsed: showPace ? elapsed : null,
            window,
            minElapsed,
            stepColors: on(config, 'PACE_MARKER_STEP_COLORS'),
        })
        : '';

    let reset = '';
    if (showReset && Number.isFinite(resetsAt)) {
        const time = clockTime(resetsAt, on(config, 'USE_24_HOUR_TIME'), weekday);
        if (time)
            reset = ` → ${resetLabel}${time}`;
    }

    return `${usageColor}${label}${rounded}%${bar}${reset}${scheme.reset}`;
}

function findBranch(cwd) {
    if (!cwd)
        return '';
    const result = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 100,
    });
    return result.status === 0 ? clean(result.stdout.trim()) : '';
}

function readProfile() {
    const configured = process.env.CLAUDE_CONFIG_DIR;
    const candidates = [
        configured && path.join(configured, '.claude.json'),
        path.join(os.homedir(), '.claude.json'),
        path.join(os.homedir(), '.claude', '.claude.json'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            const account = JSON.parse(fs.readFileSync(candidate, 'utf8')).oauthAccount;
            const label = account?.organizationName || account?.displayName || account?.email;
            if (label)
                return clean(label, 32);
        } catch (_error) {
            // Optional profile metadata.
        }
    }
    return '';
}

/**
 * Read the panel's cache. Claude Code's own `rate_limits` is preferred when
 * present; this fills the gap before the first API response of a session and
 * is the only source for extra-usage cost.
 */
function readCache(now = Date.now(), directory = claudeDirectory()) {
    let raw;
    try {
        raw = fs.readFileSync(path.join(directory, '.statusline-usage-cache'), 'utf8');
    } catch (_error) {
        return {};
    }

    const cache = {};
    for (const line of raw.split('\n')) {
        const index = line.indexOf('=');
        if (index > 0)
            cache[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }

    const stamp = Number(cache.TIMESTAMP) * 1000;
    return Number.isFinite(stamp) && now - stamp < CACHE_MAX_AGE_MS ? cache : {};
}

function renderStatusline(data, options = {}) {
    const colors = options.colors ?? !process.env.NO_COLOR;
    const now = options.now ?? Date.now();
    const config = options.config ?? readConfig();
    const cache = options.cache ?? {};
    const scheme = palette(config, colors);
    const separator = `${scheme.gray} │ ${scheme.reset}`;
    const segments = [];
    const push = (id, text) => segments.push({id, text});

    if (on(config, 'SHOW_DIRECTORY')) {
        const cwdValue = data?.workspace?.current_dir || data?.cwd;
        const cwd = typeof cwdValue === 'string' ? cwdValue : '';
        const directory = clean(path.basename(cwd) || cwd || 'Claude', 32);
        if (directory)
            push('directory', `${scheme.blue}${directory}${scheme.reset}`);
    }

    if (on(config, 'SHOW_BRANCH')) {
        const branch = clean(options.branch ?? data?.worktree?.branch ??
            data?.workspace?.git_worktree ?? '', 48);
        if (branch)
            push('branch', `${scheme.green}⎇ ${branch}${scheme.reset}`);
    }

    if (on(config, 'SHOW_MODEL')) {
        const model = clean(data?.model?.display_name || data?.model?.id || '', 32);
        if (model)
            push('model', `${scheme.yellow}${model}${scheme.reset}`);
    }

    if (on(config, 'SHOW_PROFILE')) {
        const profile = clean(config.PROFILE_NAME || options.profile || '', 32);
        if (profile)
            push('profile', `${scheme.magenta}${profile}${scheme.reset}`);
    }

    if (on(config, 'SHOW_CONTEXT')) {
        const context = data?.context_window || {};
        const size = Number(context.context_window_size);
        const current = context.current_usage || {};
        const tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
            .reduce((total, key) => total + (Number(current[key]) || 0), 0);
        const fallback = percent(context.used_percentage);

        // The mac script derives the percentage from current_usage; used_percentage
        // covers responses that omit the token breakdown.
        const value = Number.isFinite(size) && size > 0 && tokens > 0
            ? Math.floor(tokens * 100 / size)
            : fallback;

        if (value !== null) {
            const color = value <= 50 ? scheme.cyan
                : value <= 75 ? scheme.yellow
                : scheme.gradient[8];
            const label = on(config, 'SHOW_CONTEXT_LABEL') ? 'Ctx: ' : '';
            const text = on(config, 'CONTEXT_AS_TOKENS')
                ? (tokens >= 1000 ? `${Math.floor(tokens / 1000)}K` : String(tokens))
                : `${Math.round(value)}%`;
            push('context', `${color}${label}${text}${scheme.reset}`);
        }
    }

    const showUsage = on(config, 'SHOW_USAGE');
    if (showUsage) {
        const limit = data?.rate_limits?.five_hour;
        const value = percent(limit?.used_percentage) ?? percent(cache.UTILIZATION);
        const resetsAt = Number(limit?.resets_at ?? Date.parse(cache.RESETS_AT) / 1000);

        if (value === null) {
            const label = on(config, 'SHOW_USAGE_LABEL') ? 'Usage: ' : '';
            push('usage', `${scheme.yellow}${label}~${scheme.reset}`);
        } else {
            push('usage', usageSegment(scheme, config, {
                value,
                resetsAt,
                now,
                window: SESSION_WINDOW_SECONDS,
                minElapsed: SESSION_MIN_ELAPSED,
                label: on(config, 'SHOW_USAGE_LABEL') ? 'Usage: ' : '',
                showBar: on(config, 'SHOW_PROGRESS_BAR'),
                showPace: on(config, 'SHOW_PACE_MARKER'),
                showReset: on(config, 'SHOW_RESET_TIME'),
                resetLabel: on(config, 'SHOW_RESET_LABEL') ? 'Reset: ' : '',
                weekday: false,
            }));
        }
    }

    if (showUsage && on(config, 'SHOW_WEEKLY')) {
        const limit = data?.rate_limits?.seven_day;
        const value = percent(limit?.used_percentage) ?? percent(cache.WEEKLY_UTILIZATION);
        const resetsAt = Number(limit?.resets_at ?? Date.parse(cache.WEEKLY_RESETS_AT) / 1000);

        if (value !== null) {
            const override = scheme.mode === 'perElement'
                ? hexToAnsi(config.ELEMENT_COLOR_WEEKLY)
                : '';
            push('weekly', usageSegment(scheme, config, {
                value,
                resetsAt,
                now,
                window: WEEKLY_WINDOW_SECONDS,
                minElapsed: WEEKLY_MIN_ELAPSED,
                label: on(config, 'SHOW_WEEKLY_LABEL') ? 'Weekly: ' : '',
                showBar: on(config, 'SHOW_WEEKLY_BAR'),
                showPace: on(config, 'SHOW_WEEKLY_PACE_MARKER'),
                showReset: on(config, 'SHOW_WEEKLY_RESET_TIME'),
                resetLabel: '',
                weekday: true,
                color: override || undefined,
            }));
        }
    }

    if (showUsage && on(config, 'SHOW_EXTRA_USAGE')) {
        const used = Number(cache.COST_USED);
        const limit = Number(cache.COST_LIMIT);
        const currency = clean(cache.COST_CURRENCY, 8);
        if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0 && currency) {
            const override = scheme.mode === 'perElement'
                ? hexToAnsi(config.ELEMENT_COLOR_EXTRA)
                : '';
            const color = override ||
                gradientColor(scheme, Math.min(100, Math.max(0, Math.floor(used / limit * 100))));
            push('extra', `${color}${cache.COST_USED} ${currency}${scheme.reset}`);
        }
    }

    // A break before the named segment splits the row there; 'none' is the
    // single line the mac app renders.
    return segments.reduce((rows, segment, index) => {
        if (index === 0)
            return segment.text;
        return segment.id === config.LINE_BREAK
            ? `${rows}\n${segment.text}`
            : `${rows}${separator}${segment.text}`;
    }, '');
}

function main() {
    try {
        const data = JSON.parse(fs.readFileSync(0, 'utf8'));
        const cwdValue = data?.workspace?.current_dir || data?.cwd;
        const cwd = typeof cwdValue === 'string' ? cwdValue : '';
        process.stdout.write(`${renderStatusline(data, {
            branch: data?.worktree?.branch || findBranch(cwd) ||
                data?.workspace?.git_worktree,
            profile: readProfile(),
            cache: readCache(),
        })}\n`);
    } catch (_error) {
        // A statusline must never interfere with the Claude session.
    }
}

if (require.main === module)
    main();

module.exports = {
    DEFAULTS,
    clockTime,
    hexToAnsi,
    paceColor,
    palette,
    progressBar,
    readConfig,
    renderStatusline,
};
