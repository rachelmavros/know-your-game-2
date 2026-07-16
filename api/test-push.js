// api/test-push.js — sends the personalized daily notification to ONE device
// on demand (the "Send test push" button), so you can preview/iterate.

import { setVapid, getTodayGames, pickTopGames, buildPayload, sendPush } from './_push.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey || !process.env.VAPID_PUBLIC_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  let endpoint;
  try { ({ endpoint } = req.body || {}); } catch { /* ignore */ }
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  const wp = setVapid();
  const games = await getTodayGames();

  const r = await fetch(`${supabaseUrl}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&select=*`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  const sub = (await r.json())[0];
  if (!sub) return res.status(404).json({ error: 'Subscription not found — turn notifications on first.' });

  const ranked = pickTopGames(games, sub);
  const payload = ranked.length
    ? buildPayload(ranked, games.length)
    : JSON.stringify({ title: 'Know Your Game', body: 'No games on your radar today — enjoy the day off! 🟢', url: '/' });

  const result = await sendPush(wp, sub, payload, supabaseUrl, supabaseKey);
  return res.status(200).json({ result, games: games.length, top: ranked[0] || null });
}
