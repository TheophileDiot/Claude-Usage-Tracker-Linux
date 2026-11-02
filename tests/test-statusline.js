'use strict';

// Reset clock times are local; pin the zone so assertions are stable.
process.env.TZ = 'UTC';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {stripVTControlCharacters} = require('util');
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
    effort: {level: 'high'},
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

// --- Default layout keeps the macOS order, with effort replacing model ------
// 24% -> filled = (24*10+50)/100 = 2 blocks. 3h elapsed of 5h -> marker at
// index 6. Context is derived from current_usage: 15500/200000 = 7%.
assert.strictEqual(
    render(session),
    'myproj │ ⎇ main │ high │ Ctx: 7% │ Usage: 24% ▓▓░░░░┃░░░ → Reset: 08:00 PM',
    'default line shows effort in place of model'
);

for (const level of ['low', 'medium', 'high', 'xhigh', 'max'])
    assert(render({...session, effort: {level}}).includes(`│ ${level} │`),
        `${level} effort comes from the session payload`);
for (const effort of [undefined, null, {}, {level: null}, {level: 5},
    {level: {}}, {level: ''}, {level: ' \n '}]) {
    const line = render({...session, effort});
    assert.strictEqual(line,
        'myproj │ ⎇ main │ Ctx: 7% │ Usage: 24% ▓▓░░░░┃░░░ → Reset: 08:00 PM',
        'missing or invalid effort does not invent a value or restore the model');
}
assert(!render(session, {config: config({SHOW_MODEL: '0'})}).includes('│ high │'),
    'the existing component toggle hides effort');

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
    'myproj │ high │ 7% │ 24% ▓▓░░░░┃░░░ → 20:00',
    'labels off, branch hidden, 24-hour clock'
);

assert.strictEqual(
    render(session, {config: config({CONTEXT_AS_TOKENS: '1', SHOW_USAGE: '0'})}),
    'myproj │ ⎇ main │ high │ Ctx: 15K',
    'context as tokens'
);

assert.strictEqual(
    render(session, {config: config({SHOW_PROGRESS_BAR: '0', SHOW_RESET_TIME: '0'})}),
    'myproj │ ⎇ main │ high │ Ctx: 7% │ Usage: 24%',
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
    coloured.includes('\x1b[0;33mhigh') && coloured.includes('\x1b[0;90m │ '),
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
assert(perElement.includes('\x1b[38;2;187;187;0mhigh'),
    'effort inherits the former model colour');

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
    'myproj │ ⎇ main │ high\nCtx: 7% │ Usage: 24% ▓▓░░░░┃░░░ → Reset: 08:00 PM',
    'break before context splits identity from metrics'
);
assert(render(session, {config: config({LINE_BREAK: 'usage'})})
    .startsWith('myproj │ ⎇ main │ high │ Ctx: 7%\nUsage:'), 'break before usage');

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
    effort: {level: 'high\n\x1b\u202espoof'},
}, {branch: 'main\x1b]8;;http://evil\x07'});
assert(!hostile.includes('\x1b') && !hostile.includes('\nspoof') &&
    !hostile.includes('\u202e') && hostile.includes('highspoof'),
    'terminal control sequences stripped from untrusted values');

// --- Platform drift regressions ---------------------------------------------
const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const verticalConstant = /const VERTICAL_LAYOUT = [\s\S]*?;/;
assert(!/vertical\s*:\s*true/.test(extensionSource.replace(verticalConstant, '')),
    'legacy vertical property belongs only in the version-selected constant');

assert(!render({workspace: {git_worktree: 'worktree-name'}}, {branch: undefined})
    .includes('⎇'), 'worktree names are not branch names');
assert(render({worktree: {branch: 'real-branch'}}, {branch: undefined})
    .includes('⎇ real-branch'), 'explicit worktree branch remains supported');

