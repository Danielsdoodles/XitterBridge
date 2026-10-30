const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
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

const globalUserMap = new Map();

let manualAuthToken = process.env.X_AUTH_TOKEN || '';
let manualCt0 = process.env.X_CT0 || '';

app.use((req, res, next) => {
  const nowSec = Math.floor(Date.now() / 1000);
  res.setHeader('X-Rate-Limit-Limit', '180');
  res.setHeader('X-Rate-Limit-Remaining', '175');
  res.setHeader('X-Rate-Limit-Reset', String(nowSec + 900));
  res.setHeader('X-Access-Level', 'read-write');
  res.setHeader('Cache-Control', 'no-cache');
  
  if (req.path.startsWith('/1.1/') || req.path.startsWith('/1/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  
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

let localTimeline = [];
let localNotifications = [];
let cachedAccountProfile = null;
let isScraping = false;
let lastScrapeTime = 0;
let currentOAuthCallback = null;

function extractOAuthParam(authHeader, paramName) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const regex = new RegExp(`${paramName}="([^"]+)"`);
  const match = authHeader.match(regex);
  return match ? decodeURIComponent(match[1]) : null;
}

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
    if (!fixed.includes('format=')) {
      const sep = fixed.includes('?') ? '&' : '?';
      fixed = `${fixed.split('?')[0]}${sep}format=jpg&name=large`;
    }
    return fixed;
  }
  return fixed;
}

function forceJpgAvatarUrl(url) {
  const defaultAvatar = "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png";
  if (!url) return defaultAvatar;
  let fixed = fixUrl(url);
  if (fixed.includes('pbs.twimg.com/profile_images/')) {
    fixed = fixed.replace(/_(normal|mini|bigger|200x200|x96)\./i, '_400x400.');
    fixed = fixed.split('?')[0];
    if (!fixed.match(/\.(jpg|jpeg|png)$/i)) {
      fixed += '.jpg';
    }
    return fixed;
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

  const cleanImageUrl = forceJpgUrl(rawUrl);
  const httpsUrl = cleanImageUrl.replace(/^http:\/\//i, 'https://');
  const httpUrl = cleanImageUrl.replace(/^https:\/\//i, 'http://');

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
  const defaultAvatar = "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png";
  const defaultUser = {
    id: 12345678,
    id_str: "12345678",
    name: "Twitter User",
    screen_name: "twitter_user",
    location: "",
    description: "",
    url: null,
    protected: false,
    verified: false,
    followers_count: 100,
    friends_count: 100,
    listed_count: 0,
    created_at: "Wed Oct 10 00:00:00 +0000 2026",
    favourites_count: 100,
    statuses_count: 100,
    profile_image_url: defaultAvatar,
    profile_image_url_https: defaultAvatar,
    profile_banner_url: "",
    default_profile: true,
    default_profile_image: true,
    utc_offset: null,
    time_zone: null,
    geo_enabled: true,
    lang: "en",
    contributors_enabled: false,
    is_translator: false,
    profile_background_color: "C0DEED",
    profile_background_image_url: "https://abs.twimg.com/images/themes/theme1/bg.png",
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
    entities: { description: { urls: [] }, url: { urls: [] } },
    status: null
  };

  if (!u || typeof u !== 'object') return defaultUser;
  
  let rawScreen = cleanStr(u.screen_name || u.screenName || u.legacy?.screen_name || '');
  let rawName = cleanStr(u.name || u.legacy?.name || '');
  let userIdStr = cleanStr(u.id_str || u.rest_id || u.id || u.legacy?.id_str);

  if (userIdStr && globalUserMap.has(userIdStr)) {
    const cached = globalUserMap.get(userIdStr);
    if (cached.screen_name && cached.screen_name !== 'twitter_user' && !cached.screen_name.startsWith('user_')) {
      return cached;
    }
  }

  if (!rawScreen || rawScreen === 'twitter_user' || rawScreen === 'x_user' || rawScreen === 'undefined' || rawScreen === 'null' || rawScreen.startsWith('user_')) {
    const fallbackId = userIdStr && userIdStr !== "12345678" ? userIdStr : String(Math.floor(Math.random() * 800000000) + 100000000);
    rawScreen = `user_${fallbackId.slice(-6)}`;
    rawName = rawName && rawName !== 'Twitter User' && !rawName.startsWith('user_') ? rawName : `User ${fallbackId.slice(-4)}`;
  } else if (!rawName || rawName.startsWith('user_') || rawName === 'Twitter User') {
    rawName = rawScreen;
  }

  const rawAvatar = u.profile_image_url_https || u.profile_image_url || u.legacy?.profile_image_url_https;
  const avatar = forceJpgAvatarUrl(rawAvatar);
  const banner = fixUrl(u.profile_banner_url || u.legacy?.profile_banner_url) || defaultUser.profile_banner_url;
  const finalIdStr = userIdStr || String(generateUniqueUserId(rawScreen));

  const sanitized = {
    ...defaultUser,
    id: Number(finalIdStr) || 12345678,
    id_str: finalIdStr,
    name: rawName,
    screen_name: rawScreen,
    location: cleanStr(u.location || u.legacy?.location) || "",
    description: cleanStr(u.description || u.legacy?.description) || "",
    url: cleanStr(u.url || u.legacy?.url) || null,
    protected: !!(u.protected || u.legacy?.protected),
    verified: !!(u.verified || u.legacy?.verified),
    followers_count: Number(u.followers_count ?? u.legacy?.followers_count ?? 100),
    friends_count: Number(u.friends_count ?? u.legacy?.friends_count ?? 100),
    listed_count: Number(u.listed_count ?? u.legacy?.listed_count ?? 0),
    created_at: formatTwitterDate(u.created_at || u.legacy?.created_at),
    favourites_count: Number(u.favourites_count ?? u.legacy?.favourites_count ?? 100),
    statuses_count: Number(u.statuses_count ?? u.legacy?.statuses_count ?? 100),
    profile_image_url: avatar,
    profile_image_url_https: avatar,
    profile_banner_url: banner,
    entities: u.entities || u.legacy?.entities || defaultUser.entities
  };

  if (finalIdStr) globalUserMap.set(finalIdStr, sanitized);
  if (rawScreen && !rawScreen.startsWith('user_')) globalUserMap.set(rawScreen.toLowerCase(), sanitized);

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

  let author = t.user ? sanitizeUser(t.user) : null;

  let rawSource = cleanStr(t.source) || '<a href="http://twitter.com" rel="nofollow">Twitter for iPhone</a>';
  if (!rawSource.includes('<a')) {
    rawSource = `<a href="http://twitter.com" rel="nofollow">${rawSource}</a>`;
  }

  return {
    created_at: formatTwitterDate(t.created_at),
    id: safeId,
    id_str: idStr,
    text: cleanedText,
    full_text: cleanedText,
    source: rawSource,
    truncated: false,
    in_reply_to_status_id: replyIdStr ? (Number(replyIdStr) > Number.MAX_SAFE_INTEGER ? parseInt(replyIdStr.slice(-9)) : Number(replyIdStr)) : null,
    in_reply_to_status_id_str: replyIdStr,
    in_reply_to_user_id: t.in_reply_to_user_id ? Number(t.in_reply_to_user_id) : null,
    in_reply_to_user_id_str: cleanStr(t.in_reply_to_user_id_str),
    in_reply_to_screen_name: cleanStr(t.in_reply_to_screen_name),
    user_id: author?.id || 0,
    user_id_str: author?.id_str || "0",
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

async function getTokens() {
  if (manualAuthToken && manualCt0) {
    return { auth_token: manualAuthToken, ct0: manualCt0 };
  }

  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (workerUrl && secret) {
    try {
      const response = await fetch(`${workerUrl}/get-tokens`, { headers: { 'X-Bridge-Secret': secret } });
      if (response.ok) {
        const data = await response.json();
        if (data.auth_token && data.ct0) {
          return { auth_token: data.auth_token, ct0: data.ct0 };
        }
      }
    } catch (err) {}
  }

  return { 
    auth_token: process.env.X_AUTH_TOKEN || '', 
    ct0: process.env.X_CT0 || '' 
  };
}

async function getCachedAccountFromWorker() {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret) return null;

  try {
    const response = await fetch(`${workerUrl}/get-account`, { headers: { 'X-Bridge-Secret': secret } });
    if (response.ok) {
      const data = await response.json();
      if (data && data.screen_name) return sanitizeUser(data);
    }
  } catch (e) {}
  return null;
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

  const tokens = await getTokens();
  console.log(`[XitterBridge Scraper] Token Check -> auth_token present: ${!!tokens.auth_token}, ct0 present: ${!!tokens.ct0}`);

  if (!tokens.auth_token || !tokens.ct0) {
    console.log(`[XitterBridge Scraper] ABORTED: Missing auth_token or ct0 cookies!`);
    isScraping = false;
    return;
  }

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

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => 'No Title');
    console.log(`[XitterBridge Scraper] Landed on URL: ${currentUrl} | Page Title: ${pageTitle}`);

    if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
      console.log(`[XitterBridge Scraper] ERROR: X redirected to Login! Session cookies may have expired.`);
      await browser.close();
      isScraping = false;
      return;
    }

    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 }).catch(() => {});
    
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 2000));
    }

    const scrapedTweets = await page.evaluate(() => {
      const items = [];
      const postElements = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));

      postElements.forEach(art => {
        try {
          let name = "";
          let screen_name = "";
          let profile_image_url_https = "";
          let id_str = "";
          let text = "";

          // Robust root-level user handle & display name scanning
          const allLinks = art.querySelectorAll('a[href^="/"]');
          for (const a of allLinks) {
            const href = a.getAttribute('href') || '';
            const parts = href.split('/').filter(Boolean);
            if (parts.length === 1 && !['home', 'explore', 'notifications', 'messages', 'settings', 'i', 'search', 'hashtag'].includes(parts[0].toLowerCase())) {
              screen_name = parts[0];
              const nameEl = a.querySelector('span') || a.previousElementSibling;
              if (nameEl && nameEl.textContent) {
                name = nameEl.textContent.trim();
              }
              break;
            }
          }

          if (!name && screen_name) name = screen_name;

          const avatarImg = art.querySelector('[data-testid="Tweet-User-Avatar"] img, [data-testid*="Avatar"] img, img[src*="profile_images"]');
          if (avatarImg && avatarImg.src) {
            profile_image_url_https = avatarImg.src;
          }

          const textDiv = art.querySelector('[data-testid="tweetText"]');
          text = textDiv ? textDiv.innerText : "";

          const statusLinks = art.querySelectorAll('a[href*="/status/"]');
          for (const l of statusLinks) {
            const m = l.href.match(/\/status\/(\d+)/);
            if (m && m[1]) {
              id_str = m[1];
              break;
            }
          }
          if (!id_str) id_str = Math.floor(Math.random() * 900000000000000000).toString();

          const media = [];
          const photos = art.querySelectorAll('[data-testid="tweetPhoto"] img');
          photos.forEach(p => {
            if (p.src) {
              media.push({
                media_url_https: p.src,
                media_url: p.src,
                type: 'photo',
                url: p.src,
                display_url: 'pic.twitter.com',
                expanded_url: p.src
              });
            }
          });

          if (screen_name) {
            items.push({
              id_str,
              text,
              created_at: new Date().toISOString(),
              user: {
                id_str: String(Math.abs(screen_name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)) + 800000000),
                name: name || screen_name,
                screen_name: screen_name,
                profile_image_url_https: profile_image_url_https || "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
                profile_image_url: profile_image_url_https || "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
                verified: !!art.querySelector('svg[aria-label="Verified account"]')
              },
              entities: { media: media.length ? media : undefined },
              extended_entities: media.length ? { media } : undefined
            });
          }
        } catch (e) {}
      });
      return items;
    });

    console.log(`[XitterBridge Scraper] Successfully extracted ${scrapedTweets.length} posts from page DOM.`);

    await browser.close();

    const sanitizedParsed = scrapedTweets.map(t => sanitizeTweet(t));
    if (sanitizedParsed.length > 0) {
      await appendCachedTimelineToWorker(sanitizedParsed);
    }
  } catch (err) {
    console.error(`[XitterBridge Scraper] Error during scraping:`, err);
    if (browser) await browser.close().catch(() => {});
  } finally {
    isScraping = false;
  }
}

