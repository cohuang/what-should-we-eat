// api/places.js
// ============================================================
//  Vercel Serverless Function — Google Places Proxy
//  This runs on Vercel's servers, not in the browser.
//  Your API key stays hidden in a Vercel environment variable.
//
//  SETUP:
//  1. In Vercel dashboard → your project → Settings → Environment Variables
//  2. Add: GOOGLE_API_KEY = your key
//  3. Redeploy
// ============================================================

export default async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { lat, lng, radius, keyword } = req.query;

  // Basic validation
  if (!lat || !lng || !radius) {
    return res.status(400).json({ error: 'Missing required params: lat, lng, radius' });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  // Build the Google Places URL
  let url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`
          + `?location=${lat},${lng}`
          + `&radius=${radius}`
          + `&type=restaurant`
          + `&key=${apiKey}`;

  if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;

  try {
    const googleRes = await fetch(url);
    const data = await googleRes.json();

    // Cache the response for 24 hours on Vercel's edge
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

    return res.status(200).json(data);
  } catch (err) {
    console.error('Places API error:', err);
    return res.status(502).json({ error: 'Failed to reach Google Places API' });
  }
}
