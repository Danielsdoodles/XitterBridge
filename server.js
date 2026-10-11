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

let localTimeline = [];
let isScraping = false;
let userProfileCache = null;

// Unique integer ID generator per handle to prevent Windows Phone client aliasing
function generateUniqueUserId(screenName) {
  if (!screenName) return Math.floor(Math.random() * 800000000) + 100000000;
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
    console.log('[Worker Sync] Tokens updated successfully.');
  } catch (err) {
    console.error('[Worker Sync Error]', err.message);
  }
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
  } catch (err) {
    console.error('[Worker Sync Error]', err.message);
  }
  return { auth_token: '', ct0: '' };
}

// Fetch your actual authenticated profile using direct lightweight HTTP requests
async function fetchLiveUserAccount() {
  if (userProfileCache) return userProfileCache;

  const tokens = await getTokensFromCloudflareWorker();
  if (!tokens.auth_token || !tokens.ct0) return null;

  const cleanAuthToken = tokens.auth_token.trim();
  const cleanCt0 = tokens.ct0.trim();

  try {
    // Query X internal API for active viewer credentials
    const response = await fetch('https://x.com/i/api/1.1/account/verify_credentials.json', {
      headers: {
        'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'x-csrf-token': cleanCt0,
        'cookie': `auth_token=${cleanAuthToken}; ct0=${cleanCt0}`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'accept': '*/*',
        'referer': 'https://x.com/'
      }
    });

    if (response.ok) {
      const rawUser = await response.json();
      if (rawUser && rawUser.screen_name) {
        const userId = rawUser.id ? parseInt(rawUser.id) : generateUniqueUserId(rawUser.screen_name);
        const userIdStr = rawUser.id_str || userId.toString();
        const avatarUrl = rawUser.profile_image_url_https || rawUser.profile_image_url || "";

        userProfileCache = {
          id: userId,
          id_str: userIdStr,
          name: rawUser.name || rawUser.screen_name,
          screen_name: rawUser.screen_name,
          location: rawUser.location || "",
          description: rawUser.description || "",
          url: rawUser.url || null,
          protected: rawUser.protected || false,
          followers_count: rawUser.followers_count || 0,
          friends_count: rawUser.friends_count || 0,
          listed_count: rawUser.listed_count || 0,
          created_at: rawUser.created_at || new Date().toUTCString(),
          favourites_count: rawUser.favourites_count || 0,
          statuses_count: rawUser.statuses_count || 0,
          profile_image_url: avatarUrl.replace('https://', 'http://'),
          profile_image_url_https: avatarUrl,
          profile_banner_url: rawUser.profile_banner_url || "",
          default_profile: rawUser.default_profile || false,
          default_profile_image: rawUser.default_profile_image || false
        };
        console.log(`[Live Auth] Successfully resolved account profile: @${userProfileCache.screen_name}`);
        return userProfileCache;
      }
    } else {
      console.log(`[Live Auth Note] verify_credentials HTTP ${response.status}`);
    }
  } catch (err) {
    console.error('[Live Auth Error]', err.message);
  }

  return null;
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
    console.log('[Puppeteer] Scrape already in progress, skipping...');
    return;
  }
  isScraping = true;

  const tokens = await getTokensFromCloudflareWorker();
  if (!tokens.auth_token || !tokens.ct0) {
    console.log('[Puppeteer Error] Missing auth_token or ct0 in Worker KV!');
    isScraping = false;
    return;
  }

  console.log('[Puppeteer] Starting background timeline scrape...');
  let browser;
  
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Scrape operation timed out after 25s')), 25000)
  );

  const scrapeTask = (async () => {
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    await page.setCookie(
      { name: 'auth_token', value: tokens.auth_token.trim(), domain: '.x.com', path: '/' },
      { name: 'ct0', value: tokens.ct0.trim(), domain: '.x.com', path: '/' }
    );

    let parsedTweets = [];

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/graphql/') && (url.includes('HomeTimeline') || url.includes('HomeLatestTimeline'))) {
        try {
          const json = await response.json();
          const instructions = json?.data?.home?.home_timeline_urt?.instructions || [];
          for (const instr of instructions) {
            if (instr.type === 'TimelineAddEntries') {
              instr.entries?.forEach((entry, idx) => {
                const tweetResult = entry?.content?.itemContent?.tweet_results?.result;
                const legacy = tweetResult?.legacy || tweetResult?.tweet?.legacy;
                
                const userResults = 
                  tweetResult?.core?.user_results?.result || 
                  tweetResult?.tweet?.core?.user_results?.result;
                const userLegacy = userResults?.legacy;

                if (legacy && userLegacy && userLegacy.screen_name) {
                  const authorScreenName = userLegacy.screen_name;
                  const authorName = userLegacy.name || authorScreenName;
                  const authorUserId = userResults?.rest_id ? parseInt(userResults.rest_id) : generateUniqueUserId(authorScreenName);
                  const authorUserIdStr = userResults?.rest_id || authorUserId.toString();
                  const authorAvatar = userLegacy.profile_image_url_https || "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png";

                  parsedTweets.push({
                    created_at: legacy.created_at || new Date().toUTCString(),
                    id: legacy.id_str ? parseInt(legacy.id_str) : Date.now() + idx,
                    id_str: legacy.id_str || (Date.now() + idx).toString(),
                    text: legacy.full_text || legacy.text || "",
                    truncated: false,
                    user_id: authorUserId,
                    user_id_str: authorUserIdStr,
                    user: {
                      id: authorUserId,
                      id_str: authorUserIdStr,
                      name: authorName,
                      screen_name: authorScreenName,
                      location: userLegacy.location || "",
                      description: userLegacy.description || "",
                      url: userLegacy.url || null,
                      protected: userLegacy.protected || false,
                      followers_count: userLegacy.followers_count || 0,
                      friends_count: userLegacy.friends_count || 0,
                      listed_count: userLegacy.listed_count || 0,
                      created_at: userLegacy.created_at || "Wed Oct 10 00:00:00 +0000 2026",
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
              });
            }
          }
        } catch (e) {}
      }
    });

    console.log('[Puppeteer] Navigating to x.com/home...');
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 20000 });

    console.log('[Puppeteer] Waiting for timeline feed stream...');
    await new Promise((resolve) => setTimeout(resolve, 8000));

    await browser.close();

    if (parsedTweets.length > 0) {
      await saveCachedTimelineToWorker(parsedTweets);
      console.log(`[Puppeteer] Success! Cached ${parsedTweets.length} tweets to Worker KV.`);
    }
  });

  try {
    await Promise.race([scrapeTask, timeoutPromise]);
  } catch (err) {
    console.error('[Puppeteer Exec Error]:', err.message);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  } finally {
    isScraping = false;
  }
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/clear-cache', async (req, res) => {
  await saveCachedTimelineToWorker([]);
  localTimeline = [];
  userProfileCache = null;
  return res.send('KV Cache cleared successfully!');
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

  const liveAccount = await fetchLiveUserAccount();
  const screenName = liveAccount?.screen_name || usernameInput || "user";
  const userId = liveAccount?.id_str || "888888888";

  return res.send(`oauth_token=mock_access_token&oauth_token_secret=mock_access_secret&user_id=${userId}&screen_name=${screenName}`);
});

