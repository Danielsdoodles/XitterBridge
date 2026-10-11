const express = require('express');
const axios = require('axios');
const multer = require('multer');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Log incoming requests
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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json'
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

let localTimeline = [];

/**
 * Helper to parse X's complex GraphQL Tweet object into v1.1 format
 */
function parseGraphQLTweets(gqlData) {
  const tweets = [];
  try {
    const instructions = gqlData?.data?.home?.home_timeline_timeline?.timeline?.instructions || [];
    for (const inst of instructions) {
      if (inst.type === 'TimelineAddEntries') {
        for (const entry of inst.entries || []) {
          const result = entry.content?.itemContent?.tweet_results?.result;
          const legacy = result?.legacy || result?.tweet?.legacy;
          const userLegacy = result?.core?.user_results?.result?.legacy;

          if (legacy) {
            tweets.push({
              created_at: legacy.created_at,
              id: legacy.id_str ? parseInt(legacy.id_str) : Date.now(),
              id_str: legacy.id_str || Date.now().toString(),
              text: legacy.full_text || legacy.text || "",
              truncated: false,
              user: userLegacy ? {
                id: userLegacy.id_str ? parseInt(userLegacy.id_str) : 12345,
                id_str: userLegacy.id_str || "12345",
                name: userLegacy.name,
                screen_name: userLegacy.screen_name,
                profile_image_url: userLegacy.profile_image_url_https,
                profile_image_url_https: userLegacy.profile_image_url_https
              } : defaultUser,
              retweet_count: legacy.retweet_count || 0,
              favorite_count: legacy.favorite_count || 0,
              favorited: legacy.favorited || false,
              retweeted: legacy.retweeted || false
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('[XitterBridge] GraphQL parse error:', e.message);
  }
  return tweets;
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

/**
 * OAuth & Handshake
 */
app.all('/oauth/request_token', (req, res) => res.send('oauth_token=mock_req_token&oauth_token_secret=mock_req_secret&oauth_callback_confirmed=true'));
app.all('/oauth/authorize', (req, res) => res.redirect(`${req.query.oauth_callback || 'oob'}?oauth_token=mock_req_token&oauth_verifier=1234567`));
app.all('/oauth/authenticate', (req, res) => res.redirect(`${req.query.oauth_callback || 'oob'}?oauth_token=mock_req_token&oauth_verifier=1234567`));
app.all('/oauth/access_token', (req, res) => res.send(`oauth_token=mock_access_token&oauth_token_secret=mock_access_secret&user_id=12345678&screen_name=daniels_doodles`));

/**
 * Settings & User Credentials
 */
app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000, max_media_per_upload: 1, photo_size_limit: 3145728 }));
app.get('/1.1/account/settings.json', (req, res) => res.status(200).json({ screen_name: "daniels_doodles", always_use_https: true }));
app.get('/1.1/account/verify_credentials.json', (req, res) => res.status(200).json(defaultUser));
app.get('/1.1/users/show.json', (req, res) => res.status(200).json(defaultUser));

/**
 * Home Timeline (Queries Active GraphQL Endpoint)
 */
app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  let liveTweets = [];

  if (process.env.X_AUTH_TOKEN && process.env.X_CT0) {
    try {
      console.log('[XitterBridge] Querying X GraphQL HomeTimeline with cookies...');

      // Active GraphQL query for Home Timeline
      const gqlUrl = 'https://x.com/i/api/graphql/2pC8P9_k_v-R3c9N-2G01g/HomeTimeline';
      const variables = encodeURIComponent(JSON.stringify({ count: 20, includePromotedContent: false, latestControlAvailable: true }));
      const features = encodeURIComponent(JSON.stringify({ responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false }));

      const response = await axios.get(`${gqlUrl}?variables=${variables}&features=${features}`, {
        headers: getWebHeaders(),
        timeout: 7000
      });

      if (response.data) {
        liveTweets = parseGraphQLTweets(response.data);
        console.log(`[XitterBridge] Parsed ${liveTweets.length} live tweets from GraphQL response!`);
      }
    } catch (err) {
      console.error('[XitterBridge] GraphQL fetch error:', err.response?.status, err.message);
    }
  }

  return res.status(200).json([...localTimeline, ...liveTweets]);
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
 * Universal Catch-All
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