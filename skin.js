import GLib from 'gi://GLib';

/**
 * Claude Code skin configuration.
 *
 * The skin is a Node script, so it cannot read GSettings directly. Settings are
 * projected into `~/.claude/statusline-config.txt` using the same key names and
 * `KEY=value` format the macOS tracker writes, which keeps the file readable and
 * hand-editable for anyone coming from that app.
 */

const CONFIG_FILE = 'statusline-config.txt';
const CACHE_FILE = '.statusline-usage-cache';
const SETTINGS_FILE = 'settings.json';

/** GSettings key -> statusline-config.txt key. */
const BOOLEAN_KEYS = {
    'statusline-show-directory': 'SHOW_DIRECTORY',
    'statusline-show-branch': 'SHOW_BRANCH',
    'statusline-show-model': 'SHOW_MODEL',
    'statusline-show-profile': 'SHOW_PROFILE',
    'statusline-show-context': 'SHOW_CONTEXT',
    'statusline-context-as-tokens': 'CONTEXT_AS_TOKENS',
    'statusline-show-usage': 'SHOW_USAGE',
    'statusline-show-progress-bar': 'SHOW_PROGRESS_BAR',
    'statusline-show-pace-marker': 'SHOW_PACE_MARKER',
    'statusline-pace-marker-step-colors': 'PACE_MARKER_STEP_COLORS',
    'statusline-show-reset-time': 'SHOW_RESET_TIME',
    'statusline-use-24-hour-time': 'USE_24_HOUR_TIME',
    'statusline-show-context-label': 'SHOW_CONTEXT_LABEL',
    'statusline-show-usage-label': 'SHOW_USAGE_LABEL',
    'statusline-show-reset-label': 'SHOW_RESET_LABEL',
    'statusline-show-weekly': 'SHOW_WEEKLY',
    'statusline-show-weekly-bar': 'SHOW_WEEKLY_BAR',
    'statusline-show-weekly-pace-marker': 'SHOW_WEEKLY_PACE_MARKER',
    'statusline-show-weekly-reset-time': 'SHOW_WEEKLY_RESET_TIME',
    'statusline-show-weekly-label': 'SHOW_WEEKLY_LABEL',
    'statusline-show-extra-usage': 'SHOW_EXTRA_USAGE',
};

const STRING_KEYS = {
    'statusline-line-break': 'LINE_BREAK',
    'statusline-color-mode': 'COLOR_MODE',
    'statusline-single-color': 'SINGLE_COLOR',
    'statusline-element-color-dir': 'ELEMENT_COLOR_DIR',
    'statusline-element-color-branch': 'ELEMENT_COLOR_BRANCH',
    'statusline-element-color-model': 'ELEMENT_COLOR_MODEL',
    'statusline-element-color-profile': 'ELEMENT_COLOR_PROFILE',
    'statusline-element-color-context': 'ELEMENT_COLOR_CONTEXT',
    'statusline-element-color-separator': 'ELEMENT_COLOR_SEPARATOR',
    'statusline-element-color-usage': 'ELEMENT_COLOR_USAGE',
    'statusline-element-color-pace': 'ELEMENT_COLOR_PACE',
    'statusline-element-color-weekly': 'ELEMENT_COLOR_WEEKLY',
    'statusline-element-color-extra': 'ELEMENT_COLOR_EXTRA',
};

export const SKIN_KEYS = [...Object.keys(BOOLEAN_KEYS), ...Object.keys(STRING_KEYS)];

export function claudeDirectory() {
    return GLib.getenv('CLAUDE_CONFIG_DIR') ||
        GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
}

function readText(path) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return null;
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? new TextDecoder().decode(bytes) : null;
}

/** Account label used as the skin's profile name. */
export function readAccountLabel() {
    const configured = GLib.getenv('CLAUDE_CONFIG_DIR');
    const candidates = [
        configured && GLib.build_filenamev([configured, '.claude.json']),
        GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']),
        GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.claude.json']),
    ].filter(Boolean);

    for (const path of candidates) {
        try {
            const text = readText(path);
            if (!text)
                continue;
            const account = JSON.parse(text).oauthAccount;
            const label = account?.organizationName || account?.displayName || account?.email;
            if (typeof label === 'string' && label.trim())
                return label.trim().slice(0, 40);
        } catch (_error) {
            // Optional account metadata never blocks anything.
        }
    }
    return '';
}

