import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    HISTORY_SCALES,
    SerialWriter,
    addHistorySample,
    barLevel,
    clearHistoryBefore,
    formatCountdown,
    formatReset,
    historySeries,
    level,
    markerPosition,
    markerX,
    notificationThresholds,
    notificationTransition,
    normalizeUsage,
    paceMarker,
    panelMetrics,
    parseClaudeStatus,
    parseHistory,
    sanitizeHistory,
    terminalArgv,
    updatedAgo,
} from './usage.js';
import {
    SKIN_KEYS,
    claudeDirectory,
    historyDirectory,
    historyPath,
    loadTextAsync,
    readAccountLabelAsync,
    writeConfig,
    writeTextAsync,
    writeUsageCache,
} from './skin.js';

const VERTICAL_LAYOUT = Number.parseInt(Config.PACKAGE_VERSION, 10) >= 48
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

const API_URL = 'https://api.anthropic.com/api/oauth/usage';
const STATUS_URL = 'https://status.claude.com/api/v2/status.json';
const STATUS_PAGE_URL = 'https://status.claude.com';
const STATUS_INTERVAL_SECONDS = 300;
const STATUS_CLASSES = ['none', 'minor', 'major', 'critical', 'maintenance']
    .map(name => `status-${name}`);

/**
 * Bar fills are sized from code against tracks sized in `stylesheet.css`. St
 * multiplies every CSS pixel by the theme context's scale factor, while
 * `Clutter.Actor` geometry is raw stage coordinates, so these have to be scaled
 * by hand or a fill only ever reaches 1/scale of its track on HiDPI.
 */
const CARD_TRACK_WIDTH = 250;   // .cut-progress-track
const PANEL_TRACK_WIDTH = 46;   // .cut-panel-progress
const HISTORY_BAR_HEIGHT = 22;  // .cut-history-slot
const HISTORY_BAR_MINIMUM = 2;
const HISTORY_BAR_GAP = 2;      // .cut-history-bars spacing
const HISTORY_BAR_WIDTH_MAX = 8;
const TICK_WIDTH = 2;           // .cut-pace-tick, .cut-panel-pace-tick
const CARD_TICK_OVERHANG = 3;   // tick rises this far above a card track
const PANEL_TICK_OVERHANG = 1;  // ... and above a panel track

const DEFAULT_SINGLE_COLOR = '#00BFFF';
const COLOR_CLASSES = ['usage-safe', 'usage-moderate', 'usage-critical', 'usage-single'];
const RENDER_KEYS = [
    'show-pace-marker', 'bar-color-basis', 'bar-color-mode', 'single-color',
    'reset-display', 'time-format', 'panel-show-countdown',
];
const SHORTCUT_KEYS = ['shortcut-toggle-menu', 'shortcut-refresh', 'shortcut-open-prefs'];
const REFRESH_DEBOUNCE_SECONDS = 5;
const AGE_TICK_SECONDS = 60;

