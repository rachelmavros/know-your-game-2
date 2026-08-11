// api/broadcasts.js — tonight's TV/streaming networks per game, from ESPN's
// free scoreboard feed (which carries real broadcast data). Node function (not
// edge) because ESPN serves data to Vercel's Node egress but not its edge egress
// — same reason the standings ESPN calls work. Cached at the CDN via headers.
// The app matches these to its games by team name → "Watch on <network>".

const SPORTS = [
  { league: 'WNBA', path: 'basketball/wnba' },
  { league: 'MLB', path: 'baseball/mlb' },
];

// Recognizable national TV networks + league streaming, in priority order. We
// return the single best one so the app can show a clean "Watch on <network>"
// and link it to a real watch page (regional/local channels are too noisy).
const PRIORITY = [
  'ESPN2', 'ESPN+', 'ESPNU', 'ESPN', 'ABC', 'FS1', 'FS2', 'FOX', 'TNT', 'TBS', 'truTV',
  'Peacock', 'NBC', 'USA', 'CBS', 'Paramount+', 'Prime Video', 'Amazon', 'Apple TV+',
  'ION', 'NBA TV', 'MLB Network', 'MLBN', 'CW',
  'MLB.TV', 'League Pass',
];

function bestNetwork(comp) {
  const names = [];
  for (const b of (comp.broadcasts || [])) {
    if (Array.isArray(b.names)) names.push(...b.names);
    else if (b.media && b.media.shortName) names.push(b.media.shortName);
  }
  for (const g of (comp.geoBroadcasts || [])) {
    const n = g.media && (g.media.shortName || g.media.name);
    if (n) names.push(n);
  }
  const uniq = [...new Set(names.filter(Boolean))];
  const norm = s => s.toLowerCase();
  // Prefer a recognizable national/streaming network.
  for (const p of PRIORITY) {
    if (uniq.some(n => norm(n).includes(norm(p)))) return p;
  }
  // Otherwise the first regional network (better than nothing).
  return uniq[0] || '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  const debug = req.query && req.query.debug !== undefined;
  const games = [];
  const status = {};

  for (const s of SPORTS) {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${s.path}/scoreboard`);
      status[s.league] = r.status;
      if (!r.ok) continue;
      const j = await r.json();
      status[s.league] = `ok:${(j.events || []).length} events`;
      for (const ev of (j.events || [])) {
        const comp = (ev.competitions || [])[0];
        if (!comp) continue;
        const cs = comp.competitors || [];
        const homeC = cs.find(c => c.homeAway === 'home');
        const awayC = cs.find(c => c.homeAway === 'away');
        const home = homeC && homeC.team && (homeC.team.displayName || homeC.team.name);
        const away = awayC && awayC.team && (awayC.team.displayName || awayC.team.name);
        if (!home || !away) continue;
        games.push({ league: s.league, home, away, network: bestNetwork(comp) });
      }
    } catch (err) {
      status[s.league] = 'error:' + String(err).slice(0, 80);
    }
  }

  return res.status(200).json(debug ? { games, status } : { games });
}
