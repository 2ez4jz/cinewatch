import { createHash } from "node:crypto";

export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));

export function emptyState() {
  return { version: 1, sources: {}, outbox: {} };
}

// Pure reducer: a failed/incomplete source never replaces its last good snapshot.
// Persist the returned snapshot AND outbox before attempting notification delivery.
export function advance(state, batch, now) {
  if (state.version !== 1) throw new Error("Unsupported state version");
  if (typeof batch.source !== "string" || !batch.source || batch.source in Object.prototype || batch.complete !== true || !Array.isArray(batch.records)) throw new Error("Incomplete source; preserving last good state");
  if (!validTime(now) || !validTime(batch.observedAt)) throw new Error("Invalid observation time");
  const age = Date.parse(now) - Date.parse(batch.observedAt);
  if (age < -60_000 || age > 24 * 3_600_000) throw new Error("Stale or future source snapshot");
  const next = structuredClone(state);
  const previous = next.sources[batch.source];
  if (previous && Date.parse(batch.observedAt) < Date.parse(previous.observedAt)) throw new Error("Out-of-order snapshot");
  const source = previous || { history: {} };
  const ids = new Set();
  const created = [];
  for (const record of batch.records) {
    if (typeof record.id !== "string" || !record.id || record.id in Object.prototype || ids.has(record.id)) throw new Error("Missing, unsafe or duplicate record ID");
    if (typeof record.eligible !== "boolean" || !record.fingerprint) throw new Error("Malformed normalized record");
    ids.add(record.id);
    const old = source.history[record.id];
    const episode = (old?.episode || 0) + (record.eligible && !old?.active ? 1 : 0);
    const shouldAlert = previous && record.eligible && !old?.active && !(record.once && old?.everSeen);
    source.history[record.id] = { active: record.eligible, everSeen: true, episode, fingerprint: record.fingerprint };
    if (shouldAlert) {
      const id = digest([batch.source, record.id, episode]);
      next.outbox[id] = {
        id, source: batch.source, recordId: record.id, episode, fingerprint: record.fingerprint,
        createdAt: now, status: "pending", attempts: 0, simulation: Boolean(batch.simulation), message: record.message,
      };
      created.push(id);
    }
  }
  for (const [id, old] of Object.entries(source.history)) {
    if (!ids.has(id)) old.active = false;
  }
  source.observedAt = batch.observedAt;
  next.sources[batch.source] = source;
  // Revalidate pending notices against this complete snapshot. Never deliver a
  // disappeared, expired or materially changed opportunity after a retry.
  const current = new Map(batch.records.map(record => [record.id, record]));
  for (const event of Object.values(next.outbox)) {
    if (event.source !== batch.source || event.status !== "pending") continue;
    const record = current.get(event.recordId);
    if (!record?.eligible || record.fingerprint !== event.fingerprint) {
      event.status = "cancelled";
      event.reason = "Opportunity no longer matches the latest complete snapshot";
    }
  }
  // For a changed but still eligible quote, a pending event is refreshed rather
  // than silently lost. Delivered opportunities are quiet until they close/reopen.
  for (const record of batch.records) {
    if (!record.eligible || !previous) continue;
    const old = state.sources[batch.source]?.history[record.id];
    if (!old?.active || old.fingerprint === record.fingerprint) continue;
    const pendingOld = Object.values(state.outbox).some(e => e.source === batch.source && e.recordId === record.id && e.status === "pending");
    if (!pendingOld) continue;
    const id = digest([batch.source, record.id, source.history[record.id].episode, record.fingerprint]);
    next.outbox[id] = { id, source: batch.source, recordId: record.id, fingerprint: record.fingerprint,
      episode: source.history[record.id].episode, createdAt: now, status: "pending", attempts: 0,
      simulation: Boolean(batch.simulation), message: record.message };
    created.push(id);
  }
  return { state: next, created, baseline: !previous };
}

// File notifications use stable event IDs as idempotency keys. A failed sink is
// retried; it is never recorded as delivered. No SMTP or external messaging here.
export async function deliver(state, source, sink, now) {
  const next = structuredClone(state);
  for (const event of Object.values(next.outbox)) {
    if (event.source !== source || event.status !== "pending") continue;
    event.attempts++;
    try {
      await sink(event);
      event.status = "delivered";
      event.deliveredAt = now;
      delete event.lastError;
    } catch (error) {
      event.lastError = error.message;
    }
  }
  return next;
}
