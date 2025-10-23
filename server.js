import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';

const PORT = process.env.PORT || 3000;

// These will be empty until you register your Twitch app
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

const app = new Hono();

// Enable CORS for tvOS app
app.use('/*', cors());

let appToken = null; // { token, expiresAt }

async function getAppAccessToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET required');
  }

  const now = Date.now();
  if (appToken && now < appToken.expiresAt - 60_000) return appToken.token;

  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials'
  });

  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!r.ok) throw new Error(`oauth token ${r.status}`);
  const j = await r.json();
  appToken = {
    token: j.access_token,
    expiresAt: Date.now() + (j.expires_in * 1000)
  };
  return appToken.token;
}

async function getPlaybackToken(channel) {
  const payload = {
    operationName: 'PlaybackAccessToken',
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712'
      }
    },
    variables: {
      isLive: true,
      login: channel,
      isVod: false,
      vodID: '',
      playerType: 'embed'
    }
  };

  // Twitch GQL for playback tokens only needs Client-ID, no Bearer token
  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const errorText = await r.text();
    throw new Error(`gql ${r.status}: ${errorText}`);
  }

  const j = await r.json();
  const tok = j?.data?.streamPlaybackAccessToken || j?.data?.streamAccessToken;
  if (!tok?.signature || !tok?.value) return null;
  return { sig: tok.signature, token: tok.value };
}

function buildUsherURL(channel, sig, token) {
  const params = new URLSearchParams({
    sig,
    token,
    player: 'twitchweb',
    allow_source: 'true',
    allow_audio_only: 'true',
    playlist_include_framerate: 'true',
    reassignments_supported: 'true',
    p: Math.floor(Math.random() * 1e7).toString()
  });
  return `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(channel)}.m3u8?${params}`;
}

// Main HLS endpoint
app.get('/hls', async (c) => {
  try {
    const channel = c.req.query('channel')?.trim().toLowerCase();
    if (!channel) {
      return c.json({ error: 'channel required' }, 400);
    }

    // We don't need app token for playback - GQL only needs Client-ID
    const pt = await getPlaybackToken(channel);

    if (!pt) {
      return c.json({ error: 'offline or no token' }, 404);
    }

    const url = buildUsherURL(channel, pt.sig, pt.token);
    return c.json({ url });
  } catch (e) {
    console.error('HLS error:', e.message);
    // Return detailed error for debugging
    return c.json({
      error: 'server error',
      details: e.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : e.stack
    }, 500);
  }
});

// OAuth redirect handler (for Twitch app registration)
app.get('/oauth/callback', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Twitch OAuth Callback</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          max-width: 600px;
          margin: 100px auto;
          padding: 20px;
          text-align: center;
        }
        .success { color: #00c853; }
        code {
          background: #f5f5f5;
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <h1 class="success">✓ OAuth Redirect Working!</h1>
      <p>This URL is valid for Twitch app registration.</p>
      <p>You can now register your app at <a href="https://dev.twitch.tv/console/apps">dev.twitch.tv</a></p>
      <hr>
      <h3>Setup Instructions:</h3>
      <ol style="text-align: left;">
        <li>Go to <a href="https://dev.twitch.tv/console/apps" target="_blank">dev.twitch.tv/console/apps</a></li>
        <li>Click "Register Your Application"</li>
        <li>Set OAuth Redirect URL to: <code>${c.req.url}</code></li>
        <li>Category: "Application Integration"</li>
        <li>Copy Client ID and Secret to your .env file</li>
      </ol>
    </body>
    </html>
  `);
});

// Health check
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    configured: !!(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET),
    endpoints: {
      hls: '/hls?channel=CHANNEL_NAME',
      oauth: '/oauth/callback'
    }
  });
});

console.log(`
╔═══════════════════════════════════════════════════════════╗
║  Twitch Proxy Server                                      ║
╠═══════════════════════════════════════════════════════════╣
║  Local:  http://localhost:${PORT}                           ║
║  Status: ${TWITCH_CLIENT_ID ? '✓ Configured' : '⚠ Missing credentials'}                              ║
╠═══════════════════════════════════════════════════════════╣
║  Next Steps:                                              ║
║  1. Start ngrok or cloudflared tunnel                     ║
║  2. Use HTTPS URL for Twitch OAuth redirect               ║
║  3. Add credentials to .env and restart                   ║
╚═══════════════════════════════════════════════════════════╝
`);

serve({
  fetch: app.fetch,
  port: PORT
});