app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000 }));

app.get('/1.1/account/settings.json', async (req, res) => {
  const liveAccount = await fetchLiveUserAccount();
  return res.status(200).json({ screen_name: liveAccount?.screen_name || "" });
});

app.get('/1.1/application/rate_limit_status.json', (req, res) => res.status(200).json({ resources: { statuses: { "/statuses/home_timeline": { limit: 180, remaining: 180 } } } }));

app.get('/1.1/account/verify_credentials.json', async (req, res) => {
  const liveAccount = await fetchLiveUserAccount();
  if (liveAccount) return res.status(200).json(liveAccount);
  return res.status(401).json({ error: "Could not fetch live account details from X" });
});

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

  const liveAccount = await fetchLiveUserAccount();
  if (liveAccount) return res.status(200).json(liveAccount);
  return res.status(404).json({ error: "User not found" });
});

app.get('/1.1/users/lookup.json', async (req, res) => {
  const cachedTweets = await getCachedTimelineFromWorker();
  const users = cachedTweets.map(t => t.user).filter(Boolean);
  if (users.length > 0) return res.status(200).json(users);

  const liveAccount = await fetchLiveUserAccount();
  return res.status(200).json(liveAccount ? [liveAccount] : []);
});

app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  const cachedTweets = await getCachedTimelineFromWorker();
  backgroundScrape();
  return res.status(200).json([...localTimeline, ...cachedTweets]);
});

