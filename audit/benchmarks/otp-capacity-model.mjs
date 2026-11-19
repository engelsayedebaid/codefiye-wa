/**
 * Deterministic model of the current per-session send loop.
 * NOT a live HTTP or WhatsApp benchmark.
 *
 * Matches SessionRunner.pace + sendOne order (apps/worker/src/runner.ts):
 *   lookup, then pace, then provider.send.
 * lastSentAt starts at 0, so the first text message waits SEND_DELAY_MIN_MS.
 * Later messages wait a uniform gap in [min, max]. A lookup shorter than the
 * gap is absorbed by the gap; it is not added on top.
 *
 * Defaults are the code defaults (SEND_DELAY_MIN_MS=1000, SEND_DELAY_MAX_MS=3000).
 * They are not measured production values. Railway may override them (UNVERIFIED).
 *
 * Usage: node audit/benchmarks/otp-capacity-model.mjs
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gapMs(rand, minMs, maxMs) {
  return minMs + Math.floor(rand() * (maxMs - minMs + 1));
}

/** Burst of n jobs arriving at t=0 on one idle session. */
export function simulateBurst({ n, minMs, maxMs, lookupMs, sendMs, seed }) {
  const rand = mulberry32(seed);
  let now = 0;
  let lastSentAt = 0;
  let first = true;
  const doneAt = [];
  for (let i = 0; i < n; i++) {
    const gap = gapMs(rand, minMs, maxMs);
    const afterLookup = now + lookupMs;
    // First message: lastSentAt is 0 while wall clock is "now", so wait collapses to minMs.
    const wait = first ? minMs : Math.max(lastSentAt + gap - afterLookup, minMs);
    first = false;
    now = afterLookup + wait + sendMs;
    lastSentAt = now;
    doneAt.push(now);
  }
  const sorted = [...doneAt].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * n) - 1))];
  return { n, totalMs: now, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: sorted.at(-1) };
}

export function stalePct(doneAtMaxList, ttlMs) {
  const stale = doneAtMaxList.filter((t) => t > ttlMs).length;
  return (100 * stale) / doneAtMaxList.length;
}

/** Completion timestamps, same seed path as simulateBurst. */
function completions(opts) {
  const rand = mulberry32(opts.seed);
  let now = 0;
  let lastSentAt = 0;
  let first = true;
  const out = [];
  for (let i = 0; i < opts.n; i++) {
    const gap = gapMs(rand, opts.minMs, opts.maxMs);
    const afterLookup = now + opts.lookupMs;
    const wait = first ? opts.minMs : Math.max(lastSentAt + gap - afterLookup, opts.minMs);
    first = false;
    now = afterLookup + wait + opts.sendMs;
    lastSentAt = now;
    out.push(now);
  }
  return out;
}

const PLANS = { trial: 10, basic: 60, pro: 120, plus: 120, business: 120, enterprise: 300, unlimited: 2000 };
const LOADS = [100, 500, 1000, 5000, 10000];
const TTLS = [5 * 60_000, 10 * 60_000];

const profiles = [
  { name: 'code-defaults-pacing-only', minMs: 1000, maxMs: 3000, lookupMs: 0, sendMs: 0 },
  { name: 'code-defaults-lookup-300ms-send-400ms', minMs: 1000, maxMs: 3000, lookupMs: 300, sendMs: 400 },
  { name: 'assumption-0.5-mps', minMs: 2000, maxMs: 2000, lookupMs: 0, sendMs: 0 },
  { name: 'assumption-1-mps', minMs: 1000, maxMs: 1000, lookupMs: 0, sendMs: 0 },
  { name: 'assumption-5-mps', minMs: 200, maxMs: 200, lookupMs: 0, sendMs: 0 },
  { name: 'meta-doc-80-mps-NOT-our-capacity', minMs: 13, maxMs: 13, lookupMs: 0, sendMs: 0 },
];

const report = { kind: 'MODEL_NOT_LIVE_BENCHMARK', seed: 19, profiles: [], admission: [] };

for (const profile of profiles) {
  const rows = [];
  for (const n of LOADS) {
    const times = completions({ ...profile, n, seed: report.seed });
    const sim = simulateBurst({ ...profile, n, seed: report.seed });
    const stale = {};
    for (const ttl of TTLS) stale[`ttl${ttl / 60000}m`] = +((100 * times.filter((t) => t > ttl).length) / n).toFixed(1);
    rows.push({
      n,
      totalMin: +(sim.totalMs / 60_000).toFixed(2),
      p50s: +(sim.p50 / 1000).toFixed(1),
      p95s: +(sim.p95 / 1000).toFixed(1),
      p99s: +(sim.p99 / 1000).toFixed(1),
      stalePct: stale,
    });
  }
  report.profiles.push({ name: profile.name, rows });
}

for (const burst of LOADS) {
  const plans = {};
  for (const [plan, rpm] of Object.entries(PLANS)) {
    plans[plan] = { admitted: Math.min(burst, rpm), rejected: Math.max(0, burst - rpm) };
  }
  report.admission.push({ burst, singleProcessPerMinute: plans });
}

console.log(JSON.stringify(report, null, 2));
