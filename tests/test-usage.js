import GLib from 'gi://GLib';

import {
    PACE_MIN_ELAPSED_MS,
    HISTORY_SCALES,
    PACE_TIERS,
    SerialWriter,
    addHistorySample,
    barLevel,
    clearHistoryBefore,
    formatCountdown,
    formatReset,
    historySeries,
    historyToCsv,
    hourlySeries,
    level,
    markerPosition,
    markerX,
    normalizeUsage,
    notificationThresholds,
    notificationTransition,
    paceColor,
    paceMarker,
    panelMetrics,
    parseClaudeStatus,
    parseHistory,
    parseThresholdList,
    sanitizeHistory,
    terminalArgv,
    updatedAgo,
    windowRecords,
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
assert(panelMetrics(metrics).map(item => item.id).join(',') === 'session,weekly',
    'panel shows both session and overall weekly limits');
assert(panelMetrics(metrics.filter(item => item.id !== 'weekly'))
    .map(item => item.id).join(',') === 'session,model:opus',
    'panel falls back to the first model weekly limit');
assert(panelMetrics([metrics[1]]).length === 1,
    'weekly-only data appears once without an invented session');
const zeroModel = {id: 'model:opus', percent: 0};
assert(panelMetrics([metrics[0], zeroModel])[1] === zeroModel,
    'an available weekly limit at zero percent stays visible');
assert(panelMetrics([metrics[0]]).length === 1,
    'missing weekly data does not invent a limit');
assert(panelMetrics([]).length === 0, 'empty data leaves the panel unavailable');
assert(panelMetrics([metrics.at(-1)])[0].id === 'extra',
    'panel preserves its fallback when only another limit is available');
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

// The API duplicates extra usage under `spend`; that has to keep working once
// the flat `extra_usage` block goes away, and stay ignored while it is there.
const spendOnly = normalizeUsage({
    five_hour: {utilization: 5, resets_at: reset},
    spend: {
        enabled: true,
        percent: 56,
        used: {amount_minor: 6171, currency: 'eur', exponent: 2},
        limit: {amount_minor: 11000, currency: 'eur', exponent: 2},
    },
});
const spendMetric = spendOnly.find(item => item.id === 'extra');
assert(spendMetric?.percent === 56, 'spend fills in for a missing extra_usage');
assert(spendMetric.subtitle === '61.71 / 110.00 EUR',
    'spend minor units and exponent become the same money text');

const bothBlocks = normalizeUsage({
    five_hour: {utilization: 5, resets_at: reset},
    extra_usage: {
        is_enabled: false,
        used_credits: 186,
        monthly_limit: 500,
        utilization: 37.2,
        currency: 'usd',
        decimal_places: 2,
    },
    spend: {
        enabled: true,
        percent: 56,
        used: {amount_minor: 6171, currency: 'eur', exponent: 2},
        limit: {amount_minor: 11000, currency: 'eur', exponent: 2},
    },
});
assert(!bothBlocks.some(item => item.id === 'extra'),
    'extra_usage still wins while the API sends both');
assert(formatReset(reset, Date.parse(reset) - 65 * 60_000) === 'Resets in 1h 5m',
    'reset formatting');

// Local-time constructors keep the clock assertions independent of the zone.
const at = (day, hour, minute, second = 0) => new Date(2026, 7, day, hour, minute, second);
const sameDay = at(6, 16, 15).toISOString();
const noon = at(6, 12, 0).getTime();
const absolute = {display: 'absolute', timeFormat: '12h'};
assert(formatReset(sameDay, noon, absolute) === 'Resets at 4:15 PM', 'absolute, today, 12-hour');
assert(formatReset(sameDay, noon, {display: 'absolute', timeFormat: '24h'}) === 'Resets at 16:15',
    'absolute, today, 24-hour');
assert(formatReset(at(8, 9, 5).toISOString(), noon, absolute) === 'Resets Sat 9:05 AM',
    'absolute, another day, weekday');
assert(formatReset(at(8, 0, 30).toISOString(), noon, absolute) === 'Resets Sat 12:30 AM',
    'midnight hour reads 12 in 12-hour time');
assert(formatReset(at(6, 16, 14, 40).toISOString(), noon, absolute) === 'Resets at 4:15 PM',
    'absolute time rounds to the nearest minute');
assert(formatReset(sameDay, noon, {display: 'both', timeFormat: '24h'}) ===
    'Resets in 4h 15m · at 16:15', 'relative and absolute together');
assert(formatReset(sameDay, noon, {display: 'relative'}) === 'Resets in 4h 15m',
    'relative stays the default form');
assert(formatReset(sameDay, noon) === 'Resets in 4h 15m', 'options are optional');
assert(formatReset(sameDay, at(6, 16, 15).getTime(), absolute) === 'Resets now',
    'a passed reset never shows a clock time');
assert(formatReset('nonsense', noon, absolute) === null, 'unparseable reset');
assert(formatCountdown(sameDay, noon) === '4h', 'countdown in hours');
assert(formatCountdown(at(6, 12, 45).toISOString(), noon) === '45m', 'countdown in minutes');
assert(formatCountdown(at(9, 12, 0).toISOString(), noon) === '3d', 'countdown in days');
assert(formatCountdown(at(6, 11, 0).toISOString(), noon) === null, 'no countdown after reset');
assert(updatedAgo(noon, noon + 30_000) === 'just now', 'fresh refresh');
assert(updatedAgo(noon, noon + 5 * 60_000) === '5 min ago', 'minutes since refresh');
assert(updatedAgo(noon, noon + 125 * 60_000) === '2 h ago', 'hours since refresh');

// Thresholds follow the macOS app: moderate from 70, critical from 90.
assert(level(69.9) === 'safe' && level(70) === 'moderate' && level(89.9) === 'moderate' &&
    level(90) === 'critical', '70/90 level cut-offs');
assert(normalizeUsage({five_hour: {utilization: 75, resets_at: reset}})[0].level === 'moderate',
    'normalized metrics use the same cut-offs');

// The tier table must stay equal to the Claude Code skin's.
const statusline = new TextDecoder().decode(GLib.file_get_contents(
    GLib.build_filenamev([GLib.path_get_dirname(GLib.path_get_dirname(
        import.meta.url.replace('file://', ''))), 'statusline.js']))[1]);
const cube = [0, 95, 135, 175, 215, 255];
const xterm = index => {
    const offset = index - 16;
    return '#' + [cube[Math.floor(offset / 36) % 6], cube[Math.floor(offset / 6) % 6],
        cube[offset % 6]].map(value => value.toString(16).padStart(2, '0')).join('');
};
const skinCodes = statusline.match(/const PACE = \[([\d, ]+)\]/)[1].split(',').map(Number);
const skinBounds = [...statusline.match(/function paceColor[\s\S]*?\n}/)[0]
    .matchAll(/projected < (\d+)/g)].map(match => Number(match[1]));
