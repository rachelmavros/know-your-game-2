// api/scores.js — games + live scores + status from ESPN's free scoreboard, for
// any league over a date range. Node function (ESPN blocks Vercel's edge egress).
// Powers Premier League + college fixtures on Today/Calendar and live scores everywhere.
//   /api/scores?league=EPL&start=2026-08-22&end=2026-09-15

import { scoreCompetition, isNationalTv, scoreTennisMatch } from './_verdict.js';

const LEAGUE_PATH = {
  WNBA: 'basketball/wnba', MLB: 'baseball/mlb', NBA: 'basketball/nba',
  NFL: 'football/nfl', NHL: 'hockey/nhl', EPL: 'soccer/eng.1',
  CFB: 'football/college-football',
  WVB: 'volleyball/womens-college-volleyball',
  FIBA: 'basketball/fiba', // ESPN's slug for the FIBA Women's World Cup
};

function ctParts(iso) {
  try {
    const d = new Date(iso);
    const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true }).format(d) + ' CT';
    return { dateKey, time };
  } catch { return { dateKey: '', time: '' }; }
}

// The US Open is nothing like a team scoreboard: ESPN returns ONE tournament
// "event" per tour (ATP/WTA) containing `groupings[]` — singles, doubles,
// mixed doubles — each holding every match across the whole two-week draw in
// one response (no date-range query support). We only want singles main-draw
// matches: qualifying rounds and doubles are noise a casual fan didn't ask for.
async function fetchUsOpen(startKey, endKey) {
  const games = [];
  for (const [tour, path] of [['ATP', 'tennis/atp'], ['WTA', 'tennis/wta']]) {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
      if (!r.ok) continue;
      const j = await r.json();
      for (const ev of (j.events || [])) {
        if (!/us open/i.test(ev.name || '')) continue;
        const singles = (ev.groupings || []).find(g => g.grouping && g.grouping.slug === (tour === 'ATP' ? 'mens-singles' : 'womens-singles'));
        for (const comp of ((singles && singles.competitions) || [])) {
          const roundName = comp.round && comp.round.displayName;
          if (!roundName || /Qualifying/.test(roundName)) continue;   // main draw only
          const cs = comp.competitors || [];
          const H = cs.find(c => c.homeAway === 'home') || cs[0];
          const A = cs.find(c => c.homeAway === 'away') || cs[1];
          if (!H || !A || !H.athlete || !A.athlete) continue;
          const { dateKey, time } = ctParts(comp.date || ev.date || '');
          if (!dateKey || dateKey < startKey || dateKey > endKey) continue;
          let network = '';
          for (const b of (comp.broadcasts || [])) { if (Array.isArray(b.names) && b.names[0]) { network = b.names[0]; break; } }
          const st = (comp.status && comp.status.type) || {};
          const maxSets = comp.format && comp.format.regulation && comp.format.regulation.periods;
          const { verdict, reasons } = scoreTennisMatch(roundName, network, cs, maxSets);
          // notes[0].text is ESPN's own human summary ("X bt Y 7-6 6-3") — far
          // better than us reconstructing a set score from linescores.
          const resultText = (comp.notes && comp.notes[0] && comp.notes[0].text) || '';
          games.push({
            league: 'USO', home: H.athlete.displayName, away: A.athlete.displayName,
            homeAbbr: H.athlete.shortName || '', awayAbbr: A.athlete.shortName || '',
            dateKey, time,
            state: st.state || 'pre', detail: (roundName || '') + (st.shortDetail ? ` · ${st.shortDetail}` : ''),
            homeScore: null, awayScore: null,
            network, isNationalTv: isNationalTv(network),
            verdict, verdictWhy: reasons,
            homeRank: null, awayRank: null, homeRecord: '', awayRecord: '',
            resultText, tour, round: roundName,
          });
        }
      }
    } catch { /* skip a tour that errors, keep the other */ }
  }
  return games;
}

export default async function handler(req, res) {
  // Scores change fast — short CDN cache.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  const league = String(req.query.league || '').toUpperCase();

  const start0 = String(req.query.start || '');
  const end0 = String(req.query.end || '') || start0;
  if (league === 'USO') {
    try {
      const games = await fetchUsOpen(start0, end0);
      return res.status(200).json({ games });
    } catch (err) {
      return res.status(200).json({ games: [], error: String(err) });
    }
  }

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
      // Rate the game from records / AP rank / spread / TV / stakes so the whole
      // slate gets a real verdict instead of a flat "good game" default.
      // Never let a rating failure cost us the game itself: ESPN's shapes vary
      // by league and a single bad record would otherwise blank the whole slate.
      let verdict = 3, reasons = [];
      try {
        const scored = scoreCompetition(comp, ev, network, path);
        verdict = scored.verdict;
        reasons = scored.reasons;
      } catch { /* fall back to a neutral verdict for this one game */ }
      const rankOf = c => {
        const r = c.curatedRank && c.curatedRank.current;
        return (typeof r === 'number' && r > 0 && r < 99) ? r : null;
      };
      const recOf = c => {
        const rs = c.records || [];
        const t = rs.find(x => x.type === 'total') || rs[0];
        return (t && t.summary) || '';
      };
      games.push({
        league, home: nm(H), away: nm(A), homeAbbr: ab(H), awayAbbr: ab(A),
        dateKey, time,
        state: st.state || 'pre',              // pre | in | post
        detail: st.shortDetail || '',          // "Scheduled" | "Final" | "45'" | "Top 5th"
        homeScore: H.score != null && H.score !== '' ? Number(H.score) : null,
        awayScore: A.score != null && A.score !== '' ? Number(A.score) : null,
        network, isNationalTv: isNationalTv(network),
        verdict, verdictWhy: reasons,
        homeRank: rankOf(H), awayRank: rankOf(A),
        homeRecord: recOf(H), awayRecord: recOf(A),
      });
    }
    return res.status(200).json({ games });
  } catch (err) {
    return res.status(200).json({ games: [], error: String(err) });
  }
}
