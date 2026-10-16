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

function formatTwitterDate(dateObj) {
  try {
    const d = dateObj ? new Date(dateObj) : new Date();
    if (isNaN(d.getTime())) return "Wed Oct 10 00:00:00 +0000 2026";
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayName = days[d.getUTCDay()];
    const monthName = months[d.getUTCMonth()];
    const dayNum = String(d.getUTCDate()).padStart(2, '0');
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const mins = String(d.getUTCMinutes()).padStart(2, '0');
    const secs = String(d.getUTCSeconds()).padStart(2, '0');
    const year = d.getUTCFullYear();
    return `${dayName} ${monthName} ${dayNum} ${hours}:${mins}:${secs} +0000 ${year}`;
  } catch (e) {
    return "Wed Oct 10 00:00:00 +0000 2026";
  }
}

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
  created_at: formatTwitterDate(),
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
  profile_background_image_url_https: "http://abs.twimg.com/images/themes/theme1/bg.png",
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
let localNotifications = [];
let localDirectMessages = [];
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
    else fixed = fixed.replace(/\.(webp|png|jpeg|avif)$/i, '.jpg');
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
  
  const mediaRes = m.media_results?.result || m.media_results || {};
  const mediaLegacy = mediaRes.legacy || m.legacy || m;
  
  let rawUrl = cleanStr(
    mediaLegacy.media_url_https || 
    mediaLegacy.media_url || 
    m.media_url_https || 
    m.media_url || 
    m.url || 
    mediaRes.original_info?.url || 
    ''
  );
  if (!rawUrl) return null;

  const forcedJpg = forceJpgUrl(rawUrl);
  const httpsUrl = forcedJpg.replace(/^http:\/\//i, 'https://');
  const httpUrl = forcedJpg.replace(/^https:\/\//i, 'http://');

  let videoInfo = m.video_info || m.videoInfo || mediaLegacy.video_info || mediaRes.video_info;
  if (videoInfo && Array.isArray(videoInfo.variants)) {
    videoInfo = {
      aspect_ratio: videoInfo.aspect_ratio || [16, 9],
      duration_millis: videoInfo.duration_millis || 5000,
      variants: videoInfo.variants.map(v => ({
        bitrate: Number(v.bitrate || 2176000),
        content_type: cleanStr(v.content_type) || 'video/mp4',
        url: cleanStr(v.url) ? cleanStr(v.url).replace(/^http:\/\//i, 'https://') : ''
      })).filter(v => v.url)
    };
  } else if (m.type === 'video' || m.type === 'animated_gif' || mediaRes.__typename === 'Video' || mediaRes.__typename === 'AnimatedGif' || mediaLegacy.type === 'video') {
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
    id: Number(m.id || mediaRes.rest_id || Date.now()),
    id_str: cleanStr(m.id_str || mediaRes.rest_id || String(m.id || Date.now())),
    media_url: httpUrl,
    media_url_https: httpsUrl,
    url: cleanStr(m.url) || httpsUrl,
    display_url: cleanStr(m.display_url) || 'pic.twitter.com',
    expanded_url: cleanStr(m.expanded_url) || httpsUrl,
    type: cleanStr(m.type || mediaLegacy.type || mediaRes.__typename?.toLowerCase() || 'photo'),
    indices: Array.isArray(m.indices) ? m.indices : [0, 0],
    sizes: {
      thumb: { w: m.sizes?.thumb?.w || mediaLegacy.sizes?.thumb?.w || 150, h: m.sizes?.thumb?.h || mediaLegacy.sizes?.thumb?.h || 150, resize: 'crop' },
      small: { w: m.sizes?.small?.w || mediaLegacy.sizes?.small?.w || 680, h: m.sizes?.small?.h || mediaLegacy.sizes?.small?.h || 680, resize: 'fit' },
      medium: { w: m.sizes?.medium?.w || mediaLegacy.sizes?.medium?.w || 1200, h: m.sizes?.medium?.h || mediaLegacy.sizes?.medium?.h || 1200, resize: 'fit' },
      large: { w: m.sizes?.large?.w || mediaLegacy.sizes?.large?.w || 2048, h: m.sizes?.large?.h || mediaLegacy.sizes?.large?.h || 2048, resize: 'fit' }
    },
    video_info: videoInfo
  };
}

function sanitizeUser(u) {
  if (!u || typeof u !== 'object') return defaultUser;
  
  let rawScreen = cleanStr(u.screen_name || u.screenName || '');
  let rawName = cleanStr(u.name || '');
  let userIdStr = cleanStr(u.id_str || u.rest_id || u.id);

  if (!rawScreen || rawScreen === 'twitter_user') {
    return defaultUser;
  }

  const avatar = fixUrl(u.profile_image_url_https || u.profile_image_url) || defaultUser.profile_image_url_https;
  const banner = fixUrl(u.profile_banner_url);
  const finalIdStr = userIdStr || String(generateUniqueUserId(rawScreen));

  return {
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
    created_at: formatTwitterDate(u.created_at),
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
    profile_background_image_url_https: "http://abs.twimg.com/images/themes/theme1/bg.png",
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

  let entities = t.entities && typeof t.entities === 'object' ? JSON.parse(JSON.stringify(t.entities)) : {};
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

  let author = sanitizeUser(t.user);
  if (!author || author.screen_name === 'danieldoodl5802') {
    const hashNum = Math.abs(Number(safeId) || 123456789) % 5;
    const mockAccounts = [
      { name: "Windows Phone", screen_name: "windowsphone", avatar: "https://pbs.twimg.com/profile_images/1/windowsphone_normal.png" },
      { name: "Lumia Support", screen_name: "lumiasupport", avatar: "https://pbs.twimg.com/profile_images/2/lumia_normal.png" },
      { name: "Metro Design", screen_name: "metroui", avatar: "https://pbs.twimg.com/profile_images/3/metro_normal.png" },
      { name: "X Developer", screen_name: "xdevelopers", avatar: "https://pbs.twimg.com/profile_images/4/dev_normal.png" },
      { name: "Tech News", screen_name: "technews", avatar: "https://pbs.twimg.com/profile_images/5/tech_normal.png" }
    ];
    const chosen = mockAccounts[hashNum];
    author = sanitizeUser({
      id: generateUniqueUserId(chosen.screen_name),
      id_str: String(generateUniqueUserId(chosen.screen_name)),
      name: chosen.name,
      screen_name: chosen.screen_name,
      profile_image_url_https: chosen.avatar
    });
  }

  return {
    created_at: formatTwitterDate(t.created_at),
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

function formatDirectMessage(id, text, sender, recipient, createdAt) {
  const safeSender = sanitizeUser(sender || defaultUser);
  const safeRecipient = sanitizeUser(recipient || defaultUser);
  const msgIdStr = String(id || Date.now());

  return {
    id: Number(msgIdStr.slice(-9)) || 123456,
    id_str: msgIdStr,
    text: text,
    sender_id: safeSender.id,
    sender_id_str: safeSender.id_str,
    sender_screen_name: safeSender.screen_name,
    sender: safeSender,
    recipient_id: safeRecipient.id,
    recipient_id_str: safeRecipient.id_str,
    recipient_screen_name: safeRecipient.screen_name,
    recipient: safeRecipient,
    created_at: formatTwitterDate(createdAt),
    entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] }
  };
}

function getSeedDirectMessages() {
  const other = sanitizeUser({
    id: 87654321,
    id_str: "87654321",
    name: "Lumia Support",
    screen_name: "lumiasupport"
  });

  return [
    formatDirectMessage(
      "100020003",
      "Welcome to Direct Messages on Lumia!",
      other,
      defaultUser,
      new Date()
    )
  ];
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
    if (now - lastScrapeTime > 45000) { isScraping = false; } else { return; }
  }
  isScraping = true;
  lastScrapeTime = now;

  const tokens = await getTokensFromCloudflareWorker();
  if (!tokens.auth_token || !tokens.ct0) { isScraping = false; return; }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote', '--disable-extensions'],
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
    let parsedNotifications = [];
    let parsedDMs = [];

    page.on('response', async (response) => {
      try {
        const url = response.url();
        const json = await response.json().catch(() => null);
        if (!json) return;

        if (url.includes('/graphql/') && (url.includes('HomeTimeline') || url.includes('HomeLatestTimeline') || url.includes('UserTweets') || url.includes('TweetDetail') || url.includes('Notification'))) {
          const isNotif = url.includes('Notification');

          function recursiveSearch(obj) {
            if (!obj || typeof obj !== 'object') return;

            if (obj.legacy && (obj.legacy.full_text || obj.legacy.text)) {
              const legacy = obj.legacy;
              let uObj = null;
              const paths = [
                obj.core?.user_results?.result?.legacy,
                obj.core?.user_results?.result,
                obj.tweet_results?.result?.core?.user_results?.result?.legacy,
                obj.tweet_results?.result?.core?.user_results?.result,
                obj.user_results?.result?.legacy,
                obj.user_results?.result,
                obj.retweeted_status_result?.result?.core?.user_results?.result?.legacy,
                obj.retweeted_status_result?.result?.core?.user_results?.result
              ];

              for (const p of paths) {
                if (p && (p.screen_name || p.name)) { uObj = p; break; }
              }

              if (!uObj || !uObj.screen_name || uObj.screen_name === 'twitter_user') {
                function searchForUser(n) {
                  if (!n || typeof n !== 'object') return null;
                  if (n.screen_name && n.name && n.screen_name !== 'twitter_user' && (n.followers_count !== undefined || n.profile_image_url_https)) return n;
                  for (const k of Object.keys(n)) {
                    if (typeof n[k] === 'object' && n[k] !== null) {
                      const found = searchForUser(n[k]);
                      if (found) return found;
                    }
                  }
                  return null;
                }
                uObj = searchForUser(obj);
              }

              const screenName = cleanStr(uObj?.screen_name && uObj.screen_name !== 'twitter_user' ? uObj.screen_name : null);
              const name = cleanStr(uObj?.name && uObj.name !== 'twitter_user' ? uObj.name : screenName);
              const avatar = fixUrl(uObj?.profile_image_url_https || uObj?.profile_image_url);
              const restId = cleanStr(uObj?.id_str || obj.core?.user_results?.result?.rest_id || obj.user_id_str);
              const userId = restId ? parseInt(restId) : (screenName ? generateUniqueUserId(screenName) : 12345678);
              const userIdStr = restId || String(userId);

              let tweetAuthor = screenName ? sanitizeUser({
                id: userId, id_str: userIdStr, name: name || screenName, screen_name: screenName,
                profile_image_url_https: avatar, profile_image_url: avatar,
                profile_banner_url: fixUrl(uObj?.profile_banner_url), description: uObj?.description || "",
                verified: uObj?.verified || false, followers_count: uObj?.followers_count || 100, friends_count: uObj?.friends_count || 100
              }) : defaultUser;

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
                created_at: formatTwitterDate(legacy.created_at),
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
                user_id: tweetAuthor.id,
                user_id_str: tweetAuthor.id_str,
                user: tweetAuthor,
                entities: entities,
                extended_entities: extendedEntities,
                favorited: legacy.favorited || false,
                retweeted: legacy.retweeted || false,
                retweet_count: retCount,
                favorite_count: favCount,
                lang: legacy.lang || "en"
              };

              const sanitized = sanitizeTweet(rawTweet);
              parsedTweets.push(sanitized);
              if (isNotif) {
                parsedNotifications.push(sanitized);
              }
            }

            for (const key of Object.keys(obj)) {
              if (typeof obj[key] === 'object' && obj[key] !== null) recursiveSearch(obj[key]);
            }
          }
          recursiveSearch(json);
        }
      } catch (e) {}
    });

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise((resolve) => setTimeout(resolve, 4000));

    await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise((resolve) => setTimeout(resolve, 4000));

    await browser.close();

    if (parsedTweets.length > 0) {
      await appendCachedTimelineToWorker(parsedTweets);
    }
    if (parsedNotifications.length > 0) {
      const notifMap = new Map();
      localNotifications.forEach(n => notifMap.set(n.id_str || n.id, n));
      parsedNotifications.forEach(n => notifMap.set(n.id_str || n.id, n));
      localNotifications = Array.from(notifMap.values()).slice(0, 100);
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
  } finally {
    isScraping = false;
  }
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/clear-cache', async (req, res) => {
  await appendCachedTimelineToWorker([]);
  localTimeline = [];
  localNotifications = [];
  localDirectMessages = [];
  return res.send('KV Cache cleared successfully!');
});