for (const context_window of [
    {used_percentage: 150},
    {context_window_size: 100, current_usage: {input_tokens: 150}},
]) {
    const line = render({context_window, rate_limits: {
        five_hour: {used_percentage: 150}, seven_day: {used_percentage: 200},
    }}, {config: config({SHOW_WEEKLY: '1'})});
    assert(line.includes('Ctx: 100%'), 'context percentage clamps to 100');
    assert(line.includes('Usage: 100% ▓▓▓▓▓▓▓▓▓▓'), 'session text and bar clamp to 100');
    assert(line.includes('Weekly: 100% ▓▓▓▓▓▓▓▓▓▓'), 'weekly text and bar clamp to 100');
}

const oldColumns = process.env.COLUMNS;
try {
    process.env.COLUMNS = '20';
    assert(!render(session).includes('\n'), 'wrapping defaults off even with narrow COLUMNS');
    const wrapConfig = config({WRAP_TO_WIDTH: '1', SHOW_USAGE: '0'});
    assert.strictEqual(render(session, {config: wrapConfig}),
        'myproj │ ⎇ main\nhigh │ Ctx: 7%', 'narrow terminal wraps before whole segments');
    assert.strictEqual(stripVTControlCharacters(render(session, {
        config: wrapConfig, colors: true,
    })), 'myproj │ ⎇ main\nhigh │ Ctx: 7%', 'ANSI colors consume no width');
    assert.strictEqual(render(session, {config: {...wrapConfig, LINE_BREAK: 'context'}}),
        'myproj │ ⎇ main\nhigh\nCtx: 7%', 'explicit break applies before width wrapping');
    for (const columns of [undefined, '0', '-1', '3.5', '20oops']) {
        if (columns === undefined)
            delete process.env.COLUMNS;
        else
            process.env.COLUMNS = columns;
        assert(!render(session, {config: wrapConfig}).includes('\n'),
            'missing or invalid COLUMNS leaves one line');
    }
} finally {
    if (oldColumns === undefined)
        delete process.env.COLUMNS;
    else
        process.env.COLUMNS = oldColumns;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-statusline-test-'));
try {
    fs.writeFileSync(path.join(tmp, '.claude.json'),
        JSON.stringify({oauthAccount: {emailAddress: 'email-only@example.test'}}));
    fs.writeFileSync(path.join(tmp, 'statusline-config.txt'),
        'SHOW_PROFILE=1\nSHOW_DIRECTORY=0\nSHOW_BRANCH=0\nSHOW_USAGE=0\n');
    const profile = vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, '..', 'statusline.js'), 'utf8') + '\nreadProfile();', {
            require: name => name === 'os' ? {homedir: () => tmp} : require(name),
            process: {env: {CLAUDE_CONFIG_DIR: tmp}}, module: {exports: {}},
        });
    assert.strictEqual(profile, 'email-only@example.test',
        'profile reader falls back to emailAddress');

    // Run the real prefs file helpers against an isolated settings directory.
    const prefsSource = fs.readFileSync(path.join(__dirname, '..', 'prefs.js'), 'utf8');
    const prefsContext = {
        claudeDirectory: () => tmp,
        statuslineCommand: directory => `node "${directory}/statusline.js"`,
        TextDecoder,
        GLib: {
            FileTest: {EXISTS: 1},
            file_test: fs.existsSync,
            file_get_contents: file => [true, fs.readFileSync(file)],
            file_set_contents: fs.writeFileSync,
            chmod: fs.chmodSync,
            mkdir_with_parents: directory => fs.mkdirSync(directory, {recursive: true}),
            build_filenamev: parts => path.join(...parts),
            DateTime: {new_now_local: () => ({format: () => 'test-stamp'})},
        },
    };
    vm.runInNewContext(prefsSource.slice(prefsSource.indexOf('const SETTINGS_FILE'),
        prefsSource.indexOf('const BASIC_ANSI')), prefsContext);
    const settingsFile = path.join(tmp, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({keep: true}));
    const backup = prefsContext.install('/opt/ext', 60);
    assert.strictEqual(JSON.parse(fs.readFileSync(settingsFile)).statusLine.refreshInterval, 60,
        'install writes positive refreshInterval');
    assert.strictEqual(JSON.parse(fs.readFileSync(backup)).keep, true, 'install retains backup');
    assert(prefsContext.isInstalled('/opt/ext'), 'skin stays installed');
    prefsContext.install('/opt/ext', 0);
    const reinstalled = JSON.parse(fs.readFileSync(settingsFile));
    assert(!('refreshInterval' in reinstalled.statusLine), 'reinstall with zero removes interval');
    assert.strictEqual(reinstalled.keep, true, 'reinstall preserves unrelated settings');
} finally {
    fs.rmSync(tmp, {recursive: true, force: true});
}

