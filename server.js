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
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'XitterBridge' });
});

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
 * 1. Account Settings & Help Configuration (Fixes Compose Window Crash)
 */
app.get('/1.1/help/configuration.json', (req, res) => {
  return res.status(200).json({
    dm_text_character_limit: 10000,
    max_media_per_upload: 1,
    characters_reserved_per_media: 23,
    photo_size_limit: 3145728,
    photo_sizes: {
      thumb: { w: 150, h: 150, resize: "crop" },
      small: { w: 340, h: 480, resize: "fit" },
      medium: { w: 600, h: 800, resize: "fit" },
      large: { w: 1024, h: 2048, resize: "fit" }
    }
  });
});

app.get('/1.1/account/settings.json', (req, res) => {
  return res.status(200).json({
    screen_name: "daniels_doodles",
    always_use_https: true,
    geo_enabled: false,
    protected: false
  });
});

/**
 * 2. Verify Credentials Endpoint (GET)
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
 * 3. Home Timeline Endpoint (GET)
 */
app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  return res.status(200).json(localTimeline);
});

/**
 * 4. Media Upload Endpoint (POST & GET)
 */
app.all('/1.1/media/upload.json', upload.single('media'), async (req, res) => {
  return res.status(200).json({ media_id: 123456789, media_id_string: "123456789" });
});

/**
 * 5. Post Tweet Endpoint (POST)
 */
app.post('/1.1/statuses/update.json', async (req, res) => {
  const tweetText = req.body.status || req.query.status || "Posted from Lumia!";

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

  localTimeline.unshift(newTweet);
  return res.status(200).json(newTweet);
});

/**
 * 6. Universal Catch-All Handler for ALL Other v1.1 Endpoints
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