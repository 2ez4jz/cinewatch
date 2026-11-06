import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { advance, deliver, emptyState } from "../lib/core.mjs";
import { assessOffer, cardBatch, cinemaBatch } from "../lib/adapters.mjs";
import { fileSink, readJson, withWorkspace } from "../lib/storage.mjs";
import { fetchReferences } from "../lib/scryfall.mjs";
import { demoFrame, exampleOffer, times } from "../fixtures/demo.mjs";

const batch = index => cardBatch(demoFrame(index), times[index]);
const baseline = () => advance(emptyState(), batch(0), times[0]).state;

test("cost gate includes tax, transport, labor and risk reserve, using integer cents", () => {
  const result = assessOffer(exampleOffer(), times[0], true);
  assert.equal(result.eligible, true);
  assert.equal(result.capitalCents, 2660);
  assert.equal(result.netCents, 2540);
  assert.equal(result.roiBps, 9548);
});

test("blocks store credit, wrong finish, fees, stale quotes, no demand and unknown costs", () => {
  const records = batch(1).records;
  assert.deepEqual(records.filter(r => r.eligible).map(r => r.id), ["simulation-a"]);
  for (const record of records.slice(1)) assert.ok(record.reasons.length, record.id);
  assert.ok(records.find(r => r.id === "simulation-costs").reasons.includes("net_below_threshold"));
});

test("rejects mismatched printing/language/condition, currency, budget and expiring exit", () => {
  const mutations = [
    o => { o.sell.item.scryfallId = "wrong"; }, o => { o.sell.item.language = "ja"; },
    o => { o.sell.item.condition = "LP"; }, o => { o.sell.currency = "USD"; },
    o => { o.buy.unitCents = 40_000; }, o => { o.sell.validUntil = "2026-10-23T13:00:00Z"; },
    o => { o.buy.unitCents = "2000"; }, o => { o.sell.unitCents = Infinity; },
  ];
  for (const mutate of mutations) { const offer = exampleOffer(); mutate(offer); assert.equal(assessOffer(offer, times[0], true).eligible, false); }
});

test("real mode cannot treat fixtures or Scryfall reference data as quote evidence", () => {
  const offer = exampleOffer();
  offer.item.scryfallId = offer.buy.item.scryfallId = offer.sell.item.scryfallId = "46ca0b66-a000-4483-b916-f5b89e710244";
  assert.ok(assessOffer(offer, times[0], false).reasons.includes("reference_is_not_quote_evidence"));
  offer.buy.evidence = "manual:receipt-123"; offer.sell.evidence = "https://api.scryfall.com/cards/123";
  assert.equal(assessOffer(offer, times[0], false).eligible, false);
  offer.sell.evidence = "manual:cash-quote-123";
  assert.equal(assessOffer(offer, times[0], false).eligible, true);
});

test("initializes quietly even with an existing profitable candidate", () => {
  const result = advance(emptyState(), batch(1), times[1]);
  assert.equal(result.baseline, true);
  assert.equal(result.created.length, 0);
});

test("new opportunity creates one event; repeated snapshot does not repeat", () => {
  const first = advance(baseline(), batch(1), times[1]);
  const second = advance(first.state, batch(2), times[2]);
  assert.equal(first.created.length, 1);
  assert.equal(second.created.length, 0);
  assert.equal(Object.keys(second.state.outbox).length, 1);
});

test("notification failure survives JSON restart; success is delivered only once", async () => {
  let state = advance(baseline(), batch(1), times[1]).state;
  state = await deliver(state, "cards:simulation", async () => { throw new Error("offline"); }, times[1]);
  assert.equal(Object.values(state.outbox)[0].status, "pending");
  state = JSON.parse(JSON.stringify(state));
  state = advance(state, batch(2), times[2]).state;
  let sends = 0;
  state = await deliver(state, "cards:simulation", async () => { sends++; }, times[2]);
  state = await deliver(state, "cards:simulation", async () => { sends++; }, times[2]);
  assert.equal(sends, 1);
  assert.equal(Object.values(state.outbox)[0].attempts, 2);
});

test("a pending quote is cancelled if it expires before retry", () => {
  const state = advance(baseline(), batch(1), times[1]).state;
  const changed = demoFrame(2); changed.offers[0].sell.validUntil = times[2];
  const result = advance(state, cardBatch(changed, times[2]), times[2]);
  assert.equal(Object.values(result.state.outbox)[0].status, "cancelled");
  assert.equal(result.created.length, 0);
});

test("changed pending quote replaces old notice with current economics", () => {
  const state = advance(baseline(), batch(1), times[1]).state;
  const changed = demoFrame(2); changed.offers[0].buy.unitCents = 1900;
  const result = advance(state, cardBatch(changed, times[2]), times[2]);
  assert.equal(result.created.length, 1);
  assert.equal(Object.values(result.state.outbox).filter(e => e.status === "cancelled").length, 1);
  assert.match(result.state.outbox[result.created[0]].message.text, /CAD 26.53/);
});

test("already-delivered candidates remain quiet during small price changes", async () => {
  let state = advance(baseline(), batch(1), times[1]).state;
  state = await deliver(state, "cards:simulation", async () => {}, times[1]);
  const changed = demoFrame(2); changed.offers[0].buy.unitCents = 1900;
  assert.equal(advance(state, cardBatch(changed, times[2]), times[2]).created.length, 0);
});

