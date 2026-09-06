// api/refresh-standings.js — daily Vercel Cron. Pulls standings from ESPN's
// free feed for WNBA (single league-wide table) and MLB / NBA / NFL (split by
// conference/league). Caches to Supabase app_cache key='standings'. ESPN is a
// Node fetch (it blocks Vercel's edge egress). Off-season leagues return the
// most recent completed season's final standings.

export const config = { maxDuration: 30 };

const ESPN = { WNBA: 'basketball/wnba', MLB: 'baseball/mlb', NBA: 'basketball/nba', NFL: 'football/nfl', EPL: 'soccer/eng.1' };

function statVal(stats, names) {
  for (const n of names) {
    const s = (stats || []).find(x => x.name === n || x.type === n);
    if (s && s.value != null) return Number(s.value);
  }
  return null;
}

// Recursively collect every team entry under a node, tagged with its division.
function collectEntries(node, arr) {
  if (!node || typeof node !== 'object') return;
  if (node.standings && Array.isArray(node.standings.entries)) {
    for (const e of node.standings.entries) {
      const stats = e.stats || [];
      arr.push({
        team: e.team && (e.team.displayName || e.team.name),
        logo: (e.team && e.team.logos && e.team.logos[0] && e.team.logos[0].href) || '',
        w: statVal(stats, ['wins']),
        l: statVal(stats, ['losses']),
        d: statVal(stats, ['ties']),
        pts: statVal(stats, ['points']),
        played: statVal(stats, ['gamesPlayed']),
        div: node.name || '',
      });
    }
  }
  (node.children || []).forEach(c => collectEntries(c, arr));
}

// Fetch ESPN standings grouped by the top-level conference/league nodes.
async function espnGrouped(path) {
  // ESPN moved standings from site.api.espn.com (now a stub) to site.web.api.
  const r = await fetch(`https://site.web.api.espn.com/apis/v2/sports/${path}/standings`);
  if (!r.ok) return null;
  const j = await r.json();
  const groups = {};
  for (const conf of (j.children || [])) {
    const arr = [];
    collectEntries(conf, arr);
    if (arr.length) groups[conf.name] = arr;
  }
  if (!Object.keys(groups).length) {
    const arr = [];
    collectEntries(j, arr);
    if (arr.length) groups.ALL = arr;
  }
  return groups;
}

// Rank a list by win pct and compute games-back.
function rankRows(rows) {
  const seen = new Set();
  const out = (rows || [])
    .filter(t => {
      if (!t.team || !Number.isFinite(t.w) || !Number.isFinite(t.l)) return false;
      if (seen.has(t.team)) return false; // dedupe (tree can list a team at league + division level)
      seen.add(t.team);
      return true;
    })
    .map(t => ({ team: String(t.team), logo: t.logo || '', w: t.w, l: t.l, conf: t.conf || '' }))
    .sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.w - a.w);
  if (!out.length) return [];
  const lead = out[0];
  return out.map((t, i) => ({
    rank: i + 1, team: t.team, logo: t.logo, conf: t.conf, w: t.w, l: t.l,
    gb: i === 0 ? '—' : (((lead.w - t.w) + (t.l - lead.l)) / 2).toFixed(1),
  }));
}

const divLetter = name => {
  const n = name || '';
  if (/central/i.test(n)) return 'C';
  if (/west/i.test(n)) return 'W';
  if (/east/i.test(n)) return 'E';
  if (/north/i.test(n)) return 'N';
  if (/south/i.test(n)) return 'S';
  return '';
};

const confKey = (sport, name) => {
  const n = (name || '').toLowerCase();
  if (sport === 'MLB') return /american/.test(n) ? 'AL' : /national/.test(n) ? 'NL' : name;
  if (sport === 'NBA') return /east/.test(n) ? 'East' : /west/.test(n) ? 'West' : name;
  if (sport === 'NFL') return /afc|american/.test(n) ? 'AFC' : /nfc|national/.test(n) ? 'NFC' : name;
  return name;
};

