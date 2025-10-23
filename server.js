import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';

const PORT = process.env.PORT || 3000;

// Twitch's public Client-ID for GraphQL (playback tokens only)
// Custom Client-IDs don't work with GraphQL - Twitch restricts them
// This can be overridden via GQL_CLIENT_ID env var if needed
const GQL_CLIENT_ID = (process.env.GQL_CLIENT_ID || 'kimne78kx3ncx6brgo4mv6wki5h1ko').trim();

// Your registered Twitch app credentials for Helix API (metadata)
const HELIX_CLIENT_ID = (process.env.TWITCH_CLIENT_ID || '').trim();
const HELIX_CLIENT_SECRET = (process.env.TWITCH_CLIENT_SECRET || '').trim();

const app = new Hono();

// Enable CORS for tvOS app
app.use('/*', cors());

let helixAppToken = null; // { token, expiresAt }

// Get Helix API app access token
async function getHelixAppToken() {
  if (!HELIX_CLIENT_ID || !HELIX_CLIENT_SECRET) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET required for Helix API');
  }

  const now = Date.now();
  if (helixAppToken && now < helixAppToken.expiresAt - 60_000) return helixAppToken.token;

  const body = new URLSearchParams({
    client_id: HELIX_CLIENT_ID,
    client_secret: HELIX_CLIENT_SECRET,
    grant_type: 'client_credentials'
  });

  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!r.ok) throw new Error(`oauth token ${r.status}`);
  const j = await r.json();
  helixAppToken = {
    token: j.access_token,
    expiresAt: Date.now() + (j.expires_in * 1000)
  };
  return helixAppToken.token;
}

// Helper: Call Helix API
async function callHelix(endpoint, params = {}) {
  const token = await getHelixAppToken();
  const url = new URL(`https://api.twitch.tv/helix/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      v.forEach(item => url.searchParams.append(k, item));
    } else {
      url.searchParams.set(k, v);
    }
  });

  const r = await fetch(url, {
    headers: {
      'Client-ID': HELIX_CLIENT_ID,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`helix ${r.status}: ${err}`);
  }

  return r.json();
}

// Get playback token for live stream (GraphQL)
async function getLivePlaybackToken(channel) {
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

  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': GQL_CLIENT_ID,
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

// Get playback token for VOD (GraphQL)
async function getVODPlaybackToken(vodId) {
  const payload = {
    operationName: 'PlaybackAccessToken',
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712'
      }
    },
    variables: {
      isLive: false,
      login: '',
      isVod: true,
      vodID: vodId,
      playerType: 'embed'
    }
  };

  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': GQL_CLIENT_ID,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const errorText = await r.text();
    throw new Error(`gql ${r.status}: ${errorText}`);
  }

  const j = await r.json();
  const tok = j?.data?.videoPlaybackAccessToken;
  if (!tok?.signature || !tok?.value) return null;
  return { sig: tok.signature, token: tok.value };
}

function buildLiveUsherURL(channel, sig, token) {
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

function buildVODUsherURL(vodId, sig, token) {
  const params = new URLSearchParams({
    sig,
    token,
    player: 'twitchweb',
    allow_source: 'true',
    allow_audio_only: 'true',
    p: Math.floor(Math.random() * 1e7).toString()
  });
  return `https://usher.ttvnw.net/vod/${vodId}.m3u8?${params}`;
}

// Get channels with live status, viewer counts, thumbnails
app.get('/api/channels', async (c) => {
  try {
    const logins = c.req.query('logins')?.split(',') || [];
    if (logins.length === 0) {
      return c.json({ error: 'logins required (comma-separated)' }, 400);
    }

    // Get user IDs
    const usersData = await callHelix('users', { login: logins });
    const users = usersData.data;

    // Get live streams
    const streamData = await callHelix('streams', {
      user_login: logins
    });
    const liveStreams = new Map(streamData.data.map(s => [s.user_login, s]));

    // Combine data
    const channels = users.map(user => {
      const stream = liveStreams.get(user.login);
      return {
        id: user.id,
        login: user.login,
        display_name: user.display_name,
        profile_image_url: user.profile_image_url,
        is_live: !!stream,
        stream: stream ? {
          title: stream.title,
          game_name: stream.game_name,
          viewer_count: stream.viewer_count,
          thumbnail_url: stream.thumbnail_url,
          started_at: stream.started_at
        } : null
      };
    });

    return c.json({ channels });
  } catch (e) {
    console.error('Channels error:', e.message);
    return c.json({
      error: 'server error',
      details: e.message
    }, 500);
  }
});

// Get past broadcasts for a channel
app.get('/api/videos/:channel', async (c) => {
  try {
    const channel = c.params.channel?.trim().toLowerCase();
    if (!channel) {
      return c.json({ error: 'channel required' }, 400);
    }

    // Get user ID first
    const userData = await callHelix('users', { login: [channel] });
    if (!userData.data || userData.data.length === 0) {
      return c.json({ error: 'channel not found' }, 404);
    }

    const userId = userData.data[0].id;

    // Get VODs (past broadcasts)
    const videosData = await callHelix('videos', {
      user_id: userId,
      type: 'archive',
      first: '20'
    });

    return c.json({ videos: videosData.data });
  } catch (e) {
    console.error('Videos error:', e.message);
    return c.json({
      error: 'server error',
      details: e.message
    }, 500);
  }
});

// HLS endpoint - supports both live streams and VODs
app.get('/hls', async (c) => {
  try {
    const channel = c.req.query('channel')?.trim().toLowerCase();
    const vodId = c.req.query('vod')?.trim();

    if (!channel && !vodId) {
      return c.json({ error: 'channel or vod required' }, 400);
    }

    let url;
    if (vodId) {
      // VOD playback
      const pt = await getVODPlaybackToken(vodId);
      if (!pt) {
        return c.json({ error: 'vod not found or unavailable' }, 404);
      }
      url = buildVODUsherURL(vodId, pt.sig, pt.token);
    } else {
      // Live stream playback
      const pt = await getLivePlaybackToken(channel);
      if (!pt) {
        return c.json({ error: 'offline or no token' }, 404);
      }
      url = buildLiveUsherURL(channel, pt.sig, pt.token);
    }

    return c.json({ url });
  } catch (e) {
    console.error('HLS error:', e.message);
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
    helix_configured: !!(HELIX_CLIENT_ID && HELIX_CLIENT_SECRET),
    gql_enabled: true,
    endpoints: {
      channels: '/api/channels?logins=gorgc,dota2ti,admiralbulldog',
      videos: '/api/videos/:channel (e.g., /api/videos/gorgc)',
      hls_live: '/hls?channel=CHANNEL_NAME',
      hls_vod: '/hls?vod=VOD_ID',
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