assert(skinCodes.length === 6 && skinBounds.length === 5, 'skin pace table parsed');
assert(PACE_TIERS.map(([below]) => below).slice(0, 5).join() === skinBounds.join(),
    'pace tier bounds match statusline.js');
assert(PACE_TIERS.map(([, color]) => color).join() === skinCodes.map(xterm).join(),
    'pace tier colours match statusline.js');
assert(PACE_MIN_ELAPSED_MS.session / 1000 ===
    Number(statusline.match(/SESSION_MIN_ELAPSED = ([\d_]+)/)[1].replace(/_/g, '')) &&
    PACE_MIN_ELAPSED_MS.weekly / 1000 ===
    Number(statusline.match(/WEEKLY_MIN_ELAPSED = ([\d_]+)/)[1].replace(/_/g, '')),
    'minimum elapsed time matches statusline.js');
assert(paceColor(49.9) === PACE_TIERS[0][1] && paceColor(50) === PACE_TIERS[1][1] &&
    paceColor(119.9) === PACE_TIERS[4][1] && paceColor(500) === PACE_TIERS[5][1],
    'tier selection at the boundaries');

// Pace marker: session window is 5 h, weekly and model windows are 7 d.
const HOUR = 3_600_000;
const now = Date.parse('2026-08-06T10:00:00Z');
const session = (percent, remainingMs, id = 'session') => ({
    id, percent, resetAt: new Date(now + remainingMs).toISOString(),
});
let marker = paceMarker(session(30, 2 * HOUR), now);
assert(Math.abs(marker.fraction - 0.6) < 1e-9 && Math.abs(marker.projected - 50) < 1e-9 &&
    marker.color === PACE_TIERS[1][1], 'session marker position and projected tier');
