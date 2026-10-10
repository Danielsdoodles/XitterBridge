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
 * Extract or fall back to OAuth 1.0a Credentials
 */
function getKeys(req) {
  const authHeader = req.headers.authorization || '';
  const extractParam = (param) => {
    const match = authHeader.match(new RegExp(`${param}="([^"]+)"`));
    return match ? match[1] : null;
  };

  return {
    consumerKey: extractParam('oauth_consumer_key') || process.env.X_CONSUMER_KEY,
    consumerSecret: process.env.X_CONSUMER_SECRET,
    accessToken: extractParam('oauth_token') || process.env.X_ACCESS_TOKEN,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
  };
}

/**
 * 1. Verify Credentials Endpoint (GET)
 * Legacy: GET /1.1/account/verify_credentials.json
 */
app.get('/1.1/account/verify_credentials.json', async (req, res) => {
  try {
    const keys = getKeys(req);
    const targetUrl = `${X_API_BASE}/2/users/me?user.fields=profile_image_url,name,username`;
    const authHeaders = getOAuthHeader(targetUrl, 'GET', keys);

    const xResponse = await axios.get(targetUrl, {
      headers: { ...authHeaders },
    });

    const userData = xResponse.data.data;
    const v11User = {
      id: parseInt(userData.id, 10),
      id_str: userData.id,
      name: userData.name,
      screen_name: userData.username,
      profile_image_url_https: userData.profile_image_url || '',
    };

    return res.status(200).json(v11User);
  } catch (err) {
    const status = err.response?.status || 500;
    const errorData = err.response?.data || { error: err.message };
    return res.status(status).json(errorData);
  }
});

/**
 * 2. Home Timeline Endpoint (GET)
 * Legacy: GET /1.1/statuses/home_timeline.json
 */
app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  try {
    const keys = getKeys(req);
    
    // Get user ID first
    const meUrl = `${X_API_BASE}/2/users/me`;
    const meAuth = getOAuthHeader(meUrl, 'GET', keys);
    const meRes = await axios.get(meUrl, { headers: { ...meAuth } });
    const userId = meRes.data.data.id;

    const targetUrl = `${X_API_BASE}/2/users/${userId}/timelines/home_timeline?tweet.fields=created_at,text,author_id&expansions=author_id&user.fields=name,username,profile_image_url`;
    const authHeaders = getOAuthHeader(targetUrl, 'GET', keys);

    const xResponse = await axios.get(targetUrl, {
      headers: { ...authHeaders },
    });

    const tweets = xResponse.data.data || [];
    const users = xResponse.data.includes?.users || [];
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u; });

    const v11Tweets = tweets.map(tweet => {
      const author = userMap[tweet.author_id] || {};
      return {
        created_at: tweet.created_at || new Date().toUTCString(),
        id: parseInt(tweet.id, 10),
        id_str: tweet.id,
        text: tweet.text,
        user: {
          id: parseInt(author.id || '0', 10),
          id_str: author.id || '0',
          name: author.name || 'User',
          screen_name: author.username || 'user',
          profile_image_url_https: author.profile_image_url || '',
        }
      };
    });

    return res.status(200).json(v11Tweets);
  } catch (err) {
    const status = err.response?.status || 500;
    const errorData = err.response?.data || { error: err.message };
    return res.status(status).json(errorData);
  }
});

/**
 * 3. Media Upload Endpoint (POST)
 * Legacy: POST /1.1/media/upload.json
 */
app.post('/1.1/media/upload.json', upload.single('media'), async (req, res) => {
  try {
    const keys = getKeys(req);
    const targetUrl = `${X_UPLOAD_BASE}/1.1/media/upload.json`;
    const form = new FormData();

    if (req.file) {
      form.append('media', req.file.buffer, {
        filename: req.file.originalname || 'upload.jpg',
        contentType: req.file.mimetype,
      });
    } else if (req.body.media_data) {
      form.append('media_data', req.body.media_data);
    } else {
      return res.status(400).json({ errors: [{ message: 'No media or media_data provided' }] });
    }

    const authHeaders = getOAuthHeader(targetUrl, 'POST', keys);

    const xResponse = await axios.post(targetUrl, form, {
      headers: {
        ...authHeaders,
        ...form.getHeaders(),
      },
    });

    return res.status(200).json(xResponse.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const errorData = err.response?.data || { error: err.message };
    return res.status(status).json(errorData);
  }
});

/**
 * 4. Post Tweet Endpoint (POST)
 * Legacy: POST /1.1/statuses/update.json
 */
app.post('/1.1/statuses/update.json', async (req, res) => {
  try {
    const tweetText = req.body.status || req.query.status;
    const rawMediaIds = req.body.media_ids || req.query.media_ids;

    if (!tweetText) {
      return res.status(400).json({ errors: [{ message: 'Missing status parameter' }] });
    }

    const keys = getKeys(req);
    const targetUrl = `${X_API_BASE}/2/tweets`;

    const v2Payload = { text: tweetText };

    if (rawMediaIds) {
      const mediaIdArray = typeof rawMediaIds === 'string' 
        ? rawMediaIds.split(',') 
        : rawMediaIds;
      v2Payload.media = { media_ids: mediaIdArray };
    }

    const authHeaders = getOAuthHeader(targetUrl, 'POST', keys);

    const xResponse = await axios.post(targetUrl, v2Payload, {
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
    });

    const v2Data = xResponse.data.data;

    const v11Response = {
      id_str: v2Data.id,
      id: parseInt(v2Data.id, 10),
      text: v2Data.text,
      created_at: new Date().toUTCString(),
      truncated: false,
    };

    return res.status(200).json(v11Response);
  } catch (err) {
    const status = err.response?.status || 500;
    const errorData = err.response?.data || { error: err.message };
    return res.status(status).json(errorData);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`XitterBridge proxy listening on port ${PORT}`);
});