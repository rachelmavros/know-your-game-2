// api/ai.js — one serverless function for all the cached AI helpers, dispatched
// by ?action=. Consolidated to stay under Vercel Hobby's 12-function limit.
//   ?action=matchup      (POST {league,home,away})      → { ok, text }
//   ?action=team-star    (GET league, team)             → { ok, name, blurb }
//   ?action=player-info  (GET league, team, name)       → { ok, blurb, facts }
//   ?action=scoop        (GET league, team)             → { ok, bullets }
//   ?action=events       (GET)                          → { events }

export const config = { maxDuration: 30 };

const SB_URL = () => process.env.SUPABASE_URL;
const SB_KEY = () => process.env.SUPABASE_ANON_KEY;
const LEAGUE_PATH = { WNBA: 'basketball/wnba', NBA: 'basketball/nba', MLB: 'baseball/mlb', NFL: 'football/nfl', NHL: 'hockey/nhl', EPL: 'soccer/eng.1' };

async function cacheGet(key) {
  if (!SB_URL() || !SB_KEY()) return null;
  try {
    const r = await fetch(`${SB_URL()}/rest/v1/app_cache?key=eq.${encodeURIComponent(key)}&select=value,updated_at`, {
      headers: { apikey: SB_KEY(), Authorization: `Bearer ${SB_KEY()}` },
    });
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch { return null; }
}
function cacheSet(key, value) {
  if (!SB_URL() || !SB_KEY()) return;
  fetch(`${SB_URL()}/rest/v1/app_cache?on_conflict=key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SB_KEY(), Authorization: `Bearer ${SB_KEY()}`, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  }).catch(() => {});
}
async function claude(bodyExtra) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', thinking: { type: 'disabled' }, ...bodyExtra }),
  });
  const data = await r.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
const grabJSON = (raw, open, close) => {
  const s = raw.indexOf(open), e = raw.lastIndexOf(close);
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
};

async function rosterNames(league, team) {
  const path = LEAGUE_PATH[league];
  if (!path) return [];
  try {
    const tj = await (await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams`)).json();
    const list = ((((tj.sports || [])[0] || {}).leagues || [])[0] || {}).teams || [];
    const n = team.toLowerCase();
    const match = list.find(t => { const dn = String(t.team.displayName).toLowerCase(); return dn === n || dn.includes(n) || n.includes(dn); });
    if (!match) return [];
    const rj = await (await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${match.team.id}/roster`)).json();
    const names = [];
    for (const node of (rj.athletes || [])) {
      const items = Array.isArray(node.items) ? node.items : [node];
      for (const p of items) { const nm = p.fullName || p.displayName; if (nm) names.push(nm); }
    }
    return names;
  } catch { return []; }
}

async function doMatchup(body) {
  const { league, home, away } = body || {};
  if (!home || !away) return { ok: false, error: 'missing teams' };
  let recLine = '';
  const row = await cacheGet('standings');
  if (row && row.value) {
    const table = league === 'MLB' ? [] : (row.value.wnba || []); // MLB is grouped now; keep records for WNBA
    const find = name => { const n = String(name).toLowerCase(); const hit = table.find(t => { const tn = String(t.team).toLowerCase(); return tn === n || tn.includes(n) || n.includes(tn) || tn.split(' ').pop() === n.split(' ').pop(); }); return hit ? `${hit.w}-${hit.l}` : null; };
    const h = find(home), a = find(away);
    if (h || a) recLine = `Current records (use these exact numbers): ${away} ${a || 'n/a'}, ${home} ${h || 'n/a'}.`;
  }
  const prompt = `Write a tight, CONCRETE briefing for a casual fan about the ${league || ''} game ${away} at ${home} — not flowery hype.

${recLine}

In 4-6 short sentences (plain text: no headers, no markdown, no bullet symbols):
- Where each team stands and whether they're good right now (use the records above if given).
- Each team's key player(s), and specifically call out notable rookies or young players.
- One concrete point about a team's style — an offensive or defensive strength or weakness.
- The storyline that makes this game matter (rivalry, playoff race, a star to watch).

Be specific and substantive. Do NOT invent exact stats or records beyond the ones provided above — if unsure of a number, describe it qualitatively. Warm but informative.`;
  const raw = await claude({ max_tokens: 900, messages: [{ role: 'user', content: prompt }] });
  const text = (raw || '').trim();
  return text ? { ok: true, text } : { ok: false, error: 'no text' };
}

async function doTeamStar(q) {
  const league = String(q.league || '').toUpperCase(), team = String(q.team || '');
  if (!league || !team) return { ok: false, error: 'missing' };
  const key = `star2:${league}:${team}`.toLowerCase();
  const c = await cacheGet(key);
  if (c && c.value && c.value.name) return { ok: true, cached: true, ...c.value };
  const names = await rosterNames(league, team);
  const rosterClause = names.length ? `Choose ONLY from this current roster (use the exact name as written): ${names.join(', ')}.` : '';
  const prompt = `From the ${league} team the ${team}, name the single most notable, best-known player for a casual fan. ${rosterClause} Respond ONLY as raw JSON: {"name":"Full Name","blurb":"one short sentence on who they are and why they matter"}. No markdown.`;
  const raw = await claude({ max_tokens: 300, system: 'You output only raw JSON.', messages: [{ role: 'user', content: prompt }] });
  const val = raw && grabJSON(raw, '{', '}');
  if (!val || !val.name) return { ok: false };
  const out = { name: val.name, blurb: val.blurb || '' };
  cacheSet(key, out);
  return { ok: true, ...out };
}

async function doPlayerInfo(q) {
  const league = String(q.league || '').toUpperCase(), team = String(q.team || ''), name = String(q.name || '');
  if (!name) return { ok: false, error: 'missing name' };
  const key = `pinfo:${league}:${team}:${name}`.toLowerCase();
  const c = await cacheGet(key);
  if (c && c.value && c.value.blurb) return { ok: true, cached: true, ...c.value };
  const prompt = `For a casual sports fan, describe ${name}${team ? `, who plays for the ${team}` : ''}${league ? ` (${league})` : ''}. Respond ONLY as raw JSON: {"blurb":"2-3 warm, concrete sentences on who they are, their playing style, and why they matter","facts":["short interesting fact","another short fact","another"]}. Give 2-4 facts, each a short phrase. Use real, well-known information; do NOT invent specific stats. No markdown.`;
  const raw = await claude({ max_tokens: 500, system: 'You output only raw JSON.', messages: [{ role: 'user', content: prompt }] });
  const val = raw && grabJSON(raw, '{', '}');
  if (!val || !val.blurb) return { ok: false };
  const out = { blurb: String(val.blurb), facts: Array.isArray(val.facts) ? val.facts.slice(0, 4).map(String) : [] };
  cacheSet(key, out);
  return { ok: true, ...out };
}

async function doScoop(q) {
  const league = String(q.league || '').toUpperCase(), team = String(q.team || '');
  if (!league || !team) return { ok: false, error: 'missing' };
  const key = `scoop2:${league}:${team}`.toLowerCase();
  const c = await cacheGet(key);
  if (c && c.value && Array.isArray(c.value.bullets)) return { ok: true, cached: true, bullets: c.value.bullets };
  const prompt = `Give 1-2 SPECIFIC, juicy "scoop" bullets about the ${league} team the ${team}, for a casual fan who wants the real gossip and storylines.

Be concrete and name names + specific moments (real rivalries/feuds with details, iconic moments, viral plays, famous trash talk, a big trade or drama that dominated headlines, a popular team podcast).

Each bullet: one punchy, specific sentence that references the actual moment/person.

Rules:
- Everything must be REAL and WIDELY REPORTED in mainstream sports media. Public on-court feuds, trash talk, rivalries, trades, and viral moments are fair game.
- Do NOT fabricate or speculate about anyone's private life, relationships, medical details, or unverified rumors. If unsure it was widely covered, leave it out.
- If there's genuinely nothing notable, return fewer bullets or an empty list.

Respond ONLY as raw JSON: {"bullets":["...","..."]}. No markdown.`;
  const raw = await claude({ max_tokens: 400, system: 'You output only raw JSON. You never fabricate rumors, controversies, or private-life claims about real people.', messages: [{ role: 'user', content: prompt }] });
  const val = raw && grabJSON(raw, '{', '}');
  const bullets = val && Array.isArray(val.bullets) ? val.bullets.slice(0, 2).map(String) : [];
  cacheSet(key, { bullets });
  return { ok: true, bullets };
}

async function doEvents() {
  const key = 'events-list-v2'; // v2 = includes EPL
  const FRESH_MS = 14 * 86400000;
  const c = await cacheGet(key);
  let stale = null;
  if (c && Array.isArray(c.value)) {
    if (Date.now() - new Date(c.updated_at).getTime() < FRESH_MS) return { events: c.value, cached: true };
    stale = c.value;
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const prompt = `Today is ${today}. List the 8-12 biggest upcoming sports events over roughly the next 6 months that a CASUAL fan would care about — drafts, All-Star games, trade/transfer deadlines, playoff starts, championships/finals, and season openers across WNBA, NBA, MLB, NFL, NHL, and the English Premier League (EPL) — include EPL opening weekend, big derbies, and the transfer deadline.

Each object EXACTLY: {"dateKey":"YYYY-MM-DD" (today or later), "league":"WNBA|NBA|MLB|NFL|NHL|EPL", "title":"short name", "span":"human timing e.g. 'Late October'", "where":"venue or ''", "tv":"network or ''", "note":"one warm sentence on why a casual fan should care"}.

Only real, scheduled or clearly recurring events. Earliest first. Output ONLY a JSON array, no markdown.`;
  const raw = await claude({ max_tokens: 2000, system: 'You output only a raw JSON array.', messages: [{ role: 'user', content: prompt }] });
  let arr = raw && grabJSON(raw, '[', ']');
  if (!Array.isArray(arr)) return { events: stale || [] };
  arr = arr
    .filter(x => x && x.dateKey && x.title && x.league && x.dateKey >= today)
    .map(x => ({ dateKey: String(x.dateKey), league: String(x.league).toUpperCase(), title: String(x.title), span: x.span || '', where: x.where || '', tv: x.tv || '', note: x.note || '' }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
    .slice(0, 14);
  if (!arr.length) return { events: stale || [] };
  cacheSet(key, arr);
  return { events: arr };
}

async function doLeagueStars(q) {
  const league = String(q.league || '').toUpperCase();
  if (!league) return { ok: false };
  const key = `lstars:${league}`.toLowerCase();
  const c = await cacheGet(key);
  if (c && c.value && Array.isArray(c.value.stars)) return { ok: true, cached: true, stars: c.value.stars };
  const prompt = `Name the 6 most notable, best-known ${league} players right now, for a casual fan. For each output: {"name":"Full Name","team":"team name","pos":"position","blurb":"one warm sentence on who they are and why they matter","facts":["short interesting fact","another short fact"]}. Use real, well-known information; do NOT invent specific stats or numbers. Output ONLY a raw JSON array, no markdown.`;
  const raw = await claude({ max_tokens: 1300, system: 'You output only a raw JSON array.', messages: [{ role: 'user', content: prompt }] });
  const arr = raw && grabJSON(raw, '[', ']');
  if (!Array.isArray(arr)) return { ok: false };
  const stars = arr.filter(x => x && x.name && x.team).slice(0, 6).map(x => ({
    name: String(x.name), team: String(x.team), pos: String(x.pos || ''),
    blurb: String(x.blurb || ''), facts: Array.isArray(x.facts) ? x.facts.slice(0, 3).map(String) : [],
  }));
  if (!stars.length) return { ok: false };
  cacheSet(key, { stars });
  return { ok: true, stars };
}

export default async function handler(req, res) {
  const action = String((req.query.action || '')).toLowerCase();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  try {
    if (action === 'matchup') return res.status(200).json(await doMatchup(body));
    if (action === 'team-star') return res.status(200).json(await doTeamStar(req.query));
    if (action === 'player-info') return res.status(200).json(await doPlayerInfo(req.query));
    if (action === 'scoop') return res.status(200).json(await doScoop(req.query));
    if (action === 'league-stars') return res.status(200).json(await doLeagueStars(req.query));
    if (action === 'events') { res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400'); return res.status(200).json(await doEvents()); }
    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
