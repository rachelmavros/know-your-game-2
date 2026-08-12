// api/scores.js — games + live scores + status from ESPN's free scoreboard, for
// any league over a date range. Node function (ESPN blocks Vercel's edge egress).
// Powers Premier League fixtures on Today/Calendar and live scores everywhere.
//   /api/scores?league=EPL&start=2026-08-22&end=2026-09-15

const LEAGUE_PATH = { WNBA: 'basketball/wnba', MLB: 'baseball/mlb', NBA: 'basketball/nba', NFL: 'football/nfl', NHL: 'hockey/nhl', EPL: 'soccer/eng.1' };

function ctParts(iso) {
  try {
    const d = new Date(iso);
    const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true }).format(d) + ' CT';
    return { dateKey, time };
  } catch { return { dateKey: '', time: '' }; }
}

export default async function handler(req, res) {
  // Scores change fast — short CDN cache.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  const league = String(req.query.league || '').toUpperCase();
  const path = LEAGUE_PATH[league];
  if (!path) return res.status(400).json({ games: [] });

  const start = String(req.query.start || '').replace(/-/g, '');
  const end = String(req.query.end || '').replace(/-/g, '');
  const dates = start ? (end && end !== start ? `${start}-${end}` : start) : '';

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard${dates ? `?dates=${dates}&limit=400` : ''}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(200).json({ games: [], _status: r.status });
    const j = await r.json();
    const games = [];
    for (const ev of (j.events || [])) {
      const comp = (ev.competitions || [])[0];
      if (!comp) continue;
      const cs = comp.competitors || [];
      const H = cs.find(c => c.homeAway === 'home');
      const A = cs.find(c => c.homeAway === 'away');
      if (!H || !A) continue;
      const nm = c => c.team && (c.team.displayName || c.team.name);
      const ab = c => (c.team && c.team.abbreviation) || '';
      const st = (ev.status && ev.status.type) || {};
      const { dateKey, time } = ctParts(ev.date || comp.date || '');
      if (!dateKey) continue;
      let network = '';
      for (const b of (comp.broadcasts || [])) { if (Array.isArray(b.names) && b.names[0]) { network = b.names[0]; break; } }
      games.push({
        league, home: nm(H), away: nm(A), homeAbbr: ab(H), awayAbbr: ab(A),
        dateKey, time,
        state: st.state || 'pre',              // pre | in | post
        detail: st.shortDetail || '',          // "Scheduled" | "Final" | "45'" | "Top 5th"
        homeScore: H.score != null && H.score !== '' ? Number(H.score) : null,
        awayScore: A.score != null && A.score !== '' ? Number(A.score) : null,
        network,
      });
    }
    return res.status(200).json({ games });
  } catch (err) {
    return res.status(200).json({ games: [], error: String(err) });
  }
}
