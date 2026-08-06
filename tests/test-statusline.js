'use strict';

// Reset clock times are local; pin the zone so assertions are stable.
process.env.TZ = 'UTC';

const assert = require('assert');
const {
    DEFAULTS,
    clockTime,
    hexToAnsi,
    palette,
    progressBar,
    renderStatusline,
} = require('../statusline.js');

const now = Date.parse('2026-08-05T18:00:00Z');
const config = overrides => ({...DEFAULTS, ...overrides});

const session = {
    workspace: {current_dir: '/work/myproj'},
    model: {display_name: 'Opus 5'},
    context_window: {
        context_window_size: 200_000,
        used_percentage: 42,
        current_usage: {
            input_tokens: 8_500,
            cache_creation_input_tokens: 5_000,
            cache_read_input_tokens: 2_000,
        },
    },
    rate_limits: {
        five_hour: {used_percentage: 23.5, resets_at: now / 1000 + 7_200},
        seven_day: {used_percentage: 81, resets_at: now / 1000 + 172_800},
    },
};

const render = (data, options) => renderStatusline(data, {
    colors: false,
    now,
    config: config(),
    branch: 'main',
    ...options,
});

// --- Default line matches the macOS statusline-command.sh output ------------
// 24% -> filled = (24*10+50)/100 = 2 blocks. 3h elapsed of 5h -> marker at
// index 6. Context is derived from current_usage: 15500/200000 = 7%.
assert.strictEqual(
    render(session),
    'myproj │ ⎇ main │ Opus 5 │ Ctx: 7% │ Usage: 24% ▓▓░░░░┃░░░ → Reset: 08:00 PM',
    'mac-exact default line'
);

// --- Component and label toggles -------------------------------------------
assert.strictEqual(
    render(session, {
        config: config({
            SHOW_BRANCH: '0',
            SHOW_CONTEXT_LABEL: '0',
            SHOW_USAGE_LABEL: '0',
            SHOW_RESET_LABEL: '0',
            USE_24_HOUR_TIME: '1',
        }),
    }),
    'myproj │ Opus 5 │ 7% │ 24% ▓▓░░░░┃░░░ → 20:00',
    'labels off, branch hidden, 24-hour clock'
);

assert.strictEqual(
    render(session, {config: config({CONTEXT_AS_TOKENS: '1', SHOW_USAGE: '0'})}),
    'myproj │ ⎇ main │ Opus 5 │ Ctx: 15K',
    'context as tokens'
);

assert.strictEqual(
    render(session, {config: config({SHOW_PROGRESS_BAR: '0', SHOW_RESET_TIME: '0'})}),
    'myproj │ ⎇ main │ Opus 5 │ Ctx: 7% │ Usage: 24%',
    'bar and reset time off'
);

// Profile is off by default, matching the mac app's SHOW_PROFILE=0.
assert(!render(session, {profile: 'me@example.com'}).includes('example.com'),
    'profile stays hidden unless enabled');
assert(render(session, {
    profile: 'me@example.com',
    config: config({SHOW_PROFILE: '1'}),
}).includes('│ me@example.com │'), 'profile shown when enabled');

// --- Weekly segment ---------------------------------------------------------
// 81% -> 8 blocks; 2 of 7 days remaining puts the marker at index 7.
assert(render(session, {config: config({SHOW_WEEKLY: '1'})})
    .includes('Weekly: 81% ▓▓▓▓▓▓▓┃░░ → Fri 06:00 PM'), 'weekly with weekday reset');

