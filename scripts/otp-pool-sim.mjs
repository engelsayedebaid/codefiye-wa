/**
 * Simulated admission only. Baileys is not loaded and no message is sent.
 * The 2s figure is OTP_DEFAULT_SEND_MS, an estimate used to reject work that
 * would miss its TTL. It is not a measured WhatsApp throughput.
 * Run: node --experimental-strip-types scripts/otp-pool-sim.mjs
 */
import { chooseOtpSession } from '../packages/shared/src/otp-pool.ts';

function session(id) {
  return {
    sessionId: id,
    enabled: true,
    membership: 'active',
    connected: true,
    restricted: false,
    queued: 0,
    inFlight: 0,
    avgSendMs: 2_000,
    lastAssignedAt: null,
  };
}

function burst(count, sessions, maxQueue) {
  const accepted = [];
  let rejected = 0;
  for (let i = 0; i < count; i += 1) {
    const choice = chooseOtpSession(sessions, { ttlRemainingMs: 300_000, maxQueue });
    if (!choice) {
      rejected += 1;
      continue;
    }
    const row = sessions.find((s) => s.sessionId === choice.sessionId);
    row.queued += 1;
    row.lastAssignedAt = i + 1;
    accepted.push(choice.sessionId);
  }
  const distribution = Object.fromEntries(sessions.map((s) => [s.sessionId, s.queued]));
  return { accepted: accepted.length, rejected, distribution, maxQueued: Math.max(...sessions.map((s) => s.queued)) };
}

const one = burst(1000, [session('s1')], 40);
const five = burst(1000, ['s1', 's2', 's3', 's4', 's5'].map(session), 40);
const tenants = Array.from({ length: 100 }, (_, i) => burst(50, [session(`t${i}`)], 40));
const tenantAccepted = tenants.reduce((sum, row) => sum + row.accepted, 0);
const cross = burst(20, [session('workspace-a'), { ...session('workspace-b'), enabled: false }], 40);

const result = {
  label: 'SIMULATED',
  whatsapp: false,
  database: false,
  assumption: 'Each queued OTP costs 2000ms of estimated service time. TTL is 300s. Per-session queue cap is 40. No drain runs during the burst, so this is admission, not delivery.',
  singleSession1000: one,
  fiveSessions1000: five,
  hundredTenantsOf50: { requests: 5000, accepted: tenantAccepted, rejected: 5000 - tenantAccepted },
  disabledForeignSession: cross,
};

console.log(JSON.stringify(result, null, 2));