test("withdrawal and reappearance create a distinct episode", () => {
  let state = advance(baseline(), batch(1), times[1]).state;
  const id1 = Object.keys(state.outbox)[0];
  state = advance(state, batch(4), times[4]).state;
  const result = advance(state, batch(5), times[5]);
  assert.equal(result.created.length, 1);
  assert.notEqual(result.created[0], id1);
});

test("partial, malformed, stale, out-of-order and duplicate input preserve state", () => {
  const state = baseline(), snapshot = JSON.stringify(state);
  const inputs = [
    { ...batch(1), complete: false }, { ...batch(1), observedAt: "2026-10-20T00:00:00Z" },
    { ...batch(1), records: [...batch(1).records, batch(1).records[0]] },
    { ...batch(1), observedAt: "2026-10-23T11:00:00Z" },
    { ...batch(1), records: [{ ...batch(1).records[0], id: "__proto__" }] },
  ];
  for (const input of inputs) { assert.throws(() => advance(state, input, times[1])); assert.equal(JSON.stringify(state), snapshot); }
});

test("CineWatch native detector/renderer works with shared history and sink; old dates never repeat", () => {
  const cinema = { updatedAt: times[0], theatres: [{ id: 7408, name: "Vaughan", days: [{ date: "2026-11-01", movies: [] }] }] };
  const first = advance(emptyState(), cinemaBatch(cinema), times[0]);
  assert.equal(first.created.length, 0);
  cinema.updatedAt = times[1]; cinema.theatres[0].days.push({ date: "2026-11-02", movies: [] });
  const second = advance(first.state, cinemaBatch(cinema), times[1]);
  assert.equal(second.created.length, 1);
  assert.match(second.state.outbox[second.created[0]].message.html, /2026-11-02/);
  const removed = { updatedAt: times[2], theatres: [] };
  const third = advance(second.state, cinemaBatch(removed), times[2]);
  cinema.updatedAt = times[3];
  assert.equal(advance(third.state, cinemaBatch(cinema), times[3]).created.length, 0);
});

test("source namespaces isolate cinema, simulated cards and real cards", () => {
  const state = baseline();
  const cinema = { updatedAt: times[1], theatres: [] };
  const result = advance(state, cinemaBatch(cinema), times[1]);
  assert.equal(result.baseline, true);
  assert.deepEqual(result.state.sources["cards:simulation"], state.sources["cards:simulation"]);
});

test("file sink is idempotent after crash between write and receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opportunity-sink-"));
  try {
    const event = Object.values(advance(baseline(), batch(1), times[1]).state.outbox)[0];
    await fileSink(directory)(event); await fileSink(directory)(event);
    assert.equal((await readdir(join(directory, "notifications"))).length, 2);
    const eml = await readFile(join(directory, "notifications", `${event.id}.eml`), "utf8");
    assert.match(eml, /SIMULATED QUOTES/); assert.doesNotMatch(eml, /^To:/m);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("workspace refuses production paths, concurrent runs and corrupt state", async () => {
  await assert.rejects(withWorkspace(async () => {}, fileURLToPath(new URL("../../../data/", import.meta.url))), /Workspace must/);
  const path = fileURLToPath(new URL(`../.local/test-${process.pid}`, import.meta.url));
  try {
    await withWorkspace(async () => {
      await assert.rejects(withWorkspace(async () => {}, path), { code: "EEXIST" });
    }, path);
    await writeFile(join(path, "state.json"), "{broken");
    await assert.rejects(withWorkspace(async () => {}, path), SyntaxError);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("Scryfall adapter uses exact printing, required headers and 24-hour cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opportunity-reference-"));
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++; assert.equal(url, "https://api.scryfall.com/cards/cmm/410");
    assert.equal(options.headers.Accept, "application/json"); assert.match(options.headers["User-Agent"], /Opportunity/);
    return { ok: true, json: async () => ({ object: "card", id: "sample-id", set: "cmm", collector_number: "410", lang: "en", prices: { usd: "1.00" } }) };
  };
  try {
    const list = [{ set: "cmm", collectorNumber: "410" }];
    const first = await fetchReferences(list, directory, { fetcher, now: times[0] });
    await fetchReferences(list, directory, { fetcher, now: times[1] });
    assert.equal(calls, 1); assert.equal(first.cards[0].executable, false);
    assert.equal(first.executableOpportunities, 0);
    assert.equal(first.cards[0].priceUpdatedAt, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Scryfall 429 or schema error is not silently converted to empty success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opportunity-error-"));
  const list = [{ set: "cmm", collectorNumber: "410" }];
  try {
    await assert.rejects(fetchReferences(list, directory, { now: times[0], fetcher: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
    await assert.rejects(fetchReferences(list, directory, { now: times[0], fetcher: async () => ({ ok: true, json: async () => ({ object: "error" }) }) }), /mismatch/);
    assert.equal((await readdir(directory)).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("JSON loader does not hide corruption as an empty snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opportunity-json-"));
  try {
    const path = join(directory, "data.json");
    assert.equal(await readJson(path, null), null);
    await writeFile(path, "{");
    await assert.rejects(readJson(path, null), SyntaxError);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