app.get('/1.1/statuses/mentions_timeline.json', (req, res) => res.status(200).json([]));
app.get('/1.1/statuses/user_timeline.json', (req, res) => res.status(200).json(localTimeline));
app.get('/1.1/statuses/show/:id.json', async (req, res) => {
  const cachedTweets = await getCachedTimelineFromWorker();
  const matched = cachedTweets.find(t => t.id_str === req.params.id);
  if (matched) return res.status(200).json(matched);
  
  const liveAccount = await fetchLiveUserAccount();
  return res.status(200).json(localTimeline[0] || liveAccount || {});
});

app.post('/1.1/statuses/update.json', async (req, res) => {
  const liveAccount = await fetchLiveUserAccount();
  const tweetText = req.body.status || req.query.status || "Posted from Lumia!";
  const newTweet = {
    created_at: new Date().toUTCString(),
    id: Date.now(),
    id_str: Date.now().toString(),
    text: tweetText,
    truncated: false,
    user_id: liveAccount?.id || 888888888,
    user_id_str: liveAccount?.id_str || "888888888",
    user: liveAccount || {},
    retweet_count: 0,
    favorite_count: 0,
    favorited: false,
    retweeted: false
  };
  localTimeline.unshift(newTweet);
  return res.status(200).json(newTweet);
});

app.post('/1.1/favorites/create.json', (req, res) => res.status(200).json({ favorited: true }));
app.post('/1.1/favorites/destroy.json', (req, res) => res.status(200).json({ favorited: false }));
app.get('/1.1/favorites/list.json', (req, res) => res.status(200).json([]));

app.get('/1.1/search/tweets.json', (req, res) => res.status(200).json({ statuses: [], search_metadata: {} }));
app.get('/1.1/trends/place.json', (req, res) => res.status(200).json([{ trends: [{ name: "#WindowsPhone", query: "%23WindowsPhone" }] }]));

app.get('/1.1/friends/list.json', async (req, res) => {
  const liveAccount = await fetchLiveUserAccount();
  return res.status(200).json({ users: liveAccount ? [liveAccount] : [], next_cursor: 0 });
});

app.get('/1.1/followers/list.json', async (req, res) => {
  const liveAccount = await fetchLiveUserAccount();
  return res.status(200).json({ users: liveAccount ? [liveAccount] : [], next_cursor: 0 });
});

app.get('/1.1/friends/ids.json', async (req, res) => {
  const liveAccount = await fetchLiveUserAccount();
  return res.status(200).json({ ids: liveAccount ? [liveAccount.id] : [] });
});

app.get('/1.1/followers/ids.json', async (req, res) => {
  const liveAccount = await fetchLiveUserAccount();
  return res.status(200).json({ ids: liveAccount ? [liveAccount.id] : [] });
});

app.get('/1.1/direct_messages/events/list.json', (req, res) => res.status(200).json({ events: [] }));
app.post('/1.1/direct_messages/events/new.json', (req, res) => res.status(200).json({ event: { type: "message_create", id: "12345" } }));
app.get('/1.1/direct_messages.json', (req, res) => res.status(200).json([]));
app.get('/1.1/direct_messages/sent.json', (req, res) => res.status(200).json([]));
app.get('/1.1/activity/about_me.json', (req, res) => res.status(200).json([]));

app.all('/1.1/*', (req, res) => res.status(200).json({}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XitterBridge listening on port ${PORT}`));