// --- Pace marker ------------------------------------------------------------
// Marker sits at elapsed position; its colour is the projected end-of-window
// burn, not current usage.
const paceOf = (used, elapsedFraction) => {
    const elapsed = 18_000 * elapsedFraction;
    return progressBar(palette(config(), true), used, '', {
        elapsed,
        window: 18_000,
        minElapsed: 540,
        stepColors: true,
    });
};
assert(paceOf(10, 0.5).includes('\x1b[38;5;34m┃'), 'projected 20% is comfortable green');
assert(paceOf(30, 0.5).includes('\x1b[38;5;37m┃'), 'projected 60% is on-track teal');
assert(paceOf(41, 0.5).includes('\x1b[38;5;178m┃'), 'projected 82% is warming yellow');
assert(paceOf(48, 0.5).includes('\x1b[38;5;208m┃'), 'projected 96% is pressing orange');
assert(paceOf(55, 0.5).includes('\x1b[38;5;160m┃'), 'projected 110% is critical red');
assert(paceOf(70, 0.5).includes('\x1b[38;5;135m┃'), 'projected 140% is runaway purple');

// Too early in the window a projection is meaningless, so the marker inherits
// the usage colour instead of a pace tier. The mac script gates the session at
// 540s but the weekly window at 3024s, which is a far smaller fraction.
assert(!paceOf(90, 0.02).includes('\x1b[38;5;135m'), 'no session pace tier before 540s');
const weeklyPace = elapsed => progressBar(palette(config(), true), 90, '', {
    elapsed,
    window: 604_800,
    minElapsed: 3_024,
    stepColors: true,
});
assert(weeklyPace(5_000).includes('\x1b[38;5;135m┃'), 'weekly pace tier applies from 3024s');
assert(!weeklyPace(2_000).includes('\x1b[38;5;135m'), 'no weekly pace tier before 3024s');

// A finished or not-yet-started window draws no marker at all.
assert(!paceOf(50, 1).includes('┃'), 'no marker once the window is over');

// --- Ten-level usage gradient ----------------------------------------------
const gradient = [22, 28, 34, 100, 142, 178, 172, 166, 160, 124];
for (const [index, code] of gradient.entries()) {
    const used = (index + 1) * 10;
    const line = renderStatusline({rate_limits: {five_hour: {used_percentage: used}}}, {
        colors: true,
        now,
        config: config({SHOW_DIRECTORY: '0', SHOW_MODEL: '0', SHOW_CONTEXT: '0'}),
        branch: '',
    });
    assert(line.startsWith(`\x1b[38;5;${code}m`), `gradient level ${index + 1} at ${used}%`);
}

// --- Colour modes -----------------------------------------------------------
const coloured = render(session, {colors: true});
assert(coloured.includes('\x1b[0;34mmyproj') && coloured.includes('\x1b[0;32m⎇ main') &&
    coloured.includes('\x1b[0;33mOpus 5') && coloured.includes('\x1b[0;90m │ '),
'multi-colour uses the mac ANSI palette');

