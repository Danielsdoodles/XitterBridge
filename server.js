const express = require('express');
const axios = require('axios');
const multer = require('multer');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Log incoming paths
app.use((req, res, next) => {
  console.log(`[XitterBridge] ${req.method} ${req.path}`);
  next();
});

function getWebHeaders() {
  const authToken = process.env.X_AUTH_TOKEN || '';
  const ct0 = process.env.X_CT0 || '';

  return {
    'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    'Cookie': `auth_token=${authToken}; ct0=${ct0};`,
    'x-csrf-token': ct0,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  };
}

// Fallback timeline if session cookies expire or get flagged
let localTimeline = [
  {
    created_at: new Date().toUTCString(),
    id: 999999999,
    id_str: "999999999",
    text: "🎉 XitterBridge local feed active!",
    user: { id: 12345, id_str: "12345", name: "Daniel's Doodles", screen_name: "daniels_doodles", profile_image_url_https: "" }
  }
];

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

/**
 * Mock OAuth Handshake
 */
app.all('/oauth/request_token', (req, res) => res.send('oauth_token=mock_req_token&oauth_token_secret=mock_req_secret&oauth_callback_confirmed=true'));
app.all('/oauth/authorize', (req, res) => res.redirect(`${req.query.oauth_callback || 'oob'}?oauth_token=mock_req_token&oauth_verifier=mock_verifier`));
app.all('/oauth/authenticate', (req, res) => res.redirect(`${req.query.oauth_callback || 'oob'}?oauth_token=mock_req_token&oauth_verifier=mock_verifier`));
app.all('/oauth/access_token', (req, res) => res.send(`oauth_token=mock_access_token&oauth_token_secret=mock_access_secret&user_id=12345678&screen_name=daniels_doodles`));

/**
 * Settings & Config
 */
app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000, max_media_per_upload: 1, photo_size_limit: 3145728 }));
app.get('/1.1/account/settings.json', (req, res) => res.status(200).json({ screen_name: "daniels_doodles", always_use_https: true }));
app.get('/1.1/account/verify_credentials.json', (req, res) => res.status(200).json({ id: 12345678, id_str: "12345678", name: "Daniel's Doodles", screen_name: "daniels_doodles" }));

/**
 * Home Timeline (Fetches live user posts via web cookie session)
 */
app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  try {
    if (process.env.X_AUTH_TOKEN && process.env.X_CT0) {
      console.log('[XitterBridge] Attempting live web session fetch...');
      
      const liveResponse = await axios.get('https://x.com/i/api/1.1/statuses/user_timeline.json', {
        headers: getWebHeaders(),
        params: {
          screen_name: 'daniels_doodles',
          count: 20,
          tweet_mode: 'extended'
        }
      });

      if (liveResponse.data && Array.isArray(liveResponse.data)) {
        console.log(`[XitterBridge] Successfully fetched ${liveResponse.data.length} live tweets!`);
        return res.status(200).json(liveResponse.data);
      }
    }
  } catch (err) {
    console.error('[XitterBridge] Web fetch failed:', err.response?.status, err.response?.data || err.message);
  }

  // Fallback to local timeline if live fetch fails
  return res.status(200).json(localTimeline);
});

/**
 * Post Tweet
 */
app.post('/1.1/statuses/update.json', (req, res) => {
  const tweetText = req.body.status || req.query.status || "Posted from Lumia!";
  const newTweet = {
    created_at: new Date().toUTCString(),
    id: Date.now(),
    id_str: Date.now().toString(),
    text: tweetText,
    user: { id: 12345678, id_str: "12345678", name: "Daniel's Doodles", screen_name: "daniels_doodles" }
  };
  localTimeline.unshift(newTweet);
  return res.status(200).json(newTweet);
});

/**
 * Universal Catch-All
 */
app.all('/1.1/*', (req, res) => res.status(200).json([]));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XitterBridge listening on port ${PORT}`));