import { readFile, writeFile } from "node:fs/promises";

const DATA_PATH = new URL("../data/showtimes.json", import.meta.url);
const STATE_PATH = new URL("../data/notification-state.json", import.meta.url);
const SITE_URL = "https://2ez4jz.github.io/cinewatch/";

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}

export function collectTheatreDates(data) {
  const dates = {};
  for (const theatre of data.theatres || []) {
    dates[String(theatre.id)] = (theatre.days || []).map(day => day.date);
  }
  return dates;
}

export function mergeSeenDates(state, data) {
  const merged = {};
  const current = collectTheatreDates(data);
  for (const theatreId of new Set([...Object.keys(state?.seenDates || {}), ...Object.keys(current)])) {
    merged[theatreId] = [...new Set([...(state?.seenDates?.[theatreId] || []), ...(current[theatreId] || [])])].sort();
  }
  return merged;
}

export function findNewDates(data, state) {
  const seen = state?.seenDates || {};
  const notifications = [];
  for (const theatre of data.theatres || []) {
    const known = new Set(seen[String(theatre.id)] || []);
    for (const day of theatre.days || []) {
      if (!known.has(day.date)) notifications.push({ theatre, day });
    }
  }
  return notifications;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function telegramMessage({ theatre, day }) {
  const dateLabel = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/Toronto",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${day.date}T12:00:00-04:00`));
  const movies = (day.movies || []).map(movie => {
    const times = (movie.sessions || []).map(session => session.time).join("、");
    return `🎬 <b>${escapeHtml(movie.title)}</b>\n${escapeHtml(times)}`;
  }).join("\n\n");
  return [
    "🎟️ <b>CineWatch 发现新日期</b>",
    "",
    `📍 ${escapeHtml(theatre.shortName || theatre.name)}`,
    `📅 ${escapeHtml(dateLabel)}（${day.date}）`,
    "",
    movies,
    "",
    `<a href="${SITE_URL}">查看座位与购票</a>`,
  ].join("\n");
}

export function telegramBatchMessage(notifications) {
  if (notifications.length === 1) return telegramMessage(notifications[0]);
  const groups = new Map();
  for (const notification of notifications) {
    const key = String(notification.theatre.id);
    if (!groups.has(key)) groups.set(key, { theatre: notification.theatre, days: [] });
    groups.get(key).days.push(notification.day);
  }
  const sections = [...groups.values()].map(({ theatre, days }) => {
    const lines = days.sort((a, b) => a.date.localeCompare(b.date)).map(day => {
      const titles = (day.movies || []).map(movie => escapeHtml(movie.title)).join(" / ");
      return `• <b>${day.date}</b> · ${titles}`;
    });
    return `📍 <b>${escapeHtml(theatre.shortName || theatre.name)}</b>\n${lines.join("\n")}`;
  });
  return [
    `🎟️ <b>CineWatch 发现 ${notifications.length} 个新日期</b>`,
    "",
    ...sections.flatMap((section, index) => index ? ["", section] : [section]),
    "",
    `<a href="${SITE_URL}">查看场次、座位与购票</a>`,
  ].join("\n");
}

async function sendTelegram(notifications, token, chatId) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: telegramBatchMessage(notifications),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
}

async function main() {
  const data = await readJson(DATA_PATH, null);
  if (!data) throw new Error("No showtime data found");
  const state = await readJson(STATE_PATH, null);

  // The committed state is seeded during deployment. This guard prevents a
  // first-time installation from announcing every date already on the site.
  if (!state) {
    await writeFile(STATE_PATH, `${JSON.stringify({ version: 1, seenDates: collectTheatreDates(data) }, null, 2)}\n`);
    console.log("Notification state initialized; no historical dates announced.");
    return;
  }

  const notifications = findNewDates(data, state);
  if (!notifications.length) {
    console.log("No new IMAX 70mm dates.");
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    console.warn(`Found ${notifications.length} new date(s), but Telegram secrets are not configured; will retry next run.`);
    return;
  }

  await sendTelegram(notifications, token, chatId);
  console.log(`Notified ${notifications.length} new theatre-date(s).`);
  await writeFile(STATE_PATH, `${JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    seenDates: mergeSeenDates(state, data),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