// OAuth Redirect updated to point to your Cloudflare Worker WebAuth instance
app.all(['/oauth/authorize', '/oauth/authenticate'], (req, res) => {
  const oauthToken = req.query.oauth_token || '';
  return res.redirect(`https://xitterbridge-webauth.danielsdoodles.workers.dev/?oauth_token=${oauthToken}`);
});

app.all('/oauth/request_token', (req, res) => res.send('oauth_token=mock_req_token&oauth_token_secret=mock_req_secret&oauth_callback_confirmed=true'));

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

  if (matchedTweet && matchedTweet.user) return res.status(200).json(sanitizeUser(matchedTweet.user));

  if (screenName && screenName !== 'twitter_user') {
    const uid = generateUniqueUserId(screenName);
    return res.status(200).json(sanitizeUser({ ...defaultUser, id: uid, id_str: uid.toString(), name: screenName, screen_name: screenName }));
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
        matchedUsers.push(sanitizeUser({ ...defaultUser, id: uid, id_str: uid.toString(), name: name, screen_name: name }));
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
    try { return Number(BigInt(b.id_str || b.id) - BigInt(a.id_str || a.id)); } catch (e) { return b.id - a.id; }
  });

  const sinceId = req.query.since_id;
  const maxId = req.query.max_id;
  if (sinceId) {
    try {
      const sinceIdNum = BigInt(sinceId);
      timeline = timeline.filter(tweet => { try { return BigInt(tweet.id_str || tweet.id) > sinceIdNum; } catch (e) { return true; } });
    } catch (e) {}
  }
  if (maxId) {
    try {
      const maxIdNum = BigInt(maxId);
      timeline = timeline.filter(tweet => { try { return BigInt(tweet.id_str || tweet.id) < maxIdNum; } catch (e) { return true; } });
    } catch (e) {}
  }
  return res.status(200).json(timeline);
});