function iconButton(iconName, label) {
    const icon = new St.Icon({icon_name: iconName, icon_size: 16});
    const button = new St.Button({
        child: icon,
        style_class: 'cut-icon-button',
        can_focus: true,
        accessible_name: label,
    });

    // St has no tooltips. The Dash's hover label is the Shell's own look for
    // one; it lives in uiGroup so the popup cannot clip it.
    const tooltip = new St.Label({text: label, style_class: 'dash-label', visible: false});
    Main.uiGroup.add_child(tooltip);
    const sync = () => {
        if (!button.hover || !button.mapped) {
            tooltip.hide();
            return;
        }
        tooltip.show();
        Main.uiGroup.set_child_above_sibling(tooltip, null);
        const [x, y] = button.get_transformed_position();
        const [width, height] = button.get_transformed_size();
        tooltip.set_position(
            Math.clamp(Math.floor(x + (width - tooltip.width) / 2),
                0, global.stage.width - tooltip.width),
            Math.floor(y + height + 6));
    };
    button.connect('notify::hover', sync);
    button.connect('notify::mapped', sync);
    button.connect('destroy', () => tooltip.destroy());
    return [button, icon];
}

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'Claude Usage Tracker');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = new Soup.Session({timeout: 15});
        this._cancellable = null;
        this._ioCancellable = new Gio.Cancellable();
        this._timerId = 0;
        this._historyWriter = new SerialWriter(
            () => this._persistHistory(),
            error => console.error(`Claude Usage Tracker: history write failed: ${error.message}`));
        this._historyLoaded = false;
        this._keybindings = [];
        this._statusTimerId = 0;
        this._statusCancellable = null;
        this._statusRequestedAt = 0;
        this._claudeStatus = null;
        this._refreshing = false;
        this._retryAfter = 0;
        this._failures = 0;
        this._lastUpdated = 0;
        this._stateKind = 'loading';
        this._stateBase = '';
        this._ageTimerId = 0;
        this._wakeRefreshId = 0;
        this._sleepSubscriptionId = 0;
        this._networkMonitor = null;
        this._networkChangedId = 0;
        this._desktopSettings = null;
        this._clockChangedId = 0;
        this._menuOpenId = 0;
        this._destroyed = false;
        this._lastMetrics = [];
        this._history = sanitizeHistory(null);
        this._accountName = 'Claude Code';
        this._notificationSource = null;
        this._notificationSourceDestroyId = 0;
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);

        this._buildPanel();
        this._buildMenu();
        this._restoreHistorySnapshot();
        this._updatePanelMode();
        this._updateIcon();

        // Every bar is sized in stage coordinates, so a monitor scale change has
        // to redraw them rather than wait for the next refresh.
        this._scaleChangedId = this._themeContext.connect('notify::scale-factor', () => {
            this._renderMetrics();
            this._renderHistory();
            this._updatePanel();
        });

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'refresh-interval')
                this._restartTimer();
            if (['display-mode', 'percentage-mode'].includes(key)) {
                this._updatePanelMode();
                this._renderMetrics();
                this._renderHistory();
            }
            if (RENDER_KEYS.includes(key)) {
                this._renderMetrics();
                this._renderHistory();
                this._updatePanel();
            }
            if (key === 'history-scale') {
                this._syncScaleButtons();
                this._renderHistory();
            }
            if (key === 'history-cleared-at')
                this._applyHistoryClear();
            if (key === 'show-claude-status')
                this._syncClaudeStatus();
            if (['show-icon', 'icon-style'].includes(key))
                this._updateIcon();
            if (SKIN_KEYS.includes(key))
                this._writeSkinConfig();
        });

        // History has to land before the first sample is appended, otherwise the
        // load would overwrite it; the account label only gates cosmetics, so it
        // runs alongside.
        this._loadAccountName();
        this._loadHistory().then(() => {
            if (!this._destroyed)
                this._refreshUsage();
        });
        this._startTimer();
        this._watchSystem();
        this._addKeybindings();
        this._syncClaudeStatus();
    }

    /**
     * Global shortcuts. Each accelerator lives in its GSettings key, so the
     * Shell rebinds on change; an empty list leaves the action unbound.
     */
    _addKeybindings() {
        const actions = {
            'shortcut-toggle-menu': () => this.menu.toggle(),
            'shortcut-refresh': () => this._refreshUsage(true),
            'shortcut-open-prefs': () => this._openPreferences(),
        };
        for (const name of SHORTCUT_KEYS) {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                actions[name]
            );
            this._keybindings.push(name);
        }
    }

    /**
     * Refresh soon after resume and after the network returns instead of waiting
     * out the interval. Both feed one debounced refresh, which still honours a
     * Retry-After hold because it is not a manual refresh.
     */
    _watchSystem() {
        this._sleepSubscriptionId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1',
            'org.freedesktop.login1.Manager',
            'PrepareForSleep',
            '/org/freedesktop/login1',
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, parameters) => {
                const [sleeping] = parameters.deep_unpack();
                if (!sleeping)
                    this._scheduleRefresh();
            }
        );

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkChangedId = this._networkMonitor.connect(
            'network-changed', (_monitor, available) => {
                if (available)
                    this._scheduleRefresh();
            });

        // 'system' time format follows GNOME's own clock setting.
        this._desktopSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._clockChangedId = this._desktopSettings.connect('changed::clock-format', () => {
            if (this._settings.get_string('time-format') === 'system')
                this._renderMetrics();
        });
    }

    _scheduleRefresh() {
        if (this._wakeRefreshId)
            GLib.source_remove(this._wakeRefreshId);
        this._wakeRefreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_DEBOUNCE_SECONDS, () => {
                this._wakeRefreshId = 0;
                this._refreshUsage();
                return GLib.SOURCE_REMOVE;
            });
    }

    async _loadAccountName() {
        const label = await readAccountLabelAsync(this._ioCancellable);
        if (this._destroyed)
            return;
        this._accountName = label || 'Claude Code';
        this._accountLabel.text = this._accountName;
        // Keeps a fresh install working before preferences are ever opened.
        this._writeSkinConfig();
    }

    _buildPanel() {
        this._panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        const iconPath = GLib.build_filenamev([this._extensionPath, 'claude-usage.svg']);
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            icon_size: 17,
            style_class: 'cut-panel-icon',
        });
        this._panelBox.add_child(this._icon);

        this._panelReadouts = Array.from({length: 2}, () => {
            const box = new St.BoxLayout({style_class: 'cut-panel-readout'});
            const period = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'cut-panel-period',
            });
            box.add_child(period);

            // Center the track so it stays 9px tall instead of filling the panel.
            const progress = new St.Widget({
                style_class: 'cut-panel-progress',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const fill = new St.Widget({style_class: 'cut-panel-progress-fill'});
            progress.add_child(fill);
            const tick = new St.Widget({style_class: 'cut-panel-pace-tick', visible: false});
            progress.add_child(tick);
            box.add_child(progress);

            const label = new St.Label({
                text: '—',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'cut-panel-label',
            });
            box.add_child(label);

            const countdown = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'cut-panel-countdown',
                visible: false,
            });
            box.add_child(countdown);
            this._panelBox.add_child(box);
            return {box, period, progress, fill, tick, label, countdown};
        });
        this.add_child(this._panelBox);
    }

    _buildMenu() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('cut-root-item');
        this._content = new St.BoxLayout({...VERTICAL_LAYOUT, style_class: 'cut-popover'});
        item.add_child(this._content);
        this.menu.addMenuItem(item);

        const header = new St.BoxLayout({style_class: 'cut-header'});
        const identity = new St.BoxLayout({
            ...VERTICAL_LAYOUT,
            x_expand: true,
            style_class: 'cut-identity',
        });
        this._accountLabel = new St.Label({
            text: this._accountName,
            style_class: 'cut-account',
        });
        identity.add_child(this._accountLabel);

        const state = new St.BoxLayout({style_class: 'cut-state-row'});
        this._stateDot = new St.Widget({style_class: 'cut-state-dot state-loading'});
        this._stateLabel = new St.Label({
            text: 'Loading usage…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cut-state-label',
        });
        state.add_child(this._stateDot);
        state.add_child(this._stateLabel);
        identity.add_child(state);
        header.add_child(identity);

        const actions = new St.BoxLayout({style_class: 'cut-header-actions'});
        [this._refreshButton, this._refreshIcon] = iconButton(
            'view-refresh-symbolic',
            'Refresh usage'
        );
        this._refreshButton.connect('clicked', () => this._refreshUsage(true));
        actions.add_child(this._refreshButton);

        const [resetButton] = iconButton(
            'document-revert-symbolic',
            'Use a limit reset in Claude Code'
        );
        resetButton.connect('clicked', () => {
            this.menu.close();
            this._openLimitReset();
        });
        actions.add_child(resetButton);

        const [settingsButton] = iconButton('preferences-system-symbolic', 'Open settings');
        settingsButton.connect('clicked', () => {
            this.menu.close();
            this._openPreferences();
        });
        actions.add_child(settingsButton);
        header.add_child(actions);
        this._content.add_child(header);
        this._content.add_child(new St.Widget({style_class: 'cut-separator'}));

        this._errorBox = new St.BoxLayout({style_class: 'cut-error'});
        this._errorBox.add_child(new St.Icon({
            icon_name: 'dialog-warning-symbolic',
            icon_size: 15,
        }));
        this._errorLabel = new St.Label({
            text: '',
            x_expand: true,
            style_class: 'cut-error-label',
        });
        this._errorLabel.clutter_text.set_line_wrap(true);
        this._errorBox.add_child(this._errorLabel);
        this._errorBox.hide();
        this._content.add_child(this._errorBox);

        this._dashboard = new St.BoxLayout({...VERTICAL_LAYOUT, style_class: 'cut-dashboard'});
        this._metricsBox = new St.BoxLayout({...VERTICAL_LAYOUT, style_class: 'cut-metrics'});
        this._historyBox = new St.BoxLayout({...VERTICAL_LAYOUT, style_class: 'cut-history-card'});
        this._historyBox.hide();
        this._buildHistoryHeader();
        this._dashboard.add_child(this._metricsBox);
        this._dashboard.add_child(this._historyBox);

        const scroll = new St.ScrollView({style_class: 'cut-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.add_child(this._dashboard);
        this._content.add_child(scroll);

        this._buildStatusRow();

        // "Updated N min ago" only has to stay current while someone can read it.
        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            this._stopAgeTimer();
            if (!open)
                return;
            this._renderState();
            this._ageTimerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, AGE_TICK_SECONDS, () => {
                    this._renderState();
                    return GLib.SOURCE_CONTINUE;
                });
        });
    }

    /** Title, caption and the scale toggle live as long as the box; only rows rebuild. */
    _buildHistoryHeader() {
        const heading = new St.BoxLayout({style_class: 'cut-history-heading'});
        this._historyTitle = new St.Label({
            x_expand: true,
            style_class: 'cut-history-title',
        });
        heading.add_child(this._historyTitle);
        heading.add_child(new St.Label({text: 'Used %', style_class: 'cut-history-caption'}));
        this._historyBox.add_child(heading);

        const scales = new St.BoxLayout({style_class: 'cut-scale-row'});
        this._scaleButtons = new Map();
        for (const [scale, {label}] of Object.entries(HISTORY_SCALES)) {
            const button = new St.Button({
                label: scale,
                x_expand: true,
                toggle_mode: true,
                can_focus: true,
                style_class: 'cut-scale-button',
                accessible_name: label,
            });
            button.connect('clicked', () => {
                this._settings.set_string('history-scale', scale);
                // Clicking the selected scale untoggles the button; set it back.
                this._syncScaleButtons();
            });
            this._scaleButtons.set(scale, button);
            scales.add_child(button);
        }
        this._historyBox.add_child(scales);
        this._historyRows = new St.BoxLayout({...VERTICAL_LAYOUT, style_class: 'cut-history-rows'});
        this._historyBox.add_child(this._historyRows);
        this._syncScaleButtons();
    }

    _historyScale() {
        const scale = this._settings.get_string('history-scale');
        return scale in HISTORY_SCALES ? scale : '24h';
    }

    _syncScaleButtons() {
        const current = this._historyScale();
        for (const [scale, button] of this._scaleButtons)
            button.checked = scale === current;
    }

    _buildStatusRow() {
        this._statusRow = new St.Button({
            can_focus: true,
            x_expand: true,
            style_class: 'cut-status-row',
            visible: false,
        });
        const content = new St.BoxLayout({style_class: 'cut-status-content'});
        this._statusDot = new St.Widget({style_class: 'cut-status-dot'});
        this._statusLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'cut-status-label',
        });
        content.add_child(this._statusDot);
        content.add_child(this._statusLabel);
        this._statusRow.set_child(content);
        this._statusRow.connect('clicked', () => {
            this.menu.close();
            Gio.AppInfo.launch_default_for_uri_async(
                STATUS_PAGE_URL, null, this._ioCancellable, (_source, result) => {
                    try {
                        Gio.AppInfo.launch_default_for_uri_finish(result);
                    } catch (error) {
                        if (!this._destroyed && !error.matches?.(
                            Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            this._notify(`The status page could not be opened: ${error.message}`);
                    }
                });
        });
        this._content.add_child(this._statusRow);
    }

    /**
     * The opt-in status poll. It runs only while `show-claude-status` is on, on
     * its own 5-minute timer, and a request is never sent sooner than that after
     * the previous one, however often the setting is toggled.
     */
    _syncClaudeStatus() {
        if (!this._settings.get_boolean('show-claude-status')) {
            this._stopClaudeStatus();
            this._renderClaudeStatus();
            return;
        }
        if (!this._statusTimerId) {
            this._statusTimerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, STATUS_INTERVAL_SECONDS, () => {
                    this._fetchClaudeStatus();
                    return GLib.SOURCE_CONTINUE;
                });
        }
        this._renderClaudeStatus();
        this._fetchClaudeStatus();
    }

    _stopClaudeStatus() {
        if (this._statusTimerId) {
            GLib.source_remove(this._statusTimerId);
            this._statusTimerId = 0;
        }
        this._statusCancellable?.cancel();
        this._statusCancellable = null;
    }

    _fetchClaudeStatus() {
        const now = Date.now();
        if (this._destroyed || this._statusCancellable ||
            now - this._statusRequestedAt < (STATUS_INTERVAL_SECONDS - 1) * 1000)
            return;
        this._statusRequestedAt = now;

        const cancellable = new Gio.Cancellable();
        this._statusCancellable = cancellable;
        // No headers and no cookie jar: a public GET with nothing of ours in it.
        const message = Soup.Message.new('GET', STATUS_URL);
        this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (this._destroyed || cancellable.is_cancelled())
                        return;
                    if (message.status_code !== 200)
                        throw new Error(`HTTP ${message.status_code}`);
                    this._claudeStatus = parseClaudeStatus(
                        JSON.parse(new TextDecoder().decode(bytes.get_data())));
                } catch (_error) {
                    // Any failure hides the row; the next tick tries again.
                    if (!this._destroyed && !cancellable.is_cancelled())
                        this._claudeStatus = null;
                } finally {
                    if (!this._destroyed && !cancellable.is_cancelled()) {
                        this._statusCancellable = null;
                        this._renderClaudeStatus();
                    }
                }
            });
    }

    _renderClaudeStatus() {
        const status = this._settings.get_boolean('show-claude-status')
            ? this._claudeStatus : null;
        this._statusRow.visible = Boolean(status);
        if (!status)
            return;
        for (const name of STATUS_CLASSES)
            this._statusDot.remove_style_class_name(name);
        this._statusDot.add_style_class_name(`status-${status.indicator}`);
        this._statusLabel.text = status.description;
        this._statusRow.accessible_name = `Claude status: ${status.description}. Opens status.claude.com`;
    }

    _stopAgeTimer() {
        if (this._ageTimerId) {
            GLib.source_remove(this._ageTimerId);
            this._ageTimerId = 0;
        }
    }

    /**
     * The reset endpoint only answers Claude Code itself, which also checks
     * eligibility and asks before spending a reset, so the panel just opens it.
     * A GNOME session's PATH often lacks ~/.local/bin, where the installer puts
     * `claude`, hence the fallback. It starts in the Claude directory because
     * Claude Code never remembers trust for the home directory, the shell's cwd,
     * and would ask on every click.
     */
    _openLimitReset() {
        const installed = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude']);
        const claude = GLib.find_program_in_path('claude') ??
            (GLib.file_test(installed, GLib.FileTest.IS_EXECUTABLE) ? installed : null);
        if (!claude) {
            this._notify('Claude Code was not found. Install it to use a limit reset.');
            return;
        }

        const argv = terminalArgv([claude, '/limit-reset'],
            name => GLib.find_program_in_path(name));
        if (!argv) {
            this._notify('No terminal was found. Run claude /limit-reset in one.');
            return;
        }

        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.set_cwd(claudeDirectory());
        try {
            launcher.spawnv(argv);
        } catch (error) {
            this._notify(`The terminal could not be opened: ${error.message}`);
        }
    }

    _credentialPaths() {
        const configured = GLib.getenv('CLAUDE_CONFIG_DIR');
        const directory = configured || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        return [
            GLib.build_filenamev([directory, '.credentials.json']),
            GLib.build_filenamev([directory, 'credentials.json']),
        ];
    }

    async _readCredentials() {
        let invalidFile = false;
        let missingLogin = false;
        let expiredLogin = false;
        // Captured once: destroy() drops the reference, and every remaining read
        // in this loop still has to see the cancellation.
        const cancellable = this._ioCancellable;
        for (const path of this._credentialPaths()) {
            const text = await loadTextAsync(path, cancellable);
            if (text === null)
                continue;
            let data;
            try {
                data = JSON.parse(text);
            } catch (_error) {
                invalidFile = true;
                continue;
            }
            const oauth = data?.claudeAiOauth;
            if (!oauth?.accessToken) {
                // A wiped login keeps its refresh-token expiry: it was a login once.
                if (Number.isFinite(oauth?.refreshTokenExpiresAt))
                    expiredLogin = true;
                else
                    missingLogin = true;
                continue;
            }
            if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= Date.now()) {
                if (oauth.refreshToken && Number.isFinite(oauth.refreshTokenExpiresAt) &&
                    oauth.refreshTokenExpiresAt > Date.now())
                    throw new Error('Claude Code login needs a refresh. Start Claude Code once to renew it.');
                throw new Error('Claude Code login expired. Run claude auth login.');
            }
            return oauth.accessToken;
        }

        if (expiredLogin)
            throw new Error('Claude Code login expired. Run claude auth login.');
        if (missingLogin)
            throw new Error('No claude.ai login found. The panel needs a Pro, Max or Ultra login in Claude Code, not an API key.');
        if (invalidFile)
            throw new Error('Claude Code credentials are invalid. Run claude auth login.');
        throw new Error('Claude Code credentials not found. Run claude auth login.');
    }

    async _refreshUsage(manual = false) {
        if (this._refreshing || (!manual && Date.now() < this._retryAfter))
            return;
        this._setLoading(true);

        let token;
        try {
            token = await this._readCredentials();
        } catch (error) {
            if (!this._destroyed) {
                this._setLoading(false);
                this._showFailure(error.message);
            }
            return;
        }
        if (this._destroyed)
            return;

        this._cancellable = new Gio.Cancellable();
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (this._destroyed)
                        return;
                    if (message.status_code !== 200) {
                        if ([401, 403].includes(message.status_code))
                            throw new Error('Claude Code login rejected. Run claude auth login.');
                        if (message.status_code === 429) {
                            const retry = message.response_headers.get_one('Retry-After')?.trim() ?? '';
                            const now = Date.now();
                            const until = /^\d+$/.test(retry)
                                ? now + Number(retry) * 1000 : Date.parse(retry);
                            this._retryAfter = Number.isFinite(until) && until > now && until <= 8.64e15
                                ? until : now + this._settings.get_int('refresh-interval') * 1000;
                            throw new Error(`Usage service is rate limited. Next scheduled attempt after ${new Date(this._retryAfter).toLocaleString()}.`);
                        }
                        throw new Error(`Usage request failed with HTTP ${message.status_code}.`);
                    }

                    const payload = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    this._showUsage(normalizeUsage(payload));
                    this._retryAfter = 0;
                } catch (error) {
                    if (!this._destroyed && !this._cancellable?.is_cancelled())
                        this._showFailure(error.message || 'Usage refresh failed.');
                } finally {
                    if (!this._destroyed) {
                        this._cancellable = null;
                        this._setLoading(false);
                    }
                }
            }
        );
    }

    _showUsage(metrics) {
        this._lastMetrics = metrics;
        this._failures = 0;
        this._lastUpdated = Date.now();
        this._errorBox.hide();
        this._setState('Updated just now', 'ready');
        this._renderMetrics();
        this._updatePanel();

        const update = addHistorySample(this._history, metrics);
        this._history = update.history;
        if (update.changed)
            this._writeHistory();
        this._renderHistory();
        this._writeSkinCache(metrics);
        this._checkNotifications(metrics.find(item => item.id === 'session'));
    }

    /** Feed the Claude Code skin: session/weekly fallbacks and extra-usage cost. */
    _writeSkinCache(metrics) {
        writeUsageCache(
            metrics,
            metrics.find(item => item.id === 'extra')?.cost,
            Date.now(),
            this._ioCancellable
        ).catch(error => console.error(
            `Claude Usage Tracker: skin cache write failed: ${error.message}`));
    }

    _writeSkinConfig() {
        writeConfig(this._settings, this._accountName, this._ioCancellable)
            .catch(error => console.error(
                `Claude Usage Tracker: skin config write failed: ${error.message}`));
    }

    _showFailure(message) {
        this._errorLabel.text = String(message).slice(0, 180);
        this._errorBox.show();
        this._failures++;
        this._setState(this._failures >= 2
            ? `Refresh failed ${this._failures} times`
            : this._lastMetrics.length ? 'Showing cached data' : 'Usage unavailable', 'stale');
        if (!this._lastMetrics.length)
            this._updatePanel();
        this._setLoading(false);
    }

    _setState(text, state) {
        this._stateKind = state;
        this._stateBase = text;
        this._renderState();
        for (const name of ['state-loading', 'state-ready', 'state-stale'])
            this._stateDot.remove_style_class_name(name);
        this._stateDot.add_style_class_name(`state-${state}`);
    }

    /** The age is recomputed here, so a 60 s tick can refresh it in place. */
    _renderState() {
        const ago = this._lastUpdated ? updatedAgo(this._lastUpdated) : null;
        if (this._stateKind === 'ready')
            this._stateLabel.text = `Updated ${ago ?? 'just now'}`;
        else if (this._stateKind === 'stale' && ago && this._failures > 0)
            this._stateLabel.text = `${this._stateBase} · updated ${ago}`;
        else
            this._stateLabel.text = this._stateBase;
    }

    _setLoading(loading) {
        this._refreshing = loading;
        this._refreshButton.reactive = !loading;
        this._refreshButton.can_focus = !loading;
        this._refreshIcon.icon_name = loading
            ? 'content-loading-symbolic'
            : 'view-refresh-symbolic';
        if (loading)
            this._setState('Refreshing usage…', 'loading');
    }

    _displayValue(metric) {
        return this._settings.get_string('percentage-mode') === 'remaining'
            ? Math.max(0, 100 - metric.percent)
            : metric.percent;
    }

    _resetOptions() {
        let timeFormat = this._settings.get_string('time-format');
        if (timeFormat === 'system') {
            timeFormat = this._desktopSettings?.get_string('clock-format') === '24h'
                ? '24h' : '12h';
        }
        return {display: this._settings.get_string('reset-display'), timeFormat};
    }

    /**
     * Colour a bar fill or value. `property` is the CSS property the single
     * colour goes into; levels use the stylesheet classes.
     */
    _paint(actor, shown, property) {
        for (const name of COLOR_CLASSES)
            actor.remove_style_class_name(name);
        if (!shown) {
            actor.set_style(null);
        } else if (this._settings.get_string('bar-color-mode') === 'single') {
            const color = this._settings.get_string('single-color');
            actor.add_style_class_name('usage-single');
            actor.set_style(`${property}: ${/^#[0-9a-f]{6}$/i.test(color)
                ? color : DEFAULT_SINGLE_COLOR};`);
        } else {
            actor.set_style(null);
            actor.add_style_class_name(`usage-${shown}`);
        }
    }

    _barLevel(item, now) {
        return barLevel(item, this._settings.get_string('bar-color-basis'), now);
    }

    /** Place a pace tick on a bar, or hide it. Returns the marker for text. */
    _placeTick(tick, item, trackWidth, overhang, now) {
        const marker = this._settings.get_boolean('show-pace-marker')
            ? paceMarker(item, now) : null;
        tick.visible = Boolean(marker);
        if (!marker)
            return null;

        const scale = this._themeContext.scale_factor;
        const position = markerPosition(
            marker.fraction, this._settings.get_string('percentage-mode') === 'remaining');
        tick.set_position(
            markerX(position, trackWidth * scale, TICK_WIDTH * scale),
            -overhang * scale);
        tick.set_style(`background-color: ${marker.color};`);
        return marker;
    }

    _renderMetrics() {
        this._metricsBox.destroy_all_children();
        const scale = this._themeContext.scale_factor;
        const now = Date.now();
        const resetOptions = this._resetOptions();
        for (const item of this._lastMetrics) {
            const card = new St.BoxLayout({...VERTICAL_LAYOUT, style_class: 'cut-card'});
            const kind = this._settings.get_string('percentage-mode') === 'remaining'
                ? 'remaining'
                : 'used';
            const barLevelName = this._barLevel(item, now);
            const marker = paceMarker(item, now);
            card.accessible_name =
                `${item.title}, ${Math.round(this._displayValue(item))} percent ${kind}` +
                (marker && this._settings.get_boolean('show-pace-marker')
                    ? `, on pace for ${Math.round(marker.projected)} percent at reset` : '');

            const header = new St.BoxLayout({style_class: 'cut-card-header'});
            const titleBlock = new St.BoxLayout({...VERTICAL_LAYOUT, x_expand: true});
            const titleRow = new St.BoxLayout({style_class: 'cut-title-row'});
            titleRow.add_child(new St.Label({text: item.title, style_class: 'cut-card-title'}));
            if (item.tag)
                titleRow.add_child(new St.Label({text: item.tag, style_class: 'cut-tag'}));
            titleBlock.add_child(titleRow);
            if (item.subtitle)
                titleBlock.add_child(new St.Label({
                    text: item.subtitle,
                    style_class: 'cut-card-subtitle',
                }));
            header.add_child(titleBlock);

            const value = this._displayValue(item);
            const valueLabel = new St.Label({
                text: `${Math.round(value)}%`,
                y_align: Clutter.ActorAlign.START,
                style_class: 'cut-card-value',
            });
            this._paint(valueLabel, barLevelName, 'color');
            header.add_child(valueLabel);
            card.add_child(header);

            const track = new St.Widget({style_class: 'cut-progress-track'});
            const fill = new St.Widget({style_class: 'cut-progress-fill'});
            this._paint(fill, barLevelName, 'background-color');
            fill.set_width(Math.round(CARD_TRACK_WIDTH * scale * value / 100));
            track.add_child(fill);
            const tick = new St.Widget({style_class: 'cut-pace-tick'});
            track.add_child(tick);
            this._placeTick(tick, item, CARD_TRACK_WIDTH, CARD_TICK_OVERHANG, now);
            card.add_child(track);

            const reset = formatReset(item.resetAt, now, resetOptions);
            if (reset)
                card.add_child(new St.Label({text: reset, style_class: 'cut-reset'}));
            this._metricsBox.add_child(card);
        }
    }

    _updatePanel() {
        const metrics = panelMetrics(this._lastMetrics);
        const kind = this._settings.get_string('percentage-mode') === 'remaining'
            ? 'remaining'
            : 'used';
        const now = Date.now();
        const countdown = this._settings.get_boolean('panel-show-countdown');
        const descriptions = [];
        this._panelReadouts.forEach(({box, period, fill, tick, label, countdown: remaining}, index) => {
            const metric = metrics[index];
            box.visible = Boolean(metric) || index === 0;
            period.text = metric?.id === 'session' ? '5h'
                : metric?.id === 'weekly' || metric?.id.startsWith('model:') ? '7d' : '';
            period.visible = period.text !== '';
            const value = metric ? this._displayValue(metric) : 0;
            label.text = metric ? `${Math.round(value)}%` : '—';
            fill.set_width(Math.round(
                PANEL_TRACK_WIDTH * this._themeContext.scale_factor * value / 100));
            const shown = metric ? this._barLevel(metric, now) : null;
            this._paint(label, shown, 'color');
            this._paint(fill, shown, 'background-color');

            const marker = metric
                ? this._placeTick(tick, metric, PANEL_TRACK_WIDTH, PANEL_TICK_OVERHANG, now)
                : (tick.hide(), null);
            const left = metric?.id === 'session' && countdown
                ? formatCountdown(metric.resetAt, now) : null;
            remaining.text = left ?? '';
            remaining.visible = left !== null;

            if (metric) {
                const title = metric.id === 'session' ? '5-hour usage'
                    : metric.tag ? `${metric.tag} ${metric.title}` : metric.title;
                descriptions.push(`${title}, ${Math.round(value)} percent ${kind}` +
                    (marker ? `, on pace for ${Math.round(marker.projected)} percent` : '') +
                    (left ? `, resets in ${left}` : ''));
            }
        });
        this.accessible_name = descriptions.length
            ? `Claude usage, ${descriptions.join('; ')}`
            : 'Claude usage unavailable';
    }

    _updatePanelMode() {
        const mode = this._settings.get_string('display-mode');
        for (const {progress, label} of this._panelReadouts) {
            progress.visible = mode === 'bar' || mode === 'both';
            label.visible = mode === 'text' || mode === 'both';
        }
        this._updatePanel();
    }

    _updateIcon() {
        this._icon.visible = this._settings.get_boolean('show-icon');
        const monochrome = this._settings.get_string('icon-style') === 'monochrome';
        const desaturate = 'cut-desaturate';
        const brightness = 'cut-brightness';
        if (monochrome && !this._icon.get_effect(desaturate)) {
            this._icon.add_effect(new Clutter.DesaturateEffect({
                factor: 1,
                name: desaturate,
            }));
            const effect = new Clutter.BrightnessContrastEffect({name: brightness});
            effect.set_brightness_full(0.55, 0.55, 0.55);
            this._icon.add_effect(effect);
        } else if (!monochrome && this._icon.get_effect(desaturate)) {
            this._icon.remove_effect_by_name(desaturate);
            this._icon.remove_effect_by_name(brightness);
        }
    }

    _clearedAt() {
        return this._settings.get_int64('history-cleared-at');
    }

    async _loadHistory() {
        const text = await loadTextAsync(historyPath(), this._ioCancellable);
        if (this._destroyed)
            return;
        const {history, dropped} = parseHistory(text, this._clearedAt());
        this._history = history;
        this._historyLoaded = true;
        // A clear made while the extension was off left the file untouched.
        if (dropped)
            this._writeHistory();
        this._restoreHistorySnapshot();
    }

    /** Preferences cleared history: drop the samples here and rewrite the file. */
    _applyHistoryClear() {
        this._history = clearHistoryBefore(this._history, this._clearedAt());
        // Before the first load finishes `_loadHistory` applies the cutoff itself,
        // and writing the empty placeholder now would clobber the file.
        if (this._historyLoaded)
            this._writeHistory();
        this._renderHistory();
    }

    _writeHistory() {
        this._historyWriter.request();
    }

    /** Called by the writer, so the text is built from the state at write time. */
    _persistHistory() {
        GLib.mkdir_with_parents(historyDirectory(), 0o700);
        return writeTextAsync(
            historyPath(),
            JSON.stringify(this._history),
            this._ioCancellable
        );
    }

    _restoreHistorySnapshot() {
        // Thinned and partial samples are sparse: each metric comes from the
        // newest sample that has it.
        const latest = {};
        for (const sample of this._history.samples) {
            for (const [id, value] of Object.entries(sample.metrics))
                latest[id] = value;
        }
        if (!Object.keys(latest).length)
            return;

        const known = {
            session: ['Session Usage', '5-hour rolling window'],
            weekly: ['All models', null],
            extra: ['Extra Usage', null],
        };
        const order = ['session', 'weekly', 'model', 'extra'];
        const rank = id => {
            const index = order.indexOf(id.startsWith('model:') ? 'model' : id);
            return index < 0 ? order.length : index;
        };
        this._lastMetrics = Object.entries(latest).sort(([a], [b]) => rank(a) - rank(b)).map(([id, value]) => {
            const model = id.startsWith('model:')
                ? `${id.slice(6).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Usage`
                : null;
            return {
                id,
                title: known[id]?.[0] || model || 'Usage',
                tag: id === 'weekly' || id.startsWith('model:') ? 'Weekly' : null,
                subtitle: known[id]?.[1] || null,
                percent: value,
                resetAt: null,
                level: level(value),
            };
        });
        this._setState('Cached · waiting for refresh', 'stale');
        this._renderMetrics();
        this._renderHistory();
        this._updatePanel();
    }

    _renderHistory() {
        this._historyRows.destroy_all_children();
        const scale = this._themeContext.scale_factor;
        const range = this._historyScale();
        const {buckets, label: title} = HISTORY_SCALES[range];
        // Only a metric that never appears in the stored history is left out, so
        // the scale toggle stays reachable when the chosen range happens to be empty.
        const rows = [
            ['session', 'Session'],
            ['weekly', 'Weekly'],
        ].filter(([id]) => this._history.samples.some(sample => id in sample.metrics))
            .map(([id, label]) => [id, label, historySeries(this._history, id, range)]);

        if (!rows.length) {
            this._historyBox.hide();
            return;
        }

        this._historyTitle.text = title;

        // The bars share the card's inner width, so slots narrow as buckets grow.
        const slotWidth = Math.min(HISTORY_BAR_WIDTH_MAX, Math.floor(
            (CARD_TRACK_WIDTH - (buckets - 1) * HISTORY_BAR_GAP) / buckets));

        for (const [, label, values] of rows) {
            const current = [...values].reverse().find(value => value !== null);
            const row = new St.BoxLayout({...VERTICAL_LAYOUT, style_class: 'cut-history-row'});
            const labelRow = new St.BoxLayout();
            labelRow.add_child(new St.Label({
                text: label,
                x_expand: true,
                style_class: 'cut-history-label',
            }));
            labelRow.add_child(new St.Label({
                text: current === undefined ? '—' : `${Math.round(current)}%`,
                style_class: 'cut-history-value',
            }));
            row.add_child(labelRow);

            const bars = new St.BoxLayout({style_class: 'cut-history-bars'});
            for (const value of values) {
                const slot = new St.BoxLayout({
                    ...VERTICAL_LAYOUT,
                    y_align: Clutter.ActorAlign.END,
                    style_class: 'cut-history-slot',
                });
                slot.set_width(Math.round(slotWidth * scale));
                const bar = new St.Widget({
                    style_class: value === null
                        ? 'cut-history-bar history-empty'
                        : 'cut-history-bar',
                });
                bar.set_width(Math.round((slotWidth - HISTORY_BAR_GAP) * scale));
                const minimum = HISTORY_BAR_MINIMUM * scale;
                bar.set_height(value === null ? minimum : Math.max(minimum,
                    Math.round(HISTORY_BAR_HEIGHT * scale * value / 100)));
                if (value !== null)
                    this._paint(bar, level(value), 'background-color');
                slot.add_child(bar);
                bars.add_child(slot);
            }
            row.add_child(bars);
            this._historyRows.add_child(row);
        }
        this._historyBox.show();
    }

    /** `session` is undefined when the response dropped the window: that is a reset too. */
    _checkNotifications(session) {
        const enabled = notificationThresholds(
            [75, 90, 95].filter(value => this._settings.get_boolean(`threshold-${value}`)),
            this._settings.get_value('custom-thresholds').deep_unpack());
        const previous = {
            resetAt: this._settings.get_string('last-session-reset'),
            lastThreshold: this._settings.get_int('last-notified-threshold'),
            peak: this._settings.get_int('last-session-peak'),
        };
        const transition = notificationTransition(previous, session, enabled);
        if (transition.state.resetAt !== previous.resetAt)
            this._settings.set_string('last-session-reset', transition.state.resetAt);
        if (transition.state.lastThreshold !== previous.lastThreshold)
            this._settings.set_int('last-notified-threshold', transition.state.lastThreshold);
        if (transition.state.peak !== previous.peak)
            this._settings.set_int('last-session-peak', transition.state.peak);

        if (!this._settings.get_boolean('notifications-enabled'))
            return;
        if (transition.threshold) {
            this._notify(
                `${Math.round(session.percent)}% of the 5-hour window is used.`);
        }
        if (transition.reset && this._settings.get_boolean('notify-session-reset'))
            this._notify('The 5-hour window has reset.');
    }

    /**
     * An owned source carries the tracker's name and icon and keeps the alert in
     * the message tray; `Main.notify()` posts a transient banner attributed to
     * "System". The tray destroys a source once its last notification goes, so
     * this rebuilds one on demand rather than holding a stale reference.
     */
    _notify(body) {
        if (!this._notificationSource) {
            const source = new MessageTray.Source({
                title: 'Claude Usage Tracker',
                icon: Gio.icon_new_for_string(
                    GLib.build_filenamev([this._extensionPath, 'claude-usage.svg'])),
            });
            this._notificationSourceDestroyId = source.connect('destroy', () => {
                this._notificationSource = null;
                this._notificationSourceDestroyId = 0;
            });
            this._notificationSource = source;
            Main.messageTray.add(source);
        }

        this._notificationSource.addNotification(new MessageTray.Notification({
            source: this._notificationSource,
            title: 'Claude usage',
            body,
        }));
    }

    _startTimer() {
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-interval'),
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _restartTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._startTimer();
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        for (const name of this._keybindings)
            Main.wm.removeKeybinding(name);
        this._keybindings = [];
        this._historyWriter.stop();
        this._stopClaudeStatus();
        if (this._wakeRefreshId) {
            GLib.source_remove(this._wakeRefreshId);
            this._wakeRefreshId = 0;
        }
        this._stopAgeTimer();
        if (this._sleepSubscriptionId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSubscriptionId);
            this._sleepSubscriptionId = 0;
        }
        if (this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = 0;
        }
        this._networkMonitor = null;
        if (this._clockChangedId) {
            this._desktopSettings.disconnect(this._clockChangedId);
            this._clockChangedId = 0;
        }
        this._desktopSettings = null;
        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._ioCancellable?.cancel();
        this._ioCancellable = null;
        this._session.abort();
        this._session = null;
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._scaleChangedId) {
            this._themeContext.disconnect(this._scaleChangedId);
            this._scaleChangedId = 0;
        }
        this._themeContext = null;
        if (this._notificationSourceDestroyId) {
            this._notificationSource.disconnect(this._notificationSourceDestroyId);
            this._notificationSourceDestroyId = 0;
        }
        this._notificationSource?.destroy(
            MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._notificationSource = null;
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new ClaudeUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
