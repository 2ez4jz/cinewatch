import { findNewDates, emailSubject, emailHtml } from "../../../scripts/notify.mjs";
import { digest } from "./core.mjs";

const itemFields = ["scryfallId", "language", "finish", "condition"];
const cents = value => Number.isSafeInteger(value) && value >= 0;
const bps = value => cents(value) && value <= 10_000;
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const proof = value => typeof value === "string" && /^(https:\/\/|manual:|fixture:)/.test(value);
const money = value => `CAD ${(value / 100).toFixed(2)}`;
export const defaultPolicy = { minNetCents: 2000, minRoiBps: 1500, maxCapitalCents: 30_000, maxQuoteAgeHours: 24 };

export function assessOffer(offer, now, simulation = false, policy = defaultPolicy) {
  const reasons = [];
  const buy = offer.buy || {}, sell = offer.sell || {}, costs = offer.costs || {};
  const item = offer.item || {};
  const time = Date.parse(now);
  if (!timestamp(now)) throw new Error("Invalid scan time");
  if (typeof offer.id !== "string" || !offer.id) throw new Error("Offer needs a stable ID");
  if (!cents(policy.minNetCents) || !bps(policy.minRoiBps) || !cents(policy.maxCapitalCents) ||
      !Number.isFinite(policy.maxQuoteAgeHours) || policy.maxQuoteAgeHours <= 0) throw new Error("Invalid policy");
  for (const field of itemFields) {
    if (typeof item[field] !== "string" || !item[field] || buy.item?.[field] !== item[field] || sell.item?.[field] !== item[field]) reasons.push(`item_mismatch:${field}`);
  }
  if (!simulation && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.scryfallId || "")) reasons.push("invalid_card_id");
  if (buy.currency !== "CAD" || sell.currency !== "CAD") reasons.push("currency_mismatch");
  if (!cents(buy.unitCents) || !cents(sell.unitCents) || buy.unitCents === 0 || sell.unitCents === 0) reasons.push("missing_price");
  if (!Number.isSafeInteger(offer.quantity) || offer.quantity < 1 || offer.quantity > 100 ||
      !Number.isSafeInteger(buy.available) || !Number.isSafeInteger(sell.wanted) ||
      buy.available < offer.quantity || sell.wanted < offer.quantity) reasons.push("insufficient_quantity");
  if (buy.stockConfirmed !== true) reasons.push("stock_unconfirmed");
  // A public asking price, market average or store-credit bonus is not a cash exit.
  if (sell.kind !== "confirmed_cash_quote" || sell.confirmed !== true) reasons.push("no_confirmed_cash_exit");
  if (!buy.vendor || !sell.vendor || buy.vendor === sell.vendor) reasons.push("invalid_counterparties");
  if (!proof(buy.evidence) || !proof(sell.evidence)) reasons.push("missing_quote_evidence");
  if (!simulation && [buy.evidence, sell.evidence].some(value => typeof value === "string" && (value.startsWith("fixture:") || /scryfall\.(com|io)/i.test(value)))) reasons.push("reference_is_not_quote_evidence");
  if (!cents(costs.leadHours)) reasons.push("missing_lead_time");
  for (const quote of [buy, sell]) {
    if (!timestamp(quote.observedAt) || !timestamp(quote.validUntil) ||
        time - Date.parse(quote.observedAt) > policy.maxQuoteAgeHours * 3_600_000 ||
        Date.parse(quote.observedAt) > time + 60_000 ||
        Date.parse(quote.validUntil) <= time + (costs.leadHours || 0) * 3_600_000) reasons.push("stale_or_expiring_quote");
  }
  for (const key of ["buyShippingCents", "sellShippingCents", "transportCents", "laborCents", "lossReserveCents", "sellFeeFixedCents"]) {
    if (!cents(costs[key])) reasons.push(`missing_cost:${key}`);
  }
  if (!bps(costs.taxBps) || !bps(costs.sellFeeBps)) reasons.push("missing_tax_or_fee");
  let capitalCents = null, netCents = null, roiBps = null;
  if (!reasons.length) {
    const purchase = buy.unitCents * offer.quantity;
    // taxBps is a user-confirmed effective rate on merchandise + buy shipping.
    const taxedBase = purchase + costs.buyShippingCents;
    const tax = Math.ceil(taxedBase * costs.taxBps / 10_000);
    capitalCents = taxedBase + tax + costs.transportCents;
    const revenue = sell.unitCents * offer.quantity;
    const sellingFees = Math.ceil(revenue * costs.sellFeeBps / 10_000) + costs.sellFeeFixedCents;
    netCents = revenue - capitalCents - sellingFees - costs.sellShippingCents - costs.laborCents - costs.lossReserveCents;
    roiBps = capitalCents ? Math.floor(netCents * 10_000 / capitalCents) : null;
    if (![capitalCents, netCents, roiBps].every(Number.isSafeInteger)) reasons.push("unsafe_amount");
    if (capitalCents > policy.maxCapitalCents) reasons.push("capital_limit");
    if (netCents < policy.minNetCents) reasons.push("net_below_threshold");
    if (roiBps < policy.minRoiBps) reasons.push("roi_below_threshold");
  }
  const eligible = reasons.length === 0;
  // Observation/expiry timestamps are evidence freshness, not price changes.
  const fingerprint = digest([itemFields.map(key => item[key]), offer.quantity,
    buy.vendor, buy.unitCents, sell.vendor, sell.unitCents, costs, eligible]);
  return { id: offer.id, eligible, reasons: [...new Set(reasons)], capitalCents, netCents, roiBps, fingerprint,
    message: {
      subject: `${simulation ? "[SIMULATION] " : ""}Card spread — manual review: ${offer.title || offer.id}`,
      text: `${simulation ? "SIMULATED QUOTES; NOT A REAL DEAL.\n" : "CONDITIONAL QUOTES; VERIFY BEFORE BUYING.\n"}` +
        `${offer.title || offer.id}\nQuantity: ${offer.quantity}\nCapital: ${money(capitalCents || 0)}\n` +
        `Net after entered costs/reserve/labor: ${money(netCents || 0)}\n` +
        `Buy evidence: ${buy.evidence}\nCash exit evidence: ${sell.evidence}\n` +
        `Exit valid until: ${sell.validUntil}\nFinal grading/acceptance remains conditional. No order has been placed.`,
    } };
}

export function cardBatch(input, now, policy = defaultPolicy) {
  if (input.version !== 1 || typeof input.simulation !== "boolean" || !Array.isArray(input.offers)) throw new Error("Invalid quote input");
  return { source: `cards:${input.simulation ? "simulation" : "manual-cad"}`, observedAt: input.observedAt,
    complete: input.complete, simulation: input.simulation, records: input.offers.map(offer => assessOffer(offer, now, input.simulation, policy)) };
}

// Reuse the existing date detector and email renderer without touching their
// production files or notification-state.json. Generic history supplies dedupe.
// Seat refund detection stays exclusively in the existing production workflow.
export function cinemaBatch(data) {
  if (!Array.isArray(data.theatres)) throw new Error("Invalid CineWatch snapshot");
  const dates = findNewDates(data, { seenDates: {} });
  return { source: "cinewatch:dates", observedAt: data.updatedAt, complete: true, simulation: false,
    records: dates.map(({ theatre, day }) => ({
      id: `${theatre.id}:${day.date}`, once: true, eligible: true,
      fingerprint: digest([String(theatre.id), day.date]),
      message: { subject: emailSubject([{ theatre, day }]), html: emailHtml([{ theatre, day }]),
        text: `${theatre.name}: ${day.date}` },
    })) };
}
