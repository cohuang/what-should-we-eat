// api/places.js
// ============================================================
//  Vercel Serverless Function — Google Places Proxy
//  Checks a global monthly quota stored in Vercel KV before
//  making any call to Google. If the quota is exhausted it
//  returns { status: 'QUOTA_EXCEEDED' } — no Google call made.
//
//  SETUP:
//  1. In Vercel dashboard → Storage → Create KV database
//     Name it anything e.g. "where-should-we-eat-kv"
//     Connect it to your project (auto-adds env vars)
//  2. In Vercel dashboard → your project → Settings → Environment Variables
//     Add: GOOGLE_API_KEY = your key
//     (The KV env vars KV_REST_API_URL and KV_REST_API_TOKEN
//      are added automatically when you connect the KV store)
//  3. Set MONTHLY_QUOTA below to your desired global cap
//  4. Redeploy
// ============================================================

const MONTHLY_QUOTA = 4000; // Google free tier = ~6,250/month. Keep headroom.

// ── Vercel KV helpers (uses the REST API directly — no npm needed) ──
async function kvGet(key) {
  const res = await fetch(
    `${process.env.KV_REST_API_URL}/get/${key}`,
    { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } }
  );
  const json = await res.json();
  return json.result ?? null;
}

async function kvIncr(key) {
  const res = await fetch(
    `${process.env.KV_REST_API_URL}/incr/${key}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    }
  );
  const json = await res.json();
  return json.result ?? null;
}

async function kvExpireAt(key, unixTimestamp) {
  await fetch(
    `${process.env.KV_REST_API_URL}/expireat/${key}/${unixTimestamp}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    }
  );
}

// Returns the KV key for the current month e.g. "quota:2024-03"
function monthKey() {
  const d = new Date();
  return `quota:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Unix timestamp of the first second of next month (UTC)
function nextMonthTimestamp() {
  const d = new Date();
  return Math.floor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).getTime() / 1000);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { lat, lng, radius, keyword } = req.query;
  if (!lat || !lng || !radius) {
    return res.status(400).json({ error: 'Missing required params: lat, lng, radius' });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // ── Global quota check ─────────────────────────────────────────
  // Only check quota if KV is configured (gracefully skips in local dev)
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const key          = monthKey();
      const currentCount = parseInt(await kvGet(key) ?? '0', 10);

      if (currentCount >= MONTHLY_QUOTA) {
        // Quota exhausted — don't touch Google at all
        return res.status(200).json({ status: 'QUOTA_EXCEEDED' });
      }

      // Increment the counter and set it to auto-expire at end of month
      const newCount = await kvIncr(key);
      if (newCount === 1) {
        // First call of the month — set expiry so it resets automatically
        await kvExpireAt(key, nextMonthTimestamp());
      }
    } catch (kvErr) {
      // If KV fails for any reason, log and continue — don't block the user
      console.error('KV quota check failed:', kvErr);
    }
  }

  // ── Proxy to Google Places ─────────────────────────────────────
  let url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`
          + `?location=${lat},${lng}`
          + `&radius=${radius}`
          + `&type=restaurant`
          + `&key=${apiKey}`;

  if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;

  try {
    const googleRes = await fetch(url);
    const data      = await googleRes.json();

    // Cache at Vercel's edge for 24h so repeat calls for same area are free
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

    return res.status(200).json(data);
  } catch (err) {
    console.error('Places API error:', err);
    return res.status(502).json({ error: 'Failed to reach Google Places API' });
  }
}
