// api/notify.js — push jobs (Vercel Cron), picked by ?kind=:
//   (default) daily    — each subscriber's personalized "top game today"
//   big                — game-day alert when there are playoff/finals games today
//   week               — Monday digest of this week's playoff/finals games
// The big/week alerts are separate from the routine daily push and only fire
// when there's something at stake, so they never nag on a quiet day.

import {
  setVapid, getTodayGames, pickTopGames, buildPayload, sendPush,
  getBigGames, bigGamesFor, buildBigTodayPayload, buildBigWeekPayload, ctToday, ctAddDays,
} from './_push.js';

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

  const kind = String(req.query.kind || 'daily');
  const wp = setVapid();

  // Build a per-subscriber payload (or null to skip) for this kind of job.
  let games, payloadFor;
  if (kind === 'big' || kind === 'week') {
    const today = ctToday();
    games = await getBigGames(today, kind === 'week' ? ctAddDays(today, 6) : today);
    payloadFor = sub => {
      const mine = bigGamesFor(games, sub, kind === 'week' ? 'weeklyBig' : 'mustWatch');
      if (!mine.length) return null;
      return kind === 'week' ? buildBigWeekPayload(mine) : buildBigTodayPayload(mine);
    };
  } else {
    games = await getTodayGames();
    payloadFor = sub => {
      const ranked = pickTopGames(games, sub);
      return ranked.length ? buildPayload(ranked, games.length) : null; // no games today → don't nag
    };
  }
  if (!games.length) return res.status(200).json({ kind, games: 0, sent: 0 });

  const subRes = await fetch(`${supabaseUrl}/rest/v1/push_subscriptions?select=*`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!subRes.ok) {
    return res.status(500).json({ error: `Supabase read failed: ${await subRes.text()}` });
  }
  const subs = await subRes.json();

  let sent = 0, removed = 0, skipped = 0;
  for (const sub of subs) {
    const payload = payloadFor(sub);
    if (!payload) { skipped++; continue; }
    const result = await sendPush(wp, sub, payload, supabaseUrl, supabaseKey);
    if (result === 'sent') sent++;
    else if (result === 'removed') removed++;
  }

  return res.status(200).json({ kind, total: subs.length, games: games.length, sent, removed, skipped });
}