/** Render settings as the mac-compatible config file body. */
export function renderConfig(settings, profileName = readAccountLabel()) {
    const lines = ['# Written by Claude Usage Tracker. Edits are overwritten from preferences.'];
    for (const [key, name] of Object.entries(BOOLEAN_KEYS))
        lines.push(`${name}=${settings.get_boolean(key) ? '1' : '0'}`);
    for (const [key, name] of Object.entries(STRING_KEYS))
        lines.push(`${name}="${settings.get_string(key).replace(/["\\\n]/g, '')}"`);
    lines.push(`PROFILE_NAME="${String(profileName).replace(/["\\\n]/g, '')}"`);
    return `${lines.join('\n')}\n`;
}

export function writeConfig(settings, profileName = readAccountLabel()) {
    const directory = claudeDirectory();
    GLib.mkdir_with_parents(directory, 0o700);
    const path = GLib.build_filenamev([directory, CONFIG_FILE]);
    GLib.file_set_contents(path, renderConfig(settings, profileName));
    GLib.chmod(path, 0o600);
}

/**
 * Panel-sourced cache. Claude Code supplies rate limits on stdin, so this only
 * has to cover the start of a session and the extra-usage cost, which never
 * appears in the statusline payload.
 */
export function writeUsageCache(metrics, extra, now = Date.now()) {
    const find = id => metrics.find(item => item.id === id);
    const session = find('session');
    const weekly = find('weekly');
    const lines = [`TIMESTAMP=${Math.floor(now / 1000)}`];

    if (session) {
        lines.push(`UTILIZATION=${Math.round(session.percent)}`);
        lines.push(`RESETS_AT=${session.resetAt ?? ''}`);
    }
    if (weekly) {
        lines.push(`WEEKLY_UTILIZATION=${Math.round(weekly.percent)}`);
        lines.push(`WEEKLY_RESETS_AT=${weekly.resetAt ?? ''}`);
    }
    if (extra) {
        lines.push(`COST_USED=${extra.used}`);
        lines.push(`COST_LIMIT=${extra.limit}`);
        lines.push(`COST_CURRENCY=${extra.currency}`);
    }

    const directory = claudeDirectory();
    GLib.mkdir_with_parents(directory, 0o700);
    const path = GLib.build_filenamev([directory, CACHE_FILE]);
    GLib.file_set_contents(path, `${lines.join('\n')}\n`);
    GLib.chmod(path, 0o600);
}

function settingsPath() {
    return GLib.build_filenamev([claudeDirectory(), SETTINGS_FILE]);
}

export function statuslineCommand(extensionPath) {
    return `node "${GLib.build_filenamev([extensionPath, 'statusline.js'])}"`;
}

/** True when Claude Code is already pointed at this extension's skin. */
export function isInstalled(extensionPath) {
    try {
        const text = readText(settingsPath());
        return text
            ? JSON.parse(text).statusLine?.command === statuslineCommand(extensionPath)
            : false;
    } catch (_error) {
        return false;
    }
}

/**
 * Point Claude Code's statusLine at this extension, keeping a timestamped backup
 * of the previous settings.json. Returns the backup path, or null when the file
 * did not exist yet.
 */
export function install(extensionPath) {
    const path = settingsPath();
    const text = readText(path);
    let backup = null;

    if (text !== null) {
        const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
        backup = `${path}.claude-usage-tracker-backup-${stamp}`;
        GLib.file_set_contents(backup, text);
        GLib.chmod(backup, 0o600);
    }

    // Throwing on malformed JSON is deliberate: overwriting a settings file we
    // cannot parse would discard configuration we never read.
    const settings = text === null ? {} : JSON.parse(text);
    settings.statusLine = {type: 'command', command: statuslineCommand(extensionPath)};

    GLib.mkdir_with_parents(claudeDirectory(), 0o700);
    GLib.file_set_contents(path, `${JSON.stringify(settings, null, 2)}\n`);
    GLib.chmod(path, 0o600);
    return backup;
}

/** Remove the statusLine entry, leaving the rest of settings.json untouched. */
export function remove() {
    const path = settingsPath();
    const text = readText(path);
    if (text === null)
        return;

    const settings = JSON.parse(text);
    delete settings.statusLine;
    GLib.file_set_contents(path, `${JSON.stringify(settings, null, 2)}\n`);
    GLib.chmod(path, 0o600);
}
