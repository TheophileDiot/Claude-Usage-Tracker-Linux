import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    SKIN_KEYS,
    claudeDirectory,
    historyPath,
    readAccountLabelAsync,
    statuslineCommand,
    writeConfig,
    writeTextAsync,
} from './skin.js';
import {
    historyToCsv,
    parseHistory,
    parseThresholdList,
    windowRecords,
} from './usage.js';

const SETTINGS_FILE = 'settings.json';

/**
 * Claude Code's settings.json handling lives here rather than in `skin.js`
 * because preferences runs in its own process, where a synchronous read is
 * harmless. `skin.js` is imported by the shell and must stay async-only.
 */
function readText(path) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return null;
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? new TextDecoder().decode(bytes) : null;
}

function settingsPath() {
    return GLib.build_filenamev([claudeDirectory(), SETTINGS_FILE]);
}

/** True when Claude Code is already pointed at this extension's skin. */
function isInstalled(extensionPath) {
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
function install(extensionPath, refreshInterval) {
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
    if (refreshInterval > 0)
        settings.statusLine.refreshInterval = refreshInterval;

    GLib.mkdir_with_parents(claudeDirectory(), 0o700);
    GLib.file_set_contents(path, `${JSON.stringify(settings, null, 2)}\n`);
    GLib.chmod(path, 0o600);
    return backup;
}

/** Remove the statusLine entry, leaving the rest of settings.json untouched. */
function remove() {
    const path = settingsPath();
    const text = readText(path);
    if (text === null)
        return;

    const settings = JSON.parse(text);
    delete settings.statusLine;
    GLib.file_set_contents(path, `${JSON.stringify(settings, null, 2)}\n`);
    GLib.chmod(path, 0o600);
}

const BASIC_ANSI = {
    30: '#000000', 31: '#CC0000', 32: '#4E9A06', 33: '#C4A000',
    34: '#3465A4', 35: '#75507B', 36: '#06989A', 37: '#D3D7CF',
    90: '#555753', 91: '#EF2929', 92: '#8AE234', 93: '#FCE94F',
    94: '#729FCF', 95: '#AD7FA8', 96: '#34E2E2', 97: '#EEEEEC',
};

const CUBE = [0, 95, 135, 175, 215, 255];

/** xterm-256 index to hex, so the preview matches what a terminal draws. */
function xterm256(index) {
    if (index < 16)
        return BASIC_ANSI[index < 8 ? index + 30 : index + 82] ?? '#D3D7CF';
    if (index < 232) {
        const offset = index - 16;
        return '#' + [
            CUBE[Math.floor(offset / 36) % 6],
            CUBE[Math.floor(offset / 6) % 6],
            CUBE[offset % 6],
        ].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    const grey = (8 + 10 * (index - 232)).toString(16).padStart(2, '0');
    return `#${grey}${grey}${grey}`;
}

function escapeMarkup(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Convert the skin's ANSI output into Pango markup for the preview label. */
function ansiToMarkup(text) {
    let markup = '';
    let open = false;
    let index = 0;

    const close = () => {
        if (open) {
            markup += '</span>';
            open = false;
        }
    };

    while (index < text.length) {
        const escape = text.indexOf('\x1b[', index);
        if (escape === -1) {
            markup += escapeMarkup(text.slice(index));
            break;
        }
        markup += escapeMarkup(text.slice(index, escape));

        const end = text.indexOf('m', escape);
        if (end === -1) {
            markup += escapeMarkup(text.slice(escape));
            break;
        }

        const codes = text.slice(escape + 2, end).split(';').map(Number);
        index = end + 1;

        let color = null;
        if (codes[0] === 38 && codes[1] === 5)
            color = xterm256(codes[2]);
        else if (codes[0] === 38 && codes[1] === 2)
            color = '#' + codes.slice(2, 5)
                .map(value => (value || 0).toString(16).padStart(2, '0')).join('');
        else
            color = BASIC_ANSI[codes.find(code => BASIC_ANSI[code])] ?? null;

        close();
        if (color) {
            markup += `<span foreground="${color}">`;
            open = true;
        }
    }

    close();
    return markup;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, subtitle, choices) {
    const model = new Gtk.StringList();
    for (const [, label] of choices)
        model.append(label);

    const row = new Adw.ComboRow({title, subtitle, model});
    row.selected = Math.max(0, choices.findIndex(([value]) =>
        value === settings.get_string(key)));
    row.connect('notify::selected', () => {
        settings.set_string(key, choices[row.selected][0]);
    });
    return row;
}

function toHex(rgba) {
    return '#' + [rgba.red, rgba.green, rgba.blue]
        .map(value => Math.round(value * 255).toString(16).padStart(2, '0').toUpperCase())
        .join('');
}

function colorButton(hex, onChange) {
    const rgba = new Gdk.RGBA();
    if (!rgba.parse(hex))
        rgba.parse('#FFFFFF');

    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        rgba,
        valign: Gtk.Align.CENTER,
    });
    button.connect('notify::rgba', () => onChange(toHex(button.get_rgba())));
    return button;
}

function colorRow(settings, key, title) {
    const row = new Adw.ActionRow({title});
    row.add_suffix(colorButton(settings.get_string(key), hex => settings.set_string(key, hex)));
    return row;
}

/**
 * Colour row for a key where an empty string means "keep the dynamic gradient".
 * The switch chooses between dynamic and a fixed colour.
 */
function overrideColorRow(settings, key, title, subtitle, fallback) {
    const row = new Adw.ActionRow({title, subtitle});
    let hex = settings.get_string(key) || fallback;

    const button = colorButton(hex, value => {
        hex = value;
        if (settings.get_string(key))
            settings.set_string(key, value);
    });
    const toggle = new Gtk.Switch({
        active: settings.get_string(key) !== '',
        valign: Gtk.Align.CENTER,
    });
    toggle.connect('notify::active', () => {
        settings.set_string(key, toggle.active ? hex : '');
        button.sensitive = toggle.active;
    });
    button.sensitive = toggle.active;

    row.add_suffix(button);
    row.add_suffix(toggle);
    return row;
}

const SHORTCUTS = [
    ['shortcut-toggle-menu', 'Open or close the popup', 'Shows the usage popup from anywhere'],
    ['shortcut-refresh', 'Refresh usage', 'Same as the refresh button'],
    ['shortcut-open-prefs', 'Open preferences', 'Same as the settings button'],
];

/** The accelerator is captured here, not typed: Escape cancels, Backspace clears. */
function captureShortcut(window, settings, key, title) {
    const dialog = new Adw.AlertDialog({
        heading: title,
        body: 'Press the new shortcut, with Ctrl, Alt or Super held. Backspace clears it, Escape cancels.',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.set_close_response('cancel');

    const controller = new Gtk.EventControllerKey({
        propagation_phase: Gtk.PropagationPhase.CAPTURE,
    });
    controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask();
        if (mask === 0 && keyval === Gdk.KEY_Escape) {
            dialog.close();
        } else if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
            settings.set_strv(key, []);
            dialog.close();
        } else {
            const lower = Gdk.keyval_to_lower(keyval);
            // A bare letter or Shift+letter as a global binding would swallow typing.
            if (Gtk.accelerator_valid(lower, mask) && (mask & ~Gdk.ModifierType.SHIFT_MASK)) {
                const accelerator = Gtk.accelerator_name(lower, mask);
                for (const [other] of SHORTCUTS) {
                    if (other !== key && settings.get_strv(other)[0] === accelerator)
                        settings.set_strv(other, []);
                }
                settings.set_strv(key, [accelerator]);
                dialog.close();
            }
        }
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(controller);
    dialog.present(window);
}

/** `track` receives each settings handler id so the window can disconnect them. */
function shortcutRow(window, settings, [key, title, subtitle], track) {
    const row = new Adw.ActionRow({title, subtitle});
    const label = new Gtk.ShortcutLabel({
        accelerator: settings.get_strv(key)[0] ?? '',
        disabled_text: 'Not set',
        valign: Gtk.Align.CENTER,
    });
    track(settings.connect(`changed::${key}`, () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    }));
    const button = new Gtk.Button({label: 'Set…', valign: Gtk.Align.CENTER});
    button.connect('clicked', () => captureShortcut(window, settings, key, title));
    row.add_suffix(label);
    row.add_suffix(button);
    return row;
}

/**
 * Preferences runs in its own process, so a synchronous read is fine. The clear
 * cutoff is applied here too: the extension may be off and the file untouched.
 */
function readHistory(settings) {
    let text = null;
    try {
        text = readText(historyPath());
    } catch (_error) {
        // Unreadable reads as empty.
    }
    return parseHistory(text, settings.get_int64('history-cleared-at')).history;
}

function windowText(record) {
    const at = ms => GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const start = at(record.start);
    const end = at(record.end);
    const sameDay = start.format('%F') === end.format('%F');
    return `${start.format('%b %-d, %H:%M')} – ${end.format(sameDay ? '%H:%M' : '%b %-d, %H:%M')}`;
}

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._handlerIds = [];
        window.set_default_size(640, 760);
        const barColorModeId = this._buildPanelPage(window, settings);
        const colorModeId = this._buildSkinPage(window, settings);
        this._buildHistoryPage(window, settings);

        // The skin reads a file, not GSettings, so every change is projected out.
        // The preview renders the real file, so it has to wait for the write.
        const changedId = settings.connect('changed', (_settings, key) => {
            if (SKIN_KEYS.includes(key))
                this._writeSkinConfig(settings).then(() => this._refreshPreview());
        });
        window.connect('close-request', () => {
            for (const id of this._handlerIds)
                settings.disconnect(id);
            this._handlerIds = [];
            settings.disconnect(changedId);
            settings.disconnect(colorModeId);
            settings.disconnect(barColorModeId);
            this._stopPreview();
            this._preview = null;
        });
        this._writeSkinConfig(settings).then(() => this._refreshPreview());
    }

    async _writeSkinConfig(settings) {
        try {
            await writeConfig(settings, await readAccountLabelAsync());
        } catch (error) {
            console.error(`Claude Usage Tracker: skin config write failed: ${error.message}`);
        }
    }

    /** Returns the settings handler id the caller has to disconnect. */
    _buildPanelPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Panel',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const general = new Adw.PreferencesGroup({
            title: 'Usage',
            description: 'Control refresh and percentage presentation.',
        });
        page.add(general);

        const refresh = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between read-only Anthropic usage requests',
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 600,
                step_increment: 30,
                page_increment: 60,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', refresh, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(refresh);
        general.add(comboRow(
            settings,
            'percentage-mode',
            'Percentage',
            'Show quota already used or still remaining',
            [['used', 'Used'], ['remaining', 'Remaining']]
        ));
        general.add(comboRow(
            settings,
            'reset-display',
            'Reset time',
            'Time left, the clock time of the reset, or both',
            [['relative', 'Time left'], ['absolute', 'Clock time'], ['both', 'Both']]
        ));
        general.add(comboRow(
            settings,
            'time-format',
            'Clock format',
            'For clock times of resets; System follows GNOME',
            [['system', 'System'], ['12h', '12-hour'], ['24h', '24-hour']]
        ));

        const bars = new Adw.PreferencesGroup({
            title: 'Bars',
            description: 'Colours and the pace marker on panel and popup bars.',
        });
        page.add(bars);
        bars.add(switchRow(settings, 'show-pace-marker', 'Pace marker',
            'A tick at the elapsed share of the window, coloured by projected usage'));
        bars.add(comboRow(
            settings,
            'bar-color-basis',
            'Colour by',
            'Pace projects usage to the end of the window once 15% of it has passed',
            [['usage', 'Usage'], ['pace', 'Pace']]
        ));
        bars.add(comboRow(
            settings,
            'bar-color-mode',
            'Colour mode',
            'Green, amber and red at 70% and 90%, or one colour for every bar',
            [['levels', 'Levels'], ['single', 'Single colour']]
        ));
        const single = colorRow(settings, 'single-color', 'Single colour');
        bars.add(single);
        const syncSingle = () => {
            single.sensitive = settings.get_string('bar-color-mode') === 'single';
        };
        const barColorModeId = settings.connect('changed::bar-color-mode', syncSingle);
        syncSingle();

        const panel = new Adw.PreferencesGroup({
            title: 'Top panel',
            description: 'Choose the compact always-visible readout.',
        });
        page.add(panel);
        panel.add(comboRow(
            settings,
            'display-mode',
            'Display mode',
            'Percentage text, progress bar, or both',
            [['text', 'Text'], ['bar', 'Progress bar'], ['both', 'Both']]
        ));
        panel.add(comboRow(
            settings,
            'icon-style',
            'Icon style',
            'Original orange mark or monochrome panel treatment',
            [['color', 'Color'], ['monochrome', 'Monochrome']]
        ));
        panel.add(switchRow(settings, 'show-icon', 'Show icon',
            'Keep the tracker mark beside the usage value'));
        panel.add(switchRow(settings, 'panel-show-countdown', 'Reset countdown',
            'Add the time left, such as 2h or 45m, to the 5h readout'));

        const service = new Adw.PreferencesGroup({
            title: 'Service status',
            description: 'Optional popup row for status.claude.com.',
        });
        page.add(service);
        service.add(switchRow(settings, 'show-claude-status', 'Show Claude status',
            'Requests status.claude.com every 5 minutes while on, with no login or cookies. Off sends nothing.'));

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Global keyboard shortcuts. None are set by default.',
        });
        page.add(shortcuts);
        for (const shortcut of SHORTCUTS) {
            shortcuts.add(shortcutRow(window, settings, shortcut,
                id => this._handlerIds.push(id)));
        }

        const notifications = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: 'Notify once per enabled threshold in each 5-hour window.',
        });
        page.add(notifications);
        notifications.add(switchRow(settings, 'notifications-enabled',
            'Usage notifications', 'First refresh stays quiet'));

        for (const value of [75, 90, 95]) {
            const row = switchRow(settings, `threshold-${value}`, `${value}% used`,
                value === 75 ? 'Approaching limit'
                    : value === 90 ? 'High usage' : 'Critical usage');
            settings.bind('notifications-enabled', row, 'sensitive',
                Gio.SettingsBindFlags.GET);
            notifications.add(row);
        }

        const custom = new Adw.EntryRow({
            title: 'Custom thresholds (%)',
            text: settings.get_value('custom-thresholds').deep_unpack().join(', '),
            show_apply_button: true,
        });
        custom.connect('apply', () => {
            const values = parseThresholdList(custom.text);
            settings.set_value('custom-thresholds', new GLib.Variant('ai', values));
            custom.text = values.join(', ');
        });
        settings.bind('notifications-enabled', custom, 'sensitive', Gio.SettingsBindFlags.GET);
        notifications.add(custom);

        const reset = switchRow(settings, 'notify-session-reset', 'Window reset',
            'Notify when the 5-hour window resets after use');
        settings.bind('notifications-enabled', reset, 'sensitive', Gio.SettingsBindFlags.GET);
        notifications.add(reset);

        const privacy = new Adw.PreferencesGroup({title: 'Privacy'});
        page.add(privacy);
        privacy.add(new Adw.ActionRow({
            title: 'Read-only credentials',
            subtitle: 'Tokens remain in Claude Code’s credential file and are never saved in extension settings or history.',
        }));
        return barColorModeId;
    }

    _buildHistoryPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'History',
            icon_name: 'document-open-recent-symbolic',
        });
        window.add(page);
        const toast = title => window.add_toast(new Adw.Toast({title, timeout: 5}));

        const lists = [
            ['session', 'Session windows'],
            ['weekly', 'Weekly windows'],
        ].map(([id, title]) => {
            const group = new Adw.PreferencesGroup({
                title,
                description: 'Last 20 completed windows, newest first, with the peak usage.',
            });
            page.add(group);
            return {id, group, rows: []};
        });

        const refresh = () => {
            const history = readHistory(settings);
            for (const list of lists) {
                for (const row of list.rows)
                    list.group.remove(row);
                const records = windowRecords(history, list.id).slice(-20).reverse();
                list.rows = records.map(record => new Adw.ActionRow({
                    title: windowText(record),
                    subtitle: `Peak ${Math.round(record.peak)}%`,
                }));
                if (!list.rows.length) {
                    list.rows.push(new Adw.ActionRow({
                        title: 'No completed windows yet',
                        subtitle: 'A window is recorded once the panel has seen it reset.',
                    }));
                }
                for (const row of list.rows)
                    list.group.add(row);
            }
        };
        refresh();
        window.connect('notify::visible-page', () => {
            if (window.visible_page === page)
                refresh();
        });

        const exports = new Adw.PreferencesGroup({
            title: 'Export',
            description: 'Saves the stored samples to a file only you can read.',
        });
        page.add(exports);
        for (const [kind, title, subtitle] of [
            ['json', 'Export JSON', 'The samples as stored'],
            ['csv', 'Export CSV', 'timestamp_iso, metric_id, percent'],
        ]) {
            const row = new Adw.ActionRow({title, subtitle});
            const button = new Gtk.Button({label: 'Export…', valign: Gtk.Align.CENTER});
            button.connect('clicked', () => this._exportHistory(window, settings, kind, toast));
            row.add_suffix(button);
            row.activatable_widget = button;
            exports.add(row);
        }

        const clear = new Adw.PreferencesGroup({title: 'Clear'});
        page.add(clear);
        const row = new Adw.ActionRow({
            title: 'Clear history',
            subtitle: 'Deletes every stored sample and every record.',
        });
        const button = new Gtk.Button({
            label: 'Clear…',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        button.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: 'Clear history?',
                body: 'Every stored usage sample is deleted, and the records and chart start over. This cannot be undone.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('clear', 'Clear');
            dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.choose(window, null, (source, result) => {
                if (source.choose_finish(result) !== 'clear')
                    return;
                // The extension drops the samples and rewrites the file; every
                // reader applies this cutoff until it has.
                settings.set_int64('history-cleared-at', Date.now());
                refresh();
                toast('History cleared.');
            });
        });
        row.add_suffix(button);
        row.activatable_widget = button;
        clear.add(row);
    }

    _exportHistory(window, settings, kind, toast) {
        const history = readHistory(settings);
        if (!history.samples.length) {
            toast('There is no history to export.');
            return;
        }

        const json = kind === 'json';
        const dialog = new Gtk.FileDialog({
            title: json ? 'Export history as JSON' : 'Export history as CSV',
            initial_name: json ? 'claude-usage-history.json' : 'claude-usage-history.csv',
        });
        dialog.save(window, null, (source, result) => {
            let file;
            try {
                file = source.save_finish(result);
            } catch (error) {
                if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    toast(`Export failed: ${error.message}`);
                return;
            }
            const path = file.get_path();
            if (!path) {
                toast('Export failed: choose a location on this computer.');
                return;
            }
            writeTextAsync(path, json ? JSON.stringify(history) : historyToCsv(history))
                .then(() => toast(`Exported to ${path}`))
                .catch(error => toast(`Export failed: ${error.message}`));
        });
    }

    /** Returns the settings handler id the caller has to disconnect. */
    _buildSkinPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Claude Code',
            icon_name: 'utilities-terminal-symbolic',
        });
        window.add(page);

        this._buildIntegrationGroup(page, window, settings);
        this._buildPreviewGroup(page);

        const layout = new Adw.PreferencesGroup({
            title: 'Layout',
            description: 'The macOS tracker renders a single line.',
        });
        page.add(layout);
        layout.add(comboRow(settings, 'statusline-line-break', 'Line break',
            'Start a second line at this segment',
            [
                ['none', 'None (single line)'],
                ['context', 'Before context'],
                ['usage', 'Before usage'],
                ['weekly', 'Before weekly'],
            ]));

        layout.add(switchRow(settings, 'statusline-wrap-to-width', 'Wrap to terminal width',
            'Start a new line before segments that exceed the terminal width'));
        const skinRefresh = new Adw.SpinRow({
            title: 'Statusline refresh interval',
            subtitle: 'Seconds; 0 disables. Press Install or Reinstall to apply.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 600,
                step_increment: 1,
                page_increment: 60,
                value: settings.get_int('skin-refresh-interval'),
            }),
        });
        settings.bind('skin-refresh-interval', skinRefresh, 'value', Gio.SettingsBindFlags.DEFAULT);
        layout.add(skinRefresh);

        const components = new Adw.PreferencesGroup({
            title: 'Components',
            description: 'Rendered in order: directory, branch, effort, profile, context, usage.',
        });
        page.add(components);
        components.add(switchRow(settings, 'statusline-show-directory', 'Directory'));
        components.add(switchRow(settings, 'statusline-show-branch', 'Git branch'));
        components.add(switchRow(settings, 'statusline-show-model', 'Effort level',
            'Current reasoning effort reported by Claude Code'));
        components.add(switchRow(settings, 'statusline-show-profile', 'Profile',
            'Your Claude account or organisation name'));
        components.add(switchRow(settings, 'statusline-show-context', 'Context window'));
        components.add(switchRow(settings, 'statusline-context-as-tokens', 'Context as tokens',
            'Show a token count instead of a percentage'));

        const usage = new Adw.PreferencesGroup({title: 'Session usage'});
        page.add(usage);
        usage.add(switchRow(settings, 'statusline-show-usage', 'Session usage',
            '5-hour rolling window'));
        usage.add(switchRow(settings, 'statusline-show-progress-bar', 'Progress bar'));
        usage.add(switchRow(settings, 'statusline-show-pace-marker', 'Pace marker',
            'A ┃ at the elapsed-time position; its gap from the fill shows burn rate'));
        usage.add(switchRow(settings, 'statusline-pace-marker-step-colors', 'Pace marker colours',
            'Six tiers from projected usage: comfortable, on track, warming, pressing, critical, runaway'));
        usage.add(switchRow(settings, 'statusline-show-reset-time', 'Reset time'));

        const weekly = new Adw.PreferencesGroup({title: 'Weekly usage'});
        page.add(weekly);
        const weeklyRows = [
            switchRow(settings, 'statusline-show-weekly', 'Weekly usage', '7-day window'),
            switchRow(settings, 'statusline-show-weekly-bar', 'Progress bar'),
            switchRow(settings, 'statusline-show-weekly-pace-marker', 'Pace marker'),
            switchRow(settings, 'statusline-show-weekly-reset-time', 'Reset time'),
        ];
        for (const [index, row] of weeklyRows.entries()) {
            if (index > 0) {
                settings.bind('statusline-show-weekly', row, 'sensitive',
                    Gio.SettingsBindFlags.GET);
            }
            weekly.add(row);
        }
        weekly.add(switchRow(settings, 'statusline-show-extra-usage', 'Extra usage',
            'Monthly extra-usage cost, read from the panel’s last refresh'));

        const labels = new Adw.PreferencesGroup({
            title: 'Labels and time',
            description: 'Prefixes shown before each value.',
        });
        page.add(labels);
        labels.add(switchRow(settings, 'statusline-show-context-label', '“Ctx:” prefix'));
        labels.add(switchRow(settings, 'statusline-show-usage-label', '“Usage:” prefix'));
        labels.add(switchRow(settings, 'statusline-show-reset-label', '“Reset:” prefix'));
        labels.add(switchRow(settings, 'statusline-show-weekly-label', '“Weekly:” prefix'));
        labels.add(switchRow(settings, 'statusline-use-24-hour-time', '24-hour time',
            'Show reset times as 20:00 rather than 08:00 PM'));

        return this._buildColorGroup(page, settings);
    }

    _buildIntegrationGroup(page, window, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Integration',
            description: 'Point Claude Code’s statusLine at this extension.',
        });
        page.add(group);

        const row = new Adw.ActionRow({title: 'Claude Code statusline'});
        const installButton = new Gtk.Button({valign: Gtk.Align.CENTER});
        const removeButton = new Gtk.Button({
            label: 'Remove',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });

        const sync = () => {
            const installed = isInstalled(this.path);
            row.subtitle = installed
                ? 'Active in ~/.claude/settings.json'
                : 'Not configured in ~/.claude/settings.json';
            installButton.label = installed ? 'Reinstall' : 'Install';
            installButton.css_classes = installed ? [] : ['suggested-action'];
            removeButton.sensitive = installed;
        };

        const report = (message, error = false) => {
            window.add_toast(new Adw.Toast({title: message, timeout: 5}));
            if (!error)
                sync();
        };

        installButton.connect('clicked', () => {
            try {
                const backup = install(this.path, settings.get_int('skin-refresh-interval'));
                report(backup
                    ? 'Statusline installed. Previous settings.json backed up.'
                    : 'Statusline installed.');
            } catch (error) {
                report(`Install failed: ${error.message}`, true);
            }
        });
        removeButton.connect('clicked', () => {
            try {
                remove();
                report('Statusline removed from settings.json.');
            } catch (error) {
                report(`Remove failed: ${error.message}`, true);
            }
        });

        row.add_suffix(removeButton);
        row.add_suffix(installButton);
        group.add(row);
        sync();

        const command = new Adw.ActionRow({
            title: 'Command',
            subtitle: statuslineCommand(this.path),
            subtitle_lines: 2,
        });
        command.add_css_class('property');
        group.add(command);
    }

    _buildPreviewGroup(page) {
        const group = new Adw.PreferencesGroup({
            title: 'Preview',
            description: 'Rendered by the skin itself, with sample usage values.',
        });
        page.add(group);

        this._preview = new Gtk.Label({
            xalign: 0,
            wrap: true,
            selectable: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            css_classes: ['monospace'],
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        group.add(new Gtk.Frame({child: this._preview}));
    }

    _buildColorGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Colours',
            description: 'Usage always carries a ten-level gradient in multi-colour mode.',
        });
        page.add(group);
        group.add(comboRow(settings, 'statusline-color-mode', 'Colour mode', null, [
            ['colored', 'Multi-Color'],
            ['monochrome', 'Greyscale'],
            ['singleColor', 'Single Color'],
            ['perElement', 'Per Element'],
        ]));

        const single = colorRow(settings, 'statusline-single-color', 'Single colour');
        group.add(single);

        const perElement = new Adw.ExpanderRow({
            title: 'Per-element colours',
            subtitle: 'Used when the colour mode is Per Element',
        });
        group.add(perElement);
        for (const [key, title] of [
            ['statusline-element-color-dir', 'Directory'],
            ['statusline-element-color-branch', 'Git branch'],
            ['statusline-element-color-model', 'Effort level'],
            ['statusline-element-color-profile', 'Profile'],
            ['statusline-element-color-context', 'Context'],
            ['statusline-element-color-separator', 'Separator'],
        ])
            perElement.add_row(colorRow(settings, key, title));

        // These four keep their dynamic colouring unless explicitly overridden.
        for (const [key, title, subtitle, fallback] of [
            ['statusline-element-color-usage', 'Session usage',
                'Off keeps the ten-level gradient', '#4E9A06'],
            ['statusline-element-color-pace', 'Pace marker',
                'Off keeps the six pace tiers; needs pace marker colours disabled', '#FCE94F'],
            ['statusline-element-color-weekly', 'Weekly usage',
                'Off keeps the ten-level gradient', '#C4A000'],
            ['statusline-element-color-extra', 'Extra usage',
                'Off keeps the ten-level gradient', '#CC0000'],
        ])
            perElement.add_row(overrideColorRow(settings, key, title, subtitle, fallback));

        const sync = () => {
            const mode = settings.get_string('statusline-color-mode');
            single.sensitive = mode === 'singleColor';
            perElement.sensitive = mode === 'perElement';
        };
        const syncId = settings.connect('changed::statusline-color-mode', sync);
        sync();
        return syncId;
    }

    /** Drop any in-flight render so no preview process outlives the window. */
    _stopPreview() {
        this._previewCancellable?.cancel();
        this._previewCancellable = null;
        this._previewProcess?.force_exit();
        this._previewProcess = null;
    }

    /** Run the real skin against a sample payload so the preview cannot drift. */
    _refreshPreview() {
        if (!this._preview)
            return;

        // One render at a time: a burst of setting changes must not leave
        // several node processes racing to write the same label.
        this._stopPreview();

        const nowSeconds = Math.floor(GLib.get_real_time() / 1_000_000);
        const sample = JSON.stringify({
            workspace: {current_dir: GLib.build_filenamev([GLib.get_home_dir(), 'my-project'])},
            worktree: {branch: 'main'},
            effort: {level: 'high'},
            context_window: {
                context_window_size: 200_000,
                current_usage: {
                    input_tokens: 8_500,
                    cache_creation_input_tokens: 5_000,
                    cache_read_input_tokens: 2_000,
                },
            },
            rate_limits: {
                five_hour: {used_percentage: 24, resets_at: nowSeconds + 7_200},
                seven_day: {used_percentage: 81, resets_at: nowSeconds + 172_800},
            },
        });

        try {
            const cancellable = new Gio.Cancellable();
            const process = Gio.Subprocess.new(
                ['node', GLib.build_filenamev([this.path, 'statusline.js'])],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_SILENCE
            );
            this._previewCancellable = cancellable;
            this._previewProcess = process;
            process.communicate_utf8_async(sample, cancellable, (source, result) => {
                if (this._previewProcess === process) {
                    this._previewCancellable = null;
                    this._previewProcess = null;
                }
                try {
                    const [, output] = source.communicate_utf8_finish(result);
                    if (cancellable.is_cancelled() || !this._preview)
                        return;
                    this._preview.set_markup(
                        ansiToMarkup((output || '').replace(/\n$/, '')) ||
                        '<i>No output</i>'
                    );
                } catch (error) {
                    if (!cancellable.is_cancelled() && this._preview)
                        this._preview.set_text(`Preview failed: ${error.message}`);
                }
            });
        } catch (_error) {
            this._stopPreview();
            this._preview.set_text('Preview needs Node.js 22 or newer on PATH.');
        }
    }
}
