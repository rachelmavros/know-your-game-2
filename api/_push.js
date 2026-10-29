// api/_push.js — shared helpers for personalized push notifications.
// (Underscore prefix = not a routable endpoint, just an import.)
import webpush from 'web-push';

const SPORT_EMOJI = { WNBA: '🏀', MLB: '⚾', WC: '⚽', NBA: '🏀' };

// Marquee teams used to pick a "top overall" game when a user has no follows.
const MARQUEE = {
  WNBA: ['Indiana Fever', 'Las Vegas Aces', 'New York Liberty', 'Minnesota Lynx'],
  MLB: ['Los Angeles Dodgers', 'New York Yankees', 'Chicago Cubs', 'New York Mets', 'Atlanta Braves', 'Boston Red Sox', 'Philadelphia Phillies'],
  WC: ['USA', 'Brazil', 'Argentina', 'France', 'England', 'Mexico', 'Spain', 'Portugal'],
};

export function setVapid() {
  const subject = process.env.VAPID_SUBJECT || 'mailto:rachelmavros1@gmail.com';
  webpush.setVapidDetails(subject, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return webpush;
}

function ctTime(iso) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)) + ' CT';
  } catch { return ''; }
}
function ctDateKey(iso) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const g = t => (p.find(x => x.type === t) || {}).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// BallDontLie endpoints (same as api/schedule.js). Queried directly so the job
// works on protected preview deployments and doesn't depend on our own host.
const BDL = [
  { base: 'https://api.balldontlie.io/wnba/v1/games', key: 'BDL_WNBA_KEY', style: 'range', league: 'WNBA' },
  { base: 'https://api.balldontlie.io/mlb/v1/games', key: 'BDL_MLB_KEY', style: 'dates', league: 'MLB' },
  { base: 'https://api.balldontlie.io/fifa/worldcup/v1/matches', key: 'BDL_FIFA_KEY', style: 'dates', league: 'WC' },
];

// Fetch today's (Central) games across sports straight from BallDontLie.
export async function getTodayGames() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const out = [];
  for (const cfg of BDL) {
    const apiKey = process.env[cfg.key];
    if (!apiKey) continue;
    const params = new URLSearchParams();
    if (cfg.style === 'dates') params.append('dates[]', today);
    else { params.set('start_date', today); params.set('end_date', today); }
    params.set('per_page', '100');
    try {
      const r = await fetch(`${cfg.base}?${params.toString()}`, { headers: { Authorization: apiKey } });
      if (!r.ok) continue;
      const j = await r.json();
      for (const g of (j.data || [])) {
        const iso = g.date || g.datetime || '';
        if (!iso || ctDateKey(iso) !== today) continue;
        // BallDontLie leaves `full_name` empty on newer expansion teams (Portland
        // is city "Portland" + name "Fire" with no full_name), so fall back to
        // city + nickname rather than shipping a push that reads "Fire at Dallas".
        const teamName = t => {
          if (!t) return '';
          if (t.full_name) return t.full_name;
          if (t.display_name) return t.display_name;
          const city = (t.city || '').trim(), name = (t.name || '').trim();
          if (city && name && !name.startsWith(city)) return `${city} ${name}`;
          return name || city || '';
        };
        const home = teamName(g.home_team) || g.home_team_name || '';
        const away = teamName(g.visitor_team) || teamName(g.away_team) || g.away_team_name || '';
        if (!home || !away) continue;
        out.push({ league: cfg.league, home: home.trim(), away: away.trim(), time: ctTime(iso) });
      }
    } catch { /* skip a sport that errors */ }
  }
  return out;
}

// Rank games for a given subscription, using its saved follows. Returns the
// full list sorted most-notable-first (callers take as many as they need).
export function pickTopGames(games, sub) {
  const stars = sub.stars || {};
  const teams = (stars.teams || []).map(t => t.name);
  const leagues = stars.leagues || [];
  const score = g => {
    let s = 0;
    if (teams.includes(g.home) || teams.includes(g.away)) s += 100;
    if (leagues.includes(g.league)) s += 40;
    if ((MARQUEE[g.league] || []).includes(g.home) || (MARQUEE[g.league] || []).includes(g.away)) s += 10;
    return s;
  };
  return [...games].sort((a, b) => score(b) - score(a));
}

export function buildPayload(ranked, total) {
  const top = ranked[0];
  const emoji = SPORT_EMOJI[top.league] || '📣';
  // Lead with the actual matchup (game info in the first words); list a few
  // more games below, and end with a short CTA.
  const rest = ranked.slice(1, 4);
  const lines = rest.map(g => `${SPORT_EMOJI[g.league] || '📣'} ${g.away} at ${g.home} · ${g.time}`);
  const remaining = Math.max(0, total - 1 - rest.length);
  lines.push(remaining > 0 ? `+${remaining} more · View all games →` : 'View all games →');
  return JSON.stringify({
    title: `${emoji} ${top.away} at ${top.home} · ${top.time}`,
    body: lines.join('\n'),
    url: `/?league=${encodeURIComponent(top.league)}&home=${encodeURIComponent(top.home)}&away=${encodeURIComponent(top.away)}`,
  });
}

