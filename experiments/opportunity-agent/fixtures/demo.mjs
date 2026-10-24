export const times = [0, 1, 2, 3, 4, 5].map(hour => `2026-10-23T${String(12 + hour).padStart(2, "0")}:00:00.000Z`);

export function exampleOffer(now = times[0]) {
  const item = { scryfallId: "SIM-CARD-001", language: "en", finish: "nonfoil", condition: "NM" };
  return { id: "simulation-a", title: "SIMULATION Card A — fictional prices", item, quantity: 1,
    buy: { item: { ...item }, vendor: "SIMULATED seller", currency: "CAD", unitCents: 2000, available: 1,
      stockConfirmed: true, evidence: "fixture:buy-a", observedAt: now, validUntil: "2026-10-25T00:00:00Z" },
    sell: { item: { ...item }, vendor: "SIMULATED cash buyer", currency: "CAD", unitCents: 6000, wanted: 1,
      kind: "confirmed_cash_quote", confirmed: true, evidence: "fixture:cash-a", observedAt: now, validUntil: "2026-10-25T00:00:00Z" },
    costs: { taxBps: 1300, buyShippingCents: 0, sellShippingCents: 0, transportCents: 400,
      laborCents: 500, lossReserveCents: 300, sellFeeBps: 0, sellFeeFixedCents: 0, leadHours: 2 } };
}

export function demoFrame(index) {
  const now = times[index], good = exampleOffer(now);
  if (index === 0) good.buy.unitCents = 5000; // first scan establishes a baseline
  if (index === 4) good.buy.stockConfirmed = false; // opportunity closes
  const credit = exampleOffer(now); credit.id = "simulation-credit"; credit.sell.kind = "store_credit";
  const mismatch = exampleOffer(now); mismatch.id = "simulation-foil"; mismatch.sell.item.finish = "foil";
  const fees = exampleOffer(now); fees.id = "simulation-costs"; fees.costs.buyShippingCents = 2500;
  const stale = exampleOffer(now); stale.id = "simulation-stale"; stale.sell.observedAt = "2026-10-20T00:00:00Z";
  const noDemand = exampleOffer(now); noDemand.id = "simulation-no-demand"; noDemand.sell.wanted = 0;
  const unknown = exampleOffer(now); unknown.id = "simulation-unknown-cost"; delete unknown.costs.transportCents;
  return { version: 1, simulation: true, complete: true, observedAt: now,
    offers: [good, credit, mismatch, fees, stale, noDemand, unknown] };
}
