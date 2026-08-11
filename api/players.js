// api/players.js — team lists and full rosters from ESPN's free feed (Node
// function; ESPN blocks Vercel's edge egress). Headshots included.
//   /api/players?league=wnba            → [{ id, name, abbr, logo }]
//   /api/players?league=wnba&team=<id>  → { team, players:[{name,pos,jersey,headshot}] }

const LEAGUE_PATH = {
  WNBA: 'basketball/wnba', NBA: 'basketball/nba',
  MLB: 'baseball/mlb', NFL: 'football/nfl', NHL: 'hockey/nhl',
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800'); // teams/rosters change slowly
  const league = String((req.query.league || '')).toUpperCase();
  const team = req.query.team ? String(req.query.team) : null;
  const path = LEAGUE_PATH[league];
  if (!path) return res.status(400).json({ error: 'Unknown league' });

  try {
    // Team roster.
    if (team) {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${encodeURIComponent(team)}/roster`);
      if (!r.ok) return res.status(200).json({ players: [], _status: r.status });
      const j = await r.json();
      const players = [];
      // athletes is either a flat array of players or grouped {position, items:[]}.
      for (const node of (j.athletes || [])) {
        const items = Array.isArray(node.items) ? node.items : [node];
        for (const p of items) {
          if (!p || !(p.fullName || p.displayName)) continue;
          players.push({
            name: p.fullName || p.displayName,
            pos: (p.position && (p.position.abbreviation || p.position.displayName)) || '',
            jersey: p.jersey || '',
            headshot: (p.headshot && p.headshot.href) || '',
            age: p.age || '',
          });
        }
      }
      return res.status(200).json({ team: j.team && j.team.displayName, players });
    }

    // Team list for the league.
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams`);
    if (!r.ok) return res.status(200).json({ teams: [], _status: r.status });
    const j = await r.json();
    const raw = (((j.sports || [])[0] || {}).leagues || [])[0];
    const teams = ((raw && raw.teams) || []).map(t => ({
      id: t.team.id,
      name: t.team.displayName,
      abbr: t.team.abbreviation,
      logo: ((t.team.logos || [])[0] || {}).href || '',
    }));
    return res.status(200).json({ teams });
  } catch (err) {
    return res.status(200).json({ error: String(err), teams: [], players: [] });
  }
}
