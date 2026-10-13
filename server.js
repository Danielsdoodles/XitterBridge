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
  const nowSec = Math.floor(Date.now() / 1000);
  res.setHeader('X-Rate-Limit-Limit', '180');
  res.setHeader('X-Rate-Limit-Remaining', '175');
  res.setHeader('X-Rate-Limit-Reset', String(nowSec + 900));
  res.setHeader('X-Access-Level', 'read-write');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  
  console.log(`[XitterBridge WP CLIENT] ${req.method} ${req.originalUrl || req.url}`);
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
  followers_count: 150,
  friends_count: 150,
  listed_count: 5,
  created_at: "Wed Oct 10 00:00:00 +0000 2026",
  favourites_count: 42,
  statuses_count: 10,
  profile_image_url: "http://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
  profile_image_url_https: "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
  profile_banner_url: "https://pbs.twimg.com/profile_banners/12345678/1600000000/web",
  default_profile: true,
  default_profile_image: true,
  utc_offset: null,
  time_zone: null,
  geo_enabled: true,
  lang: "en",
  contributors_enabled: false,
  is_translator: false,
  profile_background_color: "C0DEED",
  profile_background_image_url: "http://abs.twimg.com/images/themes/theme1/bg.png",
  profile_background_image_url_https: "https://abs.twimg.com/images/themes/theme1/bg.png",
  profile_background_tile: false,
  profile_link_color: "1DA1F2",
  profile_sidebar_border_color: "C0DEED",
  profile_sidebar_fill_color: "DDEEF6",
  profile_text_color: "333333",
  profile_use_background_image: true,
  has_extended_profile: true,
  following: false,
  follow_request_sent: false,
  notifications: false,
  translator_type: "none",
  entities: { description: { urls: [] }, url: { urls: [] } }
};

let localTimeline = [];
const globalUserRegistry = new Map();
let isScraping = false;
let lastScrapeTime = 0;

function generateUniqueUserId(screenName) {
  if (!screenName || screenName === 'twitter_user') return Math.floor(Math.random() * 800000000) + 100000000;
  let hash = 0;
  for (let i = 0; i < screenName.length; i++) {
    hash = (hash << 5) - hash + screenName.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) + 800000000;
}

function cleanStr(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (typeof val === 'object') {
    if (Array.isArray(val.urls) && val.urls.length > 0) {
      return cleanStr(val.urls[0].expanded_url || val.urls[0].url);
    }
    if (typeof val.expanded_url === 'string') return val.expanded_url;
    if (typeof val.url === 'string') return val.url;
    if (typeof val.display_url === 'string') return val.display_url;
    if (typeof val.string_value === 'string') return val.string_value;
    if (typeof val.text === 'string') return val.text;
    if (Array.isArray(val) && val.length > 0) return cleanStr(val[0]);
    for (const k of Object.keys(val)) {
      if (typeof val[k] === 'string') return val[k];
    }
    return null;
  }
  return null;
}

function fixUrl(url) {
  if (!url) return '';
  let str = cleanStr(url);
  if (!str) return '';
  if (str.startsWith('//')) str = 'https:' + str;
  return str;
}

function forceJpgUrl(url) {
  if (!url) return '';
  let fixed = fixUrl(url);
  if (fixed.includes('pbs.twimg.com/media/')) {
    fixed = fixed.split('?')[0];
    if (!fixed.includes('.')) fixed += '.jpg';
    else fixed = fixed.replace(/\.(webp|png|jpeg)$/i, '.jpg');
    return fixed + '?format=jpg&name=large';
  }
  return fixed;
}

function sanitizeTweetText(text) {
  if (!text) return '';
  return text
    .replace(/https?:\/\/pic\.x\.com\/[a-zA-Z0-9]+/g, '')
    .replace(/https?:\/\/pic\.twitter\.com\/[a-zA-Z0-9]+/g, '')
    .replace(/https?:\/\/t\.co\/[a-zA-Z0-9]+(?=\s|$)/g, '')
    .trim();
}

