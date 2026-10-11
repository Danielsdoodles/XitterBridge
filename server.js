const express = require('express');
const multer = require('multer');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[XitterBridge] ${req.method} ${req.path}`);
  next();
});

const authenticatedAccount = {
  id: 12345678,
  id_str: "12345678",
  name: "Daniel",
  screen_name: "danieldoodl5802",
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

function generateUniqueUserId(screenName) {
  let hash = 0;
  for (let i = 0; i < screenName.length; i++) {
    hash = (hash << 5) - hash + screenName.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) + 800000000;
}

async function saveTokensToWorker(authToken, ct0Token) {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret) return;

  try {
    await fetch(`${workerUrl}/update-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': secret },
      body: JSON.stringify({ auth_token: authToken, ct0: ct0Token })
    });
  } catch (err) {}
}

async function getTokensFromCloudflareWorker() {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret) return { auth_token: process.env.X_AUTH_TOKEN || '', ct0: process.env.X_CT0 || '' };

  try {
    const response = await fetch(`${workerUrl}/get-tokens`, { headers: { 'X-Bridge-Secret': secret } });
    if (response.ok) {
      const data = await response.json();
      return { auth_token: data.auth_token || '', ct0: data.ct0 || '' };
    }
  } catch (err) {}
  return { auth_token: '', ct0: '' };
}

async function getCachedTimelineFromWorker() {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret) return [];

  try {
    const response = await fetch(`${workerUrl}/get-timeline`, { headers: { 'X-Bridge-Secret': secret } });
    if (response.ok) return await response.json();
  } catch (e) {}
  return [];
}

