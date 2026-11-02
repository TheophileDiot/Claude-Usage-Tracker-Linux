const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const HISTORY_INTERVAL_MS = 5 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_RETENTION_MS = 30 * DAY_MS;
// Samples newer than this keep the 5-minute cadence; older ones are thinned.
const HISTORY_DETAIL_MS = 7 * DAY_MS;
// Sanity bound only: retention already caps the count (about 2k recent samples
// plus 24 per metric and day beyond them).
const HISTORY_LIMIT = 10_000;
// Reset times jitter by sub-seconds between responses; a real rollover moves
// the reset by hours.
const RESET_TOLERANCE_MS = MINUTE_MS;

function percent(value) {
    if (typeof value === 'string')
        value = Number(value.trim().replace('%', ''));

    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

function resetAt(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value))
        ? value
        : null;
}

function slug(value) {
    return String(value || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

function title(value) {
    return String(value || 'Usage')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

/** Same cut-offs as the macOS app: moderate from 70 %, critical from 90 %. */
export function level(value) {
    if (value >= 90)
        return 'critical';
    if (value >= 70)
        return 'moderate';
    return 'safe';
}

function metric(id, label, source, options = {}) {
    const value = percent(source?.percent ?? source?.utilization);
    if (value === null)
        return null;

    return {
        id,
        title: label,
        tag: options.tag ?? null,
        subtitle: options.subtitle ?? null,
        percent: value,
        resetAt: resetAt(source?.resets_at),
        level: level(value),
    };
}

function money(value, decimalPlaces = 2) {
    if (!Number.isFinite(value))
        return null;
    const places = Math.min(4, Math.max(0, decimalPlaces));
    return (value / 10 ** places).toFixed(places);
}

/**
 * Extra usage arrives twice: the older flat `extra_usage` block and a newer
 * `spend` object carrying the same figures as minor units. `extra_usage` still
 * wins while both are sent, so today's behaviour is unchanged; the fallback is
 * only there for the payload that drops it.
 */
function extraUsageFrom(payload) {
    const extra = payload.extra_usage;
    if (extra && typeof extra === 'object')
        return extra;

    const spend = payload.spend;
    if (!spend || typeof spend !== 'object')
        return null;

    return {
        is_enabled: spend.enabled,
        utilization: spend.percent,
        used_credits: spend.used?.amount_minor,
        monthly_limit: spend.limit?.amount_minor,
        currency: spend.used?.currency ?? spend.limit?.currency,
        decimal_places: spend.used?.exponent ?? spend.limit?.exponent,
    };
}

/** Normalize both legacy fields and the current dynamic limits[] response. */
export function normalizeUsage(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Usage response is not an object');

    const metrics = new Map();
    const order = [];
    const put = item => {
        if (!item)
            return;
        if (!metrics.has(item.id))
            order.push(item.id);
        metrics.set(item.id, item);
    };

    put(metric('session', 'Session Usage', payload.five_hour, {
        subtitle: '5-hour rolling window',
    }));
    put(metric('weekly', 'All models', payload.seven_day, {tag: 'Weekly'}));

    const legacyModels = [
        ['seven_day_opus', 'Opus'],
        ['seven_day_sonnet', 'Sonnet'],
        ['seven_day_omelette', 'Design'],
        ['seven_day_design', 'Design'],
        ['seven_day_fable', 'Fable'],
    ];
    for (const [key, name] of legacyModels) {
        const item = metric(`model:${slug(name)}`, `${name} Usage`, payload[key], {
            tag: 'Weekly',
        });
        if (item?.percent > 0)
            put(item);
    }

    if (Array.isArray(payload.limits)) {
        for (const limit of payload.limits) {
            if (!limit || limit.is_active === false)
                continue;

            const kind = String(limit.kind || '').toLowerCase();
            const group = String(limit.group || '').toLowerCase();
            const model = limit.scope?.model;
            const modelName = model?.display_name || model?.id;

            if (kind === 'session' || group === 'session') {
                put(metric('session', 'Session Usage', limit, {
                    subtitle: '5-hour rolling window',
                }));
            } else if (modelName) {
                put(metric(
                    `model:${slug(model.id || modelName)}`,
                    `${model.display_name || title(model.id)} Usage`,
                    limit,
                    {tag: 'Weekly'}
                ));
            } else if (kind.includes('weekly') || group.includes('weekly')) {
                put(metric('weekly', 'All models', limit, {tag: 'Weekly'}));
            } else {
                const key = kind || group;
                put(metric(`limit:${slug(key)}`, title(group || kind), limit));
            }
        }
    }

    const extra = extraUsageFrom(payload);
    if (extra?.is_enabled) {
        const used = Number(extra.used_credits);
        const limit = Number(extra.monthly_limit);
        const value = percent(extra.utilization) ??
            (Number.isFinite(used) && Number.isFinite(limit) && limit > 0
                ? Math.min(100, used / limit * 100)
                : null);
        if (value !== null) {
            const parsedDecimals = Number(extra.decimal_places);
            const decimals = Number.isInteger(parsedDecimals) ? parsedDecimals : 2;
            const currency = String(extra.currency || '').toUpperCase();
            const usedText = money(used, decimals);
            const limitText = money(limit, decimals);
            put({
                id: 'extra',
                title: 'Extra Usage',
                tag: null,
                subtitle: usedText !== null && limitText !== null
                    ? `${usedText} / ${limitText}${currency ? ` ${currency}` : ''}`
                    : null,
                percent: value,
                resetAt: null,
                level: level(value),
                // Raw amounts for the Claude Code skin, which shows cost rather
                // than a percentage.
                cost: usedText !== null && limitText !== null && currency
                    ? {used: usedText, limit: limitText, currency}
                    : null,
            });
        }
    }

    const rank = id => id === 'session' ? 0 : id === 'weekly' ? 1 :
        id.startsWith('model:') ? 2 : id === 'extra' ? 4 : 3;
    const result = order.map(id => metrics.get(id))
        .sort((a, b) => rank(a.id) - rank(b.id));
    if (result.length === 0)
        throw new Error('Usage response contains no supported limits');
    return result;
}

/** Keep the panel compact, using the skin's first-model fallback for weekly. */
export function panelMetrics(metrics) {
    const session = metrics.find(item => item.id === 'session');
    const weekly = metrics.find(item => item.id === 'weekly') ??
        metrics.find(item => item.id.startsWith('model:'));
    const selected = [session, weekly].filter(Boolean);
    return selected.length ? selected : metrics.slice(0, 1);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clockText(date, timeFormat) {
    const minutes = String(date.getMinutes()).padStart(2, '0');
    if (timeFormat === '24h')
        return `${String(date.getHours()).padStart(2, '0')}:${minutes}`;
    return `${date.getHours() % 12 || 12}:${minutes} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
}

/**
 * `options.display` is relative, absolute or both; `options.timeFormat` is
 * '12h' or '24h' (the caller resolves "system"). `now` is the clock.
 */
export function formatReset(value, now = Date.now(), options = {}) {
    const target = Date.parse(value);
    if (!Number.isFinite(target))
        return null;

    const minutes = Math.max(0, Math.floor((target - now) / MINUTE_MS));
    if (minutes === 0)
        return 'Resets now';

    let relative;
    if (minutes < 60) {
        relative = `Resets in ${minutes}m`;
    } else {
        const hours = Math.floor(minutes / 60);
        relative = hours < 24
            ? `Resets in ${hours}h ${minutes % 60}m`
            : `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
    }

    const {display = 'relative', timeFormat = '12h'} = options;
    if (display === 'relative')
        return relative;

    // Rounded to the minute, as the skin does, so 4:59:59.9 reads 5:00.
    const date = new Date(Math.round(target / MINUTE_MS) * MINUTE_MS);
    const day = date.toDateString() === new Date(now).toDateString()
        ? 'at' : WEEKDAYS[date.getDay()];
    const absolute = `${day} ${clockText(date, timeFormat)}`;
    return display === 'absolute' ? `Resets ${absolute}` : `${relative} · ${absolute}`;
}

/** Compact time-to-reset for the panel: "45m", "2h", "3d"; null once passed. */
export function formatCountdown(value, now = Date.now()) {
    const target = Date.parse(value);
    if (!Number.isFinite(target))
        return null;

    const minutes = Math.floor((target - now) / MINUTE_MS);
    if (minutes <= 0)
        return null;
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** "just now", "5 min ago", "2 h ago" for the last good refresh. */
export function updatedAgo(at, now = Date.now()) {
    const minutes = Math.max(0, Math.floor((now - at) / MINUTE_MS));
    if (minutes < 1)
        return 'just now';
    return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

/** Window lengths and the skin's minimum elapsed time before a projection counts. */
const PACE_WINDOWS = {
    session: {ms: 5 * HOUR_MS, minMs: 540_000},
    weekly: {ms: 7 * 24 * HOUR_MS, minMs: 3_024_000},
};

/**
 * Six tiers of projected end-of-window usage: [exclusive upper bound, colour].
 * Mirrors `PACE` and `paceColor()` in statusline.js (xterm-256 24-bit values);
 * tests/test-usage.js fails if the two drift apart.
 */
export const PACE_TIERS = [
    [50, '#00af00'],
    [75, '#00afaf'],
    [90, '#d7af00'],
    [100, '#ff8700'],
    [120, '#d70000'],
    [Infinity, '#af5fff'],
];
export const PACE_MIN_ELAPSED_MS = {
    session: PACE_WINDOWS.session.minMs,
    weekly: PACE_WINDOWS.weekly.minMs,
};

export function paceColor(projected) {
    return PACE_TIERS.find(([below]) => projected < below)[1];
}

function paceWindow(id) {
    if (id === 'session')
        return PACE_WINDOWS.session;
    return id === 'weekly' || String(id).startsWith('model:') ? PACE_WINDOWS.weekly : null;
}

/** Elapsed share of a metric's window, or null when unknown or out of range. */
function elapsedOf(item, now) {
    const spec = paceWindow(item?.id);
    const reset = Date.parse(item?.resetAt);
    if (!spec || !Number.isFinite(reset))
        return null;
    const remaining = reset - now;
    if (remaining <= 0 || remaining >= spec.ms)
        return null;
    const elapsedMs = spec.ms - remaining;
    return {spec, elapsedMs, fraction: elapsedMs / spec.ms};
}

/**
 * Pace marker for a bar: where the window stands and the colour of the usage
 * projected to its end. Null when the metric has no known window or reset,
 * or too little of the window has elapsed for a projection (skin minimums).
 */
export function paceMarker(item, now = Date.now()) {
    const elapsed = elapsedOf(item, now);
    if (!elapsed || elapsed.elapsedMs < elapsed.spec.minMs)
        return null;
    const projected = item.percent / elapsed.fraction;
    return {fraction: elapsed.fraction, projected, color: paceColor(projected)};
}

/** Bar position 0..1. Remaining mode mirrors it, as the macOS app does. */
export function markerPosition(fraction, remainingMode) {
    return remainingMode ? 1 - fraction : fraction;
}

/**
 * Left edge in stage pixels. `trackPx` and `tickPx` are already multiplied by
 * the theme scale factor: Clutter geometry is not scaled by St.
 */
export function markerX(position, trackPx, tickPx) {
    return Math.min(trackPx - tickPx, Math.max(0, Math.round(position * trackPx - tickPx / 2)));
}

/**
 * Colour level of a bar. 'pace' colours by projected end-of-window usage once
 * 15 % of the window has gone (macOS UsageStatusCalculator); otherwise, and
 * when no projection is possible, by usage itself.
 */
export function barLevel(item, basis = 'usage', now = Date.now()) {
    if (basis === 'pace' && item.percent > 0) {
        const elapsed = elapsedOf(item, now);
        if (elapsed && elapsed.fraction >= 0.15)
            return level(item.percent / elapsed.fraction);
    }
    return level(item.percent);
}

function sameWindow(a, b) {
    if (a === undefined || b === undefined)
        return a === b;
    return Math.abs(a - b) < RESET_TOLERANCE_MS;
}

/**
 * Samples older than a week keep, per metric, hour and reset segment, the first
 * and last observation plus the highest percent. An hour is also split wherever
 * a metric's reset time changes, so a window boundary is never merged away and
 * a completed window keeps its start, end and peak. The result regroups the
 * surviving entries by timestamp, and thinning an already-thinned list changes
 * nothing.
 */
function thinSamples(samples, now) {
    const detailFrom = now - HISTORY_DETAIL_MS;
    const kept = [];
    const segments = new Map();
    const open = new Map();
    let serial = 0;

    for (const sample of samples) {
        if (sample.at >= detailFrom) {
            kept.push(sample);
            continue;
        }

        const hour = Math.floor(sample.at / HOUR_MS);
        for (const [id, value] of Object.entries(sample.metrics)) {
            const reset = sample.resets?.[id];
            let current = open.get(id);
            if (!current || current.hour !== hour || !sameWindow(current.reset, reset))
                current = {hour, key: `${id}|${serial++}`};
            current.reset = reset;
            open.set(id, current);

            const entry = {at: sample.at, id, value, reset};
            const segment = segments.get(current.key);
            if (!segment) {
                segments.set(current.key, {first: entry, peak: entry, last: entry});
                continue;
            }
            segment.last = entry;
            if (value > segment.peak.value)
                segment.peak = entry;
        }
    }

    const thinned = new Map();
    for (const {first, peak, last} of segments.values()) {
        for (const {at, id, value, reset} of new Set([first, peak, last])) {
            const sample = thinned.get(at) ?? {at, metrics: {}};
            sample.metrics[id] = value;
            if (reset !== undefined)
                (sample.resets ??= {})[id] = reset;
            thinned.set(at, sample);
        }
    }
    return [...thinned.values(), ...kept].sort((a, b) => a.at - b.at);
}

export function sanitizeHistory(raw, now = Date.now()) {
    const cutoff = now - HISTORY_RETENTION_MS;
    const samples = Array.isArray(raw?.samples) ? raw.samples : [];
    const clean = samples
        .filter(sample => Number.isFinite(sample?.at) &&
            sample.at >= cutoff && sample.at <= now &&
            sample.metrics && typeof sample.metrics === 'object')
        .map(sample => {
            const metrics = Object.fromEntries(Object.entries(sample.metrics)
                .map(([id, value]) => [id, percent(value)])
                .filter(([, value]) => value !== null));
            const resets = sample.resets && typeof sample.resets === 'object'
                ? Object.fromEntries(Object.entries(sample.resets)
                    .filter(([id, value]) => id in metrics && Number.isFinite(value)))
                : {};
            return Object.keys(resets).length
                ? {at: sample.at, metrics, resets}
                : {at: sample.at, metrics};
        })
        .sort((a, b) => a.at - b.at);

    return {version: 1, samples: thinSamples(clean, now).slice(-HISTORY_LIMIT)};
}

/** Drop every sample at or before a clear time (ms epoch; 0 keeps everything). */
export function clearHistoryBefore(history, clearedAt) {
    return {
        ...history,
        samples: history.samples.filter(sample => sample.at > clearedAt),
    };
}

/**
 * Parse history.json text, then apply the persisted clear cutoff. `dropped`
 * counts the samples the cutoff removed, so a caller that finds the file still
 * holding them (a clear made while the extension was disabled) can rewrite it.
 */
export function parseHistory(text, clearedAt = 0, now = Date.now()) {
    let raw = null;
    try {
        raw = text === null || text === undefined ? null : JSON.parse(text);
    } catch (_error) {
        // A corrupt file reads as empty and is replaced by the next write.
    }
    const loaded = sanitizeHistory(raw, now);
    const history = clearHistoryBefore(loaded, clearedAt);
    return {history, dropped: loaded.samples.length - history.samples.length};
}

export function addHistorySample(raw, metrics, now = Date.now()) {
    const history = sanitizeHistory(raw, now);
    const previous = history.samples.at(-1);
    if (previous && now - previous.at < HISTORY_INTERVAL_MS)
        return {history, changed: false};

    const sample = {
        at: now,
        metrics: Object.fromEntries(metrics.map(item => [item.id, item.percent])),
    };
    const resets = Object.fromEntries(metrics
        .map(item => [item.id, Date.parse(item.resetAt)])
        .filter(([, value]) => Number.isFinite(value)));
    if (Object.keys(resets).length)
        sample.resets = resets;

    history.samples.push(sample);
    history.samples = history.samples.slice(-HISTORY_LIMIT);
    return {history, changed: true};
}

/** Chart scales: bucket count and size. */
export const HISTORY_SCALES = {
    '5h': {buckets: 20, ms: 15 * MINUTE_MS, label: 'Last 5 hours'},
    '24h': {buckets: 24, ms: HOUR_MS, label: 'Last 24 hours'},
    '7d': {buckets: 28, ms: 6 * HOUR_MS, label: 'Last 7 days'},
    '30d': {buckets: 30, ms: DAY_MS, label: 'Last 30 days'},
};

/**
 * Oldest-to-newest bucket values for a scale, each the bucket's newest sample.
 * An unknown scale falls back to 24h.
 */
export function historySeries(raw, metricId, scale = '24h', now = Date.now()) {
    const {buckets, ms} = HISTORY_SCALES[scale] ?? HISTORY_SCALES['24h'];
    const values = Array(buckets).fill(null);
    for (const sample of sanitizeHistory(raw, now).samples) {
        const age = now - sample.at;
        if (age < 0 || age >= buckets * ms)
            continue;
        const value = percent(sample.metrics[metricId]);
        if (value !== null)
            values[buckets - 1 - Math.floor(age / ms)] = value;
    }
    return values;
}

export function hourlySeries(raw, metricId, now = Date.now()) {
    return historySeries(raw, metricId, '24h', now);
}

/**
 * The weekly metric of a stored history, read from the newest sample that has a
 * weekly or model-scoped metric: `weekly`, else that sample's first model
 * metric, as the panel and skin cache do. Older samples never override it.
 */
export function weeklyMetricId(history) {
    for (const sample of [...history.samples].reverse()) {
        if ('weekly' in sample.metrics)
            return 'weekly';
        const model = Object.keys(sample.metrics).find(id => id.startsWith('model:'));
        if (model)
            return model;
    }
    return 'weekly';
}

/**
 * Completed windows of one metric, oldest first: `{id, start, end, peak}`. A
 * window is a run of samples sharing a stored reset time and is complete once a
 * sample with a different one follows. Samples without a stored reset time for
 * the metric (legacy files, or no known reset) belong to no window, so nothing
 * is invented for them. `start` is the first sample seen; `end` is the reset
 * time, or the next window's first sample if that came earlier.
 */
export function windowRecords(history, metricId) {
    if (metricId === 'weekly')
        metricId = weeklyMetricId(history);
    const records = [];
    let run = null;
    for (const sample of history.samples) {
        const reset = sample.resets?.[metricId];
        const value = sample.metrics[metricId];
        if (reset === undefined || value === undefined)
            continue;

        if (run && sameWindow(run.reset, reset)) {
            run.reset = reset;
            run.peak = Math.max(run.peak, value);
            continue;
        }
        if (run) {
            records.push({
                id: metricId,
                start: run.start,
                end: Math.max(run.start, Math.min(run.reset, sample.at)),
                peak: run.peak,
            });
        }
        run = {reset, start: sample.at, peak: value};
    }
    return records;
}

/** `timestamp_iso,metric_id,percent`, one row per stored value. */
export function historyToCsv(history) {
    const rows = ['timestamp_iso,metric_id,percent'];
    for (const sample of history.samples) {
        const stamp = new Date(sample.at).toISOString();
        for (const [id, value] of Object.entries(sample.metrics))
            rows.push(`${stamp},${id},${value}`);
    }
    return `${rows.join('\n')}\n`;
}

/**
 * At most one write in flight. A request made meanwhile only marks a rerun,
 * which calls `write()` again after the current one settles, so the text it
 * writes is built from the state at that moment and an older snapshot can never
 * land after a newer one. `write` returns a promise and builds its own text.
 */
export class SerialWriter {
    constructor(write, onError = () => {}) {
        this._write = write;
        this._onError = onError;
        this._busy = false;
        this._pending = false;
        this._stopped = false;
    }

    request() {
        if (this._stopped)
            return;
        if (this._busy) {
            this._pending = true;
            return;
        }
        this._run();
    }

    stop() {
        this._stopped = true;
        this._pending = false;
    }

    async _run() {
        this._busy = true;
        try {
            do {
                this._pending = false;
                try {
                    await this._write();
                } catch (error) {
                    this._onError(error);
                }
            } while (this._pending && !this._stopped);
        } finally {
            this._busy = false;
        }
    }
}

const STATUS_INDICATORS = ['none', 'minor', 'major', 'critical', 'maintenance'];

/**
 * Statuspage `status.json` to `{indicator, description}`, or null when the
 * payload is not one (unknown indicators included: the row hides rather than
 * guess a colour).
 */
export function parseClaudeStatus(payload) {
    const indicator = payload?.status?.indicator;
    const description = payload?.status?.description;
    if (!STATUS_INDICATORS.includes(indicator) || typeof description !== 'string')
        return null;
    const text = description.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ')
        .trim().slice(0, 80);
    return text ? {indicator, description: text} : null;
}

/** Enabled toggle values plus custom ones: unique integers 1-100, ascending. */
export function notificationThresholds(toggled, custom = []) {
    return [...new Set([...toggled, ...custom])]
        .filter(value => Number.isInteger(value) && value >= 1 && value <= 100)
        .sort((a, b) => a - b);
}

/** Parse the preferences entry ("60, 85") into valid thresholds. */
export function parseThresholdList(text) {
    return notificationThresholds(
        String(text).split(/[\s,;]+/).filter(Boolean).map(Number));
}

/**
 * Persisted window state avoids duplicate alerts and first-launch noise. It
 * also reports `reset` once: the session window rolled over after one in which
 * usage was above zero (`state.peak`, rounded up). A rollover is a previously
 * known reset time that has passed and been replaced, including by no time.
 */
export function notificationTransition(state, sessionMetric, enabledThresholds, now = Date.now()) {
    const thresholds = notificationThresholds(enabledThresholds);
    const reset = sessionMetric?.resetAt || 'unknown';
    const reached = thresholds.filter(value => sessionMetric?.percent >= value);
    const reachedMax = reached.at(-1) || 0;
    const peak = Math.ceil(sessionMetric?.percent || 0);

    if (!state?.resetAt || state.resetAt !== reset) {
        const ended = Date.parse(state?.resetAt);
        return {
            threshold: null,
            reset: Number.isFinite(ended) && ended <= now && (state.peak || 0) > 0,
            state: {resetAt: reset, lastThreshold: reachedMax, peak},
        };
    }

    const crossed = reached.filter(value => value > (state.lastThreshold || 0));
    const threshold = crossed.at(-1) || null;
    return {
        threshold,
        reset: false,
        state: {
            resetAt: reset,
            lastThreshold: threshold || state.lastThreshold || 0,
            peak: Math.max(peak, state.peak || 0),
        },
    };
}

/**
 * Terminals tried in order: the xdg-terminal-exec spec, then GNOME's own and
 * Debian's alternatives link. Each entry carries the argument that ends its own
 * options, so `command` reaches the terminal verbatim.
 */
const TERMINALS = [
    ['xdg-terminal-exec'],
    ['ptyxis', '--'],
    ['kgx', '--'],
    ['gnome-terminal', '--'],
    ['x-terminal-emulator', '-e'],
];

/** argv that runs `command` in the first installed terminal, or null if none is. */
export function terminalArgv(command, findProgram) {
    for (const [name, ...separator] of TERMINALS) {
        const path = findProgram(name);
        if (path)
            return [path, ...separator, ...command];
    }
    return null;
}