getCachedAccountFromWorker().then(acc => {
  if (acc) cachedAccountProfile = acc;
});

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/set-tokens', (req, res) => {
  const token = req.query.auth_token;
  const ct0 = req.query.ct0;
  if (token && ct0) {
    manualAuthToken = token;
    manualCt0 = ct0;
    backgroundScrape();
    return res.send('Tokens set successfully! Scraping triggered in background.');
  }
  return res.send('Usage: /set-tokens?auth_token=YOUR_AUTH_TOKEN&ct0=YOUR_CT0');
});

app.get('/clear-cache', async (req, res) => {
  await appendCachedTimelineToWorker([]);
  localTimeline = [];
  localNotifications = [];
  cachedAccountProfile = null;
  globalUserMap.clear();
  return res.send('KV Cache and User Map cleared successfully!');
});

app.all(['/oauth/authorize', '/oauth/authenticate'], (req, res) => {
  const oauthToken = req.query.oauth_token || '';
  return res.redirect(`https://xitterbridge-webauth.danielsdoodles.workers.dev/?oauth_token=${oauthToken}`);
});

app.all('/oauth/request_token', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const callbackFromHeader = extractOAuthParam(authHeader, 'oauth_callback');
  const callbackFromQuery = req.query.oauth_callback || req.body.oauth_callback;
  
  const callback = callbackFromHeader || callbackFromQuery;
  if (callback && callback !== 'oob') {
    currentOAuthCallback = decodeURIComponent(callback);
  }

  const reqToken = "xitterbridge_req_token_static";
  const reqSecret = "xitterbridge_req_secret_static";
  return res.setHeader('Content-Type', 'text/html').status(200).send(`oauth_token=${reqToken}&oauth_token_secret=${reqSecret}&oauth_callback_confirmed=true`);
});