marker = paceMarker(session(10, 84 * HOUR, 'weekly'), now);
assert(Math.abs(marker.fraction - 0.5) < 1e-9 && marker.color === PACE_TIERS[0][1],
    'weekly window is 7 days');
assert(paceMarker(session(10, 84 * HOUR, 'model:fable'), now)?.fraction === 0.5,
    'model-scoped limits use the weekly window');
assert(paceMarker(session(10, 5 * HOUR - 539_000), now) === null,
    'no marker before the 540 s session minimum');
assert(paceMarker(session(10, 5 * HOUR - 540_000), now) !== null,
    'marker at the 540 s session minimum');
assert(paceMarker(session(10, 7 * 24 * HOUR - 3_023_000, 'weekly'), now) === null &&
    paceMarker(session(10, 7 * 24 * HOUR - 3_024_000, 'weekly'), now) !== null,
    'weekly minimum is 3024 s');
assert(paceMarker(session(10, 0), now) === null && paceMarker(session(10, -1000), now) === null,
    'no marker once the window has ended');
assert(paceMarker(session(10, 5 * HOUR), now) === null, 'no marker for a window not yet started');
assert(paceMarker({id: 'session', percent: 10, resetAt: null}, now) === null, 'no marker without a reset');
assert(paceMarker(session(10, HOUR, 'extra'), now) === null &&
    paceMarker(session(10, HOUR, 'limit:other'), now) === null, 'no marker for unknown windows');

assert(markerPosition(0.6, false) === 0.6, 'used mode places the tick at the elapsed share');
assert(Math.abs(markerPosition(0.6, true) - 0.4) < 1e-9, 'remaining mode mirrors it');
assert(markerX(0.5, 250, 2) === 124, 'tick centred on a 250 px track at 1x');
assert(markerX(0.5, 500, 4) === 248, 'scaled track and tick keep the same centre at 2x');
assert(markerX(0, 250, 2) === 0 && markerX(1, 250, 2) === 248, 'tick stays inside the track');
assert(markerX(1 - 0.6, 46 * 1.5, 2 * 1.5) === Math.round(0.4 * 69 - 1.5),
    'remaining-mode position at fractional scale');

// Pace-aware bar colour: projection needs 15 % of the window.
assert(barLevel(session(60, 2.5 * HOUR), 'usage', now) === 'safe', 'usage basis ignores pace');
assert(barLevel(session(60, 2.5 * HOUR), 'pace', now) === 'critical', 'pace basis projects 120 %');
assert(barLevel(session(40, 2.5 * HOUR), 'pace', now) === 'moderate', 'pace basis, 80 % projected');
assert(barLevel(session(20, 2.5 * HOUR), 'pace', now) === 'safe', 'pace basis, 40 % projected');
assert(barLevel(session(95, 4.5 * HOUR), 'pace', now) === 'critical',
    'under 15 % elapsed falls back to usage');
assert(barLevel(session(0, 2.5 * HOUR), 'pace', now) === 'safe', 'no usage, no projection');
assert(barLevel({id: 'extra', percent: 75, resetAt: null}, 'pace', now) === 'moderate',
    'metrics without a window fall back to usage');

assert(notificationThresholds([90, 75], [60, 75, 0, 101, 12.5, -3]).join() === '60,75,90',
    'custom thresholds merge, dedupe and drop out-of-range values');
assert(parseThresholdList('85, 60;60 abc 0 150 40').join() === '40,60,85',
    'threshold entry parses a free list');