// Send to one subscription; clean up dead ones (404/410). Returns a status string.
export async function sendPush(wp, sub, payload, supabaseUrl, supabaseKey) {
  try {
    await wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    return 'sent';
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await fetch(`${supabaseUrl}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, {
        method: 'DELETE', headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      });
      return 'removed';
    }
    return 'error';
  }
}

// ─── Big-game alerts (playoffs, finals, championships) ─────────────────────
// Separate from the routine daily push: fires only when there's postseason or
// title-game action, with copy that says what the game is FOR ("Game 6 · Yankees
// can clinch the World Series") instead of just who's playing.

const BIG_EMOJI = { WNBA: '🏀', NBA: '🏀', MLB: '⚾', NFL: '🏈', CFB: '🏈', NHL: '🏒', MLS: '⚽', EPL: '⚽', WC: '⚽' };
const BIG_PATHS = {
  NFL: 'football/nfl', CFB: 'football/college-football', NBA: 'basketball/nba', WNBA: 'basketball/wnba',
  MLB: 'baseball/mlb', NHL: 'hockey/nhl', MLS: 'soccer/usa.1',
};
export const BIG_LEAGUES = Object.keys(BIG_PATHS);
// Title games — anything that crowns a champion. Matched against ESPN's note headline.
const TITLE_RE = /world series|super bowl|nba finals|wnba finals|stanley cup final|mls cup(?! playoffs)|national championship|cup - championship/i;
// Non-postseason games that still count: in-season cup knockouts, conference title games.
const BIG_REGULAR_RE = /cup - (championship|semifinal|quarterfinal)|conference championship|championship game/i;

const dayName = dk => new Date(dk + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const nickname = c => (c.team && (c.team.shortDisplayName || c.team.name)) || '';

function stakesFor(comp, H, A, isFootball) {
  // Best-of-N series: ESPN gives each side's wins and the series length.
  const s = comp.series;
  if (s && Array.isArray(s.competitors) && s.totalCompetitions > 1) {
    const need = Math.ceil(s.totalCompetitions / 2);
    const wins = id => ((s.competitors.find(x => String(x.id) === String(id)) || {}).wins) || 0;
    const hw = wins(H.id), aw = wins(A.id);
    const lead = hw === aw ? `Series tied ${hw}-${aw}`
      : hw > aw ? `${nickname(H)} lead ${hw}-${aw}` : `${nickname(A)} lead ${aw}-${hw}`;
    if (hw === need - 1 && aw === need - 1) return { series: lead, stakes: 'Winner take all', hot: true };
    if (hw === need - 1) return { series: lead, stakes: `${nickname(H)} can clinch`, hot: true };
    if (aw === need - 1) return { series: lead, stakes: `${nickname(A)} can clinch`, hot: true };
    return { series: lead, stakes: '', hot: false };
  }
  // Single games in a bracket (NFL/CFB/MLS/wild-card rounds): one and done.
  if (isFootball || (s && s.totalCompetitions === 1)) return { series: '', stakes: 'Win or go home', hot: true };
  return { series: '', stakes: '', hot: false };
}

async function fetchLeagueBig(league, path, startKey, endKey) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`;
  const isFootball = league === 'NFL' || league === 'CFB';
  const urls = [];
  if (isFootball) {
    // Football rejects date ranges; the default (current week) + next week covers a 7-day window.
    urls.push(base);
  } else {
    urls.push(`${base}?dates=${startKey.replace(/-/g, '')}-${endKey.replace(/-/g, '')}&limit=300`);
  }
  const events = [];
  try {
    const r = await fetch(urls[0]);
    if (!r.ok) return [];
    const j = await r.json();
    events.push(...(j.events || []));
    if (isFootball && j.week && j.season) {
      const nr = await fetch(`${base}?seasontype=${j.season.type}&week=${j.week.number + 1}&dates=${j.season.year}`).catch(() => null);
      if (nr && nr.ok) events.push(...(((await nr.json()).events) || []));
    }
  } catch { return []; }

  const out = [];
  const seen = new Set();
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const headline = ((comp.notes || [])[0] || {}).headline || '';
    const post = (ev.season && ev.season.type === 3) || (comp.series && comp.series.type === 'playoff');
    if (!post && !BIG_REGULAR_RE.test(headline)) continue;
    // College bowl season is ~40 games; only the playoff itself is alert-worthy.
    if (league === 'CFB' && !/playoff|cfp|national championship/i.test(headline)) continue;
    const st = (ev.status && ev.status.type) || {};
    if (st.state === 'post') continue;
    const cs = comp.competitors || [];
    const H = cs.find(c => c.homeAway === 'home'), A = cs.find(c => c.homeAway === 'away');
    if (!H || !A) continue;
    const iso = ev.date || comp.date || '';
    const dateKey = ctDateKey(iso);
    if (dateKey < startKey || dateKey > endKey) continue;
    let network = '';
    for (const b of (comp.broadcasts || [])) { if (Array.isArray(b.names) && b.names[0]) { network = b.names[0]; break; } }
    const { series, stakes, hot } = stakesFor(comp, H, A, isFootball);
    const title = TITLE_RE.test(headline);
    out.push({
      league, dateKey, time: ctTime(iso), network,
      home: (H.team && H.team.displayName) || '', away: (A.team && A.team.displayName) || '',
      homeShort: nickname(H), awayShort: nickname(A),
      // "World Series - Game 6" → "World Series · Game 6"
      stage: (headline || `${league} Playoffs`).replace(/\s+-\s+/g, ' · '),
      series, stakes, isTitle: title,
      // Ranking: title games, then must-win/clinch games, then the rest.
      weight: (title ? 100 : 0) + (hot ? 40 : 0) + (stakes === 'Winner take all' ? 30 : 0),
    });
  }
  return out;
}

// Every playoff/finals game across leagues between two Central-time date keys.
export async function getBigGames(startKey, endKey) {
  const sets = await Promise.all(Object.entries(BIG_PATHS).map(([lg, p]) => fetchLeagueBig(lg, p, startKey, endKey)));
  return sets.flat().sort((a, b) => a.dateKey.localeCompare(b.dateKey) || (b.weight - a.weight));
}

export function ctToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function ctAddDays(dk, n) {
  const d = new Date(dk + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Which big games a subscriber wants: alerts on (default) and in their chosen
// leagues (none chosen = all). Their followed teams float to the top.
export function bigGamesFor(games, sub, prefKey) {
  const prefs = sub.prefs || {};
  if (prefs[prefKey] === false) return [];
  const leagues = Array.isArray(prefs.bigLeagues) && prefs.bigLeagues.length ? prefs.bigLeagues : null;
  const teams = ((sub.stars && sub.stars.teams) || []).map(t => t.name);
  const mine = g => teams.includes(g.home) || teams.includes(g.away);
  return games
    .filter(g => !leagues || leagues.includes(g.league))
    .sort((a, b) => (mine(b) - mine(a)) || (b.weight - a.weight));
}

const stakesText = g => [g.series, g.stakes].filter(Boolean).join(' — ');
const deepLink = g => `/?league=${encodeURIComponent(g.league)}&home=${encodeURIComponent(g.home)}&away=${encodeURIComponent(g.away)}`;

// Game-day alert: "🏆 World Series · Game 6 tonight" / "Dodgers at Yankees ·
// 7:08 PM CT on FOX — Yankees lead 3-2, can clinch".
export function buildBigTodayPayload(games) {
  const top = games[0];
  const icon = top.isTitle ? '🏆' : (top.stakes ? '🔥' : (BIG_EMOJI[top.league] || '📣'));
  const when = /PM/.test(top.time) && parseInt(top.time, 10) >= 5 && parseInt(top.time, 10) !== 12 ? 'tonight' : 'today';
  const title = `${icon} ${top.stage} ${when}`;
  const lead = `${top.awayShort} at ${top.homeShort} · ${top.time}${top.network ? ` on ${top.network}` : ''}`;
  const lines = [stakesText(top) ? `${lead}\n${stakesText(top)}` : lead];
  const more = games.slice(1, 4).map(g =>
    `${BIG_EMOJI[g.league] || '📣'} ${g.stage}: ${g.awayShort} at ${g.homeShort} · ${g.time}${g.stakes ? ` (${g.stakes})` : ''}`);
  lines.push(...more);
  if (games.length > 4) lines.push(`+${games.length - 4} more playoff games today`);
  return JSON.stringify({ title, body: lines.join('\n'), url: deepLink(top), tag: `big-${top.dateKey}` });
}

// Monday digest: the week's playoff/finals schedule in one notification.
export function buildBigWeekPayload(games) {
  const titles = games.filter(g => g.isTitle).length;
  const title = titles
    ? `🏆 Championship week: ${titles} title game${titles > 1 ? 's' : ''} on deck`
    : `🔥 Big games this week: ${games.length} playoff game${games.length > 1 ? 's' : ''}`;
  // One line per game, chronological, capped so it stays readable on a lock screen.
  const pick = [...games].sort((a, b) => b.weight - a.weight).slice(0, 5)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const lines = pick.map(g => `${dayName(g.dateKey)} · ${g.stage}: ${g.awayShort} at ${g.homeShort}${g.stakes ? ` — ${g.stakes}` : ''}`);
  if (games.length > pick.length) lines.push(`+${games.length - pick.length} more · See the week →`);
  return JSON.stringify({ title, body: lines.join('\n'), url: '/', tag: `bigweek-${games[0].dateKey}` });
}
