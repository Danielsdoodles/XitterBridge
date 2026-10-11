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

// Unique deterministic integer ID generator per handle to prevent Lumia author aliasing
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

async function getCachedDataFromWorker(key) {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret) return null;

  try {
    const response = await fetch(`${workerUrl}/get-${key}`, { headers: { 'X-Bridge-Secret': secret } });
    if (response.ok) return await response.json();
  } catch (e) {}
  return null;
}

async function saveCachedDataToWorker(key, payload) {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret || !payload) return;

  try {
    await fetch(`${workerUrl}/update-${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': secret },
      body: JSON.stringify(payload)
    });
  } catch (e) {}
}

async function backgroundScrape() {
  if (isScraping) {
    console.log('[Puppeteer] Scrape in progress, skipping...');
    return;
  }
  isScraping = true;

  const tokens = await getTokensFromCloudflareWorker();
  if (!tokens.auth_token || !tokens.ct0) {
    console.log('[Puppeteer Error] Missing auth_token or ct0!');
    isScraping = false;
    return;
  }

  console.log('[Puppeteer] Starting background timeline & account profile scrape...');
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
    let liveUserProfile = null;

    page.on('response', async (response) => {
      const url = response.url();
      
      // Capture live viewer profile node
      if (url.includes('/graphql/') && (url.includes('Viewer') || url.includes('Account') || url.includes('UserBy'))) {
        try {
          const json = await response.json();
          const userObj = json?.data?.viewer?.user_results?.result || json?.data?.user?.result;
          const legacy = userObj?.legacy;

          if (legacy && legacy.screen_name) {
            const userId = userObj.rest_id ? parseInt(userObj.rest_id) : generateUniqueUserId(legacy.screen_name);
            const avatar = legacy.profile_image_url_https || "";

            liveUserProfile = {
              id: userId,
              id_str: userObj.rest_id || userId.toString(),
              name: legacy.name || legacy.screen_name,
              screen_name: legacy.screen_name,
              location: legacy.location || "",
              description: legacy.description || "",
              url: legacy.url || null,
              protected: legacy.protected || false,
              followers_count: legacy.followers_count || 0,
              friends_count: legacy.friends_count || 0,
              listed_count: legacy.listed_count || 0,
              created_at: legacy.created_at || new Date().toUTCString(),
              favourites_count: legacy.favourites_count || 0,
              statuses_count: legacy.statuses_count || 0,
              profile_image_url: avatar.replace('https://', 'http://'),
              profile_image_url_https: avatar,
              profile_banner_url: legacy.profile_banner_url || "",
              default_profile: legacy.default_profile || false,
              default_profile_image: legacy.default_profile_image || false
            };
            await saveCachedDataToWorker('account', liveUserProfile);
            console.log(`[Account Scrape] Updated live account profile: @${liveUserProfile.screen_name}`);
          }
        } catch (e) {}
      }

      // Capture live timeline stream
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
                  const authorAvatar = userLegacy.profile_image_url_https || "";

                  parsedTweets.push({
                    created_at: legacy.created_at || new Date().toUTCString(),
                    id: legacy.id_str ? parseInt(legacy.id_str) : Date.now() + idx,
                    id_str: legacy.id_str || (Date.now() + idx).toString(),
                    text: legacy.full_text || legacy.text || "",
                    truncated: false,
                    source: legacy.source || "<a href=\"http://twitter.com\" rel=\"nofollow\">Twitter Web Client</a>",
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

    console.log('[Puppeteer] Waiting for feed stream...');
    await new Promise((resolve) => setTimeout(resolve, 8000));

    await browser.close();

    if (parsedTweets.length > 0) {
      await saveCachedDataToWorker('timeline', parsedTweets);
      console.log(`[Puppeteer] Success! Cached ${parsedTweets.length} live tweets to KV.`);
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

async function getLiveUserAccount() {
  const cachedAccount = await getCachedDataFromWorker('account');
  if (cachedAccount && cachedAccount.screen_name) return cachedAccount;
  
  // Fallback structure generated from input screen_name or session
  return {
    id: 12345678,
    id_str: "12345678",
    name: "User",
    screen_name: "user",
    location: "",
    description: "",
    url: null,
    protected: false,
    followers_count: 0,
    friends_count: 0,
    listed_count: 0,
    created_at: new Date().toUTCString(),
    favourites_count: 0,
    statuses_count: 0,
    profile_image_url: "http://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
    profile_image_url_https: "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
    profile_banner_url: "",
    default_profile: true,
    default_profile_image: true
  };
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/clear-cache', async (req, res) => {
  await saveCachedDataToWorker('timeline', []);
  await saveCachedDataToWorker('account', null);
  localTimeline = [];
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

  const liveAccount = await getLiveUserAccount();
  const screenName = (usernameInput && usernameInput.length < 30) ? usernameInput.trim() : liveAccount.screen_name;
  
  return res.send(`oauth_token=mock_access_token&oauth_token_secret=mock_access_secret&user_id=${liveAccount.id_str}&screen_name=${screenName}`);
});

app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000 }));

app.get('/1.1/account/settings.json', async (req, res) => {
  const account = await getLiveUserAccount();
  return res.status(200).json({ screen_name: account.screen_name });
});

app.get('/1.1/application/rate_limit_status.json', (req, res) => res.status(200).json({ resources: { statuses: { "/statuses/home_timeline": { limit: 180, remaining: 180 } } } }));

app.get('/1.1/account/verify_credentials.json', async (req, res) => {
  const account = await getLiveUserAccount();
  return res.status(200).json(account);
});

app.get('/1.1/users/show.json', async (req, res) => {
  const screenName = req.query.screen_name;
  const userId = req.query.user_id;
  const cachedTweets = await getCachedDataFromWorker('timeline') || [];
  
  const matchedTweet = cachedTweets.find(t => 
    (screenName && t.user?.screen_name?.toLowerCase() === screenName.toLowerCase()) ||
    (userId && t.user?.id_str === userId.toString())
  );

  if (matchedTweet && matchedTweet.user) {
    return res.status(200).json(matchedTweet.user);
  }

  const account = await getLiveUserAccount();
  return res.status(200).json(account);
});

app.get('/1.1/users/lookup.json', async (req, res) => {
  const cachedTweets = await getCachedDataFromWorker('timeline') || [];
  const users = cachedTweets.map(t => t.user).filter(Boolean);
  if (users.length > 0) return res.status(200).json(users);

  const account = await getLiveUserAccount();
  return res.status(200).json([account]);
});

app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  const cachedTweets = await getCachedDataFromWorker('timeline') || [];
  backgroundScrape();
  return res.status(200).json([...localTimeline, ...cachedTweets]);
});

app.get('/1.1/statuses/mentions_timeline.json', (req, res) => res.status(200).json([]));
app.get('/1.1/statuses/user_timeline.json', (req, res) => res.status(200).json(localTimeline));
app.get('/1.1/statuses/show/:id.json', async (req, res) => {
  const cachedTweets = await getCachedDataFromWorker('timeline') || [];
  const matched = cachedTweets.find(t => t.id_str === req.params.id);
  if (matched) return res.status(200).json(matched);
  
  const account = await getLiveUserAccount();
  return res.status(200).json(localTimeline[0] || account);
});

app.post('/1.1/statuses/update.json', async (req, res) => {
  const account = await getLiveUserAccount();
  const tweetText = req.body.status || req.query.status || "Posted from Lumia!";
  const newTweet = {
    created_at: new Date().toUTCString(),
    id: Date.now(),
    id_str: Date.now().toString(),
    text: tweetText,
    truncated: false,
    user_id: account.id,
    user_id_str: account.id_str,
    user: account,
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
  const account = await getLiveUserAccount();
  return res.status(200).json({ users: [account], next_cursor: 0 });
});

app.get('/1.1/followers/list.json', async (req, res) => {
  const account = await getLiveUserAccount();
  return res.status(200).json({ users: [account], next_cursor: 0 });
});

app.get('/1.1/friends/ids.json', async (req, res) => {
  const account = await getLiveUserAccount();
  return res.status(200).json({ ids: [account.id] });
});

app.get('/1.1/followers/ids.json', async (req, res) => {
  const account = await getLiveUserAccount();
  return res.status(200).json({ ids: [account.id] });
});

app.get('/1.1/direct_messages/events/list.json', (req, res) => res.status(200).json({ events: [] }));
app.post('/1.1/direct_messages/events/new.json', (req, res) => res.status(200).json({ event: { type: "message_create", id: "12345" } }));
app.get('/1.1/direct_messages.json', (req, res) => res.status(200).json([]));
app.get('/1.1/direct_messages/sent.json', (req, res) => res.status(200).json([]));
app.get('/1.1/activity/about_me.json', (req, res) => res.status(200).json([]));

app.all('/1.1/*', (req, res) => res.status(200).json({}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XitterBridge listening on port ${PORT}`));