function sanitizeMedia(m) {
  if (!m || typeof m !== 'object') return null;
  
  let rawUrl = cleanStr(m.media_url_https || m.media_url || m.url || '');
  if (!rawUrl) return null;

  const forcedJpg = forceJpgUrl(rawUrl);
  const httpsUrl = forcedJpg.replace(/^http:\/\//i, 'https://');
  const httpUrl = forcedJpg.replace(/^https:\/\//i, 'http://');

  let videoInfo = m.video_info || m.videoInfo;
  if (videoInfo && Array.isArray(videoInfo.variants)) {
    videoInfo = {
      aspect_ratio: videoInfo.aspect_ratio || [16, 9],
      duration_millis: videoInfo.duration_millis || 5000,
      variants: videoInfo.variants.map(v => ({
        bitrate: Number(v.bitrate || 2176000),
        content_type: cleanStr(v.content_type) || 'video/mp4',
        url: cleanStr(v.url) ? cleanStr(v.url).replace(/^http:\/\//i, 'https://') : ''
      }))
    };
  } else if (m.type === 'video' || m.type === 'animated_gif') {
    videoInfo = {
      aspect_ratio: [16, 9],
      duration_millis: 5000,
      variants: [{
        bitrate: 2176000,
        content_type: 'video/mp4',
        url: httpsUrl.replace(/\.[^/.]+$/, ".mp4")
      }]
    };
  }

  return {
    id: Number(m.id || Date.now()),
    id_str: cleanStr(m.id_str) || String(m.id || Date.now()),
    media_url: httpUrl,
    media_url_https: httpsUrl,
    url: cleanStr(m.url) || httpsUrl,
    display_url: cleanStr(m.display_url) || 'pic.twitter.com',
    expanded_url: cleanStr(m.expanded_url) || httpsUrl,
    type: cleanStr(m.type) || 'photo',
    indices: Array.isArray(m.indices) ? m.indices : [0, 0],
    sizes: {
      thumb: { w: m.sizes?.thumb?.w || 150, h: m.sizes?.thumb?.h || 150, resize: 'crop' },
      small: { w: m.sizes?.small?.w || 680, h: m.sizes?.small?.h || 680, resize: 'fit' },
      medium: { w: m.sizes?.medium?.w || 1200, h: m.sizes?.medium?.h || 1200, resize: 'fit' },
      large: { w: m.sizes?.large?.w || 2048, h: m.sizes?.large?.h || 2048, resize: 'fit' }
    },
    video_info: videoInfo
  };
}

function sanitizeUser(u) {
  if (!u || typeof u !== 'object') return null;
  
  let rawScreen = cleanStr(u.screen_name || u.screenName || '');
  let rawName = cleanStr(u.name || '');
  let userIdStr = cleanStr(u.id_str || u.rest_id || u.id);

  if (!rawScreen || rawScreen === 'twitter_user') return null;

  const avatar = fixUrl(u.profile_image_url_https || u.profile_image_url) || defaultUser.profile_image_url_https;
  const banner = fixUrl(u.profile_banner_url);
  const finalIdStr = userIdStr || String(generateUniqueUserId(rawScreen));

  const sanitized = {
    id: Number(finalIdStr) || 12345678,
    id_str: finalIdStr,
    name: rawName || rawScreen,
    screen_name: rawScreen,
    location: cleanStr(u.location) || "",
    description: cleanStr(u.description) || "",
    url: cleanStr(u.url) || null,
    protected: !!u.protected,
    verified: !!u.verified,
    followers_count: Number(u.followers_count ?? 100),
    friends_count: Number(u.friends_count ?? 100),
    listed_count: Number(u.listed_count ?? 0),
    created_at: cleanStr(u.created_at) || "Wed Oct 10 00:00:00 +0000 2026",
    favourites_count: Number(u.favourites_count ?? 100),
    statuses_count: Number(u.statuses_count ?? 100),
    profile_image_url: avatar,
    profile_image_url_https: avatar,
    profile_banner_url: banner,
    default_profile: !!u.default_profile,
    default_profile_image: !!u.default_profile_image,
    utc_offset: null,
    time_zone: null,
    geo_enabled: true,
    lang: "en",
    contributors_enabled: false,
    is_translator: false,
    profile_background_color: "C0DEED",
    profile_background_image_url: "http://abs.twimg.com/images/themes/theme1/bg.png",
    profile_background_image_url_https: "https://abs.twimg.com/images/themes/theme1/bg.png",
    profile_background_tile: false,
    profile_link_color: "1DA1F2",
    profile_sidebar_border_color: "C0DEED",
    profile_sidebar_fill_color: "DDEEF6",
    profile_text_color: "333333",
    profile_use_background_image: true,
    has_extended_profile: true,
    following: false,
    follow_request_sent: false,
    notifications: false,
    translator_type: "none",
    entities: u.entities || { description: { urls: [] }, url: { urls: [] } }
  };

  globalUserRegistry.set(finalIdStr, sanitized);
  globalUserRegistry.set(rawScreen.toLowerCase(), sanitized);
  return sanitized;
}

function sanitizeTweet(t) {
  if (!t || typeof t !== 'object') return t;
  
  const idStr = cleanStr(t.id_str) || String(t.id || Date.now());
  let safeId = 123456789;
  try {
    safeId = Number(idStr) || 123456789;
    if (safeId > Number.MAX_SAFE_INTEGER) {
      safeId = parseInt(idStr.slice(-9)) || 123456789;
    }
  } catch (e) {}

  let rawMediaList = [];
  if (t.extended_entities && Array.isArray(t.extended_entities.media)) {
    rawMediaList = t.extended_entities.media;
  } else if (t.entities && Array.isArray(t.entities.media)) {
    rawMediaList = t.entities.media;
  }

  const sanitizedMedia = rawMediaList.map(m => sanitizeMedia(m)).filter(Boolean);

  let entities = t.entities && typeof t.entities === 'object' ? t.entities : {};
  entities.hashtags = Array.isArray(entities.hashtags) ? entities.hashtags : [];
  entities.symbols = Array.isArray(entities.symbols) ? entities.symbols : [];
  entities.user_mentions = Array.isArray(entities.user_mentions) ? entities.user_mentions : [];
  entities.urls = Array.isArray(entities.urls) ? entities.urls.map(u => ({
    url: cleanStr(u.url) || '',
    expanded_url: fixUrl(u.expanded_url) || '',
    display_url: cleanStr(u.display_url) || '',
    indices: Array.isArray(u.indices) ? u.indices : [0, 0]
  })) : [];
  
  if (sanitizedMedia.length > 0) {
    entities.media = sanitizedMedia;
  }

  let extendedEntities = sanitizedMedia.length > 0 ? { media: sanitizedMedia } : undefined;

  const langVal = cleanStr(t.lang) || 'en';
  const rawText = cleanStr(t.text) || cleanStr(t.full_text) || '';
  const cleanedText = sanitizeTweetText(rawText);
  const replyIdStr = cleanStr(t.in_reply_to_status_id_str || t.in_reply_to_status_id);

  // Author resolution priority check
  let author = null;
  const uidStr = cleanStr(t.user_id_str || t.user?.id_str);

  if (uidStr && globalUserRegistry.has(uidStr)) {
    author = globalUserRegistry.get(uidStr);
  } else if (t.user && typeof t.user === 'object' && t.user.screen_name && t.user.screen_name !== 'twitter_user') {
    author = sanitizeUser(t.user);
  } else if (t.user?.screen_name && globalUserRegistry.has(t.user.screen_name.toLowerCase())) {
    author = globalUserRegistry.get(t.user.screen_name.toLowerCase());
  } else {
    author = defaultUser;
  }

  return {
    created_at: cleanStr(t.created_at) || new Date().toUTCString(),
    id: safeId,
    id_str: idStr,
    text: cleanedText,
    full_text: cleanedText,
    source: cleanStr(t.source) || '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
    truncated: false,
    in_reply_to_status_id: replyIdStr ? (Number(replyIdStr) > Number.MAX_SAFE_INTEGER ? parseInt(replyIdStr.slice(-9)) : Number(replyIdStr)) : null,
    in_reply_to_status_id_str: replyIdStr,
    in_reply_to_user_id: t.in_reply_to_user_id ? Number(t.in_reply_to_user_id) : null,
    in_reply_to_user_id_str: cleanStr(t.in_reply_to_user_id_str),
    in_reply_to_screen_name: cleanStr(t.in_reply_to_screen_name),
    user_id: author.id,
    user_id_str: author.id_str,
    user: author,
    geo: null,
    coordinates: null,
    place: null,
    contributors: null,
    is_quote_status: !!t.is_quote_status,
    retweet_count: Number(t.retweet_count ?? 0),
    favorite_count: Number(t.favorite_count ?? 0),
    entities: entities,
    extended_entities: extendedEntities,
    favorited: !!t.favorited,
    retweeted: !!t.retweeted,
    lang: langVal,
    metadata: {
      result_type: "recent",
      iso_language_code: langVal
    },
    possibly_sensitive: false,
    filter_level: "medium",
    retweeted_status: t.retweeted_status ? sanitizeTweet(t.retweeted_status) : null,
    quoted_status: t.quoted_status ? sanitizeTweet(t.quoted_status) : null
  };
}

function findTweetById(allTweets, idInput) {
  if (!idInput) return null;
  const cleanId = String(idInput).replace('.json', '').trim();
  return allTweets.find(t => 
    String(t.id_str) === cleanId || 
    String(t.id) === cleanId || 
    String(t.id_str).slice(-9) === cleanId.slice(-9) ||
    String(t.id).slice(-9) === cleanId.slice(-9)
  );
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
    if (response.ok) {
      const data = await response.json();
      return Array.isArray(data) ? data.map(t => sanitizeTweet(t)) : [];
    }
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
      body: JSON.stringify(merged.slice(0, 500).map(t => sanitizeTweet(t)))
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
        if (url.includes('/graphql/') && (url.includes('HomeTimeline') || url.includes('HomeLatestTimeline') || url.includes('UserTweets') || url.includes('TweetDetail'))) {
          const json = await response.json().catch(() => null);
          if (!json) return;

          function recursiveSearch(obj) {
            if (!obj || typeof obj !== 'object') return;

            // 1. HARVEST USERS FIRST: Catch any User object anywhere in graph and cache it
            if (obj.__typename === 'User' || obj.screen_name || obj.legacy?.screen_name) {
              const uObj = obj.legacy || obj;
              const rId = obj.rest_id || obj.id_str || uObj.id_str;
              if (uObj.screen_name && uObj.screen_name !== 'twitter_user') {
                sanitizeUser({
                  id_str: rId,
                  id: rId ? Number(rId) : undefined,
                  name: uObj.name,
                  screen_name: uObj.screen_name,
                  profile_image_url_https: uObj.profile_image_url_https || uObj.profile_image_url,
                  profile_banner_url: uObj.profile_banner_url,
                  description: uObj.description,
                  verified: uObj.verified,
                  followers_count: uObj.followers_count,
                  friends_count: uObj.friends_count
                });
              }
            }

            // 2. HARVEST TWEETS
            if (obj.legacy && (obj.legacy.full_text || obj.legacy.text)) {
              const legacy = obj.legacy;
              
              let userLegacy = null;
              let restId = null;

              const possibleUserRes = [
                obj.core?.user_results?.result,
                obj.tweet_results?.result?.core?.user_results?.result,
                obj.user_results?.result,
                obj.retweeted_status_result?.result?.core?.user_results?.result
              ];

              for (const uRes of possibleUserRes) {
                if (uRes) {
                  userLegacy = uRes.legacy || uRes;
                  restId = uRes.rest_id || uRes.id_str;
                  break;
                }
              }

              if (!userLegacy || !userLegacy.screen_name || userLegacy.screen_name === 'twitter_user') {
                function findUser(n) {
                  if (!n || typeof n !== 'object') return null;
                  if (n.screen_name && n.name && n.screen_name !== 'twitter_user' && (n.followers_count !== undefined || n.profile_image_url_https)) return n;
                  for (const k of Object.keys(n)) {
                    if (typeof n[k] === 'object' && n[k] !== null) {
                      const res = findUser(n[k]);
                      if (res) return res;
                    }
                  }
                  return null;
                }
                userLegacy = findUser(obj) || userLegacy;
              }

              const screenName = cleanStr(userLegacy?.screen_name && userLegacy.screen_name !== 'twitter_user' ? userLegacy.screen_name : null);
              const name = cleanStr(userLegacy?.name && userLegacy.name !== 'twitter_user' ? userLegacy.name : screenName);
              const avatar = fixUrl(userLegacy?.profile_image_url_https || userLegacy?.profile_image_url);
              const userId = restId ? parseInt(restId) : (screenName ? generateUniqueUserId(screenName) : 12345678);
              const userIdStr = restId || String(userId);

              let authorObj = null;
              if (screenName) {
                authorObj = sanitizeUser({
                  id: userId,
                  id_str: userIdStr,
                  name: name || screenName,
                  screen_name: screenName,
                  profile_image_url_https: avatar,
                  profile_image_url: avatar,
                  profile_banner_url: fixUrl(userLegacy?.profile_banner_url),
                  description: userLegacy?.description || "",
                  verified: userLegacy?.verified || false,
                  followers_count: userLegacy?.followers_count || 100,
                  friends_count: userLegacy?.friends_count || 100
                });
              }

              let entities = legacy.entities ? JSON.parse(JSON.stringify(legacy.entities)) : { hashtags: [], symbols: [], user_mentions: [], urls: [] };
              let extendedEntities = legacy.extended_entities ? JSON.parse(JSON.stringify(legacy.extended_entities)) : (entities.media ? { media: entities.media } : undefined);

              if (extendedEntities && extendedEntities.media) {
                extendedEntities.media = extendedEntities.media.map(m => sanitizeMedia(m)).filter(Boolean);
                entities.media = extendedEntities.media;
              }

              const tweetIdStr = legacy.id_str || Date.now().toString();
              const favCount = Number(legacy.favorite_count ?? obj.favorite_count ?? 0);
              const retCount = Number(legacy.retweet_count ?? obj.retweet_count ?? 0);

              const rawTweet = {
                created_at: legacy.created_at || new Date().toUTCString(),
                id: tweetIdStr,
                id_str: tweetIdStr,
                text: legacy.full_text || legacy.text || "",
                full_text: legacy.full_text || legacy.text || "",
                source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
                truncated: false,
                in_reply_to_status_id: legacy.in_reply_to_status_id_str || null,
                in_reply_to_status_id_str: legacy.in_reply_to_status_id_str || null,
                in_reply_to_user_id: legacy.in_reply_to_user_id_str || null,
                in_reply_to_user_id_str: legacy.in_reply_to_user_id_str || null,
                in_reply_to_screen_name: legacy.in_reply_to_screen_name || null,
                user_id: authorObj ? authorObj.id : 12345678,
                user_id_str: authorObj ? authorObj.id_str : "12345678",
                user: authorObj || defaultUser,
                entities: entities,
                extended_entities: extendedEntities,
                favorited: legacy.favorited || false,
                retweeted: legacy.retweeted || false,
                retweet_count: retCount,
                favorite_count: favCount,
                lang: legacy.lang || "en"
              };

              parsedTweets.push(sanitizeTweet(rawTweet));
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
    console.error('[backgroundScrape] Error:', err);
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

app.get('/1.1/account/verify_credentials.json', (req, res) => res.status(200).json(sanitizeUser(defaultUser)));
app.all('/1/account/push_destinations.json', (req, res) => res.status(200).json({ status: "ok" }));

app.all(['/1.1/users/show.json', '/1/users/show.json'], async (req, res) => {
  const screenName = req.query.screen_name || req.body?.screen_name;
  const userId = req.query.user_id || req.body?.user_id;
  const cachedTweets = await getCachedTimelineFromWorker();
  
  const matchedTweet = cachedTweets.find(t => 
    (screenName && t.user?.screen_name?.toLowerCase() === screenName.toLowerCase()) ||
    (userId && t.user?.id_str === userId.toString())
  );

  if (matchedTweet && matchedTweet.user) {
    return res.status(200).json(sanitizeUser(matchedTweet.user));
  }

  if (screenName && screenName !== 'twitter_user') {
    const uid = generateUniqueUserId(screenName);
    return res.status(200).json(sanitizeUser({
      ...defaultUser,
      id: uid,
      id_str: uid.toString(),
      name: screenName,
      screen_name: screenName
    }));
  }

  return res.status(200).json(sanitizeUser(defaultUser));
});

app.all(['/1.1/users/lookup.json', '/1/users/lookup.json'], async (req, res) => {
  const screenNameQuery = req.query.screen_name || req.body?.screen_name || req.query.user_id || req.body?.user_id;
  const cachedTweets = await getCachedTimelineFromWorker();

  if (screenNameQuery) {
    const requestedNames = String(screenNameQuery).split(',').map(s => s.trim().toLowerCase());
    const matchedUsers = [];

    for (const name of requestedNames) {
      const match = cachedTweets.find(t => t.user?.screen_name?.toLowerCase() === name || t.user?.id_str === name);
      if (match && match.user) {
        matchedUsers.push(sanitizeUser(match.user));
      } else {
        const uid = generateUniqueUserId(name);
        matchedUsers.push(sanitizeUser({
          ...defaultUser,
          id: uid,
          id_str: uid.toString(),
          name: name,
          screen_name: name
        }));
      }
    }
    return res.status(200).json(matchedUsers);
  }

  const users = cachedTweets.map(t => sanitizeUser(t.user)).filter(Boolean);
  return res.status(200).json(users.length > 0 ? users : [sanitizeUser(defaultUser)]);
});

app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  const cachedTweets = await getCachedTimelineFromWorker();
  backgroundScrape();

  let timeline = [...localTimeline, ...cachedTweets].map(t => sanitizeTweet(t));
  
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
app.get('/1.1/statuses/user_timeline.json', (req, res) => res.status(200).json(localTimeline.map(t => sanitizeTweet(t))));

app.get(['/1.1/statuses/:id/activity/summary.json', '/1/statuses/:id/activity/summary.json'], async (req, res) => {
  const tweetId = req.params.id.replace('.json', '');
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  const found = findTweetById(allTweets, tweetId);

  const favs = found ? found.favorite_count : 0;
  const rts = found ? found.retweet_count : 0;

  return res.status(200).json({
    favoriters_count: favs,
    retweeters_count: rts,
    replies_count: 0,
    favoriters: [],
    retweeters: [],
    replies: []
  });
});

app.get(['/1.1/conversation/show.json', '/1/conversation/show.json', '/1.1/conversation/show/:id.json', '/1/conversation/show/:id.json', '/1.1/conversation/show/:id', '/1/conversation/show/:id'], async (req, res) => {
  const tweetId = req.query.id || req.params.id || '';
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  
  let parentTweet = findTweetById(allTweets, tweetId);
  if (!parentTweet) {
    parentTweet = {
      created_at: new Date().toUTCString(),
      id: tweetId,
      id_str: String(tweetId).replace('.json', ''),
      text: "Thread parent loaded from bridge cache",
      full_text: "Thread parent loaded from bridge cache",
      source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
      user: defaultUser,
      retweet_count: 0,
      favorite_count: 0
    };
  }

  const parentIdStr = String(parentTweet.id_str || parentTweet.id);
  const replies = allTweets.filter(t => {
    const replyTo = String(t.in_reply_to_status_id_str || t.in_reply_to_status_id || '');
    return replyTo === parentIdStr || replyTo.slice(-9) === parentIdStr.slice(-9);
  });

  const statuses = [sanitizeTweet(parentTweet), ...replies.map(r => sanitizeTweet(r))];
  const statusIds = statuses.map(s => s.id_str);

  return res.status(200).json({
    ids: statusIds,
    statuses: statuses,
    conversation: statuses,
    descendants: replies.map(r => sanitizeTweet(r)),
    globalObjects: {
      tweets: statuses.reduce((acc, t) => { acc[t.id_str] = t; return acc; }, {}),
      users: statuses.reduce((acc, t) => { if (t.user) acc[t.user.id_str] = t.user; return acc; }, {})
    }
  });
});

app.get(['/1.1/statuses/show/:id.json', '/1.1/statuses/show/:id', '/1/statuses/show/:id.json'], async (req, res) => {
  const tweetId = req.params.id;
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  let found = findTweetById(allTweets, tweetId);
  
  if (!found) {
    found = {
      created_at: new Date().toUTCString(),
      id: tweetId,
      id_str: String(tweetId).replace('.json', ''),
      text: "Status detail loaded from bridge",
      full_text: "Status detail loaded from bridge",
      source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
      user: defaultUser
    };
  }

  return res.status(200).json(sanitizeTweet(found));
});

app.get(['/1.1/statuses/lookup.json', '/1/statuses/lookup.json'], async (req, res) => {
  const idQuery = req.query.id || req.query.map;
  const cached = await getCachedTimelineFromWorker();
  if (idQuery) {
    const ids = String(idQuery).split(',').map(s => s.trim());
    const found = cached.filter(t => ids.includes(t.id_str) || ids.includes(String(t.id)));
    return res.status(200).json(found.map(t => sanitizeTweet(t)));
  }
  return res.status(200).json([]);
});

app.get('/1.1/statuses/retweets/:id.json', (req, res) => res.status(200).json([]));
app.get('/1.1/statuses/retweeters/ids.json', (req, res) => res.status(200).json({ ids: [], previous_cursor: 0, next_cursor: 0, previous_cursor_str: "0", next_cursor_str: "0" }));
app.get('/1.1/statuses/favoriters/ids.json', (req, res) => res.status(200).json({ ids: [], previous_cursor: 0, next_cursor: 0, previous_cursor_str: "0", next_cursor_str: "0" }));

app.get(['/1.1/trends/closest.json', '/1/trends/closest.json'], (req, res) => {
  return res.status(200).json([{
    woeid: 1,
    name: "Worldwide",
    country_code: "",
    parentid: 0,
    placeType: { code: 19, name: "Global" },
    url: "http://where.yahooapis.com/v1/place/1",
    centroid: [0, 0]
  }]);
});

app.get('/1.1/trends/place.json', (req, res) => res.status(200).json([{ trends: [{ name: "#WindowsPhone", query: "%23WindowsPhone" }] }]));

app.get(['/1.1/search/universal.json', '/1/search/universal.json', '/1.1/discover/universal.json'], async (req, res) => {
  const rawQuery = req.query.q || "";
  const query = decodeURIComponent(rawQuery).trim().toLowerCase();
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  
  const matching = query !== '' ? allTweets.filter(t => t.text?.toLowerCase().includes(query)) : allTweets;
  const statuses = (matching.length > 0 ? matching : allTweets).slice(0, 15).map(t => sanitizeTweet(t));
  const users = allTweets.map(t => sanitizeUser(t.user)).filter(Boolean).slice(0, 5);

  return res.status(200).json({
    modules: [
      { type: "status", items: statuses.map(s => ({ status: { id: s.id, id_str: s.id_str } })) },
      { type: "user", items: users.map(u => ({ user: { id: u.id, id_str: u.id_str } })) }
    ],
    globalObjects: {
      tweets: statuses.reduce((acc, t) => { acc[t.id_str] = t; return acc; }, {}),
      users: users.reduce((acc, u) => { acc[u.id_str] = u; return acc; }, {})
    },
    cursor: null
  });
});

app.get(['/1.1/search/typeahead.json', '/1/search/typeahead.json'], async (req, res) => {
  const rawQuery = req.query.q || "";
  const query = decodeURIComponent(rawQuery).trim().toLowerCase();
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  
  const users = allTweets.map(t => sanitizeUser(t.user)).filter(Boolean).slice(0, 5);
  const matchingStatuses = allTweets.filter(t => query === '' || t.text?.toLowerCase().includes(query)).slice(0, 5);

  return res.status(200).json({
    users: users,
    statuses: matchingStatuses.map(t => sanitizeTweet(t)),
    topics: [{ topic: "#WindowsPhone", query: "%23WindowsPhone" }]
  });
});

app.get(['/1.1/search/tweets.json', '/1/search/tweets.json', '/1/search.json'], async (req, res) => {
  const rawQuery = req.query.q || "";
  const query = decodeURIComponent(rawQuery).trim();
  const qLower = query.toLowerCase();

  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  
  let results = allTweets;
  if (query !== '') {
    results = allTweets.filter(t => t.text && t.text.toLowerCase().includes(qLower));
  }

  const finalStatuses = (results.length > 0 ? results : allTweets).slice(0, 20).map(t => sanitizeTweet(t));
  const uniqueUsers = {};
  finalStatuses.forEach(s => {
    if (s.user && s.user.id_str) uniqueUsers[s.user.id_str] = s.user;
  });

  return res.status(200).json({
    ids: finalStatuses.map(s => s.id_str),
    statuses: finalStatuses,
    search_metadata: {
      completed_in: 0.025,
      max_id: 999999999999999999,
      max_id_str: "999999999999999999",
      query: query,
      count: finalStatuses.length,
      since_id: 0,
      since_id_str: "0",
      refresh_url: `?since_id=999999999999999999&q=${encodeURIComponent(query)}`,
      next_results: null
    },
    globalObjects: {
      tweets: finalStatuses.reduce((acc, t) => { acc[t.id_str] = t; return acc; }, {}),
      users: uniqueUsers
    }
  });
});

app.post('/1.1/statuses/update.json', (req, res) => {
  const tweetText = req.body.status || req.query.status || "Posted from Lumia!";
  const inReplyToStatusId = req.body.in_reply_to_status_id || req.query.in_reply_to_status_id;

  const newTweet = sanitizeTweet({
    created_at: new Date().toUTCString(),
    id: Date.now().toString(),
    id_str: Date.now().toString(),
    text: tweetText,
    full_text: tweetText,
    source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
    truncated: false,
    in_reply_to_status_id: inReplyToStatusId || null,
    in_reply_to_status_id_str: inReplyToStatusId ? String(inReplyToStatusId) : null,
    user: defaultUser,
    retweet_count: 0,
    favorite_count: 0,
    entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] },
    favorited: false,
    retweeted: false
  });

  localTimeline.unshift(newTweet);
  appendCachedTimelineToWorker([newTweet]);
  return res.status(200).json(newTweet);
});

app.post('/1.1/favorites/create.json', (req, res) => res.status(200).json({ favorited: true }));
app.post('/1.1/favorites/destroy.json', (req, res) => res.status(200).json({ favorited: false }));
app.get('/1.1/favorites/list.json', (req, res) => res.status(200).json([]));

app.get('/1.1/friends/list.json', (req, res) => res.status(200).json({ users: [sanitizeUser(defaultUser)], next_cursor: 0 }));
app.get('/1.1/followers/list.json', (req, res) => res.status(200).json({ users: [sanitizeUser(defaultUser)], next_cursor: 0 }));
app.get('/1.1/friends/ids.json', (req, res) => res.status(200).json({ ids: [12345678] }));
app.get('/1.1/followers/ids.json', (req, res) => res.status(200).json({ ids: [12345678] }));

app.get('/1.1/direct_messages/events/list.json', (req, res) => res.status(200).json({ events: [] }));
app.post('/1.1/direct_messages/events/new.json', (req, res) => res.status(200).json({ event: { type: "message_create", id: "12345" } }));
app.get('/1.1/direct_messages.json', (req, res) => res.status(200).json({ direct_messages: [] }));
app.get('/1.1/direct_messages/sent.json', (req, res) => res.status(200).json({ direct_messages: [] }));
app.get('/1.1/activity/about_me.json', (req, res) => res.status(200).json({ activities: [] }));

app.all('*', (req, res) => {
  const path = req.path;
  console.log(`[XitterBridge] Unhandled endpoint hit: ${path}`);
  if (path.includes('/ids')) {
    return res.status(200).json({ ids: [], previous_cursor: 0, next_cursor: 0, previous_cursor_str: "0", next_cursor_str: "0" });
  }
  if (path.includes('/list') || path.includes('/timeline') || path.includes('/lookup')) {
    return res.status(200).json([]);
  }
  return res.status(200).json({});
});

app.use((err, req, res, next) => {
  console.error(`[XitterBridge CRASH CAUGHT] Endpoint: ${req.method} ${req.url}`);
  console.error(err.stack || err);
  res.status(200).json({
    errors: [{ code: 99, message: "Bridge Diagnostic Error: " + (err.message || "Unknown error") }]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XitterBridge listening on port ${PORT}`));