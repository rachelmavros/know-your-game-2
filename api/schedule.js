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

const SPORTS = {
  wnba: { base: "https://api.balldontlie.io/wnba/v1/games", keyVar: "BDL_WNBA_KEY" },
  mlb:  { base: "https://api.balldontlie.io/mlb/v1/games",  keyVar: "BDL_MLB_KEY"  },
  // World Cup matches require the paid GOAT tier ($39.99/mo), so this is not
  // fetched by the app today — World Cup games are hand-curated. URL kept
  // correct here in case of a future upgrade. Note: path is /fifa/worldcup/.
  worldcup: { base: "https://api.balldontlie.io/fifa/worldcup/v1/matches", keyVar: "BDL_FIFA_KEY" },
};

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

  // Build the upstream URL
  const params = new URLSearchParams();
  if (start_date) params.set("start_date", start_date);
  if (end_date) params.set("end_date", end_date);
  params.set("per_page", "100");
  const url = `${cfg.base}?${params.toString()}`;

  try {
    const r = await fetch(url, { headers: { Authorization: apiKey } });
    if (!r.ok) {
      // 401 = key/tier problem, 429 = rate limited. Return empty so the app
      // gracefully falls back to its built-in schedule instead of crashing.
      return res.status(200).json({ data: [], _upstreamStatus: r.status });
    }
    const json = await r.json();
    return res.status(200).json(json);
  } catch (err) {
    return res.status(200).json({ data: [], _error: String(err) });
  }
}
