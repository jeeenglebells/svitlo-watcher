// Сторож графіка відключень (Вінницяобленерго).
// Кожні ~5 хв перевіряє дзеркало графіка і шле пуш у ntfy, якщо графік черги змінився
// або з'явився графік на завтра. Стан зберігається у state.json у цьому ж репозиторії.
import fs from "node:fs"

const QUEUE = process.env.QUEUE || "1.2"
const TOPIC = process.env.NTFY_TOPIC
const DRY = process.env.DRY_RUN === "1"
const MIRROR = "https://raw.githubusercontent.com/vn-progr/gpv-voe-vinnytsia/main/data/Vinnytsiaoblenerho.json"
const OPEN_URL = "https://disconnection.voe.com.ua/"
const STATE_FILE = "state.json"
const TZ = "Europe/Kyiv"

const kyivDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d) // YYYY-MM-DD
const pad = (n) => String(n).padStart(2, "0")
const slotTime = (i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`

// значення години N (N-1:00–N:00) → два півгодинні слоти: 0 світло, 1 немає, 2 можливо
const MAP = { yes: [0, 0], on: [0, 0], no: [1, 1], off: [1, 1], first: [1, 0], second: [0, 1], maybe: [2, 2], mfirst: [2, 0], msecond: [0, 2] }

function slotsFor(hours) {
  const s = []
  for (let h = 1; h <= 24; h++) s.push(...(MAP[String(hours[String(h)] ?? "yes").toLowerCase()] || [0, 0]))
  return s
}

function describe(sig) {
  const s = sig.split("").map(Number), out = []
  for (const st of [1, 2]) {
    let start = null
    for (let i = 0; i <= 48; i++) {
      const v = i < 48 ? s[i] : -1
      if (v === st && start === null) start = i
      if (v !== st && start !== null) { out.push({ a: start, t: `${slotTime(start)}–${i === 48 ? "24:00" : slotTime(i)}${st === 2 ? "?" : ""}` }); start = null }
    }
  }
  out.sort((x, y) => x.a - y.a)
  return out.length ? out.map((x) => x.t).join(", ") : "без відключень"
}

async function push(title, message, tags) {
  if (DRY || !TOPIC) { console.log(`[push] ${title}\n${message}`); return }
  const r = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: TOPIC, title, message, tags, priority: 4, click: OPEN_URL }),
  })
  console.log("ntfy:", r.status)
}

async function main() {
  let json
  try {
    const r = await fetch(MIRROR + "?t=" + Date.now(), { headers: { "Cache-Control": "no-cache" } })
    if (!r.ok) throw new Error("HTTP " + r.status)
    json = await r.json()
  } catch (e) { console.log("Дзеркало недоступне:", e.message); return }

  const now = new Date()
  const today = kyivDate(now)
  const tomorrow = kyivDate(new Date(now.getTime() + 24 * 3600e3))
  const days = {}
  for (const [ts, groups] of Object.entries(json?.fact?.data || {})) {
    const key = kyivDate(new Date(Number(ts) * 1000))
    if ((key === today || key === tomorrow) && groups["GPV" + QUEUE]) days[key] = slotsFor(groups["GPV" + QUEUE]).join("")
  }
  // ще не опублікований графік на завтра дзеркало віддає як «все зі світлом» — не вважаємо його графіком
  if (days[tomorrow] && !/[12]/.test(days[tomorrow])) delete days[tomorrow]
  if (!days[today]) { console.log("Немає графіка на сьогодні для черги", QUEUE); return }

  let prev = null
  try { prev = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) } catch {}
  const state = { queue: QUEUE, days, alive: today }   // alive змінюється раз на добу — щоденний коміт не дає GitHub вимкнути розклад
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n")

  if (!prev || prev.queue !== QUEUE) {
    await push(`✅ Сторож графіка працює · черга ${QUEUE}`,
      `Сьогодні: ${describe(days[today])}` + (days[tomorrow] ? `\nЗавтра: ${describe(days[tomorrow])}` : ""), ["zap"])
    return
  }

  const lines = []
  let changed = false, published = false
  for (const [label, key] of [["Сьогодні", today], ["Завтра", tomorrow]]) {
    if (!days[key]) continue
    const was = prev.days?.[key]
    if (was === undefined) { if (label === "Завтра") published = true; else continue }
    else if (was !== days[key]) changed = true
    else continue
    lines.push(`${label}: ${describe(days[key])}`)
  }
  if (!lines.length) { console.log("Без змін"); return }
  await push(changed ? `⚡ Графік змінився · черга ${QUEUE}` : `⚡ Графік на завтра · черга ${QUEUE}`, lines.join("\n"), ["zap"])
}

main().catch((e) => { console.error(e); process.exitCode = 0 })
