// api/broadcasts.js — tonight's TV/streaming networks per game, from ESPN's
// free scoreboard feed (which carries real broadcast data). Cached at the edge
// so it costs nothing per visitor and adds no client-side work beyond one fetch.
// The app matches these to its games by team name and shows "Watch on <network>".

export const config = { runtime: 'edge' };

const SPORTS = [
  { league: 'WNBA', path: 'basketball/wnba' },
  { league: 'MLB', path: 'baseball/mlb' },
];

export default async function handler() {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=1800, stale-while-revalidate=3600' };
  const games = [];

  for (const s of SPORTS) {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${s.path}/scoreboard`);
      if (!r.ok) continue;
      const j = await r.json();
      for (const ev of (j.events || [])) {
        const comp = (ev.competitions || [])[0];
        if (!comp) continue;
        const cs = comp.competitors || [];
        const homeC = cs.find(c => c.homeAway === 'home');
        const awayC = cs.find(c => c.homeAway === 'away');
        const home = homeC && homeC.team && (homeC.team.displayName || homeC.team.name);
        const away = awayC && awayC.team && (awayC.team.displayName || awayC.team.name);
        if (!home || !away) continue;

        // Network can live in a few places depending on the feed — try each.
        let names = [];
        for (const b of (comp.broadcasts || [])) {
          if (Array.isArray(b.names)) names.push(...b.names);
          else if (b.market && b.media && b.media.shortName) names.push(b.media.shortName);
        }
        if (!names.length) {
          for (const g of (comp.geoBroadcasts || [])) {
            const n = g.media && (g.media.shortName || g.media.name);
            if (n) names.push(n);
          }
        }
        const network = [...new Set(names.filter(Boolean))].join(' / ');
        games.push({ league: s.league, home, away, network });
      }
    } catch { /* skip a league that errors */ }
  }

  return new Response(JSON.stringify({ games }), { status: 200, headers });
}