assert(parseThresholdList('').length === 0, 'empty threshold entry');

let history = sanitizeHistory({samples: []}, 1_000_000);
let update = addHistorySample(history, metrics, 1_000_000);
assert(update.changed && update.history.samples.length === 1, 'first history sample');
update = addHistorySample(update.history, metrics, 1_000_000 + 60_000);
assert(!update.changed && update.history.samples.length === 1, 'five-minute sampling cap');
update = addHistorySample(update.history, metrics, 1_000_000 + 5 * 60_000);
assert(update.changed && update.history.samples.length === 2, 'next history bucket');
assert(hourlySeries(update.history, 'session', 1_000_000 + 5 * 60_000).at(-1) === 42,
    'hourly chart uses latest value');

assert(update.history.samples.at(-1).resets?.session === Date.parse(reset),
    'a sample records each metric reset time in ms');
assert(!('resets' in addHistorySample(null, [{id: 'extra', percent: 3, resetAt: null}], 5)
    .history.samples[0]), 'no reset times, no resets map');

// 30-day history: thinning, scales, records, export, clear.
{
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 100 * DAY;
const windowA = NOW - 20 * DAY + 3 * HOUR;
const windowB = windowA + 5 * HOUR;
const tick = (at, session, resets) => ({
    at, metrics: {session}, ...(resets === undefined ? {} : {resets: {session: resets}}),
});

const recent = Array.from({length: 40}, (_, i) => tick(NOW - 2 * DAY + i * 300_000, 10));
const dense = Array.from({length: 12}, (_, i) =>
    tick(NOW - 20 * DAY + i * 300_000, i === 5 ? 70 : 20, windowA));
let thinned = sanitizeHistory({samples: [...dense, ...recent]}, NOW);
assert(thinned.samples.length === 3 + recent.length,
    `old samples thin to first, peak and last per hour, recent stay (${thinned.samples.length})`);
const peakSample = thinned.samples.find(sample => sample.metrics.session === 70);
assert(peakSample.resets.session === windowA && thinned.samples[0].at === dense[0].at &&
    thinned.samples[2].at === dense.at(-1).at,
    'thinning keeps the hour\'s highest percent with its reset time');
assert(JSON.stringify(sanitizeHistory(thinned, NOW)) === JSON.stringify(thinned),
    'thinning is idempotent');
assert(sanitizeHistory({samples: [tick(NOW - 31 * DAY, 5), tick(NOW - 29 * DAY, 6)]}, NOW)
    .samples.length === 1, '30-day retention');
assert(sanitizeHistory({samples: [{at: NOW - 1, metrics: {session: 5}, resets: {session: 'x', gone: 1}}]}, NOW)
    .samples[0].resets === undefined, 'invalid reset entries are dropped');

const crossing = [
    tick(NOW - 20 * DAY, 30, windowA), tick(NOW - 20 * DAY + 300_000, 80, windowA),
    tick(NOW - 20 * DAY + 600_000, 5, windowB), tick(NOW - 20 * DAY + 900_000, 9, windowB),
];
const kept = sanitizeHistory({samples: crossing}, NOW);
assert(kept.samples.length === 4 && kept.samples[0].resets.session === windowA &&
    kept.samples[1].resets.session === windowA && kept.samples[2].resets.session === windowB &&
    kept.samples[3].resets.session === windowB,
    'thinning never merges samples across a reset boundary');
const records = windowRecords(
    sanitizeHistory({samples: [...crossing, tick(NOW - 1000, 12, windowB + 5 * HOUR)]}, NOW),
    'session');
assert(records.length === 2 && records[0].peak === 80 && records[1].peak === 9,
    'a rollover inside one thinned hour still yields its windows');
assert(records[0].end === Math.min(windowA, records[1].start) && records[0].start === NOW - 20 * DAY,
    'record start and end');
assert(windowRecords(sanitizeHistory({samples: crossing}, NOW), 'session').length === 1,
    'exactly one completed window after one rollover');
assert(windowRecords(sanitizeHistory({samples: [
    tick(NOW - 3 * DAY, 20), tick(NOW - 2 * DAY, 60), tick(NOW - DAY, 10),
]}, NOW), 'session').length === 0, 'a legacy-only file has no records');
assert(windowRecords(sanitizeHistory({samples: [
    tick(NOW - 3 * DAY, 20), tick(NOW - 2 * DAY, 60, windowA),
    tick(NOW - 2 * DAY + 60_000, 61, windowA + 400), tick(NOW - DAY, 10),
]}, NOW), 'session').length === 0, 'legacy samples and reset jitter invent no window');
assert(windowRecords(history, 'weekly').length === 0, 'unknown metric has no records');

// Thinning must not move a completed window's bounds.
{
    const base = NOW - 20 * DAY;
    const at = minute => base + minute * 60_000;
    const windowOne = base + 3 * HOUR;
    const windowTwo = base + 8 * HOUR;
    const values = [10, 15, 20, 90, 30, 25, 22];
    const raw = [
        ...values.map((value, i) => tick(at(i * 5), value, windowOne)),
        ...[4, 8, 60, 12].map((value, i) => tick(at(35 + i * 5), value, windowTwo)),
        tick(at(4 * 60), 3, windowTwo + 5 * HOUR),
    ];
    const before = windowRecords({samples: raw}, 'session');
    const after = windowRecords(sanitizeHistory({samples: raw}, NOW), 'session');
    assert(before.length === 2 && JSON.stringify(after) === JSON.stringify(before),
        `thinning keeps window bounds (${JSON.stringify(before)} vs ${JSON.stringify(after)})`);
    const thinnedAgain = sanitizeHistory(sanitizeHistory({samples: raw}, NOW), NOW);
    assert(JSON.stringify(thinnedAgain) === JSON.stringify(sanitizeHistory({samples: raw}, NOW)),
        'thinning with window bounds is still idempotent');
}

// Weekly records fall back to the first model-scoped metric, as the panel does.
{
    const stamp = (at, metrics, resets) => ({at, metrics, resets});
    const weekOne = NOW - 20 * DAY + 7 * DAY;
    const modelOnly = {samples: [
        stamp(NOW - 20 * DAY, {'model:fable': 40}, {'model:fable': weekOne}),
        stamp(NOW - 19 * DAY, {'model:fable': 55}, {'model:fable': weekOne}),
        stamp(NOW - 10 * DAY, {'model:fable': 5}, {'model:fable': weekOne + 7 * DAY}),
    ]};
    const weeklyRecords = windowRecords(modelOnly, 'weekly');
    assert(weeklyRecords.length === 1 && weeklyRecords[0].peak === 55,
        'weekly records use the first model metric when no weekly id exists');
    const both = {samples: modelOnly.samples.map(sample => ({
        ...sample, metrics: {...sample.metrics, weekly: 1},
        resets: {...sample.resets, weekly: weekOne},
    }))};
    assert(windowRecords(both, 'weekly').length === 0,
        'the weekly id wins over a model metric');
    // An old aggregate sample must not override newer model-only samples.
    const mixed = {samples: [
        stamp(NOW - 40 * DAY, {weekly: 70}, {weekly: weekOne - 14 * DAY}),
        ...modelOnly.samples,
    ]};
    const mixedRecords = windowRecords(mixed, 'weekly');
    assert(mixedRecords.length === 1 && mixedRecords[0].id === 'model:fable' &&
        mixedRecords[0].peak === 55,
        'weekly records follow the newest sample, not an old aggregate one');
}

assert(HISTORY_SCALES['5h'].buckets * HISTORY_SCALES['5h'].ms === 5 * HOUR &&
    HISTORY_SCALES['24h'].buckets * HISTORY_SCALES['24h'].ms === DAY &&
    HISTORY_SCALES['7d'].buckets * HISTORY_SCALES['7d'].ms === 7 * DAY &&
    HISTORY_SCALES['30d'].buckets * HISTORY_SCALES['30d'].ms === 30 * DAY,
    'every scale spans its label');
const series = {samples: [tick(NOW - 20 * DAY, 11), tick(NOW - 2 * HOUR, 44),
    tick(NOW - 2 * HOUR + 60_000, 45), tick(NOW - 2 * HOUR + 120_000, 46),
    tick(NOW - 10 * 60_000, 50)]};
assert(historySeries(series, 'session', '30d', NOW)[9] === 11 &&
    historySeries(series, 'session', '30d', NOW).length === 30, '30d buckets by day');
assert(historySeries(series, 'session', '5h', NOW).length === 20 &&
    historySeries(series, 'session', '5h', NOW)[19] === 50 &&
    historySeries(series, 'session', '5h', NOW)[11] === 44 &&
    historySeries(series, 'session', '5h', NOW)[12] === 46, '5h buckets by 15 minutes, newest wins');
assert(historySeries(series, 'session', '7d', NOW).length === 28, '7d buckets by 6 hours');
assert(historySeries(series, 'session', 'bogus', NOW).length === 24, 'unknown scale means 24h');
assert(historySeries(series, 'session', '24h', NOW).join() === hourlySeries(series, 'session', NOW).join(),
    'hourlySeries is the 24h series');

const csv = historyToCsv({samples: [{at: 0, metrics: {session: 4, weekly: 7.5}}]});
assert(csv === 'timestamp_iso,metric_id,percent\n1970-01-01T00:00:00.000Z,session,4\n' +
    '1970-01-01T00:00:00.000Z,weekly,7.5\n', 'CSV rows');

const cleared = clearHistoryBefore({version: 1, samples: [tick(10, 1), tick(20, 2), tick(30, 3)]}, 20);
assert(cleared.samples.length === 1 && cleared.samples[0].at === 30,
    'clear drops samples at or before the cutoff');
const fileText = JSON.stringify({version: 1, samples: [tick(NOW - 3000, 1), tick(NOW - 2000, 2), tick(NOW - 1000, 3)]});
let loaded = parseHistory(fileText, NOW - 2000, NOW);
assert(loaded.history.samples.length === 1 && loaded.dropped === 2,
    'a clear made while disabled is applied when history loads, and reported');
loaded = parseHistory(fileText, 0, NOW);
assert(loaded.history.samples.length === 3 && loaded.dropped === 0, 'no cutoff keeps everything');
assert(parseHistory('{broken', 0, NOW).history.samples.length === 0 &&
    parseHistory(null, 0, NOW).history.samples.length === 0, 'corrupt or missing history is empty');

// Writes are serialized: a clear issued while an older write is in flight must
// not be undone by that write landing last.
{
    let state = {samples: [{at: 1}, {at: 2}, {at: 3}]};
    let disk = null;
    const gates = [];
    let inFlight = 0;
    let overlap = false;
    const writer = new SerialWriter(() => {
        const text = JSON.stringify(state);
        inFlight++;
        overlap ||= inFlight > 1;
        return new Promise(resolve => gates.push(() => {
            disk = text;
            inFlight--;
            resolve();
        }));
    });
    writer.request();
    state = {samples: state.samples.filter(sample => sample.at > 2)};
    writer.request();
    writer.request();
    assert(gates.length === 1, 'a request during a write waits');
    gates.shift()();
    await Promise.resolve();
    await Promise.resolve();
    assert(gates.length === 1, 'one rerun covers every request made meanwhile');
    gates.shift()();
    await Promise.resolve();
    await Promise.resolve();
    assert(!overlap && gates.length === 0, 'never two writes at once, no extra rerun');
    assert(JSON.parse(disk).samples.length === 1 && JSON.parse(disk).samples[0].at === 3,
        'the file ends without the cleared samples');

    const failures = [];
    const failing = new SerialWriter(() => Promise.reject(new Error('disk full')), e => failures.push(e.message));
    failing.request();
    await Promise.resolve();
    await Promise.resolve();
    failing.request();
    await Promise.resolve();
    await Promise.resolve();
    assert(failures.length === 2, 'a failed write is reported and does not wedge the queue');

    let runs = 0;
    const stopped = new SerialWriter(() => (runs++, new Promise(resolve => gates.push(resolve))));
    stopped.request();
    stopped.request();
    stopped.stop();
    gates.shift()();
    await Promise.resolve();
    await Promise.resolve();
    stopped.request();
    assert(runs === 1, 'stop drops the pending rerun and refuses new requests');
}

assert(parseClaudeStatus({status: {indicator: 'minor', description: ' Minor Service Outage '}})
    .description === 'Minor Service Outage', 'status description is trimmed');
assert(['none', 'minor', 'major', 'critical', 'maintenance'].every(indicator =>
    parseClaudeStatus({status: {indicator, description: 'x'}})?.indicator === indicator),
    'every Statuspage indicator parses');
assert(parseClaudeStatus({status: {indicator: 'purple', description: 'x'}}) === null &&
    parseClaudeStatus({status: {indicator: 'none'}}) === null &&
    parseClaudeStatus({status: {indicator: 'none', description: '‮ '}}) === null &&
    parseClaudeStatus(null) === null, 'malformed status payloads are rejected');
assert(!parseClaudeStatus({status: {indicator: 'none', description: 'a‮b\nc'}})
    .description.match(/[‮\n]/), 'status text carries no control or bidi characters');
}

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

