// api/notify.js — daily push job, triggered by Vercel Cron.
// Reads all push subscriptions from Supabase and sends each a notification.
// Node runtime (web-push needs Node crypto).

import webpush from 'web-push';

export default async function handler(req, res) {
  // If CRON_SECRET is set, Vercel Cron sends it as a Bearer token.
  // Reject anything that isn't the cron (so randoms can't spam pushes).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:rachelmavros1@gmail.com';

  if (!supabaseUrl || !supabaseKey || !vapidPublic || !vapidPrivate) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  webpush.setVapidDetails(subject, vapidPublic, vapidPrivate);

  // Load every saved subscription.
  const subRes = await fetch(`${supabaseUrl}/rest/v1/push_subscriptions?select=*`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });

  if (!subRes.ok) {
    const err = await subRes.text();
    return res.status(500).json({ error: `Supabase read failed: ${err}` });
  }

  const subs = await subRes.json();

  const payload = JSON.stringify({
    title: 'Know Your Game',
    body: "Today's games are ready — tap to see what's worth watching 🏀",
    url: '/',
  });

  let sent = 0;
  let removed = 0;

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      );
      sent++;
    } catch (err) {
      // 404 / 410 mean the subscription is dead — clean it up.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await fetch(
          `${supabaseUrl}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
          {
            method: 'DELETE',
            headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
          }
        );
        removed++;
      }
    }
  }

  return res.status(200).json({ total: subs.length, sent, removed });
}
