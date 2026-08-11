// api/refresh-standings.js — daily Vercel Cron. Pulls CURRENT WNBA + MLB
// standings from API-Sports (free tier, APISPORTS_KEY), with ESPN's free
// unofficial feed as an automatic fallback, and caches them in Supabase
// (app_cache key='standings'). The app reads /api/standings and falls back to
// its built-in table when the cache is empty. Both sources are server-side, so
// there is no client-facing bloat or load-time cost.

export const config = { maxDuration: 30 };

// Conference/division letter from a group name.
const CONF_WNBA = n => /east/i.test(n) ? 'E' : /west/i.test(n) ? 'W' : '';
const CONF_MLB  = n => /west/i.test(n) ? 'W' : /central/i.test(n) ? 'C' : /east/i.test(n) ? 'E' : '';

// --- API-Sports (primary) --------------------------------------------------
// Look up the league id + current season so we never hardcode a stale season.
async function apiSportsLeague(key, sport, search) {
  const r = await fetch(`https://v1.${sport}.api-sports.io/leagues?search=${encodeURIComponent(search)}`,
    { headers: { 'x-apisports-key': key } });
  const j = await r.json();
  const first = (j.response || [])[0];
  if (!first) return null;
  const id = first.id ?? (first.league && first.league.id);
  const seasons = first.seasons || [];
  const cur = seasons.find(s => s.current) || seasons[seasons.length - 1];
  const season = cur ? (cur.season ?? cur.year) : new Date().getFullYear();
  return { id, season };
}

async function apiSportsStandings(key, sport, search) {
  const lg = await apiSportsLeague(key, sport, search);
  if (!lg || lg.id == null) return [];
  const r = await fetch(`https://v1.${sport}.api-sports.io/standings?league=${lg.id}&season=${lg.season}`,
    { headers: { 'x-apisports-key': key } });
  const j = await r.json();
  // response is either an array of rows or an array of groups (arrays of rows).
  const groups = Array.isArray(j.response) ? j.response : [];
  const out = [];
  for (const g of groups) {
    const rows = Array.isArray(g) ? g : [g];
    for (const t of rows) {
      if (!t || !t.team) continue;
      out.push({
        team: t.team.name,
        group: (t.group && (t.group.name || t.group)) || '',
        w: t.games && t.games.win && t.games.win.total,
        l: t.games && t.games.lose && t.games.lose.total,
      });
    }
  }
  return out;
}

// --- ESPN (fallback) -------------------------------------------------------
async function espnStandings(path) {
  const r = await fetch(`https://site.api.espn.com/apis/v2/sports/${path}/standings?level=3`);
  const j = await r.json();
  const out = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.standings && Array.isArray(node.standings.entries)) {
      const groupName = node.name || '';
      for (const e of node.standings.entries) {
        const stats = e.stats || [];
        const stat = n => { const s = stats.find(x => x.name === n || x.type === n); return s ? Number(s.value) : null; };
        out.push({ team: e.team && (e.team.displayName || e.team.name), group: groupName, w: stat('wins'), l: stat('losses') });
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(j);
  return out;
}

// --- Normalize -------------------------------------------------------------
// Keep only well-formed rows, rank by win pct, and compute games-back so a
// malformed league can't poison the table.
function clean(rows) {
  const out = (rows || [])
    .filter(t => t && t.team && Number.isFinite(Number(t.w)) && Number.isFinite(Number(t.l)))
    .map(t => ({ team: String(t.team), conf: t.conf ? String(t.conf) : '', w: Number(t.w), l: Number(t.l) }))
    .sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.w - a.w);
  if (!out.length) return [];
  const lead = out[0];
  return out.map((t, i) => ({
    rank: i + 1, team: t.team, conf: t.conf, w: t.w, l: t.l,
    gb: i === 0 ? '—' : (((lead.w - t.w) + (t.l - lead.l)) / 2).toFixed(1),
  }));
}

function buildWnba(rows) {
  return clean(rows.map(t => ({ team: t.team, conf: CONF_WNBA(t.group), w: t.w, l: t.l })));
}
function buildMlb(rows) {
  // The app's MLB table shows the National League race — keep NL only.
  const nl = rows.filter(t => /national|(^|[^a-z])nl([^a-z]|$)/i.test(t.group || ''));
  const src = nl.length ? nl : rows; // if the filter matches nothing, don't drop everything
  return clean(src.map(t => ({ team: t.team, conf: CONF_MLB(t.group), w: t.w, l: t.l })));
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.APISPORTS_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const debug = req.query && req.query.debug !== undefined;

  // WNBA: API-Sports basketball → ESPN.
  let wnbaRows = [], wnbaSource = 'none';
  if (apiKey) { try { wnbaRows = await apiSportsStandings(apiKey, 'basketball', 'WNBA'); if (wnbaRows.length) wnbaSource = 'api-sports'; } catch { /* fall through */ } }
  if (!wnbaRows.length) { try { wnbaRows = await espnStandings('basketball/wnba'); if (wnbaRows.length) wnbaSource = 'espn'; } catch { /* give up */ } }

  // MLB: API-Sports baseball → ESPN.
  let mlbRows = [], mlbSource = 'none';
  if (apiKey) { try { mlbRows = await apiSportsStandings(apiKey, 'baseball', 'MLB'); if (mlbRows.length) mlbSource = 'api-sports'; } catch { /* fall through */ } }
  if (!mlbRows.length) { try { mlbRows = await espnStandings('baseball/mlb'); if (mlbRows.length) mlbSource = 'espn'; } catch { /* give up */ } }

  const value = { wnba: buildWnba(wnbaRows), mlb: buildMlb(mlbRows) };

  // ?debug — return what we parsed without writing the cache, so shapes can be
  // verified before going live.
  if (debug) {
    return res.status(200).json({
      ok: true, debug: true, wnbaSource, mlbSource,
      rawWnbaSample: wnbaRows.slice(0, 3), rawMlbSample: mlbRows.slice(0, 3),
      value,
    });
  }

  if (!value.wnba.length && !value.mlb.length) {
    return res.status(200).json({ ok: false, error: 'Both leagues empty after parsing', wnbaSource, mlbSource });
  }

  const up = await fetch(`${supabaseUrl}/rest/v1/app_cache?on_conflict=key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ key: 'standings', value, updated_at: new Date().toISOString() }),
  });
  if (!up.ok) return res.status(500).json({ ok: false, error: await up.text() });

  return res.status(200).json({ ok: true, wnba: value.wnba.length, mlb: value.mlb.length, wnbaSource, mlbSource });
}