app.get('/1.1/statuses/mentions_timeline.json', async (req, res) => {
  backgroundScrape();
  const cachedTweets = await getCachedTimelineFromWorker();
  const sourceList = localNotifications.length > 0 ? localNotifications : ([...localTimeline, ...cachedTweets].length > 0 ? [...localTimeline, ...cachedTweets] : [
    sanitizeTweet({ id: "9998881", id_str: "9998881", text: "Welcome to XitterBridge notifications!", user: { id: 111, id_str: "111", name: "Lumia Bot", screen_name: "lumiabot" } })
  ]);
  return res.status(200).json(sourceList.slice(0, 30).map(t => sanitizeTweet(t)));
});

app.get('/1.1/statuses/user_timeline.json', (req, res) => res.status(200).json(localTimeline.map(t => sanitizeTweet(t))));

app.get(['/1.1/activity/about_me.json', '/1/activity/about_me.json'], async (req, res) => {
  backgroundScrape();
  const cachedTweets = await getCachedTimelineFromWorker();
  const sourceList = localNotifications.length > 0 ? localNotifications : ([...localTimeline, ...cachedTweets].length > 0 ? [...localTimeline, ...cachedTweets] : [
    sanitizeTweet({ id: "9998882", id_str: "9998882", text: "XitterBridge interaction seed", user: { id: 222, id_str: "222", name: "Daniel", screen_name: "danieldoodl5802" } })
  ]);
  
  const secondUser = sanitizeUser({ id: 87654321, id_str: "87654321", name: "Lumia Support", screen_name: "lumiasupport" });

  const activities = sourceList.slice(0, 20).map((t, idx) => ({
    action: idx % 3 === 0 ? "favorite" : (idx % 3 === 1 ? "retweet" : "mention"),
    max_position: "1234567890",
    min_position: "1234567890",
    created_at: formatTwitterDate(t.created_at),
    sources: [t.user || defaultUser, secondUser],
    targets: [t],
    target_objects: [t]
  }));

  return res.status(200).json(activities);
});

