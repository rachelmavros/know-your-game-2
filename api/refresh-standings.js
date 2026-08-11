// api/refresh-standings.js — daily Vercel Cron. Pulls standings from ESPN's
// free feed for WNBA (single league-wide table) and MLB / NBA / NFL (split by
// conference/league). Caches to Supabase app_cache key='standings'. ESPN is a
// Node fetch (it blocks Vercel's edge egress). Off-season leagues return the
// most recent completed season's final standings.

export const config = { maxDuration: 30 };

const ESPN = { WNBA: 'basketball/wnba', MLB: 'baseball/mlb', NBA: 'basketball/nba', NFL: 'football/nfl' };

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
        w: statVal(stats, ['wins']),
        l: statVal(stats, ['losses']),
        div: node.name || '',
      });
    }
  }
  (node.children || []).forEach(c => collectEntries(c, arr));
}

// Fetch ESPN standings grouped by the top-level conference/league nodes.
async function espnGrouped(path) {
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/standings?level=3`);
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
  const out = (rows || [])
    .filter(t => t.team && Number.isFinite(t.w) && Number.isFinite(t.l))
    .map(t => ({ team: String(t.team), w: t.w, l: t.l, conf: t.conf || '' }))
    .sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.w - a.w);
  if (!out.length) return [];
  const lead = out[0];
  return out.map((t, i) => ({
    rank: i + 1, team: t.team, conf: t.conf, w: t.w, l: t.l,
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

  counts.wnba = (value.wnba || []).length;
  for (const k of ['mlb', 'nba', 'nfl']) counts[k] = value[k] ? Object.fromEntries(Object.entries(value[k]).map(([c, r]) => [c, r.length])) : null;

  if (debug) return res.status(200).json({ ok: true, debug: true, counts, value });

  const anything = (value.wnba || []).length || value.mlb || value.nba || value.nfl;
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
