const DATA_URL = "data/showtimes.json";
const REFRESH_MS = 5 * 60 * 1000;

const theatreTabs = document.querySelector("#theatre-tabs");
const showtimesEl = document.querySelector("#showtimes");
const summaryEl = document.querySelector("#summary");
const updatedEl = document.querySelector("#updated");
const statusEl = document.querySelector("#live-status");
const dialog = document.querySelector("#seat-dialog");
const seatMapEl = document.querySelector("#seat-map");
const seatStatsEl = document.querySelector("#seat-stats");
const seatTitleEl = document.querySelector("#seat-title");
const seatKickerEl = document.querySelector("#seat-kicker");
const buyLinkEl = document.querySelector("#buy-link");

let data = null;
let selectedTheatreId = new URL(location.href).searchParams.get("theatre") || "7408";

function formatDate(dateStr, options) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "America/Toronto", ...options })
    .format(new Date(`${dateStr}T12:00:00-04:00`));
}

function formatTime(time) {
  const [hour, minute] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function relativeUpdated(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function sessionSeatCounts(session) {
  let available = 0;
  let occupied = 0;
  let unknown = 0;
  for (const row of session.seats || []) {
    for (const char of row) {
      if (char === "A") available++;
      else if (char === "O") occupied++;
      else if (char === "?") unknown++;
    }
  }
  return { available, occupied, unknown };
}

function renderTabs() {
  theatreTabs.replaceChildren();
  for (const theatre of data.theatres) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theatre-tab";
    button.classList.toggle("active", String(theatre.id) === selectedTheatreId);
    button.innerHTML = `<strong>${theatre.shortName}</strong><span>${theatre.location}</span>`;
    button.addEventListener("click", () => {
      selectedTheatreId = String(theatre.id);
      const url = new URL(location.href);
      url.searchParams.set("theatre", selectedTheatreId);
      history.replaceState(null, "", url);
      render();
    });
    theatreTabs.append(button);
  }
}

function openSeatMap(theatre, movie, day, session) {
  const layout = theatre.auditoriums?.[session.layoutKey];
  if (!layout || !session.seats) return;

  seatKickerEl.textContent = `${formatDate(day.date, { month: "short", day: "numeric", weekday: "short" })} · ${formatTime(session.time)} · ${theatre.shortName}`;
  seatTitleEl.textContent = movie.title;
  buyLinkEl.href = session.ticketUrl;
  seatMapEl.replaceChildren();

  const counts = sessionSeatCounts(session);
  seatStatsEl.textContent = `${counts.available} 个可选座位 · ${counts.occupied} 个已占座位`;

  session.seats.forEach((row, rowIndex) => {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";
    rowEl.style.setProperty("--columns", layout.totalColumns);

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = layout.rowLabels?.[rowIndex] || "";
    rowEl.append(label);

    const types = layout.seatTypes?.[rowIndex] || "";
    for (let column = 0; column < layout.totalColumns; column++) {
      const status = row[column] || ".";
      const type = types[column] || "S";
      const seat = document.createElement("span");
      const accessible = (type === "W" || type === "C") && status === "A";
      seat.className = `seat ${accessible ? "accessible" : status === "A" ? "available" : status === "O" ? "occupied" : status === "?" ? "unknown" : "none"}`;
      seat.title = `${label.textContent}${column + 1} · ${status === "A" ? "可选" : status === "O" ? "已占" : "未知"}`;
      rowEl.append(seat);
    }
    seatMapEl.append(rowEl);
  });

  dialog.showModal();
}

function render() {
  if (!data) return;
  const theatre = data.theatres.find(item => String(item.id) === selectedTheatreId) || data.theatres[0];
  selectedTheatreId = String(theatre.id);
  renderTabs();
  showtimesEl.replaceChildren();

  const sessionCount = theatre.days.reduce((total, day) =>
    total + day.movies.reduce((sum, movie) => sum + movie.sessions.length, 0), 0);
  summaryEl.innerHTML = `<span><strong>${sessionCount}</strong> 个场次 · <strong>${theatre.days.length}</strong> 个日期</span><span>每 5 分钟检查一次</span>`;

  if (!theatre.days.length) {
    showtimesEl.innerHTML = '<div class="state-card">目前没有发现 IMAX 70mm 场次。系统仍会继续检查。</div>';
    return;
  }

  for (const day of theatre.days) {
    const dayCard = document.createElement("article");
    dayCard.className = "day-card";
    dayCard.innerHTML = `<div class="day-heading"><time datetime="${day.date}">${formatDate(day.date, { month: "short", day: "numeric" })}</time><span>${formatDate(day.date, { weekday: "long" })}</span></div>`;
    const movieList = document.createElement("div");
    movieList.className = "movie-list";

    for (const movie of day.movies) {
      const movieCard = document.createElement("section");
      movieCard.className = "movie-card";
      movieCard.innerHTML = `<div><h2 class="movie-title"></h2><p class="format">IMAX · 70MM</p></div>`;
      movieCard.querySelector("h2").textContent = movie.title;
      const sessions = document.createElement("div");
      sessions.className = "sessions";

      for (const session of movie.sessions) {
        const counts = sessionSeatCounts(session);
        const button = document.createElement("button");
        button.type = "button";
        button.className = `session-button ${session.seats ? "has-seats" : ""}`;
        button.innerHTML = `<strong>${formatTime(session.time)}</strong><span>${session.seats ? `${counts.available} 个可选 · 查看座位` : "座位数据暂不可用"}</span>`;
        if (session.seats) button.addEventListener("click", () => openSeatMap(theatre, movie, day, session));
        else button.addEventListener("click", () => window.open(session.ticketUrl, "_blank", "noopener"));
        sessions.append(button);
      }
      movieCard.append(sessions);
      movieList.append(movieCard);
    }
    dayCard.append(movieList);
    showtimesEl.append(dayCard);
  }
}

async function loadData({ quiet = false } = {}) {
  if (!quiet) {
    statusEl.className = "live-status";
    statusEl.lastElementChild.textContent = "正在读取";
  }
  try {
    const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
    updatedEl.textContent = `数据更新于 ${relativeUpdated(data.updatedAt)} · Toronto 时间`;
    statusEl.className = "live-status ready";
    statusEl.lastElementChild.textContent = "监控中";
    render();
  } catch (error) {
    console.error(error);
    statusEl.className = "live-status error";
    statusEl.lastElementChild.textContent = "数据读取失败";
    if (!data) showtimesEl.innerHTML = '<div class="state-card">暂时无法读取数据，请稍后刷新页面。</div>';
  }
}

document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", event => {
  if (event.target === dialog) dialog.close();
});

loadData();
setInterval(() => loadData({ quiet: true }), REFRESH_MS);
