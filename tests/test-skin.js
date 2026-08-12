import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    SKIN_KEYS,
    loadTextAsync,
    readAccountLabelAsync,
    renderConfig,
    statuslineCommand,
    writeConfig,
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

// The config write must never conjure a Claude directory into existence.
const tmp = GLib.Dir.make_tmp('claude-usage-tracker-XXXXXX');
const missing = GLib.build_filenamev([tmp, 'missing']);
GLib.setenv('CLAUDE_CONFIG_DIR', missing, true);
writeConfig(settings, 'Acme Inc');
assert(!GLib.file_test(missing, GLib.FileTest.EXISTS),
    'writeConfig leaves a missing Claude directory alone');

GLib.setenv('CLAUDE_CONFIG_DIR', tmp, true);
writeConfig(settings, 'Acme Inc');
const written = GLib.build_filenamev([tmp, 'statusline-config.txt']);
assert(GLib.file_test(written, GLib.FileTest.EXISTS),
    'writeConfig still projects into an existing Claude directory');

// Everything the shell reads goes through the async path: `.claude.json` carries
// Claude Code's project history and must never be parsed on the compositor
// thread. A missing file is reported, not thrown.
const account = GLib.build_filenamev([tmp, '.claude.json']);
GLib.file_set_contents(account,
    JSON.stringify({oauthAccount: {organizationName: 'Acme Inc'}}));

const loop = GLib.MainLoop.new(null, false);
let asyncError = null;
(async () => {
    try {
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
Gio.File.new_for_path(written).delete(null);
Gio.File.new_for_path(tmp).delete(null);

print('skin checks passed');
