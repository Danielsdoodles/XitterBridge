const express = require('express');
const multer = require('multer');
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteer = addExtra(require('puppeteer-core'));
const chromium = require('@sparticuz/chromium').default || require('@sparticuz/chromium');
require('dotenv').config();

puppeteer.use(StealthPlugin());

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

let isScraping = false;

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

async function backgroundScrape() {
  if (isScraping) {
    console.log('[Puppeteer] Scrape already in progress...');
    return [];
  }
  isScraping = true;

  const tokens = await getTokensFromCloudflareWorker();
  if (!tokens.auth_token || !tokens.ct0) {
    console.log('[Puppeteer Error] Missing auth_token or ct0!');
    isScraping = false;
    return [];
  }

  console.log('[Puppeteer] Starting timeline scrape...');
  let browser;
  let parsedTweets = [];

  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Scrape operation timed out after 30s')), 30000)
  );

  const scrapeTask = (async () => {
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    await page.setCookie(
      { name: 'auth_token', value: tokens.auth_token.trim(), domain: '.x.com', path: '/' },
      { name: 'ct0', value: tokens.ct0.trim(), domain: '.x.com', path: '/' }
    );

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/graphql/')) {
        try {
          const json = await response.json();
          JSON.stringify(json, (key, value) => {
            if (key === 'tweet_results' && value?.result) {
              const tweetResult = value.result;
              const legacy = tweetResult?.legacy || tweetResult?.tweet?.legacy;
              
              const userResults = 
                tweetResult?.core?.user_results?.result || 
                tweetResult?.tweet?.core?.user_results?.result;
              const userLegacy = userResults?.legacy;

              if (legacy && userLegacy && userLegacy.screen_name) {
                const authorScreenName = userLegacy.screen_name;
                const authorName = userLegacy.name || authorScreenName;
                const authorId = userResults.rest_id ? parseInt(userResults.rest_id) : generateUniqueUserId(authorScreenName);
                const authorIdStr = userResults.rest_id || authorId.toString();
                const authorAvatar = userLegacy.profile_image_url_https || "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png";

                parsedTweets.push({
                  created_at: legacy.created_at || new Date().toUTCString(),
                  id: legacy.id_str ? parseInt(legacy.id_str) : Date.now(),
                  id_str: legacy.id_str || Date.now().toString(),
                  text: legacy.full_text || legacy.text || "",
                  truncated: false,
                  source: legacy.source || "<a href=\"http://twitter.com\" rel=\"nofollow\">Twitter Web Client</a>",
                  user_id: authorId,
                  user_id_str: authorIdStr,
                  screen_name: authorScreenName,
                  name: authorName,
                  user: {
                    id: authorId,
                    id_str: authorIdStr,
                    name: authorName,
                    screen_name: authorScreenName,
                    location: userLegacy.location || "",
                    description: userLegacy.description || "",
                    url: userLegacy.url || null,
                    protected: userLegacy.protected || false,
                    followers_count: userLegacy.followers_count || 0,
                    friends_count: userLegacy.friends_count || 0,
                    listed_count: userLegacy.listed_count || 0,
                    created_at: userLegacy.created_at || "Wed Oct 10 00:00:00 +0000 2020",
                    favourites_count: userLegacy.favourites_count || 0,
                    statuses_count: userLegacy.statuses_count || 0,
                    profile_image_url: authorAvatar.replace('https://', 'http://'),
                    profile_image_url_https: authorAvatar,
                    default_profile: userLegacy.default_profile || false,
                    default_profile_image: userLegacy.default_profile_image || false
                  },
                  retweet_count: legacy.retweet_count || 0,
                  favorite_count: legacy.favorite_count || 0,
                  favorited: legacy.favorited || false,
                  retweeted: legacy.retweeted || false
                });
              }
            }
            return value;
          });
        } catch (e) {}
      }
    });

    console.log('[Puppeteer] Fast loading x.com/home...');
    try {
      await page.goto('https://x.com/home', { waitUntil: 'commit', timeout: 12000 });
    } catch (e) {}

    await new Promise((resolve) => setTimeout(resolve, 8000));
    await browser.close();

    if (parsedTweets.length > 0) {
      const uniqueTweets = Array.from(new Map(parsedTweets.map(t => [t.id_str, t])).values());
      await saveCachedTimelineToWorker(uniqueTweets);
      console.log(`[Puppeteer] Scrape complete! Saved ${uniqueTweets.length} live author tweets to KV.`);
      return uniqueTweets;
    } else {
      console.log('[Puppeteer Warning] 0 tweets parsed.');
      return [];
    }
  });

  try {
    return await Promise.race([scrapeTask, timeoutPromise]);
  } catch (err) {
    console.error('[Puppeteer Error]:', err.message);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    return [];
  } finally {
    isScraping = false;
  }
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/clear-cache', async (req, res) => {
  await saveCachedTimelineToWorker([]);
  return res.send('KV Cache wiped successfully!');
});

// Synchronous scrape trigger that waits until Puppeteer finishes before responding
app.get('/refresh-now', async (req, res) => {
  console.log('[Direct Refresh] Triggering synchronous scrape...');
  const newTweets = await backgroundScrape();
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
  backgroundScrape();
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