app.get(['/1.1/statuses/:id/activity/summary.json', '/1/statuses/:id/activity/summary.json'], async (req, res) => {
  const tweetId = req.params.id.replace('.json', '');
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  const found = findTweetById(allTweets, tweetId);
  return res.status(200).json({
    favoriters_count: found ? found.favorite_count : 0,
    retweeters_count: found ? found.retweet_count : 0,
    replies_count: 0,
    favoriters: [], retweeters: [], replies: []
  });
});

app.get(['/1.1/conversation/show.json', '/1/conversation/show.json', '/1.1/conversation/show/:id.json', '/1/conversation/show/:id.json', '/1.1/conversation/show/:id', '/1/conversation/show/:id'], async (req, res) => {
  const tweetId = String(req.query.id || req.params.id || '').replace('.json', '');
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  let found = findTweetById(allTweets, tweetId);

  const parentTweet = found || {
    created_at: formatTwitterDate(), id: tweetId, id_str: tweetId,
    text: "Tweet conversation loaded", full_text: "Tweet conversation loaded",
    source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
    user: defaultUser, retweet_count: 0, favorite_count: 0
  };

  const parentIdStr = String(parentTweet.id_str || parentTweet.id);
  let replies = allTweets.filter(t => {
    const replyTo = String(t.in_reply_to_status_id_str || t.in_reply_to_status_id || '');
    return replyTo === parentIdStr || replyTo.slice(-9) === parentIdStr.slice(-9);
  });

  const statuses = [sanitizeTweet(parentTweet), ...replies.map(r => sanitizeTweet(r))];
  return res.status(200).json({
    ids: statuses.map(s => s.id_str),
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
  const tweetId = String(req.params.id).replace('.json', '');
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  let found = findTweetById(allTweets, tweetId);
  
  if (!found) {
    found = {
      created_at: formatTwitterDate(), id: tweetId, id_str: tweetId,
      text: "Status detail loaded from bridge", full_text: "Status detail loaded from bridge",
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
  return res.status(200).json([{ woeid: 1, name: "Worldwide", country_code: "", parentid: 0, placeType: { code: 19, name: "Global" }, url: "http://where.yahooapis.com/v1/place/1", centroid: [0, 0] }]);
});

app.get('/1.1/trends/place.json', (req, res) => res.status(200).json([{ trends: [{ name: "#WindowsPhone", query: "%23WindowsPhone" }] }]));

app.get(['/1.1/search/tweets.json', '/1/search/tweets.json', '/1/search.json', '/1.1/search/universal.json', '/1.1/discover/universal.json'], async (req, res) => {
  const rawQuery = req.query.q || req.query.query || "";
  const query = decodeURIComponent(rawQuery).trim().toLowerCase();
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  
  let matching = allTweets;
  if (query !== '') {
    matching = allTweets.filter(t => 
      (t.text && t.text.toLowerCase().includes(query)) ||
      (t.user?.screen_name && t.user.screen_name.toLowerCase().includes(query)) ||
      (t.user?.name && t.user.name.toLowerCase().includes(query))
    );
  }

  const resultsToUse = matching.length > 0 ? matching : allTweets;
  const finalStatuses = resultsToUse.slice(0, 25).map(t => sanitizeTweet(t));
  const uniqueUsers = {};
  finalStatuses.forEach(s => { if (s.user && s.user.id_str) uniqueUsers[s.user.id_str] = s.user; });

  return res.status(200).json({
    statuses: finalStatuses,
    search_metadata: {
      completed_in: 0.025, max_id: 999999999999999999, max_id_str: "999999999999999999",
      query: query, count: finalStatuses.length, since_id: 0, since_id_str: "0",
      refresh_url: `?since_id=999999999999999999&q=${encodeURIComponent(query)}`, next_results: null
    },
    globalObjects: {
      tweets: finalStatuses.reduce((acc, t) => { acc[t.id_str] = t; return acc; }, {}),
      users: uniqueUsers
    }
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

app.post('/1.1/statuses/update.json', (req, res) => {
  const tweetText = req.body.status || req.query.status || "Posted from Lumia!";
  const inReplyToStatusId = req.body.in_reply_to_status_id || req.query.in_reply_to_status_id;

  const newTweet = sanitizeTweet({
    created_at: formatTwitterDate(), id: Date.now().toString(), id_str: Date.now().toString(),
    text: tweetText, full_text: tweetText, source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
    truncated: false, in_reply_to_status_id: inReplyToStatusId || null,
    in_reply_to_status_id_str: inReplyToStatusId ? String(inReplyToStatusId) : null,
    user: defaultUser, retweet_count: 0, favorite_count: 0,
    entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] }, favorited: false, retweeted: false
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

// Direct Message endpoints routing
function getActiveDirectMessages() {
  return localDirectMessages.length > 0 ? localDirectMessages : getSeedDirectMessages();
}

app.get(['/1.1/direct_messages.json', '/1/direct_messages.json'], (req, res) => {
  return res.status(200).json(getActiveDirectMessages());
});

app.get(['/1.1/direct_messages/sent.json', '/1/direct_messages/sent.json'], (req, res) => {
  const active = getActiveDirectMessages();
  const sent = active.filter(d => d.sender_id_str === defaultUser.id_str);
  return res.status(200).json(sent.length > 0 ? sent : active);
});

app.get(['/1.1/direct_messages/conversations.json', '/1/direct_messages/conversations/list.json', '/1.1/direct_messages/conversation.json', '/1/direct_messages/conversation.json'], (req, res) => {
  const active = getActiveDirectMessages();
  const targetUserId = req.query.user_id || req.query.screen_name;
  if (!targetUserId) return res.status(200).json(active);
  
  const conversation = active.filter(d => 
    d.sender_id_str === String(targetUserId) || 
    d.recipient_id_str === String(targetUserId) ||
    d.sender_screen_name.toLowerCase() === String(targetUserId).toLowerCase() ||
    d.recipient_screen_name.toLowerCase() === String(targetUserId).toLowerCase()
  );

  return res.status(200).json(conversation.length > 0 ? conversation : active);
});

app.get(['/1.1/direct_messages/events/list.json', '/1/direct_messages/events/list.json'], (req, res) => {
  const active = getActiveDirectMessages();
  const events = active.map(d => ({
    type: "message_create",
    id: d.id_str,
    created_timestamp: String(new Date(d.created_at).getTime() || Date.now()),
    message_create: {
      target: { recipient_id: d.recipient_id_str },
      sender_id: d.sender_id_str,
      message_data: {
        text: d.text,
        entities: d.entities
      }
    }
  }));

  return res.status(200).json({ events: events, next_cursor: null });
});

app.post(['/1.1/direct_messages/new.json', '/1.1/direct_messages/events/new.json', '/1/direct_messages/new.json'], (req, res) => {
  const text = req.body?.text || req.body?.status || req.body?.event?.message_create?.message_data?.text || "Hello from Lumia!";
  const recipientScreen = req.body?.screen_name || req.body?.user_id || "lumiasupport";

  const recipientUser = sanitizeUser({
    id: generateUniqueUserId(recipientScreen),
    id_str: String(generateUniqueUserId(recipientScreen)),
    name: recipientScreen,
    screen_name: recipientScreen
  });

  const newDM = formatDirectMessage(
    Date.now().toString(),
    text,
    defaultUser,
    recipientUser,
    new Date()
  );

  localDirectMessages.unshift(newDM);

  return res.status(200).json({
    event: {
      type: "message_create",
      id: newDM.id_str,
      created_timestamp: String(Date.now()),
      message_create: {
        target: { recipient_id: recipientUser.id_str },
        sender_id: defaultUser.id_str,
        message_data: { text: text }
      }
    },
    ...newDM
  });
});

app.all('*', (req, res) => {
  const path = req.path;
  console.log(`[XitterBridge] Unhandled endpoint hit: ${path}`);
  if (path.includes('/ids')) return res.status(200).json({ ids: [], previous_cursor: 0, next_cursor: 0, previous_cursor_str: "0", next_cursor_str: "0" });
  if (path.includes('/list') || path.includes('/timeline') || path.includes('/lookup')) return res.status(200).json([]);
  return res.status(200).json({});
});

app.use((err, req, res, next) => {
  console.error(`[XitterBridge CRASH CAUGHT] Endpoint: ${req.method} ${req.url}`);
  console.error(err.stack || err);
  res.status(200).json({ errors: [{ code: 99, message: "Bridge Diagnostic Error: " + (err.message || "Unknown error") }] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XitterBridge listening on port ${PORT}`));