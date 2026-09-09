import { readFile, mkdir, writeFile } from "node:fs/promises";

const API_BASE = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1";
const TICKETING_BASE = "https://apis.cineplex.com/prod/ticketing/api/v1";
const OUTPUT_PATH = new URL("../data/showtimes.json", import.meta.url);
const MODE = process.env.SCRAPE_MODE === "deep" ? "deep" : "quick";
const NEAR_DAYS = 14;
const DEEP_DAYS = 180;
const CONCURRENCY = 10;
const REQUEST_TIMEOUT_MS = 18_000;

export const THEATRES = [
  { id: 7408, slug: "vaughan", name: "Cineplex Cinemas Vaughan", shortName: "Vaughan", location: "Highway 7 & Highway 400" },
  { id: 7420, slug: "mississauga", name: "Cineplex Cinemas Mississauga", shortName: "Mississauga", location: "Square One" },
];

function timeoutSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function discoverSubscriptionKey() {
  console.log("Discovering Cineplex frontend API key…");
  const home = await fetch("https://www.cineplex.com/", { signal: timeoutSignal() });
  if (!home.ok) throw new Error(`Could not load Cineplex.com: HTTP ${home.status}`);
  const html = await home.text();
  const chunks = [...new Set([...html.matchAll(/["'(]([^"'()]*_next\/static\/[^"'()]*?\.js)/g)].map(match => match[1]))];
  const keyPattern = /Ocp-Apim-Subscription-Key"?\s*:\s*"([0-9a-f]{32})"/i;
  for (const chunk of chunks.slice(0, 40)) {
    try {
      const response = await fetch(new URL(chunk, "https://www.cineplex.com/"), { signal: timeoutSignal() });
      if (!response.ok) continue;
      const source = await response.text();
      const match = source.match(keyPattern);
      if (match) return match[1];
    } catch (error) {
      console.warn(`Skipping frontend chunk: ${error.message}`);
    }
  }
  throw new Error("Could not discover the Cineplex API key. Add CINEPLEX_SUBSCRIPTION_KEY as a repository secret.");
}

async function getSubscriptionKey() {
  return process.env.CINEPLEX_SUBSCRIPTION_KEY?.trim() || discoverSubscriptionKey();
}

function apiHeaders(key) {
  return { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" };
}

function torontoToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
}

