const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const HISTORY_INTERVAL_MS = 5 * MINUTE_MS;
const HISTORY_RETENTION_MS = 7 * 24 * HOUR_MS;
const HISTORY_LIMIT = HISTORY_RETENTION_MS / HISTORY_INTERVAL_MS;

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

function level(value) {
    if (value >= 80)
        return 'critical';
    if (value >= 50)
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

    const extra = payload.extra_usage;
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

export function formatReset(value, now = Date.now()) {
    const target = Date.parse(value);
    if (!Number.isFinite(target))
        return null;

    const minutes = Math.max(0, Math.floor((target - now) / MINUTE_MS));
    if (minutes === 0)
        return 'Resets now';
    if (minutes < 60)
        return `Resets in ${minutes}m`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `Resets in ${hours}h ${minutes % 60}m`;
    return `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function sanitizeHistory(raw, now = Date.now()) {
    const cutoff = now - HISTORY_RETENTION_MS;
    const samples = Array.isArray(raw?.samples) ? raw.samples : [];
    return {
        version: 1,
        samples: samples
            .filter(sample => Number.isFinite(sample?.at) &&
                sample.at >= cutoff && sample.at <= now &&
                sample.metrics && typeof sample.metrics === 'object')
            .map(sample => ({
                at: sample.at,
                metrics: Object.fromEntries(Object.entries(sample.metrics)
                    .map(([id, value]) => [id, percent(value)])
                    .filter(([, value]) => value !== null)),
            }))
            .sort((a, b) => a.at - b.at)
            .slice(-HISTORY_LIMIT),
    };
}

export function addHistorySample(raw, metrics, now = Date.now()) {
    const history = sanitizeHistory(raw, now);
    const previous = history.samples.at(-1);
    if (previous && now - previous.at < HISTORY_INTERVAL_MS)
        return {history, changed: false};

    history.samples.push({
        at: now,
        metrics: Object.fromEntries(metrics.map(item => [item.id, item.percent])),
    });
    history.samples = history.samples.slice(-HISTORY_LIMIT);
    return {history, changed: true};
}

/** Return 24 oldest-to-newest hourly values, using each bucket's newest sample. */
export function hourlySeries(raw, metricId, now = Date.now()) {
    const values = Array(24).fill(null);
    for (const sample of sanitizeHistory(raw, now).samples) {
        const age = now - sample.at;
        if (age < 0 || age >= 24 * HOUR_MS)
            continue;
        const index = 23 - Math.floor(age / HOUR_MS);
        const value = percent(sample.metrics[metricId]);
        if (value !== null)
            values[index] = value;
    }
    return values;
}

/** Persisted threshold state avoids duplicate alerts and first-launch noise. */
export function notificationTransition(state, sessionMetric, enabledThresholds) {
    const thresholds = [...new Set(enabledThresholds)]
        .filter(value => Number.isInteger(value) && value > 0 && value <= 100)
        .sort((a, b) => a - b);
    const reset = sessionMetric?.resetAt || 'unknown';
    const reached = thresholds.filter(value => sessionMetric?.percent >= value);
    const reachedMax = reached.at(-1) || 0;

    if (!state?.resetAt || state.resetAt !== reset) {
        return {
            threshold: null,
            state: {resetAt: reset, lastThreshold: reachedMax},
        };
    }

    const crossed = reached.filter(value => value > (state.lastThreshold || 0));
    const threshold = crossed.at(-1) || null;
    return {
        threshold,
        state: {
            resetAt: reset,
            lastThreshold: threshold || state.lastThreshold || 0,
        },
    };
}
