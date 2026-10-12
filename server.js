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

const defaultUser = {
  id: 12345678,
  id_str: "12345678",
  name: "Daniel",
  screen_name: "danieldoodl5802",
  location: "",
  description: "Windows Phone preservation project",
  url: null,
  protected: false,
  verified: false,
  followers_count: 10,
  friends_count: 10,
  listed_count: 0,
  created_at: "Wed Oct 10 00:00:00 +0000 2026",
  favourites_count: 0,
  statuses_count: 1,
  profile_image_url: "http://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
  profile_image_url_https: "http://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
  profile_banner_url: "https://pbs.twimg.com/profile_banners/12345678/1600000000/web",
  default_profile: true,
  default_profile_image: true
};

let localTimeline = [];
let isScraping = false;
let lastScrapeTime = 0;

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

async function appendCachedTimelineToWorker(newTweets) {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret || !newTweets.length) return;

  try {
    const existing = await getCachedTimelineFromWorker();
    const map = new Map();
    existing.forEach(t => map.set(t.id_str || t.id, t));
    newTweets.forEach(t => map.set(t.id_str || t.id, t));
    const merged = Array.from(map.values()).sort((a, b) => {
      try {
        return Number(BigInt(b.id_str || b.id) - BigInt(a.id_str || a.id));
      } catch (e) {
        return b.id - a.id;
      }
    });

    await fetch(`${workerUrl}/update-timeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': secret },
      body: JSON.stringify(merged.slice(0, 400))
    });
  } catch (e) {}
}

async function backgroundScrape() {
  const now = Date.now();
  if (isScraping) {
    if (now - lastScrapeTime > 45000) {
      isScraping = false;
    } else {
      return;
    }
  }
  isScraping = true;
  lastScrapeTime = now;

  const tokens = await getTokensFromCloudflareWorker();
  if (!tokens.auth_token || !tokens.ct0) {
    isScraping = false;
    return;
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-extensions'
      ],
      defaultViewport: { width: 1280, height: 800 },
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
      try {
        const url = response.url();
        if (url.includes('/graphql/') && (url.includes('HomeTimeline') || url.includes('HomeLatestTimeline') || url.includes('UserTweets'))) {
          const json = await response.json().catch(() => null);
          if (!json) return;

          function recursiveSearch(obj) {
            if (!obj || typeof obj !== 'object') return;

            if (obj.legacy && (obj.legacy.full_text || obj.legacy.text)) {
              const legacy = obj.legacy;
              
              let userLegacy = null;
              let restId = null;

              const possibleUserRes = [
                obj.core?.user_results?.result,
                obj.tweet_results?.result?.core?.user_results?.result,
                obj.user_results?.result
              ];

              for (const uRes of possibleUserRes) {
                if (uRes) {
                  userLegacy = uRes.legacy || uRes;
                  restId = uRes.rest_id || uRes.id_str;
                  break;
                }
              }

              if (!userLegacy || !userLegacy.screen_name) {
                function findUser(n) {
                  if (!n || typeof n !== 'object') return null;
                  if (n.screen_name && n.name && (n.followers_count !== undefined || n.profile_image_url_https)) return n;
                  for (const k of Object.keys(n)) {
                    if (typeof n[k] === 'object' && n[k] !== null) {
                      const res = findUser(n[k]);
                      if (res) return res;
                    }
                  }
                  return null;
                }
                userLegacy = findUser(obj);
              }

              const screenName = userLegacy?.screen_name || 'twitter_user';
              const name = userLegacy?.name || screenName;
              const avatar = userLegacy?.profile_image_url_https || defaultUser.profile_image_url_https;
              const userId = restId ? parseInt(restId) : generateUniqueUserId(screenName);
              const userIdStr = restId || userId.toString();

              let entities = legacy.entities ? JSON.parse(JSON.stringify(legacy.entities)) : { hashtags: [], symbols: [], user_mentions: [], urls: [] };
              let extendedEntities = legacy.extended_entities ? JSON.parse(JSON.stringify(legacy.extended_entities)) : (entities.media ? { media: entities.media } : undefined);

              if (extendedEntities && extendedEntities.media) {
                extendedEntities.media = extendedEntities.media.map(m => {
                  let mUrl = m.media_url_https || m.media_url || '';
                  mUrl = mUrl.split('?')[0] + '?format=jpg&name=medium';
                  const httpUrl = mUrl.replace('https://', 'http://');
                  return {
                    id: m.id ? parseInt(m.id) : Date.now(),
                    id_str: m.id_str || (m.id ? m.id.toString() : Date.now().toString()),
                    indices: m.indices || [0, 0],
                    media_url: httpUrl,
                    media_url_https: httpUrl,
                    url: m.url || '',
                    display_url: m.display_url || '',
                    expanded_url: m.expanded_url || '',
                    type: m.type || 'photo',
                    sizes: m.sizes || {
                      thumb: { w: 150, h: 150, resize: 'crop' },
                      small: { w: 680, h: 680, resize: 'fit' },
                      medium: { w: 1200, h: 1200, resize: 'fit' },
                      large: { w: 2048, h: 2048, resize: 'fit' }
                    }
                  };
                });
                entities.media = extendedEntities.media;
              }

              const tweetIdStr = legacy.id_str || Date.now().toString();
              
              // Extract accurate counts with fallbacks to other property paths if needed
              const favCount = legacy.favorite_count ?? obj.favorite_count ?? obj.unviewed_favorite_count ?? 0;
              const retCount = legacy.retweet_count ?? obj.retweet_count ?? 0;

              parsedTweets.push({
                created_at: legacy.created_at || new Date().toUTCString(),
                id: parseInt(tweetIdStr.slice(-12)) || Date.now(),
                id_str: tweetIdStr,
                text: legacy.full_text || legacy.text || "",
                source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
                truncated: false,
                in_reply_to_status_id: legacy.in_reply_to_status_id_str ? parseInt(legacy.in_reply_to_status_id_str) : null,
                in_reply_to_status_id_str: legacy.in_reply_to_status_id_str || null,
                in_reply_to_user_id: legacy.in_reply_to_user_id_str ? parseInt(legacy.in_reply_to_user_id_str) : null,
                in_reply_to_user_id_str: legacy.in_reply_to_user_id_str || null,
                in_reply_to_screen_name: legacy.in_reply_to_screen_name || null,
                user_id: userId,
                user_id_str: userIdStr,
                user: {
                  id: userId,
                  id_str: userIdStr,
                  name: name,
                  screen_name: screenName,
                  location: userLegacy?.location || "",
                  description: userLegacy?.description || "",
                  url: userLegacy?.url || null,
                  protected: userLegacy?.protected || false,
                  verified: userLegacy?.verified || false,
                  followers_count: userLegacy?.followers_count || 100,
                  friends_count: userLegacy?.friends_count || 100,
                  listed_count: userLegacy?.listed_count || 0,
                  created_at: userLegacy?.created_at || "Wed Oct 10 00:00:00 +0000 2026",
                  favourites_count: userLegacy?.favourites_count || 100,
                  statuses_count: userLegacy?.statuses_count || 100,
                  profile_image_url: avatar.replace('https://', 'http://'),
                  profile_image_url_https: avatar.replace('https://', 'http://'),
                  profile_banner_url: userLegacy?.profile_banner_url || null,
                  default_profile: userLegacy?.default_profile || false,
                  default_profile_image: userLegacy?.default_profile_image || false
                },
                entities: entities,
                extended_entities: extendedEntities,
                favorited: legacy.favorited || false,
                retweeted: legacy.retweeted || false,
                retweet_count: retCount,
                favorite_count: favCount,
                lang: legacy.lang || "en"
              });
            }

            for (const key of Object.keys(obj)) {
              if (typeof obj[key] === 'object' && obj[key] !== null) {
                recursiveSearch(obj[key]);
              }
            }
          }

          recursiveSearch(json);
        }
      } catch (e) {}
    });

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise((resolve) => setTimeout(resolve, 5000));

    for (let i = 0; i < 5; i++) {
      try {
        await page.evaluate(() => window.scrollBy(0, 1500));
      } catch (e) {}
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    await browser.close();

    if (parsedTweets.length > 0) {
      await appendCachedTimelineToWorker(parsedTweets);
    }
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  } finally {
    isScraping = false;
  }
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/clear-cache', async (req, res) => {
  await appendCachedTimelineToWorker([]);
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
  return res.send(`oauth_token=mock_access_token&oauth_token_secret=mock_access_secret&user_id=12345678&screen_name=danieldoodl5802`);
});

app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000 }));
app.get('/1.1/account/settings.json', (req, res) => res.status(200).json({ screen_name: "danieldoodl5802" }));
app.get('/1.1/application/rate_limit_status.json', (req, res) => res.status(200).json({ resources: { statuses: { "/statuses/home_timeline": { limit: 180, remaining: 180 } } } }));

app.get('/1.1/account/verify_credentials.json', (req, res) => res.status(200).json(defaultUser));

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

  if (screenName) {
    const uid = generateUniqueUserId(screenName);
    return res.status(200).json({
      ...defaultUser,
      id: uid,
      id_str: uid.toString(),
      name: screenName,
      screen_name: screenName
    });
  }

  return res.status(200).json(defaultUser);
});

app.get('/1.1/users/lookup.json', async (req, res) => {
  const screenNameQuery = req.query.screen_name;
  const cachedTweets = await getCachedTimelineFromWorker();

  if (screenNameQuery) {
    const requestedNames = screenNameQuery.split(',').map(s => s.trim().toLowerCase());
    const matchedUsers = [];

    for (const name of requestedNames) {
      const match = cachedTweets.find(t => t.user?.screen_name?.toLowerCase() === name);
      if (match && match.user) {
        matchedUsers.push(match.user);
      } else {
        const uid = generateUniqueUserId(name);
        matchedUsers.push({
          ...defaultUser,
          id: uid,
          id_str: uid.toString(),
          name: name,
          screen_name: name
        });
      }
    }
    return res.status(200).json(matchedUsers);
  }

  const users = cachedTweets.map(t => t.user).filter(Boolean);
  return res.status(200).json(users.length > 0 ? users : [defaultUser]);
});

app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  const cachedTweets = await getCachedTimelineFromWorker();
  backgroundScrape();

  let timeline = [...localTimeline, ...cachedTweets];
  
  const uniqueMap = new Map();
  timeline.forEach(t => uniqueMap.set(t.id_str || t.id, t));
  timeline = Array.from(uniqueMap.values()).sort((a, b) => {
    try {
      return Number(BigInt(b.id_str || b.id) - BigInt(a.id_str || a.id));
    } catch (e) {
      return b.id - a.id;
    }
  });

  const sinceId = req.query.since_id;
  const maxId = req.query.max_id;

  if (sinceId) {
    try {
      const sinceIdNum = BigInt(sinceId);
      timeline = timeline.filter(tweet => {
        try { return BigInt(tweet.id_str || tweet.id) > sinceIdNum; } catch (e) { return true; }
      });
    } catch (e) {}
  }

  if (maxId) {
    try {
      const maxIdNum = BigInt(maxId);
      timeline = timeline.filter(tweet => {
        try { return BigInt(tweet.id_str || tweet.id) < maxIdNum; } catch (e) { return true; }
      });
    } catch (e) {}
  }

  return res.status(200).json(timeline);
});

app.get('/1.1/statuses/mentions_timeline.json', (req, res) => res.status(200).json([]));
app.get('/1.1/statuses/user_timeline.json', (req, res) => res.status(200).json(localTimeline));

app.get('/1.1/statuses/show/:id.json', async (req, res) => {
  const tweetId = req.params.id.replace('.json', '');
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  const found = allTweets.find(t => (t.id_str === tweetId) || (t.id.toString() === tweetId));
  
  if (found) {
    return res.status(200).json(found);
  }

  return res.status(200).json({
    created_at: new Date().toUTCString(),
    id: parseInt(tweetId) || Date.now(),
    id_str: tweetId,
    text: "Media item loaded from Windows Phone bridge",
    source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
    truncated: false,
    user: defaultUser,
    retweet_count: 0,
    favorite_count: 0,
    entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] },
    favorited: false,
    retweeted: false
  });
});

app.post('/1.1/statuses/update.json', (req, res) => {
  const tweetText = req.body.status || req.query.status || "Posted from Lumia!";
  const newTweet = {
    created_at: new Date().toUTCString(),
    id: Date.now(),
    id_str: Date.now().toString(),
    text: tweetText,
    source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
    truncated: false,
    user: defaultUser,
    retweet_count: 0,
    favorite_count: 0,
    entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] },
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

app.get('/1.1/friends/list.json', (req, res) => res.status(200).json({ users: [defaultUser], next_cursor: 0 }));
app.get('/1.1/followers/list.json', (req, res) => res.status(200).json({ users: [defaultUser], next_cursor: 0 }));
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