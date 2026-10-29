// api/test-push.js — sends a notification to ONE device on demand (the test
// buttons), so you can preview/iterate. body.kind: 'daily' (default) or 'big'.

import {
  setVapid, getTodayGames, pickTopGames, buildPayload, sendPush,
  getBigGames, bigGamesFor, buildBigTodayPayload, buildBigWeekPayload, ctToday, ctAddDays,
} from './_push.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey || !process.env.VAPID_PUBLIC_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  let endpoint, kind;
  try { ({ endpoint, kind } = req.body || {}); } catch { /* ignore */ }
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  const wp = setVapid();

  const r = await fetch(`${supabaseUrl}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&select=*`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  const sub = (await r.json())[0];
  if (!sub) return res.status(404).json({ error: 'Subscription not found — turn notifications on first.' });

  // Playoff preview: today's alert if there are playoff games today, otherwise
  // the weekly digest, so the button always shows what these alerts look like.
  if (kind === 'big') {
    const today = ctToday();
    const week = bigGamesFor(await getBigGames(today, ctAddDays(today, 6)), { ...sub, prefs: { ...(sub.prefs || {}), mustWatch: true } }, 'mustWatch');
    const todays = week.filter(g => g.dateKey === today);
    const payload = todays.length ? buildBigTodayPayload(todays)
      : week.length ? buildBigWeekPayload(week)
      : JSON.stringify({ title: '🏆 Playoff alerts are on', body: 'No playoff or finals games in the next week. We\'ll ping you the day they start.', url: '/' });
    const result = await sendPush(wp, sub, payload, supabaseUrl, supabaseKey);
    return res.status(200).json({ result, games: week.length });
  }

  const games = await getTodayGames();
  const ranked = pickTopGames(games, sub);
  const payload = ranked.length
    ? buildPayload(ranked, games.length)
    : JSON.stringify({ title: 'Know Your Game', body: 'No games on your radar today — enjoy the day off! 🟢', url: '/' });

  const result = await sendPush(wp, sub, payload, supabaseUrl, supabaseKey);
  return res.status(200).json({ result, games: games.length, top: ranked[0] || null });
}