app.get('/oauth/callback', (req, res) => {
  const oauthToken = req.query.oauth_token || 'xitterbridge_req_token_static';
  const oauthVerifier = req.query.oauth_verifier || 'xitterbridge_verified';

  if (currentOAuthCallback && !currentOAuthCallback.includes('xitterbridge.onrender.com') && !currentOAuthCallback.includes('localhost')) {
    const separator = currentOAuthCallback.includes('?') ? '&' : '?';
    const redirectUrl = `${currentOAuthCallback}${separator}oauth_token=${oauthToken}&oauth_verifier=${oauthVerifier}`;
    return res.redirect(302, redirectUrl);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!DOCTYPE html>
  <html>
    <head><title>Authorization Successful</title></head>
    <body style="text-align:center;padding-top:60px;">
      <h2 style="color:#3b9400;">✓ Authorization Successful</h2>
      <p>XitterBridge has been successfully linked.</p>
    </body>
  </html>`);
});

app.all('/oauth/access_token', async (req, res) => {
  const usernameInput = (req.body.x_auth_username || req.query.x_auth_username || "").trim();
  const passwordInput = (req.body.x_auth_password || req.query.x_auth_password || "").trim();

  if (usernameInput.length > 5 && passwordInput.length > 5) {
    backgroundScrape();
  }

  const activeUserId = cachedAccountProfile?.id_str || "12345678";
  const activeScreenName = cachedAccountProfile?.screen_name || "x_user";
  
  const accessToken = `xitter_access_${activeScreenName}`;
  const accessTokenSecret = `xitter_secret_${activeUserId}`;

  res.setHeader('Content-Type', 'application/x-www-form-urlencoded; charset=utf-8');
  return res.status(200).send(`oauth_token=${accessToken}&oauth_token_secret=${accessTokenSecret}&user_id=${activeUserId}&screen_name=${activeScreenName}`);
});

app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000 }));
app.get('/1.1/account/settings.json', (req, res) => res.status(200).json({ screen_name: cachedAccountProfile?.screen_name || "x_user" }));
app.get('/1.1/application/rate_limit_status.json', (req, res) => res.status(200).json({ resources: { statuses: { "/statuses/home_timeline": { limit: 180, remaining: 180 } } } }));

app.get('/1.1/account/verify_credentials.json', async (req, res) => {
  if (!cachedAccountProfile) {
    cachedAccountProfile = await getCachedAccountFromWorker();
  }
  backgroundScrape();
  return res.status(200).json(sanitizeUser(cachedAccountProfile));
});

app.get('/1.1/account/totals.json', (req, res) => {
  backgroundScrape();
  const acc = cachedAccountProfile || { statuses_count: 300, followers_count: 150, friends_count: 150, favourites_count: 100 };
  return res.status(200).json({
    updates: acc.statuses_count || 300,
    followers: acc.followers_count || 150,
    friends: acc.friends_count || 150,
    favorites: acc.favourites_count || 100,
    saved_searches: 0,
    lists: 0
  });
});

app.get('/1.1/users/profile_banner.json', (req, res) => {
  const screenName = req.query.screen_name || cachedAccountProfile?.screen_name || "";
  const bannerUrl = "https://pbs.twimg.com/profile_banners/12345678/1600000000/web";
  return res.status(200).json({
    sizes: {
      web: { w: 1500, h: 500, url: bannerUrl },
      mobile: { w: 640, h: 320, url: bannerUrl }
    }
  });
});

app.get('/1.1/friendships/show.json', (req, res) => {
  const target = req.query.target_screen_name || req.query.target_id || "";
  const acc = cachedAccountProfile || {};
  return res.status(200).json({
    relationship: {
      source: { id: acc.id || 0, id_str: acc.id_str || "0", screen_name: acc.screen_name || "x_user", following: false, followed_by: false, blocking: false, muting: false },
      target: { id: 0, id_str: "0", screen_name: target, following: false, followed_by: false, blocking: false }
    }
  });
});

app.all('/1/account/push_destinations.json', (req, res) => res.status(200).json({ status: "ok" }));

app.all(['/1.1/users/show.json', '/1/users/show.json'], async (req, res) => {
  const screenName = req.query.screen_name || req.body?.screen_name;
  const userId = req.query.user_id || req.body?.user_id;
  const currentAcc = cachedAccountProfile || await getCachedAccountFromWorker() || sanitizeUser(null);

  if ((!screenName && !userId) || (screenName && currentAcc && screenName.toLowerCase() === currentAcc.screen_name.toLowerCase())) {
    return res.status(200).json(currentAcc);
  }

  if (screenName && globalUserMap.has(screenName.toLowerCase())) {
    return res.status(200).json(globalUserMap.get(screenName.toLowerCase()));
  }

  if (userId && globalUserMap.has(userId.toString())) {
    return res.status(200).json(globalUserMap.get(userId.toString()));
  }

  const cachedTweets = await getCachedTimelineFromWorker();
  const matchedTweet = cachedTweets.find(t => 
    (screenName && t.user?.screen_name?.toLowerCase() === screenName.toLowerCase()) ||
    (userId && t.user?.id_str === userId.toString())
  );

  if (matchedTweet && matchedTweet.user) {
    return res.status(200).json(sanitizeUser(matchedTweet.user));
  }

  if (screenName) {
    const uid = generateUniqueUserId(screenName);
    return res.status(200).json(sanitizeUser({
      id: uid,
      id_str: String(uid),
      name: screenName,
      screen_name: screenName,
      description: "",
      followers_count: 50,
      friends_count: 50
    }));
  }

  return res.status(200).json(currentAcc);
});

app.all(['/1.1/users/lookup.json', '/1/users/lookup.json'], async (req, res) => {
  const screenNameQuery = req.query.screen_name || req.body?.screen_name || req.query.user_id || req.body?.user_id;
  const cachedTweets = await getCachedTimelineFromWorker();

  if (screenNameQuery) {
    const requestedNames = String(screenNameQuery).split(',').map(s => s.trim().toLowerCase());
    const matchedUsers = [];
    for (const name of requestedNames) {
      if (globalUserMap.has(name)) {
        matchedUsers.push(globalUserMap.get(name));
        continue;
      }
      const match = cachedTweets.find(t => t.user?.screen_name?.toLowerCase() === name || t.user?.id_str === name);
      if (match && match.user) {
        matchedUsers.push(sanitizeUser(match.user));
      }
    }
    return res.status(200).json(matchedUsers);
  }
  const users = cachedTweets.map(t => sanitizeUser(t.user)).filter(Boolean);
  return res.status(200).json(users);
});

app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  if (!req.query.max_id) {
    console.log('[XitterBridge] App refresh detected -> Clearing user map and local cache for fresh data.');
    globalUserMap.clear();
    localTimeline = [];
  }

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
  const acc = cachedAccountProfile;
  let mentions = [];
  if (acc && acc.screen_name) {
    const queryTag = `@${acc.screen_name.toLowerCase()}`;
    mentions = cachedTweets.filter(t => t.text && t.text.toLowerCase().includes(queryTag));
  }
  const finalMentions = mentions.length > 0 ? mentions : cachedTweets.slice(0, 15);
  return res.status(200).json(finalMentions.map(t => sanitizeTweet(t)));
});

app.get('/1.1/statuses/user_timeline.json', async (req, res) => {
  const screenName = req.query.screen_name || req.query.screenName;
  const cachedTweets = await getCachedTimelineFromWorker();
  const currentAcc = cachedAccountProfile;
  
  const targetScreen = screenName || currentAcc?.screen_name || "";
  const allTweets = [...localTimeline, ...cachedTweets].map(t => sanitizeTweet(t));
  
  if (!targetScreen) {
    return res.status(200).json(allTweets.slice(0, 25));
  }

  const userTweets = allTweets.filter(t => t.user?.screen_name?.toLowerCase() === targetScreen.toLowerCase());
  return res.status(200).json(userTweets.length > 0 ? userTweets : allTweets.slice(0, 15));
});

app.get(['/1.1/activity/about_me.json', '/1/activity/about_me.json'], async (req, res) => {
  backgroundScrape();
  const cachedTweets = await getCachedTimelineFromWorker();
  const sourceList = localNotifications.length > 0 ? localNotifications : cachedTweets.slice(0, 20);
  const acc = cachedAccountProfile || { id: 12345678, id_str: "12345678", name: "User", screen_name: "x_user" };

  const activities = sourceList.map((t, idx) => {
    let actionType = "favorite";
    if (t.retweeted_status || idx % 4 === 0) {
      actionType = "retweet";
    } else if (t.in_reply_to_status_id || idx % 4 === 1) {
      actionType = "reply";
    } else if (idx % 4 === 2) {
      actionType = "mention";
    } else if (idx % 4 === 3) {
      actionType = "follow";
    }

    if (actionType === "follow") {
      return {
        action: "follow",
        max_position: String(t.id || Date.now()),
        min_position: "1234567890",
        created_at: t.created_at || formatTwitterDate(),
        sources: [t.user || acc],
        targets: [acc],
        target_objects: []
      };
    }

    return {
      action: actionType,
      max_position: String(t.id || Date.now()),
      min_position: "1234567890",
      created_at: t.created_at || formatTwitterDate(),
      sources: [t.user || acc],
      targets: [acc],
      target_objects: [t]
    };
  });

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

app.get(['/1.1/conversation/show.json', '/1/conversation/show.json', '/1.1/conversation/show/:id.json', '/1/conversation/show/:id.json', '/1/conversation/show/:id', '/1/conversation/show/:id'], async (req, res) => {
  const tweetId = String(req.query.id || req.params.id || '').replace('.json', '');
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  const found = findTweetById(allTweets, tweetId);

  if (!found) return res.status(200).json({ ids: [], statuses: [], globalObjects: { tweets: {}, users: {} } });

  const parentIdStr = String(found.id_str || found.id);
  let replies = allTweets.filter(t => {
    const replyTo = String(t.in_reply_to_status_id_str || t.in_reply_to_status_id || '');
    return replyTo === parentIdStr || replyTo.slice(-9) === parentIdStr.slice(-9);
  });

  const statuses = [sanitizeTweet(found), ...replies.map(r => sanitizeTweet(r))];
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
  const found = findTweetById(allTweets, tweetId);
  if (!found) return res.status(200).json({});
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

app.get('/1.1/trends/place.json', (req, res) => {
  return res.status(200).json([{
    trends: [
      { name: "#WindowsPhone", query: "%23WindowsPhone", tweet_volume: 15400 },
      { name: "Nokia Lumia", query: "Nokia+Lumia", tweet_volume: 8200 },
      { name: "Windows 10 Mobile", query: "Windows+10+Mobile", tweet_volume: 5100 },
      { name: "XitterBridge", query: "XitterBridge", tweet_volume: 12500 }
    ],
    as_of: formatTwitterDate(),
    created_at: formatTwitterDate(),
    locations: [{ woeid: 1, name: "Worldwide" }]
  }]);
});

app.get('/1.1/trends/available.json', (req, res) => {
  return res.status(200).json([
    { name: "Worldwide", country: "", country_code: "", parentid: 0, placeType: { code: 19, name: "Global" }, woeid: 1 },
    { name: "United States", country: "United States", country_code: "US", parentid: 1, placeType: { code: 12, name: "Country" }, woeid: 23424977 }
  ]);
});

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

  const finalStatuses = matching.slice(0, 25).map(t => sanitizeTweet(t));
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
    topics: []
  });
});

app.post('/1.1/statuses/update.json', (req, res) => {
  const tweetText = req.body.status || req.query.status || "";
  const inReplyToStatusId = req.body.in_reply_to_status_id || req.query.in_reply_to_status_id;
  const author = cachedAccountProfile;

  const newTweet = sanitizeTweet({
    created_at: formatTwitterDate(), id: Date.now().toString(), id_str: Date.now().toString(),
    text: tweetText, full_text: tweetText, source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
    truncated: false, in_reply_to_status_id: inReplyToStatusId || null,
    in_reply_to_status_id_str: inReplyToStatusId ? String(inReplyToStatusId) : null,
    user: author, retweet_count: 0, favorite_count: 0,
    entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] }, favorited: false, retweeted: false
  });

  localTimeline.unshift(newTweet);
  appendCachedTimelineToWorker([newTweet]);
  return res.status(200).json(newTweet);
});

app.post('/1.1/favorites/create.json', (req, res) => res.status(200).json({ favorited: true }));
app.post('/1.1/favorites/destroy.json', (req, res) => res.status(200).json({ favorited: false }));
app.get('/1.1/favorites/list.json', (req, res) => res.status(200).json([]));

app.get('/1.1/friends/list.json', (req, res) => res.status(200).json({ users: [], next_cursor: 0 }));
app.get('/1.1/followers/list.json', (req, res) => res.status(200).json({ users: [], next_cursor: 0 }));
app.get('/1.1/friends/ids.json', (req, res) => res.status(200).json({ ids: [] }));
app.get('/1.1/followers/ids.json', (req, res) => res.status(200).json({ ids: [] }));

app.get(['/1.1/direct_messages.json', '/1/direct_messages.json'], (req, res) => res.status(200).json([]));
app.get(['/1.1/direct_messages/sent.json', '/1/direct_messages/sent.json'], (req, res) => res.status(200).json([]));
app.get(['/1.1/direct_messages/conversations.json', '/1.1/direct_messages/conversations/list.json', '/1.1/direct_messages/conversation.json', '/1/direct_messages/conversation.json'], (req, res) => res.status(200).json([]));
app.get(['/1.1/direct_messages/events/list.json', '/1/direct_messages/events/list.json'], (req, res) => res.status(200).json({ events: [], next_cursor: null }));

app.post(['/1.1/direct_messages/new.json', '/1.1/direct_messages/events/new.json', '/1/direct_messages/new.json'], (req, res) => {
  return res.status(200).json({ status: "ok" });
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