// Grouped {ConfLabel: rankedRows} for MLB/NBA/NFL.
async function buildGrouped(sport) {
  const groups = await espnGrouped(ESPN[sport]);
  if (!groups) return null;
  const out = {};
  for (const [confName, rows] of Object.entries(groups)) {
    const key = confKey(sport, confName);
    out[key] = rankRows(rows.map(t => ({ ...t, conf: divLetter(t.div) })));
  }
  return Object.keys(out).length ? out : null;
}

// WNBA seeds league-wide → one flat table, conf letter = E/W.
async function buildWnba() {
  const groups = await espnGrouped(ESPN.WNBA);
  if (!groups) return [];
  const all = [];
  for (const [confName, rows] of Object.entries(groups)) {
    const c = /east/i.test(confName) ? 'E' : /west/i.test(confName) ? 'W' : '';
    for (const t of rows) all.push({ ...t, conf: c });
  }
  return rankRows(all);
}

// Premier League: one table ranked by POINTS (3 for a win, 1 for a draw).
async function buildEpl() {
  const groups = await espnGrouped(ESPN.EPL);
  if (!groups) return [];
  const all = [];
  for (const rows of Object.values(groups)) all.push(...rows);
  const seen = new Set();
  const out = all
    .filter(t => { if (!t.team || seen.has(t.team) || !Number.isFinite(t.pts)) return false; seen.add(t.team); return true; })
    .sort((a, b) => b.pts - a.pts || (b.w - a.w));
  return out.map((t, i) => ({ rank: i + 1, team: t.team, logo: t.logo || '', conf: '', w: t.w, d: t.d, l: t.l, pts: t.pts, played: t.played }));
}

// College sports have ~400 teams across divisions, so a W-L table is useless to
// a casual fan. The AP Top 25 poll IS the standings people actually follow, so
// that's what we cache for college football and women's volleyball.
async function buildRankings(path) {
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/rankings`);
  if (!r.ok) return [];
  const j = await r.json();
  const polls = j.rankings || [];
  // Prefer the AP poll; fall back to whatever poll ESPN lists first.
  const poll = polls.find(p => /AP/i.test(p.shortName || p.name || '')) || polls[0];
  if (!poll) return [];
  return (poll.ranks || []).map(e => {
    const t = e.team || {};
    const logos = t.logos || [];
    const logo = (logos.find(l => (l.rel || []).includes('default')) || logos[0] || {}).href || '';
    return {
      rank: e.current,
      team: [t.location, t.name].filter(Boolean).join(' ') || t.nickname || '',
      abbr: t.abbreviation || '',
      logo,
      record: e.recordSummary || '',
      points: e.points || null,
      trend: e.trend && e.trend !== '-' ? e.trend : '',
      firstPlaceVotes: e.firstPlaceVotes || 0,
      poll: poll.shortName || poll.name || 'Poll',
    };
  }).filter(x => x.rank && x.team);
}

// ATP/WTA world rankings (player-based, not a team poll — but rendered the
// same way as the AP Top 25 in the UI, so shaped to match `buildRankings`'s
// output). Top 25 only; ESPN returns ~150.
async function buildTennisRankings(tour) {
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/rankings`);
  if (!r.ok) return [];
  const j = await r.json();
  const list = (j.rankings && j.rankings[0] && j.rankings[0].ranks) || [];
  return list.slice(0, 25).map(e => {
    const a = e.athlete || {};
    return {
      rank: e.current,
      team: a.displayName || '',                 // "team" so the UI's shared poll renderer just works
      abbr: '',
      logo: a.headshot || '',
      flag: a.flag || '',
      record: '',
      points: e.points || null,
      trend: e.previous && e.current && e.previous !== e.current
        ? (e.previous > e.current ? `+${e.previous - e.current}` : `-${e.current - e.previous}`)
        : '',
      firstPlaceVotes: 0,
      poll: tour.toUpperCase(),
    };
  }).filter(x => x.rank && x.team);
}