function dateRange(days) {
  const start = new Date(`${torontoToday()}T12:00:00Z`);
  return Array.from({ length: days }, (_, offset) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
}

export function isImax70mm(tags = []) {
  const normalized = new Set(tags.map(tag => String(tag).toLowerCase().replace(/[^a-z0-9]/g, "")));
  return normalized.has("imax") && normalized.has("70mm");
}

function ticketUrl(theatreId, showtimeId, fallback) {
  if (fallback) return fallback;
  const params = new URLSearchParams({ theatreId: String(theatreId), showtimeId: String(showtimeId), dbox: "false" });
  return `https://www.cineplex.com/ticketing/preview?${params}`;
}

export function extractMovies(payload, theatreId, dateStr) {
  const entries = Array.isArray(payload) ? payload : [payload];
  const theatre = entries.find(item => String(item?.theatreId) === String(theatreId)) || entries[0];
  const dates = theatre?.dates || [];
  const date = dates.find(item => String(item?.startDate || "").slice(0, 10) === dateStr) || (dates.length === 1 ? dates[0] : null);
  if (!date) return [];

  const movies = [];
  for (const movie of date.movies || []) {
    const sessions = [];
    for (const experience of movie.experiences || []) {
      const formats = (experience.experienceTypes || []).map(String);
      if (!isImax70mm(formats)) continue;
      for (const session of experience.sessions || []) {
        const showtimeId = session.vistaSessionId;
        const start = String(session.showStartDateTime || "");
        if (!showtimeId || !start || session.isInThePast || session.isShowtimeEnabledOnline === false) continue;
        sessions.push({
          id: String(showtimeId),
          time: start.slice(11, 16),
          formats,
          ticketUrl: ticketUrl(theatreId, showtimeId, session.deeplinkUrl || session.ticketingUrl),
          seatEligible: Boolean(session.isReservedSeating && !session.isSoldOut),
        });
      }
    }
    if (sessions.length) {
      sessions.sort((a, b) => a.time.localeCompare(b.time));
      movies.push({ title: movie.name || "Untitled", runtimeMinutes: movie.runtimeInMinutes || null, sessions });
    }
  }
  return movies;
}

async function fetchJson(url, key) {
  const response = await fetch(url, { headers: apiHeaders(key), signal: timeoutSignal() });
  if (!response.ok) throw new Error(`HTTP ${response.status} · ${url.pathname}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchDate(theatre, dateStr, key) {
  const url = new URL(`${API_BASE}/showtimes`);
  url.search = new URLSearchParams({ language: "en", locationId: theatre.id, date: dateStr });
  try {
    const payload = await fetchJson(url, key);
    return { ok: true, date: dateStr, movies: payload ? extractMovies(payload, theatre.id, dateStr) : [] };
  } catch (error) {
    console.warn(`${theatre.shortName} ${dateStr}: ${error.message}`);
    return { ok: false, date: dateStr, movies: [] };
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function mergeDboxRows(layout) {
  const dbox = layout.dboxSeats;
  const columnWidth = dbox?.columnCount ? dbox.areaWidth / dbox.columnCount : 0;
  const dboxRows = new Map((dbox?.rows || []).map((row, index) => [dbox.top + index, row]));
  return (layout.standardSeats?.rows || []).map(row => {
    const seats = (row.seats || []).map(seat => ({ ...seat, isDbox: false }));
    for (const seat of dboxRows.get(row.number)?.seats || []) {
      seats.push({ ...seat, column: Math.round(dbox.left + seat.column * columnWidth), isDbox: true });
    }
    return { ...row, seats };
  });
}

function seatType(seat) {
  if (seat.type === "Wheelchair") return "W";
  if (seat.type === "Companion") return "C";
  if (seat.isDbox) return "D";
  return "S";
}

export function compactLayout(layout) {
  const rows = mergeDboxRows(layout);
  return {
    totalRows: rows.length,
    totalColumns: layout.totalColumns,
    rowLabels: rows.map(row => row.label),
    seatTypes: rows.map(row => {
      const byColumn = new Map(row.seats.map(seat => [seat.column, seat]));
      return Array.from({ length: layout.totalColumns }, (_, column) => byColumn.has(column) ? seatType(byColumn.get(column)) : ".").join("");
    }),
  };
}

export function compactAvailability(layout, availability) {
  return mergeDboxRows(layout).map(row => {
    const byColumn = new Map(row.seats.map(seat => [seat.column, seat]));
    return Array.from({ length: layout.totalColumns }, (_, column) => {
      const seat = byColumn.get(column);
      if (!seat) return ".";
      const status = availability[seat.id];
      return status === "Available" ? "A" : status === "Occupied" ? "O" : "?";
    }).join("");
  });
}

async function attachSeats(theatre, days, key) {
  const auditoriums = {};
  const sessions = days.flatMap(day => day.movies.flatMap(movie => movie.sessions)).filter(session => session.seatEligible);
  await mapLimit(sessions, CONCURRENCY, async session => {
    try {
      const layoutUrl = new URL(`${TICKETING_BASE}/theatre/${theatre.id}/showtime/${session.id}/seat-layout`);
      const availabilityUrl = new URL(`${TICKETING_BASE}/theatre/${theatre.id}/showtime/${session.id}/seat-availability`);
      const [layout, availability] = await Promise.all([fetchJson(layoutUrl, key), fetchJson(availabilityUrl, key)]);
      session.layoutKey = session.id;
      session.seats = compactAvailability(layout, availability?.seatAvailabilities || {});
      auditoriums[session.layoutKey] = compactLayout(layout);
    } catch (error) {
      console.warn(`Seat map ${theatre.shortName} ${session.id}: ${error.message}`);
    }
    delete session.seatEligible;
  });
  return auditoriums;
}

async function loadExisting() {
  try { return JSON.parse(await readFile(OUTPUT_PATH, "utf8")); }
  catch { return { theatres: [] }; }
}

function datesToScan(existingTheatre) {
  const near = dateRange(NEAR_DAYS);
  if (MODE === "deep") return dateRange(DEEP_DAYS);
  const knownFuture = (existingTheatre?.days || []).map(day => day.date).filter(date => date > near.at(-1));
  return [...new Set([...near, ...knownFuture])].sort();
}

async function scrapeTheatre(theatre, existingTheatre, key) {
  const dates = datesToScan(existingTheatre);
  console.log(`${theatre.shortName}: ${dates.length} dates (${MODE})`);
  const results = await mapLimit(dates, CONCURRENCY, date => fetchDate(theatre, date, key));
  if (!results.some(result => result.ok)) {
    if (existingTheatre) {
      console.warn(`${theatre.shortName}: all requests failed; keeping last good data`);
      return existingTheatre;
    }
    throw new Error(`${theatre.shortName}: every date request failed`);
  }
  const days = results.filter(result => result.ok && result.movies.length).map(({ date, movies }) => ({ date, movies }));
  const auditoriums = await attachSeats(theatre, days, key);
  return { ...theatre, auditoriums, days };
}

async function main() {
  const key = await getSubscriptionKey();
  const existing = await loadExisting();
  const theatres = [];
  for (const theatre of THEATRES) {
    const old = existing.theatres?.find(item => String(item.id) === String(theatre.id));
    theatres.push(await scrapeTheatre(theatre, old, key));
  }
  const output = { version: 2, updatedAt: new Date().toISOString(), mode: MODE, theatres };
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Updated ${theatres.reduce((sum, theatre) => sum + theatre.days.length, 0)} theatre-days`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
