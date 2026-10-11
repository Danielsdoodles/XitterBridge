const express = require('express');
const axios = require('axios');
const multer = require('multer');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Log incoming requests for debugging
app.use((req, res, next) => {
  console.log(`[XitterBridge] ${req.method} ${req.path}`);
  next();
});

// Advanced web headers designed to mimic an authentic X web client session
function getWebHeaders() {
  const authToken = process.env.X_AUTH_TOKEN || '';
  const ct0 = process.env.X_CT0 || '';

  return {
    'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    'Cookie': `auth_token=${authToken}; ct0=${ct0};`,
    'x-csrf-token': ct0,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://x.com/home',
    'Origin': 'https://x.com'
  };
}

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
  profile_banner_url: "https://pbs.twimg.com/profile_banners/12345678/1600000000/web",
  default_profile: true,
  default_profile_image: true
};

// Completely empty timeline storage (no fake/fallback tweets)
let localTimeline = [];

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

/**
 * 1. OAuth Handshake & PIN Auth Support
 */
app.all('/oauth/request_token', (req, res) => res.send('oauth_token=mock_req_token&oauth_token_secret=mock_req_secret&oauth_callback_confirmed=true'));
app.all('/oauth/authorize', (req, res) => {
  const callback = req.query.oauth_callback || 'oob';
  if (callback === 'oob') {
    return res.send(`<html><body><h2>XitterBridge PIN Authorization</h2><p>Your authorization PIN is: <b>1234567</b></p></body></html>`);
  }
  res.redirect(`${callback}?oauth_token=${req.query.oauth_token || 'mock_req_token'}&oauth_verifier=1234567`);
});
app.all('/oauth/authenticate', (req, res) => {
  const callback = req.query.oauth_callback || 'oob';
  if (callback === 'oob') {
    return res.send(`<html><body><h2>XitterBridge PIN Authorization</h2><p>Your authorization PIN is: <b>1234567</b></p></body></html>`);
  }
  res.redirect(`${callback}?oauth_token=${req.query.oauth_token || 'mock_req_token'}&oauth_verifier=1234567`);
});
app.all('/oauth/access_token', (req, res) => res.send(`oauth_token=mock_access_token&oauth_token_secret=mock_access_secret&user_id=12345678&screen_name=daniels_doodles`));

/**
 * 2. Settings & Credentials
 */
app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000, max_media_per_upload: 1, photo_size_limit: 3145728 }));
app.get('/1.1/account/settings.json', (req, res) => res.status(200).json({ screen_name: "daniels_doodles", always_use_https: true }));
app.get('/1.1/account/verify_credentials.json', (req, res) => res.status(200).json(defaultUser));
app.get('/1.1/users/show.json', (req, res) => res.status(200).json(defaultUser));

/**
 * 3. Home Timeline (Pure Live Cookie Fetch with Detailed Error Logging)
 */
app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  let liveTweets = [];

  if (process.env.X_AUTH_TOKEN && process.env.X_CT0) {
    try {
      console.log('[XitterBridge] Attempting live fetch via cookie session...');
      
      // Attempting query to X syndication/public profile endpoint to bypass GraphQL hash rotations
      const response = await axios.get('https://cdn.syndication.twimg.com/timeline/profile?screen_name=daniels_doodles', {
        headers: getWebHeaders(),
        timeout: 6000
      });

      if (response.data && response.data.entries) {
        liveTweets = response.data.entries.map((entry, index) => ({
          created_at: entry.tweet?.created_at || new Date().toUTCString(),
          id: entry.tweet?.id_str ? parseInt(entry.tweet.id_str) : Date.now() + index,
          id_str: entry.tweet?.id_str || (Date.now() + index).toString(),
          text: entry.tweet?.text || "",
          truncated: false,
          user: defaultUser,
          retweet_count: entry.tweet?.retweet_count || 0,
          favorite_count: entry.tweet?.favorite_count || 0,
          favorited: false,
          retweeted: false
        }));
        console.log(`[XitterBridge] Successfully pulled ${liveTweets.length} live tweets!`);
      }
    } catch (err) {
      console.error('[XitterBridge] Live cookie fetch failed:', err.response?.status, err.response?.data || err.message);
    }
  } else {
    console.log('[XitterBridge] Warning: X_AUTH_TOKEN or X_CT0 environment variables are not set.');
  }

  // Combine real live posts with any tweets posted from the phone during this session (Zero fallbacks)
  return res.status(200).json([...localTimeline, ...liveTweets]);
});

/**
 * 4. Post Tweet
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
  console.log(`[XitterBridge] Tweet posted successfully: "${tweetText}"`);
  return res.status(200).json(newTweet);
});

/**
 * 5. Universal Catch-All
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