// FIBA Women's World Cup: a 2-week group-stage tournament, not a season — ESPN
// has no standings feed for it, so we compute Group A/B/C/D tables ourselves
// from completed match results across the tournament's fixed date window.
// (Group letter only exists as free text in each game's `notes` headline.)
const FIBA_WC_WINDOW = { start: '20260904', end: '20260914' };
async function buildFibaGroups() {
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/fiba/scoreboard?dates=${FIBA_WC_WINDOW.start}-${FIBA_WC_WINDOW.end}&limit=200`);
  if (!r.ok) return {};
  const j = await r.json();
  const table = {}; // group letter -> { teamName -> row }
  for (const ev of (j.events || [])) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const note = ((comp.notes || [])[0] || {}).headline || '';
    const m = note.match(/Group ([A-Z])/);
    if (!m) continue;
    const grp = m[1];
    const cs = comp.competitors || [];
    if (cs.length < 2) continue;
    table[grp] = table[grp] || {};
    const final = comp.status && comp.status.type && comp.status.type.completed;
    for (const c of cs) {
      const name = c.team && (c.team.displayName || c.team.name);
      if (!name) continue;
      const logo = (c.team.logos && c.team.logos[0] && c.team.logos[0].href) || '';
      const row = table[grp][name] || { team: name, logo, w: 0, l: 0, pf: 0, pa: 0, played: 0 };
      row.logo = row.logo || logo;
      if (final) {
        const own = Number(c.score) || 0;
        const opp = Number((cs.find(x => x !== c) || {}).score) || 0;
        row.played += 1;
        row.pf += own; row.pa += opp;
        if (c.winner) row.w += 1; else row.l += 1;
      }
      table[grp][name] = row;
    }
  }
  const out = {};
  for (const [grp, teams] of Object.entries(table)) {
    out[grp] = Object.values(teams)
      .sort((a, b) => b.w - a.w || (b.pf - b.pa) - (a.pf - a.pa))
      .map((t, i) => ({ rank: i + 1, team: t.team, logo: t.logo, w: t.w, l: t.l, diff: t.pf - t.pa, played: t.played }));
  }
  return out;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Missing Supabase env vars' });

  const debug = req.query && req.query.debug !== undefined;

  const value = {};
  const counts = {};
  const tryBuild = async (key, fn) => { try { value[key] = await fn(); } catch (e) { value[key] = key === 'wnba' ? [] : null; counts[key + '_err'] = String(e).slice(0, 80); } };

  await tryBuild('wnba', buildWnba);
  await tryBuild('mlb', () => buildGrouped('MLB'));
  await tryBuild('nba', () => buildGrouped('NBA'));
  await tryBuild('nfl', () => buildGrouped('NFL'));
  await tryBuild('epl', buildEpl);
  await tryBuild('cfb', () => buildRankings('football/college-football'));
  await tryBuild('wvb', () => buildRankings('volleyball/womens-college-volleyball'));
  await tryBuild('atp', () => buildTennisRankings('atp'));
  await tryBuild('wta', () => buildTennisRankings('wta'));
  await tryBuild('fiba', buildFibaGroups);

  counts.wnba = (value.wnba || []).length;
  counts.epl = (value.epl || []).length;
  counts.cfb = (value.cfb || []).length;
  counts.wvb = (value.wvb || []).length;
  counts.atp = (value.atp || []).length;
  counts.wta = (value.wta || []).length;
  counts.fiba = value.fiba ? Object.fromEntries(Object.entries(value.fiba).map(([g, r]) => [g, r.length])) : null;
  for (const k of ['mlb', 'nba', 'nfl']) counts[k] = value[k] ? Object.fromEntries(Object.entries(value[k]).map(([c, r]) => [c, r.length])) : null;

  if (debug) return res.status(200).json({ ok: true, debug: true, counts, value });

  const anything = (value.wnba || []).length || value.mlb || value.nba || value.nfl
    || (value.epl || []).length || (value.cfb || []).length || (value.wvb || []).length
    || (value.atp || []).length || (value.wta || []).length || (value.fiba && Object.keys(value.fiba).length);
  if (!anything) return res.status(200).json({ ok: false, error: 'No standings parsed', counts });

  const up = await fetch(`${supabaseUrl}/rest/v1/app_cache?on_conflict=key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ key: 'standings', value, updated_at: new Date().toISOString() }),
  });
  if (!up.ok) return res.status(500).json({ ok: false, error: await up.text() });

  return res.status(200).json({ ok: true, counts });
}