// Session reset: a known window that has ended and used something, once.
const windowA = '2026-08-06T10:00:00.000Z';
const windowB = '2026-08-06T15:00:00.000Z';
const afterA = Date.parse(windowA) + 60_000;
const used = {id: 'session', percent: 30, resetAt: windowA};
let rolled = notificationTransition({}, used, [], afterA);
assert(!rolled.reset && rolled.state.peak === 30, 'first observation stays quiet, records peak');
rolled = notificationTransition(rolled.state, {...used, percent: 12}, [], afterA);
assert(!rolled.reset && rolled.state.peak === 30, 'peak keeps the window maximum');
rolled = notificationTransition(rolled.state, {...used, percent: 2, resetAt: windowB}, [], afterA);
assert(rolled.reset && rolled.threshold === null, 'rollover after use notifies once');
assert(rolled.state.resetAt === windowB && rolled.state.peak === 2, 'new window starts a new peak');
rolled = notificationTransition(rolled.state, {...used, percent: 3, resetAt: windowB}, [], afterA);
assert(!rolled.reset, 'same window does not repeat');
rolled = notificationTransition({resetAt: windowA, lastThreshold: 0, peak: 0},
    {...used, resetAt: windowB}, [], afterA);
assert(!rolled.reset, 'a window with no usage does not notify');
rolled = notificationTransition({resetAt: windowA, lastThreshold: 0, peak: 30},
    {...used, resetAt: windowB}, [], Date.parse(windowA) - 60_000);
