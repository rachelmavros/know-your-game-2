// /api/schedule — proxies BallDontLie schedule/games data.
//
// BallDontLie's free tier is ONE SPORT PER KEY, so each sport has its own
// free account + API key, stored as a separate Vercel env var:
//   BDL_WNBA_KEY   → WNBA   (api.balldontlie.io/wnba/v1/games)
//   BDL_MLB_KEY    → MLB    (api.balldontlie.io/mlb/v1/games)
//   BDL_FIFA_KEY   → World Cup (api.balldontlie.io/fifa/v1/games)
//
// Frontend calls: /api/schedule?sport=wnba&start_date=2026-06-21&end_date=2026-06-28
//
// The Games endpoint is on the FREE tier for every sport. Standings,
// injuries, and stats are NOT free, so we don't touch those here.

// dateStyle:
//   "range" → uses start_date / end_date (older WNBA-style API)
//   "dates" → uses repeated dates[]=YYYY-MM-DD (newer MLB / FIFA-style API,
//             which ignores start_date/end_date entirely)
const SPORTS = {
  wnba: { base: "https://api.balldontlie.io/wnba/v1/games", keyVar: "BDL_WNBA_KEY", dateStyle: "range" },
  mlb:  { base: "https://api.balldontlie.io/mlb/v1/games",  keyVar: "BDL_MLB_KEY",  dateStyle: "dates" },
  worldcup: { base: "https://api.balldontlie.io/fifa/worldcup/v1/matches", keyVar: "BDL_FIFA_KEY", dateStyle: "dates" },
};

// Expand an inclusive YYYY-MM-DD range into individual date strings.
function expandDates(start, end) {
  const out = [];
  if (!start) return out;
  const s = new Date(start + "T00:00:00Z");
  const e = end ? new Date(end + "T00:00:00Z") : s;
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export default async function handler(req, res) {
  // Basic CORS / cache headers. Cache for 10 min at the edge so we stay
  // well under the 5-req/min free-tier limit even with many visitors.
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");

  const { sport, start_date, end_date } = req.query;

  const cfg = SPORTS[(sport || "").toLowerCase()];
  if (!cfg) {
    return res.status(400).json({ error: "Unknown sport. Use wnba, mlb, or worldcup." });
  }

  const apiKey = process.env[cfg.keyVar];
  if (!apiKey) {
    return res.status(200).json({ data: [], _note: `Missing ${cfg.keyVar} env var — add it in Vercel settings.` });
  }

  // Build the upstream URL (with cursor pagination support)
  const buildUrl = cursor => {
    const params = new URLSearchParams();
    if (cfg.dateStyle === "dates") {
      for (const d of expandDates(start_date, end_date)) params.append("dates[]", d);
    } else {
      if (start_date) params.set("start_date", start_date);
      if (end_date) params.set("end_date", end_date);
    }
    params.set("per_page", "100");
    if (cursor != null) params.set("cursor", String(cursor));
    return `${cfg.base}?${params.toString()}`;
  };

  try {
    // Follow next_cursor up to a few pages so we get the full window, not just
    // the first 100 games (MLB plays ~15/day, so one page isn't enough).
    // Capped at 4 pages (400 games) to respect the 5-req/min free-tier limit.
    const all = [];
    let cursor = null;
    let upstreamStatus = null;
    for (let page = 0; page < 4; page++) {
      const r = await fetch(buildUrl(cursor), { headers: { Authorization: apiKey } });
      if (!r.ok) {
        upstreamStatus = r.status;
        break;
      }
      const json = await r.json();
      if (Array.isArray(json.data)) all.push(...json.data);
      const next = json.meta && json.meta.next_cursor;
      if (!next) break;
      cursor = next;
    }

    if (all.length === 0 && upstreamStatus) {
      // 401 = key/tier problem, 429 = rate limited. Return empty so the app
      // gracefully falls back to its built-in schedule instead of crashing.
      return res.status(200).json({ data: [], _upstreamStatus: upstreamStatus });
    }
    return res.status(200).json({ data: all });
  } catch (err) {
    return res.status(200).json({ data: [], _error: String(err) });
  }
}