async function testPanelDrift() {
    let credentialText = '{}';
    let responseStatus = 429;
    let retryAfter = '120';
    let requests = 0;
    const context = {
        Config: {PACKAGE_VERSION: '51.1'},
        Clutter: {Orientation: {VERTICAL: 1}},
        GObject: {registerClass: value => value},
        PanelMenu: {Button: class {}}, Extension: class {},
        Gio: {Cancellable: class { is_cancelled() { return false; } }}, GLib: {PRIORITY_DEFAULT: 0},
        Soup: {Message: {new: () => ({
            status_code: responseStatus,
            request_headers: {append() {}},
            response_headers: {get_one: () => retryAfter},
        })}},
        loadTextAsync: async () => credentialText,
        TextDecoder,
        normalizeUsage: value => value,
    };
    vm.createContext(context);
    const source = extensionSource.replace(/^import [\s\S]*?;\n/gm, '')
        .replace('export default class', 'class');
    vm.runInContext(`${source}\nglobalThis.Indicator = ClaudeUsageIndicator;\n` +
        'globalThis.layout = VERTICAL_LAYOUT;', context);
    assert.strictEqual(context.layout.orientation, 1, 'GNOME 51 uses orientation');
    for (const version of ['46.8', '47.0', '48.0', '50.1']) {
        const layout = vm.runInNewContext(
            extensionSource.match(verticalConstant)[0] + '\nVERTICAL_LAYOUT;', {
                Config: {PACKAGE_VERSION: version}, Clutter: context.Clutter,
            });
        assert(version.startsWith('46') || version.startsWith('47')
            ? layout.vertical === true : layout.orientation === 1,
        `layout constructor property matches GNOME ${version}`);
    }
    const indicator = new context.Indicator();
    indicator._credentialPaths = () => ['fake-credentials'];
    indicator._settings = {get_int: () => 60};
    indicator._setLoading = () => {};
    indicator._showFailure = message => { indicator.failure = message; };
    indicator._showUsage = () => {};
    indicator._session = {
        send_and_read_async(message, _priority, _cancellable, callback) {
            requests++;
            callback(this, {});
        },
        send_and_read_finish: () => ({get_data: () => Buffer.from('{}')}),
    };
    await assert.rejects(() => indicator._readCredentials(),
        /No claude.ai login found.*Pro, Max or Ultra/);
    credentialText = JSON.stringify({claudeAiOauth: {
        accessToken: 'fake-token', refreshToken: 'fake-refresh', expiresAt: Date.now() - 1,
        refreshTokenExpiresAt: Date.now() + 60_000,
    }});
    await assert.rejects(() => indicator._readCredentials(), /Start Claude Code once to renew it/);
    credentialText = JSON.stringify({claudeAiOauth: {
        accessToken: 'fake-token', refreshToken: '', expiresAt: 0,
        refreshTokenExpiresAt: Date.now() + 60_000,
    }});
    await assert.rejects(() => indicator._readCredentials(), /Run claude auth login/,
        'a wiped refresh token cannot be renewed by starting Claude Code');
    credentialText = JSON.stringify({claudeAiOauth: {
        accessToken: '', refreshToken: '', expiresAt: 0,
        refreshTokenExpiresAt: Date.now() + 60_000,
    }});
    await assert.rejects(() => indicator._readCredentials(), /Run claude auth login/,
        'a wiped login with a refresh expiry reads as expired, not as an API key');
    credentialText = JSON.stringify({claudeAiOauth: {
        accessToken: 'fake-token', expiresAt: 1, refreshTokenExpiresAt: 1,
    }});
    await assert.rejects(() => indicator._readCredentials(), /Run claude auth login/);
    credentialText = JSON.stringify({claudeAiOauth: {accessToken: 'fake-token'}});
    indicator._credentialPaths = () => ['empty-credentials', 'valid-credentials'];
    context.loadTextAsync = async file => file === 'empty-credentials' ? '{}' : credentialText;
    assert.strictEqual(await indicator._readCredentials(), 'fake-token',
        'missing OAuth in first file still allows legacy credential path');
    indicator._credentialPaths = () => ['valid-credentials'];
    const before = Date.now();
    await indicator._refreshUsage();
    assert(indicator._retryAfter >= before + 120_000, '429 delay-seconds sets backoff');
    assert(indicator.failure.includes(new Date(indicator._retryAfter).toLocaleString()),
        'rate limit message names next attempt time');
    await indicator._refreshUsage();
    assert.strictEqual(requests, 1, 'scheduled refresh skips during backoff');
    retryAfter = new Date(Date.now() + 240_000).toUTCString();
    await indicator._refreshUsage(true);
    assert.strictEqual(requests, 2, 'manual refresh can bypass backoff');
    assert.strictEqual(indicator._retryAfter, Date.parse(retryAfter), '429 accepts HTTP-date');
    retryAfter = 'invalid';
    await indicator._refreshUsage(true);
    assert(indicator._retryAfter >= Date.now() + 59_000, 'invalid header uses normal interval');
    responseStatus = 200;
    await indicator._refreshUsage(true);
    assert.strictEqual(indicator._retryAfter, 0, 'successful manual retry clears backoff');
}

