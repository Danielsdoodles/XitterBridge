const express = require('express');
const axios = require('axios');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const multer = require('multer');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const X_API_BASE = 'https://api.x.com';
const X_UPLOAD_BASE = 'https://upload.x.com';

// In-memory storage for tweets posted during this session
let localTimeline = [
  {
    created_at: new Date().toUTCString(),
    id: 999999999,
    id_str: "999999999",
    text: "🎉 XitterBridge local feed is active! Any status you post below will appear here instantly.",
    user: {
      id: 12345,
      id_str: "12345",
      name: "Daniel's Doodles",
      screen_name: "daniels_doodles",
      profile_image_url_https: ""
    }
  }
];

/**
 * Health check endpoint for uptime monitors
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'XitterBridge' });
});

/**
 * OAuth 1.0a Signature Generator
 */
function getOAuthHeader(url, method, keys, extraParams = {}) {
  const oauth = OAuth({
    consumer: { key: keys.consumerKey, secret: keys.consumerSecret },
    signature_method: 'HMAC-SHA1',
    hash_function(base_string, key) {
      return crypto.createHmac('sha1', key).update(base_string).digest('base64');
    },
  });

  const request_data = { url, method, data: extraParams };
  const token = { key: keys.accessToken, secret: keys.accessTokenSecret };

  return oauth.toHeader(oauth.authorize(request_data, token));
}

/**
 * Strictly enforce Render Environment Variables for all keys
 */
function getKeys(req) {
  return {
    consumerKey: process.env.X_CONSUMER_KEY,
    consumerSecret: process.env.X_CONSUMER_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
  };
}

/**
 * Mock OAuth Authentication Handshake
 */
app.all('/oauth/request_token', (req, res) => {
  res.send('oauth_token=mock_req_token&oauth_token_secret=mock_req_secret&oauth_callback_confirmed=true');
});

app.all('/oauth/authorize', (req, res) => {
  const callback = req.query.oauth_callback || 'oob';
  res.redirect(`${callback}?oauth_token=${req.query.oauth_token || 'mock_req_token'}&oauth_verifier=mock_verifier`);
});

app.all('/oauth/authenticate', (req, res) => {
  const callback = req.query.oauth_callback || 'oob';
  res.redirect(`${callback}?oauth_token=${req.query.oauth_token || 'mock_req_token'}&oauth_verifier=mock_verifier`);
});

app.all('/oauth/access_token', (req, res) => {
  const keys = getKeys(req);
  res.send(`oauth_token=${encodeURIComponent(keys.accessToken)}&oauth_token_secret=${encodeURIComponent(keys.accessTokenSecret)}&user_id=12345678&screen_name=Danielsdoodles`);
});

/**
 * 1. Verify Credentials Endpoint (GET)
 */
app.get('/1.1/account/verify_credentials.json', async (req, res) => {
  return res.status(200).json({
    id: 12345678,
    id_str: "12345678",
    name: "Daniel's Doodles",
    screen_name: "daniels_doodles",
    profile_image_url_https: ""
  });
});

/**
 * 2. Home Timeline Endpoint (GET)
 * Returns the local timeline array containing all posted tweets
 */
app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  console.log(`[XitterBridge] Serving timeline (${localTimeline.length} tweets)`);
  return res.status(200).json(localTimeline);
});

/**
 * 3. Media Upload Endpoint (POST)
 */
app.post('/1.1/media/upload.json', upload.single('media'), async (req, res) => {
  return res.status(200).json({ media_id: 123456789, media_id_string: "123456789" });
});

/**
 * 4. Post Tweet Endpoint (POST)
 * Captures outgoing tweets from the phone and adds them directly to the local feed
 */
app.post('/1.1/statuses/update.json', async (req, res) => {
  const tweetText = req.body.status || req.query.status;

  if (!tweetText) {
    return res.status(400).json({ errors: [{ message: 'Missing status parameter' }] });
  }

  const newTweetId = Date.now();
  const newTweet = {
    created_at: new Date().toUTCString(),
    id: newTweetId,
    id_str: newTweetId.toString(),
    text: tweetText,
    user: {
      id: 12345,
      id_str: "12345",
      name: "Daniel's Doodles",
      screen_name: "daniels_doodles",
      profile_image_url_https: ""
    }
  };

  // Prepend new tweet to the top of the timeline
  localTimeline.unshift(newTweet);
  console.log(`[XitterBridge] New tweet posted: "${tweetText}"`);

  return res.status(200).json(newTweet);
});

/**
 * 5. Universal Catch-All Handler for ALL Other v1.1 Endpoints
 */
app.all('/1.1/*', async (req, res) => {
  const path = req.path;
  if (path.includes('favorites/create')) return res.status(200).json({ favorited: true });
  if (path.includes('favorites/destroy')) return res.status(200).json({ favorited: false });
  if (path.includes('list') || path.includes('timeline') || path.includes('search') || path.includes('ids')) {
    return res.status(200).json([]);
  }
  return res.status(200).json({ status: 'bridged', endpoint: path });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`XitterBridge proxy listening on port ${PORT}`);
});