// api/notify.js — daily push job (Vercel Cron). Sends each subscriber a
// personalized "top game today" notification based on their saved follows.

import { setVapid, getTodayGames, pickTopGames, buildPayload, sendPush } from './_push.js';

export default async function handler(req, res) {
  // If CRON_SECRET is set, Vercel Cron sends it as a Bearer token.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const wp = setVapid();
  const games = await getTodayGames();

  const subRes = await fetch(`${supabaseUrl}/rest/v1/push_subscriptions?select=*`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!subRes.ok) {
    return res.status(500).json({ error: `Supabase read failed: ${await subRes.text()}` });
  }
  const subs = await subRes.json();

  let sent = 0, removed = 0, skipped = 0;
  for (const sub of subs) {
    const ranked = pickTopGames(games, sub);
    if (!ranked.length) { skipped++; continue; } // no games today → don't nag
    const result = await sendPush(wp, sub, buildPayload(ranked, games.length), supabaseUrl, supabaseKey);
    if (result === 'sent') sent++;
    else if (result === 'removed') removed++;
  }

  return res.status(200).json({ total: subs.length, games: games.length, sent, removed, skipped });
}
