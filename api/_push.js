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
        const home = (g.home_team && (g.home_team.full_name || g.home_team.display_name || g.home_team.name)) || g.home_team_name || '';
        const away = (g.visitor_team && (g.visitor_team.full_name || g.visitor_team.name)) ||
                     (g.away_team && (g.away_team.display_name || g.away_team.full_name || g.away_team.name)) || g.away_team_name || '';
        if (!home || !away) continue;
        out.push({ league: cfg.league, home: home.trim(), away: away.trim(), time: ctTime(iso) });
      }
    } catch { /* skip a sport that errors */ }
  }
  return out;
}

// Pick the most notable game for a given subscription, using its saved follows.
export function pickTopGame(games, sub) {
  if (!games.length) return null;
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
  return [...games].sort((a, b) => score(b) - score(a))[0];
}

export function buildPayload(top, total) {
  const emoji = SPORT_EMOJI[top.league] || '📣';
  const others = Math.max(0, total - 1);
  const tail = others > 0 ? ` · +${others} more game${others > 1 ? 's' : ''} worth watching — tap for your rundown` : ' · tap for details';
  return JSON.stringify({
    title: `${emoji} Top game today: ${top.away} at ${top.home}`,
    body: `${top.time}${tail}`,
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