async function saveCachedTimelineToWorker(tweets) {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret || !tweets.length) return;

  try {
    await fetch(`${workerUrl}/update-timeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': secret },
      body: JSON.stringify(tweets)
    });
  } catch (e) {}
}

async function fetchTimelineDirectly() {
  const tokens = await getTokensFromCloudflareWorker();
  if (!tokens.auth_token || !tokens.ct0) {
    console.log('[API Error] Missing auth_token or ct0!');
    return [];
  }

  console.log('[API Fetch] Requesting home timeline directly via v1.1 REST API...');

  const cleanAuthToken = tokens.auth_token.trim();
  const cleanCt0 = tokens.ct0.trim();

  // Primary v1.1 REST home timeline endpoint with Web Client Bearer Token
  const targetUrl = 'https://api.x.com/1.1/statuses/home_timeline.json?count=20&tweet_mode=extended';

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'x-csrf-token': cleanCt0,
        'cookie': `auth_token=${cleanAuthToken}; ct0=${cleanCt0}`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'accept': '*/*',
        'referer': 'https://x.com/home'
      }
    });

    console.log(`[API Response] HTTP ${response.status} ${response.statusText}`);

    if (response.ok) {
      const rawTweets = await response.json();
      if (Array.isArray(rawTweets) && rawTweets.length > 0) {
        const parsedTweets = rawTweets.map(tweet => {
          const authorScreenName = tweet.user?.screen_name || "unknown";
          const authorName = tweet.user?.name || authorScreenName;
          const authorId = tweet.user?.id || generateUniqueUserId(authorScreenName);
          const authorIdStr = tweet.user?.id_str || authorId.toString();
          const authorAvatar = tweet.user?.profile_image_url_https || "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png";

          return {
            created_at: tweet.created_at || new Date().toUTCString(),
            id: tweet.id || Date.now(),
            id_str: tweet.id_str || Date.now().toString(),
            text: tweet.full_text || tweet.text || "",
            truncated: false,
            source: tweet.source || "<a href=\"http://twitter.com\" rel=\"nofollow\">Twitter Web Client</a>",
            user_id: authorId,
            user_id_str: authorIdStr,
            screen_name: authorScreenName,
            name: authorName,
            user: {
              id: authorId,
              id_str: authorIdStr,
              name: authorName,
              screen_name: authorScreenName,
              location: tweet.user?.location || "",
              description: tweet.user?.description || "",
              url: tweet.user?.url || null,
              protected: tweet.user?.protected || false,
              followers_count: tweet.user?.followers_count || 0,
              friends_count: tweet.user?.friends_count || 0,
              listed_count: tweet.user?.listed_count || 0,
              created_at: tweet.user?.created_at || "Wed Oct 10 00:00:00 +0000 2020",
              favourites_count: tweet.user?.favourites_count || 0,
              statuses_count: tweet.user?.statuses_count || 0,
              profile_image_url: authorAvatar.replace('https://', 'http://'),
              profile_image_url_https: authorAvatar,
              default_profile: tweet.user?.default_profile || false,
              default_profile_image: tweet.user?.default_profile_image || false
            },
            retweet_count: tweet.retweet_count || 0,
            favorite_count: tweet.favorite_count || 0,
            favorited: tweet.favorited || false,
            retweeted: tweet.retweeted || false
          };
        });

        const uniqueTweets = Array.from(new Map(parsedTweets.map(t => [t.id_str, t])).values());
        await saveCachedTimelineToWorker(uniqueTweets);
        console.log(`[API Fetch] Success! Fetched and cached ${uniqueTweets.length} live tweets.`);
        return uniqueTweets;
      }
    }
  } catch (err) {
    console.error('[API Fetch Exception]:', err.message);
  }
  return [];
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/clear-cache', async (req, res) => {
  await saveCachedTimelineToWorker([]);
  return res.send('KV Cache wiped successfully!');
});

app.get('/refresh-now', async (req, res) => {
  console.log('[Direct Refresh] Triggering API fetch...');
  const newTweets = await fetchTimelineDirectly();
  return res.json({ success: true, count: newTweets.length, tweets: newTweets });
});

app.all('/oauth/request_token', (req, res) => res.send('oauth_token=mock_req_token&oauth_token_secret=mock_req_secret&oauth_callback_confirmed=true'));
app.all('/oauth/authorize', (req, res) => res.send(`<html><body><h2>PIN</h2><p><b>1234567</b></p></body></html>`));
app.all('/oauth/authenticate', (req, res) => res.send(`<html><body><h2>PIN</h2><p><b>1234567</b></p></body></html>`));

app.all('/oauth/access_token', async (req, res) => {
  const usernameInput = req.body.x_auth_username || req.query.x_auth_username || "";
  const passwordInput = req.body.x_auth_password || req.query.x_auth_password || "";

  if (usernameInput.length > 20 && passwordInput.length > 20) {
    await saveTokensToWorker(usernameInput.trim(), passwordInput.trim());
  }
  return res.send(`oauth_token=mock_access_token&oauth_token_secret=mock_access_secret&user_id=12345678&screen_name=danieldoodl5802`);
});

app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000 }));
app.get('/1.1/account/settings.json', (req, res) => res.status(200).json({ screen_name: "danieldoodl5802" }));
app.get('/1.1/application/rate_limit_status.json', (req, res) => res.status(200).json({ resources: { statuses: { "/statuses/home_timeline": { limit: 180, remaining: 180 } } } }));

app.get('/1.1/account/verify_credentials.json', (req, res) => res.status(200).json(authenticatedAccount));

app.get('/1.1/users/show.json', async (req, res) => {
  const screenName = req.query.screen_name;
  const userId = req.query.user_id;
  const cachedTweets = await getCachedTimelineFromWorker();
  
  const matchedTweet = cachedTweets.find(t => 
    (screenName && t.user?.screen_name?.toLowerCase() === screenName.toLowerCase()) ||
    (userId && t.user?.id_str === userId.toString())
  );

  if (matchedTweet && matchedTweet.user) {
    return res.status(200).json(matchedTweet.user);
  }
  return res.status(200).json(authenticatedAccount);
});

app.get('/1.1/users/lookup.json', async (req, res) => {
  const cachedTweets = await getCachedTimelineFromWorker();
  const users = cachedTweets.map(t => t.user).filter(Boolean);
  return res.status(200).json(users.length > 0 ? users : [authenticatedAccount]);
});

app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  const cachedTweets = await getCachedTimelineFromWorker();
  fetchTimelineDirectly();
  return res.status(200).json(cachedTweets);
});

app.get('/1.1/statuses/mentions_timeline.json', (req, res) => res.status(200).json([]));
app.get('/1.1/statuses/user_timeline.json', (req, res) => res.status(200).json([]));
app.get('/1.1/statuses/show/:id.json', (req, res) => res.status(200).json(authenticatedAccount));

app.post('/1.1/statuses/update.json', (req, res) => res.status(200).json({ success: true }));
app.post('/1.1/favorites/create.json', (req, res) => res.status(200).json({ favorited: true }));
app.post('/1.1/favorites/destroy.json', (req, res) => res.status(200).json({ favorited: false }));
app.get('/1.1/favorites/list.json', (req, res) => res.status(200).json([]));

app.get('/1.1/search/tweets.json', (req, res) => res.status(200).json({ statuses: [], search_metadata: {} }));
app.get('/1.1/trends/place.json', (req, res) => res.status(200).json([{ trends: [{ name: "#WindowsPhone", query: "%23WindowsPhone" }] }]));

app.get('/1.1/friends/list.json', (req, res) => res.status(200).json({ users: [authenticatedAccount], next_cursor: 0 }));
app.get('/1.1/followers/list.json', (req, res) => res.status(200).json({ users: [authenticatedAccount], next_cursor: 0 }));
app.get('/1.1/friends/ids.json', (req, res) => res.status(200).json({ ids: [12345678] }));
app.get('/1.1/followers/ids.json', (req, res) => res.status(200).json({ ids: [12345678] }));

app.get('/1.1/direct_messages/events/list.json', (req, res) => res.status(200).json({ events: [] }));
app.post('/1.1/direct_messages/events/new.json', (req, res) => res.status(200).json({ event: { type: "message_create", id: "12345" } }));
app.get('/1.1/direct_messages.json', (req, res) => res.status(200).json([]));
app.get('/1.1/direct_messages/sent.json', (req, res) => res.status(200).json([]));
app.get('/1.1/activity/about_me.json', (req, res) => res.status(200).json([]));

app.all('/1.1/*', (req, res) => res.status(200).json({}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XitterBridge listening on port ${PORT}`));