function loadIndicator(overrides = {}) {
    const usageSource = fs.readFileSync(path.join(__dirname, '..', 'usage.js'), 'utf8')
        .replace(/^export /gm, '');
    const context = {
        Config: {PACKAGE_VERSION: '51.1'},
        Clutter: {Orientation: {VERTICAL: 1}},
        GObject: {registerClass: value => value},
        PanelMenu: {Button: class {}}, Extension: class {},
        Gio: {Cancellable: class {}}, GLib: {PRIORITY_DEFAULT: 0},
        console, TextDecoder, ...overrides,
    };
    vm.createContext(context);
    const source = extensionSource.replace(/^import [\s\S]*?;\n/gm, '')
        .replace('export default class', 'class');
    vm.runInContext(`${usageSource}\n${source}\nglobalThis.Indicator = ClaudeUsageIndicator;`, context);
    return new context.Indicator();
}

function testPanelFixups() {
    // A weekly-only response after a used 5-hour window must still announce the reset.
    const ended = new Date(Date.now() - 60_000).toISOString();
    const saved = {'last-session-reset': ended, 'last-session-peak': 30, 'last-notified-threshold': 0};
    const indicator = loadIndicator();
    indicator._settings = {
        get_string: key => saved[key],
        get_int: key => saved[key],
        get_boolean: () => true,
        get_value: () => ({deep_unpack: () => []}),
        set_string: (key, value) => { saved[key] = value; },
        set_int: (key, value) => { saved[key] = value; },
    };
    const notices = [];
    indicator._notify = body => notices.push(body);
    indicator._checkNotifications(undefined);
    assert.strictEqual(JSON.stringify(notices), JSON.stringify(['The 5-hour window has reset.']),
        'a payload without the session window still notifies the reset once');
    indicator._checkNotifications(undefined);
    assert.strictEqual(notices.length, 1, 'the reset is not repeated');

    // Startup restore reads each metric from its own latest sample.
    const restored = loadIndicator();
    restored._history = {samples: [
        {at: 1, metrics: {session: 30, weekly: 40, extra: 5}},
        {at: 2, metrics: {extra: 6}},
    ]};
    restored._setState = () => {};
    restored._renderMetrics = () => {};
    restored._renderHistory = () => {};
    restored._updatePanel = () => {};
    restored._restoreHistorySnapshot();
    assert.strictEqual(JSON.stringify(restored._lastMetrics.map(item => [item.id, item.percent])),
        JSON.stringify([['session', 30], ['weekly', 40], ['extra', 6]]),
        'a sparse latest sample still restores the stable quotas');
}

testPanelDrift().then(testPanelFixups).then(() => console.log('statusline checks passed')).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
