import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { atomicJson, readJson } from "./storage.mjs";

// Identity/reference evidence only. These daily estimates are NOT executable
// buy prices, buylist bids, inventory or guaranteed sale proceeds.
export async function fetchReferences(watchlist, directory, { fetcher = fetch, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(watchlist) || !watchlist.length || watchlist.length > 20) throw new Error("Watchlist must contain 1–20 exact printings");
  await mkdir(directory, { recursive: true });
  const cards = [];
  let requests = 0;
  for (const card of watchlist) {
    if (!/^[a-z0-9]{2,8}$/.test(card.set) || !/^[a-z0-9-]{1,12}$/.test(card.collectorNumber)) throw new Error("Invalid exact printing");
    const filename = join(directory, `${card.set}-${card.collectorNumber}.json`);
    const cached = await readJson(filename, null);
    const age = Date.parse(now) - Date.parse(cached?.fetchedAt);
    if (cached && age >= 0 && age < 24 * 3_600_000) { cards.push(cached); continue; }
    if (requests) await setTimeout(600); // conservative <2 requests/sec; no search crawl
    const url = `https://api.scryfall.com/cards/${card.set}/${card.collectorNumber}`;
    const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), redirect: "error",
      headers: { "User-Agent": "CineWatch-Opportunity-Experiment/0.1", Accept: "application/json" } });
    requests++;
    // No fallback to stale prices, alternate endpoints or automatic 429 retries.
    if (!response.ok) throw new Error(`Scryfall HTTP ${response.status}; retry on a later run, preserve last good evidence`);
    const body = await response.json();
    if (body.object !== "card" || !body.id || body.set !== card.set || String(body.collector_number) !== card.collectorNumber || body.lang !== "en" || !body.prices) throw new Error("Scryfall schema/printing mismatch");
    const evidence = { fetchedAt: now, source: url, scryfallId: body.id, name: body.name,
      set: body.set, collectorNumber: body.collector_number, language: body.lang, finishes: body.finishes,
      prices: body.prices, priceType: "daily_reference_only", executable: false, priceUpdatedAt: null,
      warning: "Fetch time is not price-update time. Do not use reference prices as cash exit quotes." };
    await atomicJson(filename, evidence);
    cards.push(evidence);
  }
  return { version: 1, fetchedAt: now, requests, cards, executableOpportunities: 0 };
}
