import {
    addHistorySample,
    formatReset,
    hourlySeries,
    normalizeUsage,
    notificationTransition,
    sanitizeHistory,
} from '../usage.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const reset = '2026-08-06T10:00:00.000Z';
const metrics = normalizeUsage({
    five_hour: {utilization: 12.5, resets_at: reset},
    seven_day: null,
    seven_day_opus: {utilization: 9, resets_at: reset},
    limits: [
        {kind: 'session', group: 'session', percent: 42, resets_at: reset, is_active: true},
        {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 63,
            resets_at: reset,
            is_active: true,
            scope: {model: {id: null, display_name: 'Fable'}},
        },
        {kind: 'weekly', group: 'weekly', percent: '55%', resets_at: reset, is_active: true},
        {kind: 'weekly_scoped', group: 'weekly', percent: 99, is_active: false,
            scope: {model: {display_name: 'Hidden'}}},
    ],
    extra_usage: {
        is_enabled: true,
        used_credits: 186,
        monthly_limit: 500,
        utilization: 37.2,
        currency: 'usd',
        decimal_places: 2,
    },
});

assert(metrics.map(item => item.id).join(',') ===
    'session,weekly,model:opus,model:fable,extra', 'metric order and visibility');
assert(metrics[0].percent === 42, 'dynamic session overrides legacy field');
assert(metrics[1].percent === 55, 'dynamic weekly supports null seven_day');
assert(metrics.find(item => item.id === 'extra').subtitle === '1.86 / 5.00 USD',
    'extra usage money formatting');
const wholeCurrency = normalizeUsage({
    extra_usage: {
        is_enabled: true,
        used_credits: 500,
        monthly_limit: 1000,
        utilization: 50,
        currency: 'jpy',
        decimal_places: 0,
    },
});
assert(wholeCurrency[0].subtitle === '500 / 1000 JPY',
    'extra usage respects currency decimal places');
assert(formatReset(reset, Date.parse(reset) - 65 * 60_000) === 'Resets in 1h 5m',
    'reset formatting');

let history = sanitizeHistory({samples: []}, 1_000_000);
let update = addHistorySample(history, metrics, 1_000_000);
assert(update.changed && update.history.samples.length === 1, 'first history sample');
update = addHistorySample(update.history, metrics, 1_000_000 + 60_000);
assert(!update.changed && update.history.samples.length === 1, 'five-minute sampling cap');
update = addHistorySample(update.history, metrics, 1_000_000 + 5 * 60_000);
assert(update.changed && update.history.samples.length === 2, 'next history bucket');
assert(hourlySeries(update.history, 'session', 1_000_000 + 5 * 60_000).at(-1) === 42,
    'hourly chart uses latest value');

let transition = notificationTransition({}, metrics[0], [75, 90, 95]);
assert(transition.threshold === null, 'first refresh stays quiet');
transition = notificationTransition(transition.state, {...metrics[0], percent: 76}, [75, 90, 95]);
assert(transition.threshold === 75, 'threshold crossing notifies');
transition = notificationTransition(transition.state, {...metrics[0], percent: 89}, [75, 90, 95]);
assert(transition.threshold === null, 'same threshold does not repeat');
transition = notificationTransition(transition.state, {...metrics[0], percent: 96}, [75, 90, 95]);
assert(transition.threshold === 95, 'highest newly crossed threshold wins');
transition = notificationTransition(transition.state, {
    ...metrics[0],
    percent: 76,
    resetAt: '2026-08-07T10:00:00Z',
}, [75, 90, 95]);
assert(transition.threshold === null && transition.state.lastThreshold === 75,
    'new window rearms without startup noise');

let failed = false;
try {
    normalizeUsage({five_hour: null, limits: []});
} catch (_error) {
    failed = true;
}
assert(failed, 'unsupported payload fails closed');

console.log('usage checks passed');