assert(!rolled.reset, 'a changed reset time before the window ended is jitter, not a rollover');
rolled = notificationTransition({resetAt: windowA, lastThreshold: 0, peak: 30}, null, [], afterA);
assert(rolled.reset && rolled.state.resetAt === 'unknown',
    'a window that ended with no new reset time still counts');
rolled = notificationTransition(rolled.state, {...used, resetAt: windowB}, [], afterA);
assert(!rolled.reset, 'an unknown previous window does not notify');

const installed = {'gnome-terminal': '/usr/bin/gnome-terminal', 'xdg-terminal-exec': '/usr/bin/xdg-terminal-exec'};
const find = name => installed[name] ?? null;
assert(terminalArgv(['claude', '/limit-reset'], find).join(' ') ===
    '/usr/bin/xdg-terminal-exec claude /limit-reset', 'xdg-terminal-exec wins, no separator');
delete installed['xdg-terminal-exec'];
assert(terminalArgv(['claude', '/limit-reset'], find).join(' ') ===
    '/usr/bin/gnome-terminal -- claude /limit-reset', 'GNOME terminals take --');
assert(terminalArgv(['claude'], () => null) === null, 'no terminal installed');

let failed = false;
try {
    normalizeUsage({five_hour: null, limits: []});
} catch (_error) {
    failed = true;
}
assert(failed, 'unsupported payload fails closed');

console.log('usage checks passed');
