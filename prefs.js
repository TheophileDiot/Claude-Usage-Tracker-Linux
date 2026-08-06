import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    SKIN_KEYS,
    install,
    isInstalled,
    remove,
    statuslineCommand,
    writeConfig,
} from './skin.js';

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

function switchRow(settings, key, title, subtitle) {
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

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 760);
        this._buildPanelPage(window, settings);
        this._buildSkinPage(window, settings);

        // The skin reads a file, not GSettings, so every change is projected out.
        const changedId = settings.connect('changed', (_settings, key) => {
            if (SKIN_KEYS.includes(key)) {
                this._writeSkinConfig(settings);
                this._refreshPreview();
            }
        });
        window.connect('close-request', () => settings.disconnect(changedId));
        this._writeSkinConfig(settings);
        this._refreshPreview();
    }

    _writeSkinConfig(settings) {
        try {
            writeConfig(settings);
        } catch (error) {
            console.error(`Claude Usage Tracker: skin config write failed: ${error.message}`);
        }
    }

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

        const privacy = new Adw.PreferencesGroup({title: 'Privacy'});
        page.add(privacy);
        privacy.add(new Adw.ActionRow({
            title: 'Read-only credentials',
            subtitle: 'Tokens remain in Claude Code’s credential file and are never saved in extension settings or history.',
        }));
    }

    _buildSkinPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Claude Code',
            icon_name: 'utilities-terminal-symbolic',
        });
        window.add(page);

        this._buildIntegrationGroup(page, window);
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

        const components = new Adw.PreferencesGroup({
            title: 'Components',
            description: 'Rendered in order: directory, branch, model, profile, context, usage.',
        });
        page.add(components);
        components.add(switchRow(settings, 'statusline-show-directory', 'Directory'));
        components.add(switchRow(settings, 'statusline-show-branch', 'Git branch'));
        components.add(switchRow(settings, 'statusline-show-model', 'Model'));
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

        this._buildColorGroup(page, settings);
    }

    _buildIntegrationGroup(page, window) {
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
                const backup = install(this.path);
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
            ['statusline-element-color-model', 'Model'],
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
        settings.connect('changed::statusline-color-mode', sync);
        sync();
    }

    /** Run the real skin against a sample payload so the preview cannot drift. */
    _refreshPreview() {
        if (!this._preview)
            return;

        const nowSeconds = Math.floor(GLib.get_real_time() / 1_000_000);
        const sample = JSON.stringify({
            workspace: {current_dir: GLib.build_filenamev([GLib.get_home_dir(), 'my-project'])},
            worktree: {branch: 'main'},
            model: {display_name: 'Opus 5'},
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
            const process = Gio.Subprocess.new(
                ['node', GLib.build_filenamev([this.path, 'statusline.js'])],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_SILENCE
            );
            process.communicate_utf8_async(sample, null, (source, result) => {
                try {
                    const [, output] = source.communicate_utf8_finish(result);
                    this._preview.set_markup(
                        ansiToMarkup((output || '').replace(/\n$/, '')) ||
                        '<i>No output</i>'
                    );
                } catch (error) {
                    this._preview.set_text(`Preview failed: ${error.message}`);
                }
            });
        } catch (_error) {
            this._preview.set_text('Preview needs Node.js 18 or newer on PATH.');
        }
    }
}
