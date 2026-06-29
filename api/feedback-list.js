// api/feedback-list.js — returns all feedback, newest first.
// Gated by an ADMIN_KEY so only you can read it from the in-app admin page.

export const config = { runtime: 'edge' };

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' },
});

export default async function handler(req) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return json({ error: 'ADMIN_KEY not configured' }, 500);

  const key = new URL(req.url).searchParams.get('key');
  if (key !== adminKey) return json({ error: 'Unauthorized' }, 401);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return json({ error: 'Supabase not configured' }, 500);

  const r = await fetch(`${supabaseUrl}/rest/v1/feedback?select=*&order=created_at.desc`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!r.ok) return json({ error: await r.text() }, 500);

  return json({ data: await r.json() }, 200);
}
