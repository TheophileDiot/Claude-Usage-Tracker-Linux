import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    SKIN_KEYS,
    loadTextAsync,
    readAccountLabelAsync,
    renderConfig,
    statuslineCommand,
    writeConfig,
    writeUsageCache,
} from '../skin.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.claude-usage-tracker';

function assert(condition, message) {
    if (!condition)
        throw new Error(`assertion failed: ${message}`);
}

// A memory backend keeps the test off the user's real dconf.
const source = Gio.SettingsSchemaSource.new_from_directory(
    GLib.build_filenamev([GLib.path_get_dirname(
        GLib.path_get_dirname(import.meta.url.replace('file://', ''))), 'schemas']),
    null,
    true
);
const settings = Gio.Settings.new_full(
    source.lookup(SCHEMA_ID, false),
    Gio.memory_settings_backend_new(),
    null
);

const config = Object.fromEntries(renderConfig(settings, 'Acme Inc')
    .split('\n')
    .filter(line => line.includes('=') && !line.startsWith('#'))
    .map(line => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, '')];
    }));

// Defaults must match the macOS statusline-config.txt defaults.
const expected = {
    SHOW_DIRECTORY: '1',
    SHOW_BRANCH: '1',
    SHOW_MODEL: '1',
    SHOW_PROFILE: '0',
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
    LINE_BREAK: 'none',
};

for (const [key, value] of Object.entries(expected))
    assert(config[key] === value, `${key} defaults to "${value}", got "${config[key]}"`);

assert(config.PROFILE_NAME === 'Acme Inc', 'profile name is written for the skin');
assert(SKIN_KEYS.length === Object.keys(expected).length,
    `every skin key is projected (${SKIN_KEYS.length} vs ${Object.keys(expected).length})`);

// Values that would break the KEY="value" format must not survive.
settings.set_string('statusline-single-color', 'a"b\nSHOW_USAGE=0');
assert(!renderConfig(settings, '').includes('\nSHOW_USAGE=0'),
    'config values cannot inject extra keys');
settings.set_string('statusline-single-color', '#00BFFF');

assert(statuslineCommand('/opt/ext') === 'node "/opt/ext/statusline.js"',
    'statusline command quotes the script path');

// Shell code must not block the compositor on I/O, so both writers are async.
const tmp = GLib.Dir.make_tmp('claude-usage-tracker-XXXXXX');
const missing = GLib.build_filenamev([tmp, 'missing']);
const written = GLib.build_filenamev([tmp, 'statusline-config.txt']);
const cached = GLib.build_filenamev([tmp, '.statusline-usage-cache']);

const readCache = () => Object.fromEntries(new TextDecoder()
    .decode(GLib.file_get_contents(cached)[1])
    .split('\n')
    .filter(line => line.includes('='))
    .map(line => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
    }));

const mode = path => Gio.File.new_for_path(path)
    .query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
    .get_attribute_uint32('unix::mode') & 0o777;

// `.claude.json` carries Claude Code's project history and must never be parsed
// on the compositor thread. A missing file is reported, not thrown.
const account = GLib.build_filenamev([tmp, '.claude.json']);
GLib.file_set_contents(account,
    JSON.stringify({oauthAccount: {organizationName: 'Acme Inc'}}));

const loop = GLib.MainLoop.new(null, false);
let asyncError = null;
(async () => {
    try {
        // Neither writer may conjure a Claude directory into existence.
        GLib.setenv('CLAUDE_CONFIG_DIR', missing, true);
        await writeConfig(settings, 'Acme Inc');
        await writeUsageCache([{id: 'session', percent: 1, resetAt: ''}], null);
        assert(!GLib.file_test(missing, GLib.FileTest.EXISTS),
            'neither writer touches a missing Claude directory');

        GLib.setenv('CLAUDE_CONFIG_DIR', tmp, true);
        await writeConfig(settings, 'Acme Inc');
        assert(GLib.file_test(written, GLib.FileTest.EXISTS),
            'writeConfig still projects into an existing Claude directory');

        // The skin's weekly component has no other source: Claude Code puts only
        // `five_hour` and `seven_day` on stdin, and the API now reports the
        // weekly window per model instead of as one all-models figure.
        await writeUsageCache([
            {id: 'session', percent: 21, resetAt: '2026-08-18T11:20:00Z'},
            {id: 'model:fable', percent: 3, resetAt: '2026-08-22T01:59:59Z'},
        ], null);
        assert(readCache().UTILIZATION === '21',
            'the cache carries the session window');
        assert(readCache().WEEKLY_UTILIZATION === '3',
            'a model-scoped metric fills the weekly line when seven_day is gone');
        assert(readCache().WEEKLY_RESETS_AT === '2026-08-22T01:59:59Z',
            'the model-scoped reset time comes along with it');

        await writeUsageCache([
            {id: 'weekly', percent: 40, resetAt: ''},
            {id: 'model:fable', percent: 3, resetAt: ''},
        ], null);
        assert(readCache().WEEKLY_UTILIZATION === '40',
            'an all-models window still wins over the model-scoped fallback');

        // Both files sit next to Claude Code's credentials; async writing must
        // not have widened them.
        assert(mode(written) === 0o600, 'the projected config stays owner-only');
        assert(mode(cached) === 0o600, 'the usage cache stays owner-only');

        assert(await loadTextAsync(missing) === null,
            'loadTextAsync reports a missing file as no text');
        assert(await readAccountLabelAsync() === 'Acme Inc',
            'readAccountLabelAsync reads the account label');
    } catch (error) {
        asyncError = error;
    }
    loop.quit();
})();
loop.run();
if (asyncError)
    throw asyncError;

Gio.File.new_for_path(account).delete(null);
Gio.File.new_for_path(cached).delete(null);
Gio.File.new_for_path(written).delete(null);
Gio.File.new_for_path(tmp).delete(null);

print('skin checks passed');