// Greyscale drops colour but keeps the reset sequences, exactly as the mac
// script does. Only NO_COLOR (colors: false) produces wholly bare text.
const greyscale = render(session, {colors: true, config: config({COLOR_MODE: 'monochrome'})});
assert(!/\x1b\[(38;[25];|0;3|0;9)/.test(greyscale), 'greyscale emits no colour');
assert(greyscale.includes('\x1b[0m'), 'greyscale keeps resets, matching the mac script');
assert(!render(session, {colors: false}).includes('\x1b'), 'NO_COLOR emits no escapes at all');

assert.strictEqual(hexToAnsi('#00BFFF'), '\x1b[38;2;0;191;255m', 'hex to truecolor');
assert(render(session, {colors: true, config: config({COLOR_MODE: 'singleColor'})})
    .includes('\x1b[38;2;0;191;255mmyproj'), 'single colour applies to every element');

const perElement = render(session, {
    colors: true,
    config: config({COLOR_MODE: 'perElement', ELEMENT_COLOR_DIR: '#FF0000'}),
});
assert(perElement.includes('\x1b[38;2;255;0;0mmyproj'), 'per-element directory colour');
assert(perElement.includes('\x1b[38;2;0;187;0m⎇ main'), 'per-element branch default');

// Mac quirk: pace step colours are applied last, so they beat a custom pace
// colour unless step colours are switched off.
const stepColours = config({
    COLOR_MODE: 'perElement',
    ELEMENT_COLOR_PACE: '#FF00FF',
    PACE_MARKER_STEP_COLORS: '1',
});
assert.strictEqual(palette(stepColours, true).pace[0], '\x1b[38;5;34m',
    'step colours override a custom pace colour');
assert.strictEqual(
    palette({...stepColours, PACE_MARKER_STEP_COLORS: '0'}, true).pace[0],
    '\x1b[38;2;255;0;255m',
    'custom pace colour applies once step colours are off'
);

// --- Line breaks ------------------------------------------------------------
assert.strictEqual(render(session).includes('\n'), false, 'mac default is one line');
assert.strictEqual(
    render(session, {config: config({LINE_BREAK: 'context'})}),
    'myproj │ ⎇ main │ Opus 5\nCtx: 7% │ Usage: 24% ▓▓░░░░┃░░░ → Reset: 08:00 PM',
    'break before context splits identity from metrics'
);
assert(render(session, {config: config({LINE_BREAK: 'usage'})})
    .startsWith('myproj │ ⎇ main │ Opus 5 │ Ctx: 7%\nUsage:'), 'break before usage');

// --- Extra usage cost -------------------------------------------------------
assert(render(session, {
    config: config({SHOW_EXTRA_USAGE: '1'}),
    cache: {COST_USED: '12.34', COST_LIMIT: '100.00', COST_CURRENCY: 'USD'},
}).endsWith('12.34 USD'), 'extra usage renders cost, not a percentage');

// --- Cache fallback ---------------------------------------------------------
assert(render({workspace: {current_dir: '/work/myproj'}}, {
    cache: {UTILIZATION: '55', RESETS_AT: '2026-08-05T20:00:00Z'},
}).includes('Usage: 55%'), 'cache covers sessions with no rate_limits yet');
assert(render({workspace: {current_dir: '/work/myproj'}}).includes('Usage: ~'),
    'unknown usage degrades to a tilde');

// --- Clock rounding ---------------------------------------------------------
assert.strictEqual(clockTime(Date.parse('2026-08-05T18:59:45Z') / 1000, true), '19:00',
    'rounds up to the nearest minute');
assert.strictEqual(clockTime(Date.parse('2026-08-05T18:59:20Z') / 1000, false), '06:59 PM',
    'rounds down and formats 12-hour');
assert.strictEqual(clockTime(Date.parse('2026-08-05T00:30:00Z') / 1000, false), '12:30 AM',
    'midnight is 12 AM');

// --- Defaults agree with the settings schema --------------------------------
// The skin reads a file and the panel writes it from GSettings; if the two sets
// of defaults drift, a fresh install renders differently before and after the
// config file first appears.
const schema = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'schemas',
        'org.gnome.shell.extensions.claude-usage-tracker.gschema.xml'),
    'utf8'
);
const keyPattern =
    /<key name="(statusline-[a-z0-9-]+)" type="([bs])">\s*<default>(.*?)<\/default>/g;
let schemaKeys = 0;
for (const [, key, type, value] of schema.matchAll(keyPattern)) {
    const name = key.replace(/^statusline-/, '').replace(/-/g, '_').toUpperCase();
    const expected = type === 'b'
        ? (value === 'true' ? '1' : '0')
        : value.replace(/^'|'$/g, '');
    assert.strictEqual(DEFAULTS[name], expected, `${key} matches DEFAULTS.${name}`);
    schemaKeys += 1;
}
// PROFILE_NAME is supplied by the panel, not stored as a setting.
assert.strictEqual(schemaKeys, Object.keys(DEFAULTS).length - 1,
    'every skin default has a matching schema key');

// --- Hostile input ----------------------------------------------------------
const hostile = render({
    workspace: {current_dir: '/tmp/\x1b[31mevil'},
    model: {display_name: 'Claude\nspoof'},
}, {branch: 'main\x1b]8;;http://evil\x07'});
assert(!hostile.includes('\x1b') && !hostile.includes('\nspoof'),
    'terminal control sequences stripped from untrusted values');

console.log('statusline checks passed');
