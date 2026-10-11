const express = require('express');
const axios = require('axios');
const multer = require('multer');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Log incoming paths to track requests
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

// Compliant v1.1 User Object
const defaultUser = {
  id: 12345678,
  id_str: "12345678",
  name: "Daniel's Doodles",
  screen_name: "daniels_doodles",
  location: "",
  description: "Windows Phone preservation project",
  url: null,
  protected: false,
  followers_count: 10,
  friends_count: 10,
  listed_count: 0,
  created_at: "Wed Oct 10 00:00:00 +0000 2026",
  favourites_count: 0,
  statuses_count: 1,
  profile_image_url: "http://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
  profile_image_url_https: "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
  default_profile: true,
  default_profile_image: true
};

// Fallback timeline
let localTimeline = [
  {
    created_at: new Date().toUTCString(),
    id: 999999999,
    id_str: "999999999",
    text: "🎉 XitterBridge session active!",
    truncated: false,
    user: defaultUser,
    retweet_count: 0,
    favorite_count: 0,
    favorited: false,
    retweeted: false
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
 * Settings & Configuration
 */
app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000, max_media_per_upload: 1, photo_size_limit: 3145728 }));
app.get('/1.1/account/settings.json', (req, res) => res.status(200).json({ screen_name: "daniels_doodles", always_use_https: true }));

/**
 * Verify Credentials & User Lookup (Must return User Object, NOT Array)
 */
app.get('/1.1/account/verify_credentials.json', (req, res) => {
  return res.status(200).json(defaultUser);
});

app.get('/1.1/users/show.json', (req, res) => {
  return res.status(200).json(defaultUser);
});

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
    truncated: false,
    user: defaultUser,
    retweet_count: 0,
    favorite_count: 0,
    favorited: false,
    retweeted: false
  };
  localTimeline.unshift(newTweet);
  return res.status(200).json(newTweet);
});

/**
 * Smart Universal Catch-All
 */
app.all('/1.1/*', (req, res) => {
  const path = req.path;
  if (path.includes('users/show') || path.includes('account/verify_credentials')) {
    return res.status(200).json(defaultUser);
  }
  if (path.includes('favorites/create')) return res.status(200).json({ favorited: true });
  if (path.includes('favorites/destroy')) return res.status(200).json({ favorited: false });
  return res.status(200).json([]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XitterBridge listening on port ${PORT}`));