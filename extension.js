import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    addHistorySample,
    formatReset,
    hourlySeries,
    notificationTransition,
    normalizeUsage,
    sanitizeHistory,
} from './usage.js';
import {
    SKIN_KEYS,
    loadTextAsync,
    readAccountLabelAsync,
    writeConfig,
    writeTextAsync,
    writeUsageCache,
} from './skin.js';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';
const HISTORY_DIRECTORY = 'claude-usage-tracker';
const HISTORY_FILE = 'history.json';

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

function usageLevel(value) {
    if (value >= 80)
        return 'critical';
    if (value >= 50)
        return 'moderate';
    return 'safe';
}

function iconButton(iconName, label) {
    const icon = new St.Icon({icon_name: iconName, icon_size: 16});
    const button = new St.Button({
        child: icon,
        style_class: 'cut-icon-button',
        can_focus: true,
        accessible_name: label,
    });
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
        this._historyWriteId = 0;
        this._refreshing = false;
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
            }
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

        // Without an explicit alignment the box layout fills the cross axis, so the
        // track grows to the panel height instead of the 9px the stylesheet asks for.
        this._panelProgress = new St.Widget({
            style_class: 'cut-panel-progress',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressFill = new St.Widget({style_class: 'cut-panel-progress-fill'});
        this._panelProgress.add_child(this._panelProgressFill);
        this._panelBox.add_child(this._panelProgress);

        this._panelLabel = new St.Label({
            text: '—',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cut-panel-label',
        });
        this._panelBox.add_child(this._panelLabel);
        this.add_child(this._panelBox);
    }

    _buildMenu() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('cut-root-item');
        this._content = new St.BoxLayout({vertical: true, style_class: 'cut-popover'});
        item.add_child(this._content);
        this.menu.addMenuItem(item);

        const header = new St.BoxLayout({style_class: 'cut-header'});
        const identity = new St.BoxLayout({
            vertical: true,
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
        this._refreshButton.connect('clicked', () => this._refreshUsage());
        actions.add_child(this._refreshButton);

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

        this._dashboard = new St.BoxLayout({vertical: true, style_class: 'cut-dashboard'});
        this._metricsBox = new St.BoxLayout({vertical: true, style_class: 'cut-metrics'});
        this._historyBox = new St.BoxLayout({vertical: true, style_class: 'cut-history-card'});
        this._historyBox.hide();
        this._dashboard.add_child(this._metricsBox);
        this._dashboard.add_child(this._historyBox);

        const scroll = new St.ScrollView({style_class: 'cut-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.add_child(this._dashboard);
        this._content.add_child(scroll);
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
        // Captured once: destroy() drops the reference, and every remaining read
        // in this loop still has to see the cancellation.
        const cancellable = this._ioCancellable;
        for (const path of this._credentialPaths()) {
            const text = await loadTextAsync(path, cancellable);
            if (text === null)
                continue;
            try {
                const data = JSON.parse(text);
                const oauth = data.claudeAiOauth;
                if (!oauth?.accessToken)
                    throw new Error('missing access token');
                if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= Date.now())
                    throw new Error('Claude Code login expired. Run claude auth login.');
                return oauth.accessToken;
            } catch (error) {
                if (error.message.includes('expired'))
                    throw error;
                invalidFile = true;
            }
        }

        if (invalidFile)
            throw new Error('Claude Code credentials are invalid. Run claude auth login.');
        throw new Error('Claude Code credentials not found. Run claude auth login.');
    }

    async _refreshUsage() {
        if (this._refreshing)
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
                        if (message.status_code === 429)
                            throw new Error('Usage service is rate limited. Cached data remains visible.');
                        throw new Error(`Usage request failed with HTTP ${message.status_code}.`);
                    }

                    const payload = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    this._showUsage(normalizeUsage(payload));
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
        this._setState(this._lastMetrics.length ? 'Showing cached data' : 'Usage unavailable', 'stale');
        if (!this._lastMetrics.length)
            this._panelLabel.text = '—';
        this._setLoading(false);
    }

    _setState(text, state) {
        this._stateLabel.text = text;
        for (const name of ['state-loading', 'state-ready', 'state-stale'])
            this._stateDot.remove_style_class_name(name);
        this._stateDot.add_style_class_name(`state-${state}`);
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

    _renderMetrics() {
        this._metricsBox.destroy_all_children();
        const scale = this._themeContext.scale_factor;
        for (const item of this._lastMetrics) {
            const card = new St.BoxLayout({vertical: true, style_class: 'cut-card'});
            const kind = this._settings.get_string('percentage-mode') === 'remaining'
                ? 'remaining'
                : 'used';
            card.accessible_name =
                `${item.title}, ${Math.round(this._displayValue(item))} percent ${kind}`;

            const header = new St.BoxLayout({style_class: 'cut-card-header'});
            const titleBlock = new St.BoxLayout({vertical: true, x_expand: true});
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
            header.add_child(new St.Label({
                text: `${Math.round(value)}%`,
                y_align: Clutter.ActorAlign.START,
                style_class: `cut-card-value usage-${item.level}`,
            }));
            card.add_child(header);

            const track = new St.Widget({style_class: 'cut-progress-track'});
            const fill = new St.Widget({style_class: `cut-progress-fill usage-${item.level}`});
            fill.set_width(Math.round(CARD_TRACK_WIDTH * scale * value / 100));
            track.add_child(fill);
            card.add_child(track);

            const reset = formatReset(item.resetAt);
            if (reset)
                card.add_child(new St.Label({text: reset, style_class: 'cut-reset'}));
            this._metricsBox.add_child(card);
        }
    }

    _updatePanel() {
        const metric = this._lastMetrics.find(item => item.id === 'session') ||
            this._lastMetrics.find(item => item.id === 'weekly') ||
            this._lastMetrics[0];
        if (!metric) {
            this._panelLabel.text = '—';
            this._panelProgressFill.set_width(0);
            return;
        }

        const value = this._displayValue(metric);
        this._panelLabel.text = `${Math.round(value)}%`;
        this._panelProgressFill.set_width(Math.round(
            PANEL_TRACK_WIDTH * this._themeContext.scale_factor * value / 100));
        for (const actor of [this._panelLabel, this._panelProgressFill]) {
            for (const name of ['usage-safe', 'usage-moderate', 'usage-critical'])
                actor.remove_style_class_name(name);
            actor.add_style_class_name(`usage-${metric.level}`);
        }
        const kind = this._settings.get_string('percentage-mode') === 'remaining'
            ? 'remaining'
            : 'used';
        this.accessible_name = `Claude usage, ${Math.round(value)} percent ${kind}`;
    }

    _updatePanelMode() {
        const mode = this._settings.get_string('display-mode');
        this._panelProgress.visible = mode === 'bar' || mode === 'both';
        this._panelLabel.visible = mode === 'text' || mode === 'both';
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

    _historyPath() {
        return GLib.build_filenamev([
            GLib.get_user_state_dir(),
            HISTORY_DIRECTORY,
            HISTORY_FILE,
        ]);
    }

    async _loadHistory() {
        const text = await loadTextAsync(this._historyPath(), this._ioCancellable);
        if (this._destroyed)
            return;
        try {
            this._history = sanitizeHistory(text === null ? null : JSON.parse(text));
        } catch (_error) {
            this._history = sanitizeHistory(null);
        }
        this._restoreHistorySnapshot();
    }

    _writeHistory() {
        if (this._historyWriteId)
            return;
        this._historyWriteId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._historyWriteId = 0;
            const directory = GLib.build_filenamev([
                GLib.get_user_state_dir(),
                HISTORY_DIRECTORY,
            ]);
            GLib.mkdir_with_parents(directory, 0o700);
            writeTextAsync(
                this._historyPath(),
                JSON.stringify(this._history),
                this._ioCancellable
            ).catch(error => console.error(
                `Claude Usage Tracker: history write failed: ${error.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _restoreHistorySnapshot() {
        const sample = this._history.samples.at(-1);
        if (!sample)
            return;

        const known = {
            session: ['Session Usage', '5-hour rolling window'],
            weekly: ['All models', null],
            extra: ['Extra Usage', null],
        };
        this._lastMetrics = Object.entries(sample.metrics).map(([id, value]) => {
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
                level: usageLevel(value),
            };
        });
        this._setState('Cached · waiting for refresh', 'stale');
        this._renderMetrics();
        this._renderHistory();
        this._updatePanel();
    }

    _renderHistory() {
        this._historyBox.destroy_all_children();
        const scale = this._themeContext.scale_factor;
        const rows = [
            ['session', 'Session'],
            ['weekly', 'Weekly'],
        ].map(([id, label]) => [id, label, hourlySeries(this._history, id)])
            .filter(([, , values]) => values.some(value => value !== null));

        if (!rows.length) {
            this._historyBox.hide();
            return;
        }

        const heading = new St.BoxLayout({style_class: 'cut-history-heading'});
        heading.add_child(new St.Label({
            text: 'Last 24 hours',
            x_expand: true,
            style_class: 'cut-history-title',
        }));
        heading.add_child(new St.Label({text: 'Used %', style_class: 'cut-history-caption'}));
        this._historyBox.add_child(heading);

        for (const [, label, values] of rows) {
            const current = [...values].reverse().find(value => value !== null);
            const row = new St.BoxLayout({vertical: true, style_class: 'cut-history-row'});
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
                    vertical: true,
                    y_align: Clutter.ActorAlign.END,
                    style_class: 'cut-history-slot',
                });
                const bar = new St.Widget({
                    style_class: value === null
                        ? 'cut-history-bar history-empty'
                        : `cut-history-bar usage-${usageLevel(value)}`,
                });
                const minimum = HISTORY_BAR_MINIMUM * scale;
                bar.set_height(value === null ? minimum : Math.max(minimum,
                    Math.round(HISTORY_BAR_HEIGHT * scale * value / 100)));
                slot.add_child(bar);
                bars.add_child(slot);
            }
            row.add_child(bars);
            this._historyBox.add_child(row);
        }
        this._historyBox.show();
    }

    _checkNotifications(session) {
        if (!session)
            return;

        const enabled = [75, 90, 95].filter(value =>
            this._settings.get_boolean(`threshold-${value}`));
        const previous = {
            resetAt: this._settings.get_string('last-session-reset'),
            lastThreshold: this._settings.get_int('last-notified-threshold'),
        };
        const transition = notificationTransition(previous, session, enabled);
        if (transition.state.resetAt !== previous.resetAt)
            this._settings.set_string('last-session-reset', transition.state.resetAt);
        if (transition.state.lastThreshold !== previous.lastThreshold)
            this._settings.set_int('last-notified-threshold', transition.state.lastThreshold);

        if (transition.threshold && this._settings.get_boolean('notifications-enabled')) {
            this._notify(
                `${Math.round(session.percent)}% of the 5-hour window is used.`);
        }
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
        if (this._historyWriteId) {
            GLib.source_remove(this._historyWriteId);
            this._historyWriteId = 0;
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
