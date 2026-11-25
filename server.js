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

// Legacy clients can't play HLS and choke on 1080p/4K, so videos are capped (override with env MAX_VIDEO_BITRATE).
const MAX_VIDEO_BITRATE = Number(process.env.MAX_VIDEO_BITRATE) || 2176000;

// VIDEO_MODE=photo (default): videos/GIFs are sent as their thumbnail picture, so clients that can't play
// native video still show something. Set VIDEO_MODE=video on Render to send real playable video instead.
const VIDEO_MODE = (process.env.VIDEO_MODE || 'photo').toLowerCase();
// How long users/show and user_timeline wait for a fresh profile fetch before answering with what's known.
const PROFILE_WAIT_MS = Number(process.env.PROFILE_WAIT_MS) || 20000;
const STORE = { forStorage: true };
// IMAGE_PROXY=on: pictures are fetched by this server and passed to the phone, so the phone never has to
// connect to X's image server itself (fixes phones that can't reach pbs.twimg.com).
const IMAGE_PROXY = /^(on|true|1|yes)$/i.test(process.env.IMAGE_PROXY || '');
const IMAGE_HOSTS = ['pbs.twimg.com', 'abs.twimg.com'];

// Real users captured from X's own API responses (handle -> sanitized user). Never cleared on refresh.
const knownUsers = new Map();
// Profile fetches: handle -> { user, tweets, fetchedAt, ttl }
const profileCache = new Map();
const profileInFlight = new Map();
const scrapeStats = { lastHome: null, lastProfile: null, lastError: null };

// Display names learned from user_mentions (handle -> name). Mentions carry real display names.
const nameDirectory = new Map();
function indexMentionNames(t) {
  if (!t || typeof t !== 'object') return;
  const list = t.entities && Array.isArray(t.entities.user_mentions) ? t.entities.user_mentions : [];
  for (const m of list) {
    const h = cleanStr(m && m.screen_name), n = cleanStr(m && m.name);
    if (h && n && n.toLowerCase() !== h.toLowerCase()) nameDirectory.set(h.toLowerCase(), n);
  }
  if (t.retweeted_status) indexMentionNames(t.retweeted_status);
  if (t.quoted_status) indexMentionNames(t.quoted_status);
}

let tokenSource = 'none';
let ownRefreshedAt = 0;
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
  
  if (req.path !== '/img') console.log(`[XitterBridge WP CLIENT] ${req.method} ${req.originalUrl || req.url}`);
  next();
});

function proxiedImageUrl(url, base) {
  return `${base}/img?u=${encodeURIComponent(url)}`;
}

// Rewrites picture addresses in an API reply to go through /img (only what's sent; storage is untouched).
function rewriteImagesForClient(obj, base) {
  const keys = new Set(['profile_image_url', 'profile_image_url_https', 'media_url', 'media_url_https', 'profile_banner_url']);
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && keys.has(k)) {
        try {
          const u = new URL(v.replace(/^http:/i, 'https:'));
          if (IMAGE_HOSTS.includes(u.hostname)) node[k] = proxiedImageUrl(u.toString(), base);
        } catch (e) {}
      } else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(obj);
  return obj;
}

app.use((req, res, next) => {
  if (!IMAGE_PROXY || !(req.path.startsWith('/1.1/') || req.path.startsWith('/1/'))) return next();
  const base = (process.env.PUBLIC_URL || `https://${req.headers.host}`).replace(/\/$/, '');
  const json = res.json.bind(res);
  res.json = body => json(rewriteImagesForClient(JSON.parse(JSON.stringify(body)), base));
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

// FIX: one stable, collision-resistant id per handle (fits signed 32-bit for old clients)
function generateUniqueUserId(screenName) {
  if (!screenName || screenName === 'twitter_user') return Math.floor(Math.random() * 800000000) + 100000000;
  const digest = crypto.createHash('sha1').update(String(screenName).toLowerCase()).digest('hex');
  return (parseInt(digest.slice(0, 8), 16) % 1000000000) + 1000000000;
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
    const fmt = (fixed.match(/[?&]format=(jpg|jpeg|png)/i) || [])[1];
    fixed = fixed.split('?')[0];
    if (!fixed.match(/\.(jpg|jpeg|png)$/i)) {
      fixed += '.' + (fmt ? fmt.toLowerCase() : 'jpg');
    }
    return fixed;
  }
  return fixed.split('?')[0];
}

function forceJpgAvatarUrl(url) {
  const defaultAvatar = "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png";
  if (!url) return defaultAvatar;
  let fixed = fixUrl(url);
  if (fixed.includes('pbs.twimg.com/profile_images/')) {
    // Old clients expect "_normal" and replace it themselves (_bigger, _reasonably_small, or nothing for
    // full size). Keep the picture's real file type: a .png avatar asked for as .jpg can fail to load.
    const m = fixed.split('?')[0].match(/^(.*?)(?:_(?:normal|mini|bigger|reasonably_small|200x200|x96|400x400))?\.(jpe?g|png|gif|webp)$/i);
    if (m) return `${m[1]}_normal.${m[2].toLowerCase()}`;
    return fixed.split('?')[0];
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

function sanitizeMedia(m, opts = {}) {
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
    // Keep MP4s only (no HLS), at or under MAX_VIDEO_BITRATE, best first.
    const mp4s = videoInfo.variants.filter(v => /mp4/i.test(v.content_type));
    if (mp4s.length) {
      const capped = mp4s.filter(v => v.bitrate <= MAX_VIDEO_BITRATE);
      const pick = capped.length ? capped : [mp4s.slice().sort((a, b) => a.bitrate - b.bitrate)[0]];
      videoInfo.variants = pick.sort((a, b) => b.bitrate - a.bitrate);
    }
  }

  // Every media item needs its own id (the old fallback gave all photos in a tweet the same Date.now()).
  let mediaIdStr = cleanStr(m.id_str || mediaRes.rest_id);
  if (!mediaIdStr) mediaIdStr = String(parseInt(crypto.createHash('sha1').update(String(rawUrl)).digest('hex').slice(0, 10), 16));
  let mediaIdNum = Number(mediaIdStr) || Date.now();
  if (mediaIdNum > Number.MAX_SAFE_INTEGER) mediaIdNum = parseInt(mediaIdStr.slice(-9)) || Date.now();

  // Storage keeps the real video; only what's sent to the client is converted (so nothing is lost in KV).
  let outType = cleanStr(m.type || mediaLegacy.type || mediaRes.__typename?.toLowerCase() || 'photo');
  let outVideo = videoInfo;
  if (!opts.forStorage && VIDEO_MODE === 'photo' && (outType === 'video' || outType === 'animated_gif')) {
    outType = 'photo';
    outVideo = undefined;
  }

  return {
    id: mediaIdNum,
    id_str: mediaIdStr,
    media_url: httpUrl,
    media_url_https: httpsUrl,
    url: cleanStr(m.url) || httpsUrl,
    display_url: cleanStr(m.display_url) || 'pic.twitter.com',
    expanded_url: cleanStr(m.expanded_url) || httpsUrl,
    type: outType,
    indices: Array.isArray(m.indices) ? m.indices : [0, 0],
    sizes: (m.sizes && m.sizes.large && m.sizes.large.w) ? m.sizes : {
      thumb: { w: 150, h: 150, resize: 'crop' },
      small: { w: 680, h: 680, resize: 'fit' },
      medium: { w: 1200, h: 1200, resize: 'fit' },
      large: { w: 2048, h: 2048, resize: 'fit' }
    },
    video_info: outVideo
  };
}

// NEW: understands X's newer GraphQL user shape (core / avatar / privacy / verification)
// and unwraps { result: {...} } / { user_results: { result: {...} } } wrappers.
function normalizeRawUser(u) {
  let r = u;
  for (let i = 0; i < 3; i++) {
    if (r && r.user_results && r.user_results.result) r = r.user_results.result;
    else if (r && r.result && typeof r.result === 'object' && !r.screen_name) r = r.result;
    else break;
  }
  if (!r || typeof r !== 'object') return u;
  const core = r.core || {};
  const legacy = r.legacy || {};
  return {
    ...legacy,
    ...r,
    id_str: cleanStr(r.id_str || r.rest_id || legacy.id_str) || undefined,
    screen_name: cleanStr(r.screen_name || core.screen_name || legacy.screen_name) || undefined,
    name: cleanStr(r.name || core.name || legacy.name) || undefined,
    created_at: r.created_at || core.created_at || legacy.created_at,
    profile_image_url_https: r.profile_image_url_https || (r.avatar && r.avatar.image_url) || legacy.profile_image_url_https || r.profile_image_url,
    location: cleanStr((r.location && r.location.location) ?? r.location ?? legacy.location) || '',
    verified: !!(r.verified || (r.verification && r.verification.verified) || legacy.verified),
    protected: !!(r.protected || (r.privacy && r.privacy.protected) || legacy.protected)
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
    geo_enabled: true,
    lang: "en",
    entities: { description: { urls: [] }, url: { urls: [] } }
  };

  if (!u || typeof u !== 'object') return defaultUser;

  const beforeNormalize = u;
  u = normalizeRawUser(u);
  
  let rawScreen = cleanStr(u.screen_name || u.screenName || u.legacy?.screen_name || '');
  let rawName = cleanStr(u.name || u.legacy?.name || '');
  let userIdStr = cleanStr(u.id_str || u.rest_id || u.id || u.legacy?.id_str);

  const hasRealScreen = !!rawScreen && rawScreen !== 'twitter_user' && rawScreen !== 'x_user' && !rawScreen.startsWith('user_');

  // IDs from the old char-code-sum scraper (800000000-800009999) collide between users, so ignore them.
  if (hasRealScreen && userIdStr && /^80000\d{4}$/.test(userIdStr)) userIdStr = null;

  // Look users up by handle (unique) instead of by ID when we know the handle.
  const knownReal = hasRealScreen ? knownUsers.get(rawScreen.toLowerCase()) : null;
  const knownByName = hasRealScreen ? (knownReal || globalUserMap.get(rawScreen.toLowerCase())) : null;
  if (!hasRealScreen && userIdStr && globalUserMap.has(userIdStr)) {
    const cached = globalUserMap.get(userIdStr);
    if (cached.screen_name && cached.screen_name !== 'twitter_user' && !cached.screen_name.startsWith('user_')) {
      return cached;
    }
  }

  if (!rawScreen || rawScreen === 'twitter_user' || rawScreen === 'x_user' || rawScreen.startsWith('user_')) {
    const fallbackId = userIdStr && userIdStr !== "12345678" ? userIdStr : String(Math.floor(Math.random() * 800000000) + 100000000);
    rawScreen = `user_${fallbackId.slice(-6)}`;
    rawName = rawName && rawName !== 'Twitter User' && !rawName.startsWith('user_') ? rawName : `User ${fallbackId.slice(-4)}`;
  } else if (!rawName || rawName === 'Twitter User' || rawName === rawScreen) {
    const cachedName = knownByName && knownByName.name && knownByName.name.toLowerCase() !== rawScreen.toLowerCase() ? knownByName.name : null;
    rawName = cachedName || nameDirectory.get(rawScreen.toLowerCase()) || rawScreen;
  }

  const rawAvatar = u.profile_image_url_https || u.profile_image_url || u.legacy?.profile_image_url_https;
  let avatar = forceJpgAvatarUrl(rawAvatar);
  if (avatar.includes('default_profile') && knownByName && knownByName.profile_image_url_https && !knownByName.profile_image_url_https.includes('default_profile')) {
    avatar = knownByName.profile_image_url_https; // a half-loaded scrape shouldn't wipe a good avatar
  }
  const banner = fixUrl(u.profile_banner_url || u.legacy?.profile_banner_url) || (knownReal && knownReal.profile_banner_url) || defaultUser.profile_banner_url;
  if (knownReal) {
    // A thin copy of a user (e.g. from an old cached tweet) inherits the real profile we captured from X.
    for (const k of ['description', 'location', 'url', 'followers_count', 'friends_count', 'listed_count', 'favourites_count', 'statuses_count', 'created_at', 'verified', 'protected', 'entities']) {
      if (u[k] === undefined || u[k] === null || u[k] === '') u = { ...u, [k]: knownReal[k] };
    }
  }
  const finalIdStr = (knownReal && knownReal.id_str) || userIdStr || (knownByName && knownByName.id_str) || String(generateUniqueUserId(rawScreen));

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

// The text has its trailing t.co/pic links stripped, so entity indices from X no longer line up.
// Re-find each entity in the cleaned text (bad indices make some clients drop the media or crash).
function fixEntityIndices(text, entities, mediaList) {
  const lower = text.toLowerCase();
  const len = text.length;
  const realign = (list, needleOf) => {
    let cursor = 0;
    return list.slice().sort((a, b) => ((a.indices && a.indices[0]) || 0) - ((b.indices && b.indices[0]) || 0)).map(e => {
      const needle = needleOf(e);
      const i = needle ? lower.indexOf(String(needle).toLowerCase(), cursor) : -1;
      if (i < 0) return null;
      cursor = i + String(needle).length;
      return { ...e, indices: [i, cursor] };
    }).filter(Boolean);
  };
  entities.hashtags = realign(entities.hashtags, h => h.text ? '#' + h.text : null);
  entities.user_mentions = realign(entities.user_mentions, m => m.screen_name ? '@' + m.screen_name : null);
  entities.urls = realign(entities.urls, u => u.url);
  (mediaList || []).forEach(m => {
    const i = m.url ? lower.indexOf(String(m.url).toLowerCase()) : -1;
    m.indices = i >= 0 ? [i, i + String(m.url).length] : [len, len];
  });
}

function sanitizeTweet(t, opts = {}) {
  if (!t || typeof t !== 'object') return t;
  indexMentionNames(t);
  
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

  const sanitizedMedia = rawMediaList.map(m => sanitizeMedia(m, opts)).filter(Boolean);
  if (rawMediaList.length > 0 && sanitizedMedia.length === 0) {
    console.log('[XitterBridge sanitizeTweet] tweet', idStr, 'had', rawMediaList.length, 'raw media item(s) but 0 survived sanitizing. First raw item:', JSON.stringify(rawMediaList[0]).slice(0, 500));
  }
  sanitizedMedia.forEach(m => {
    if (m.type === 'video' && (!m.video_info || !Array.isArray(m.video_info.variants) || m.video_info.variants.length === 0)) {
      console.log('[XitterBridge sanitizeTweet] tweet', idStr, 'media', m.id_str, 'is type video but has no playable variants.');
    }
  });

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
  fixEntityIndices(cleanedText, entities, sanitizedMedia);
  const replyIdStr = cleanStr(t.in_reply_to_status_id_str || t.in_reply_to_status_id);

  let author = t.user ? sanitizeUser(t.user) : null;

  // NEW: if we couldn't identify the author, recover the handle from the tweet's own media link
  // (https://x.com/<handle>/status/<this tweet's id>/photo/1). Only trusted when the status id matches.
  const mediaHandle = (() => {
    for (const m of rawMediaList) {
      const link = cleanStr(m && (m.expanded_url || m.url)) || '';
      const hit = link.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
      if (hit && hit[2] === idStr) return hit[1];
    }
    return null;
  })();
  if (mediaHandle && (!author || author.screen_name === 'twitter_user' || author.screen_name.startsWith('user_')) &&
      !(author && author.screen_name.toLowerCase() === mediaHandle.toLowerCase())) {
    const keepAvatar = author && !String(author.profile_image_url_https).includes('default_profile') ? author.profile_image_url_https : undefined;
    author = sanitizeUser({ screen_name: mediaHandle, profile_image_url_https: keepAvatar });
  }

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
    user_id: author?.id || 0,
    user_id_str: author?.id_str || "0",
    user: author,
    retweet_count: Number(t.retweet_count ?? 0),
    favorite_count: Number(t.favorite_count ?? 0),
    entities: entities,
    extended_entities: extendedEntities,
    favorited: !!t.favorited,
    retweeted: !!t.retweeted,
    lang: langVal,
    retweeted_status: t.retweeted_status ? sanitizeTweet(t.retweeted_status, opts) : null,
    quoted_status: t.quoted_status ? sanitizeTweet(t.quoted_status, opts) : null
  };
}

// ---------- X GraphQL capture ----------
// The headless browser already loads X, and X's page fetches complete JSON for every tweet and author
// (real name, avatar, video files). We read those responses instead of guessing from the rendered page.
// Finds a number field by any of its known names inside one user object (not inside other users nested in it).
function findCount(obj, names, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  for (const n of names) {
    const v = obj[n];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (v.rest_id || v.__typename === 'User' || k === 'user_results') continue;
    const r = findCount(v, names, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

// Last raw user objects seen from X, for /debug/user.
const rawGraphUsers = new Map();

function userFromGraphQL(u) {
  if (!u || typeof u !== 'object' || u.__typename === 'UserUnavailable') return null;
  const core = u.core || {};
  const legacy = u.legacy || {};
  const screen_name = core.screen_name || legacy.screen_name;
  const id_str = u.rest_id || legacy.id_str;
  if (!screen_name || !id_str) return null;
  return {
    id_str,
    screen_name,
    name: core.name || legacy.name || screen_name,
    created_at: core.created_at || legacy.created_at,
    profile_image_url_https: (u.avatar && u.avatar.image_url) || legacy.profile_image_url_https,
    profile_banner_url: legacy.profile_banner_url || '',
    description: legacy.description || (u.profile_bio && u.profile_bio.description) || '',
    location: (u.location && u.location.location) || (typeof legacy.location === 'string' ? legacy.location : '') || '',
    url: legacy.url || null,
    followers_count: findCount(legacy, ['followers_count']) ?? findCount(u, ['followers_count', 'normal_followers_count']),
    friends_count: findCount(legacy, ['friends_count']) ?? findCount(u, ['friends_count', 'following_count']),
    listed_count: findCount(legacy, ['listed_count']) ?? findCount(u, ['listed_count']),
    favourites_count: findCount(legacy, ['favourites_count']) ?? findCount(u, ['favourites_count', 'likes_count', 'like_count']),
    statuses_count: findCount(legacy, ['statuses_count']) ?? findCount(u, ['statuses_count', 'tweet_count', 'tweets_count']),
    verified: !!(u.is_blue_verified || (u.verification && u.verification.verified) || legacy.verified),
    protected: !!((u.privacy && u.privacy.protected) || legacy.protected),
    entities: legacy.entities
  };
}

function tweetFromGraphQL(r, depth = 0) {
  if (!r || typeof r !== 'object' || depth > 3) return null;
  if (r.__typename === 'TweetWithVisibilityResults' && r.tweet) r = r.tweet;
  else if (r.tweet && !r.legacy) r = r.tweet;
  const legacy = r.legacy;
  if (!legacy) return null;
  const user = userFromGraphQL(r.core && r.core.user_results && r.core.user_results.result);
  const note = r.note_tweet && r.note_tweet.note_tweet_results && r.note_tweet.note_tweet_results.result;
  const text = (note && note.text) || legacy.full_text || '';
  const rt = legacy.retweeted_status_result && legacy.retweeted_status_result.result;
  const qt = r.quoted_status_result && r.quoted_status_result.result;
  return {
    id_str: r.rest_id || legacy.id_str,
    created_at: legacy.created_at,
    text,
    full_text: text,
    source: r.source,
    in_reply_to_status_id_str: legacy.in_reply_to_status_id_str || null,
    retweet_count: legacy.retweet_count,
    favorite_count: legacy.favorite_count,
    favorited: !!legacy.favorited,
    retweeted: !!legacy.retweeted,
    lang: legacy.lang,
    entities: legacy.entities || {},
    extended_entities: legacy.extended_entities,
    user,
    retweeted_status: rt ? tweetFromGraphQL(rt, depth + 1) : null,
    quoted_status: qt ? tweetFromGraphQL(qt, depth + 1) : null
  };
}

function newSink() {
  return { tweets: [], users: new Map(), seen: new Set(), pending: [], responses: 0, profileUser: null };
}

// Walks any X GraphQL response, so it keeps working when X moves fields around.
function collectFromGraphQL(json, sink) {
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 60) return;
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    if (node.__typename === 'User' && node.rest_id) {
      const u = userFromGraphQL(node);
      if (u) {
        const key = u.screen_name.toLowerCase();
        // Keep the richest copy: profile responses carry more than timeline ones.
        const prev = sink.users.get(key);
        if (!prev || (u.followers_count !== undefined && prev.followers_count === undefined) || (u.description && !prev.description)) sink.users.set(key, u);
        if (rawGraphUsers.size > 300) rawGraphUsers.delete(rawGraphUsers.keys().next().value);
        rawGraphUsers.set(key, node);
      }
    }
    if ((node.itemType === 'TimelineTweet' || node.__typename === 'TimelineTweet') &&
        node.tweet_results && node.tweet_results.result && !node.promotedMetadata) {
      const t = tweetFromGraphQL(node.tweet_results.result);
      if (t && t.user && t.id_str && !sink.seen.has(t.id_str)) {
        sink.seen.add(t.id_str);
        sink.tweets.push(t);
      }
    }
    for (const k of Object.keys(node)) walk(node[k], depth + 1);
  };
  walk(json, 0);
}

function attachGraphQLCapture(page, sink) {
  page.on('response', resp => {
    const url = resp.url();
    if (!url.includes('/i/api/graphql/')) return;
    try { if (resp.request().method() === 'OPTIONS') return; } catch (e) {}
    sink.pending.push(resp.json().then(json => {
      sink.responses++;
      collectFromGraphQL(json, sink);
      if (url.includes('UserByScreenName')) {
        const u = userFromGraphQL(json && json.data && json.data.user && json.data.user.result);
        if (u) sink.profileUser = u;
      }
    }).catch(() => {}));
  });
}

function registerSinkUsers(sink) {
  for (const u of sink.users.values()) {
    const s = sanitizeUser(u);
    if (s && s.screen_name && !s.screen_name.startsWith('user_')) knownUsers.set(s.screen_name.toLowerCase(), s);
  }
}

async function openXPage(tokens) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote', '--disable-extensions'],
    defaultViewport: { width: 1280, height: 800 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '');
  await page.setCookie(
    { name: 'auth_token', value: clean(tokens.auth_token), domain: '.x.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
    { name: 'ct0', value: clean(tokens.ct0), domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' }
  );
  return { browser, page };
}

// Describes a cookie's format without revealing it: a real auth_token is 40 hex characters, ct0 is usually 160.
function describeCookie(v) {
  const str = String(v || '');
  const t = str.trim();
  const problems = [];
  if (t !== str) problems.push('has spaces/newlines around it');
  if (/["'%]/.test(t)) problems.push('contains quotes or %-encoding');
  if (/^(auth_token|ct0)\s*=/.test(t)) problems.push('includes the cookie NAME, paste only the value');
  if (t && !/^[0-9a-f]+$/i.test(t)) problems.push('has non-hex characters');
  return `${t.length} chars${problems.length ? ' (' + problems.join(', ') + ')' : ', hex ok'}`;
}

async function saveOwnAccount(user) {
  if (!user || isPlaceholderUser(user)) return;
  cachedAccountProfile = user;
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret) return;
  try {
    await fetch(`${workerUrl}/update-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': secret },
      body: JSON.stringify(user)
    });
    console.log(`[XitterBridge] Saved your account @${user.screen_name} (id ${user.id_str}) to the Worker.`);
  } catch (e) {}
}

function isPlaceholderUser(u) {
  return !u || !u.screen_name || u.screen_name === 'twitter_user' || u.screen_name === 'x_user' || u.screen_name.startsWith('user_');
}

// The phone stores IDs as floating-point numbers, so 19-digit IDs come back rounded
// (1088463100137791489 -> 1088463100137791500). Match exactly, or on the same rounded value.
function idMatches(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  const sa = String(a), sb = String(b);
  if (sa === sb) return true;
  const na = Number(sa), nb = Number(sb);
  return na > 0 && na === nb;
}

const recentUsersById = new Map(); // id_str -> user, filled from every timeline read
function handleForUserId(id) {
  if (!id) return null;
  const sid = String(id);
  for (const u of knownUsers.values()) if (idMatches(u.id_str, sid)) return u.screen_name;
  for (const p of profileCache.values()) if (p.user && idMatches(p.user.id_str, sid)) return p.user.screen_name;
  for (const [k, u] of recentUsersById) if (idMatches(k, sid) && !isPlaceholderUser(u)) return u.screen_name;
  const g = globalUserMap.get(sid);
  return g && !isPlaceholderUser(g) ? g.screen_name : null;
}

function findUserById(id) {
  const h = handleForUserId(id);
  if (!h) return null;
  const key = h.toLowerCase();
  return knownUsers.get(key) || (profileCache.get(key) || {}).user || globalUserMap.get(key) || null;
}

function filterByIdRange(list, query) {
  let out = list;
  try { if (query.since_id) { const s = BigInt(query.since_id); out = out.filter(t => { try { return BigInt(t.id_str) > s; } catch (e) { return true; } }); } } catch (e) {}
  try { if (query.max_id) { const m = BigInt(query.max_id); out = out.filter(t => { try { return BigInt(t.id_str) < m; } catch (e) { return true; } }); } } catch (e) {}
  return out;
}

// Opens x.com/<handle> in the shared headless browser and keeps that person's real profile + tweets.
function scrapeProfile(handle) {
  const key = String(handle).toLowerCase();
  if (profileInFlight.has(key)) return profileInFlight.get(key);
  const job = (async () => {
    const tokens = await getTokens();
    if (!tokens.auth_token || !tokens.ct0) return null;
    // Render's small instances can only run one Chromium, so wait for the timeline scraper to finish.
    const waitStart = Date.now();
    while (isScraping && Date.now() - waitStart < 40000) await new Promise(r => setTimeout(r, 500));
    isScraping = true;
    lastScrapeTime = Date.now();
    let browser;
    const sink = newSink();
    try {
      const opened = await openXPage(tokens);
      browser = opened.browser;
      const page = opened.page;
      attachGraphQLCapture(page, sink);
      await page.goto(`https://x.com/${encodeURIComponent(handle)}`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await page.waitForSelector('article[data-testid="tweet"], [data-testid="emptyState"]', { timeout: 15000 }).catch(() => {});
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await new Promise(r => setTimeout(r, 2500));
      await Promise.allSettled(sink.pending);
    } catch (e) {
      scrapeStats.lastError = `profile ${handle}: ${e && e.message ? e.message : e}`;
    } finally {
      if (browser) await browser.close().catch(() => {});
      isScraping = false;
    }
    registerSinkUsers(sink);
    const user = sink.profileUser ? sanitizeUser(sink.profileUser) : (knownUsers.get(key) || null);
    if (user && !isPlaceholderUser(user)) knownUsers.set(key, user);
    const tweets = sink.tweets
      .filter(t => t.user && t.user.screen_name && t.user.screen_name.toLowerCase() === key)
      .map(t => sanitizeTweet(t, STORE))
      .sort((a, b) => { try { return Number(BigInt(b.id_str) - BigInt(a.id_str)); } catch (e) { return 0; } });
    const ok = !!user || tweets.length > 0;
    const entry = { user, tweets, fetchedAt: Date.now(), ttl: ok ? 10 * 60 * 1000 : 2 * 60 * 1000 };
    profileCache.set(key, entry);
    scrapeStats.lastProfile = { handle, at: new Date().toISOString(), graphqlResponses: sink.responses, gotUser: !!user, tweets: tweets.length };
    console.log(`[XitterBridge Profile] @${handle}: ${sink.responses} API responses, user ${user ? 'found' : 'NOT found'}, ${tweets.length} tweets.`);
    return entry;
  })().finally(() => profileInFlight.delete(key));
  profileInFlight.set(key, job);
  return job;
}

async function getProfile(handle, wait = true) {
  if (!handle) return null;
  const key = String(handle).toLowerCase();
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < cached.ttl) return cached;
  const job = scrapeProfile(handle);
  if (!wait) return cached || null;
  const fresh = await Promise.race([job, new Promise(r => setTimeout(() => r(null), PROFILE_WAIT_MS))]);
  return fresh || cached || null;
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
    tokenSource = (manualAuthToken === process.env.X_AUTH_TOKEN) ? 'Render env vars X_AUTH_TOKEN/X_CT0 (these override your app login!)' : '/set-tokens';
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
          tokenSource = 'Worker (from your app login)';
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

async function getRawTimelineFromWorker() {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret) return [];

  try {
    const response = await fetch(`${workerUrl}/get-timeline`, { headers: { 'X-Bridge-Secret': secret } });
    if (response.ok) {
      const data = await response.json();
      if (!Array.isArray(data)) return [];
      data.forEach(indexMentionNames);
      data.forEach(t => {
        try {
          if (!t || !t.user) return;
          const s = sanitizeUser(t.user);
          if (!isPlaceholderUser(s)) {
            if (recentUsersById.size > 2000) recentUsersById.delete(recentUsersById.keys().next().value);
            recentUsersById.set(s.id_str, s);
          }
          // Remember fully-known users (real handle + real avatar) across refreshes.
          if (!isPlaceholderUser(s) && !String(s.profile_image_url_https).includes('default_profile') && !knownUsers.has(s.screen_name.toLowerCase())) {
            knownUsers.set(s.screen_name.toLowerCase(), s);
          }
        } catch (e) {}
      });
      return data;
    }
  } catch (e) {}
  return [];
}

async function getCachedTimelineFromWorker() {
  const raw = await getRawTimelineFromWorker();
  return raw.map(t => sanitizeTweet(t));
}

// The Worker's copy of a tweet has the real date/counts/video; the DOM scraper's copy has the real name/avatar.
// Merge them instead of letting one overwrite the other.
function mergeTweet(a, b) {
  if (!a) return b;
  if (!b) return a;
  const mediaOf = t => (t.extended_entities && t.extended_entities.media) || [];
  const richness = t => (t.retweet_count || 0) + (t.favorite_count || 0) + (mediaOf(t).some(m => m.video_info) ? 1e6 : 0) + mediaOf(t).length;
  const userScore = u => !u ? 0 :
    (u.screen_name && !u.screen_name.startsWith('user_') ? 2 : 0) +
    (u.profile_image_url_https && !u.profile_image_url_https.includes('default_profile') ? 2 : 0) +
    (u.name && u.name !== u.screen_name ? 1 : 0);
  const base = richness(a) >= richness(b) ? a : b;
  const other = base === a ? b : a;
  const out = { ...base };
  if (userScore(other.user) > userScore(base.user)) {
    out.user = other.user;
    out.user_id = other.user_id;
    out.user_id_str = other.user_id_str;
  }
  const ta = Date.parse(a.created_at), tb = Date.parse(b.created_at);
  if (!isNaN(ta) && !isNaN(tb)) out.created_at = ta <= tb ? a.created_at : b.created_at; // scraper stamps "now"
  return out;
}

async function appendCachedTimelineToWorker(newTweets) {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!workerUrl || !secret || !newTweets.length) return;

  try {
    const existing = (await getRawTimelineFromWorker()).map(t => sanitizeTweet(t, STORE));
    const map = new Map();
    existing.forEach(t => map.set(t.id_str || t.id, t));
    newTweets.map(t => sanitizeTweet(t, STORE)).forEach(t => { const k = t.id_str || t.id; map.set(k, mergeTweet(map.get(k), t)); });
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
      body: JSON.stringify(merged.slice(0, 500).map(t => sanitizeTweet(t, STORE)))
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
  const sink = newSink();
  try {
    const opened = await openXPage(tokens);
    browser = opened.browser;
    const page = opened.page;
    attachGraphQLCapture(page, sink);

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => 'No Title');
    console.log(`[XitterBridge Scraper] Landed on URL: ${currentUrl} | Page Title: ${pageTitle}`);

    const loggedOut = currentUrl.includes('/login') || currentUrl.includes('/i/flow/login') || !currentUrl.includes('/home');
    if (loggedOut) {
      // Did X delete the cookie (it considers it invalid) or keep it but still refuse (blocking this server)?
      const jar = await page.cookies('https://x.com').catch(() => []);
      const kept = jar.find(c => c.name === 'auth_token');
      const verdict = kept
        ? 'X KEPT auth_token but still showed the logged-out page: the cookie looks valid, X is refusing it from this server.'
        : 'X DELETED auth_token: X considers this cookie invalid (expired, logged out, or copied wrong).';
      scrapeStats.lastHome = {
        at: new Date().toISOString(), landedUrl: currentUrl, loggedOut: true, tokenSource, verdict,
        auth_token_format: describeCookie(tokens.auth_token), ct0_format: describeCookie(tokens.ct0)
      };
      console.log(`[XitterBridge Scraper] ERROR: X treated these cookies as LOGGED OUT (landed on ${currentUrl}). Cookie source: ${tokenSource}.`);
      console.log(`[XitterBridge Scraper] ${verdict} auth_token: ${describeCookie(tokens.auth_token)} | ct0: ${describeCookie(tokens.ct0)}`);
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

          const userNameBlock = art.querySelector('[data-testid="User-Name"]');
          if (userNameBlock) {
            const links = Array.from(userNameBlock.querySelectorAll('a[href]'));
            for (const l of links) {
              const href = l.getAttribute('href') || '';
              const cleaned = href.replace(/^\//, '').split('/')[0].trim();
              if (cleaned && cleaned !== 'i' && cleaned !== 'status') {
                screen_name = cleaned;
                break;
              }
            }
            const spans = Array.from(userNameBlock.querySelectorAll('span'));
            for (const s of spans) {
              const txt = s.textContent ? s.textContent.trim() : '';
              if (txt.startsWith('@')) {
                screen_name = txt.replace('@', '');
                break;
              }
            }
            for (const s of spans) {
              const txt = s.textContent ? s.textContent.trim() : '';
              if (txt && !txt.startsWith('@') && txt !== '·' && txt.length > 0) {
                name = txt;
                break;
              }
            }
          }

          // The avatar's data-testid carries the exact handle; trust it over text scraping.
          const avatarBox = art.querySelector('[data-testid="Tweet-User-Avatar"] [data-testid^="UserAvatar-Container-"]');
          if (avatarBox) {
            const h = (avatarBox.getAttribute('data-testid') || '').replace('UserAvatar-Container-', '').trim();
            if (h) screen_name = h;
          }

          if (!screen_name) {
            const allLinks = art.querySelectorAll('a[href^="/"]');
            for (const a of allLinks) {
              const href = a.getAttribute('href') || '';
              const parts = href.split('/').filter(Boolean);
              if (parts.length === 1 && !['home', 'explore', 'notifications', 'messages', 'settings', 'i', 'search', 'hashtag', 'compose'].includes(parts[0].toLowerCase())) {
                screen_name = parts[0];
                break;
              }
            }
          }

          if (!screen_name) screen_name = "twitter_user";
          if (!name) name = screen_name;

          const avatarImg = art.querySelector('[data-testid="Tweet-User-Avatar"] img[src*="profile_images"]') || art.querySelector('img[src*="profile_images"]');
          if (avatarImg && (avatarImg.currentSrc || avatarImg.src)) {
            profile_image_url_https = avatarImg.currentSrc || avatarImg.src;
          }
          if (!profile_image_url_https) {
            const bgEl = art.querySelector('[data-testid="Tweet-User-Avatar"] [style*="background-image"]');
            const bgMatch = bgEl && (bgEl.getAttribute('style') || '').match(/url\(["']?([^"')]+)["']?\)/);
            if (bgMatch) profile_image_url_https = bgMatch[1];
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

          const posters = art.querySelectorAll('[data-testid="videoPlayer"] video[poster], [data-testid="videoComponent"] video[poster]');
          posters.forEach(v => {
            const src = v.getAttribute('poster');
            if (src && !media.some(x => x.media_url_https === src)) {
              media.push({ media_url_https: src, media_url: src, type: 'photo', url: src, display_url: 'pic.twitter.com', expanded_url: src });
            }
          });

          items.push({
            id_str,
            text,
            created_at: new Date().toISOString(),
            user: {
              id_str: String(Math.abs(screen_name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)) + 800000000),
              name: name,
              screen_name: screen_name,
              profile_image_url_https: profile_image_url_https || "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
              profile_image_url: profile_image_url_https || "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
              verified: !!art.querySelector('svg[aria-label="Verified account"]')
            },
            entities: { media: media.length ? media : undefined },
            extended_entities: media.length ? { media } : undefined
          });
        } catch (e) {}
      });
      return items;
    });

    console.log(`[XitterBridge Scraper] Successfully extracted ${scrapedTweets.length} posts from page DOM.`);

    const ownHandle = await page.evaluate(() => {
      const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      return a ? (a.getAttribute('href') || '').replace(/^\//, '').split('/')[0] : null;
    }).catch(() => null);

    await Promise.allSettled(sink.pending);
    await browser.close();
    browser = null;

    registerSinkUsers(sink);
    scrapeStats.lastHome = {
      at: new Date().toISOString(),
      landedUrl: currentUrl,
      graphqlResponses: sink.responses,
      graphqlTweets: sink.tweets.length,
      graphqlUsers: sink.users.size,
      domTweets: scrapedTweets.length,
      ownHandle
    };
    console.log(`[XitterBridge Scraper] X API: ${sink.responses} responses, ${sink.tweets.length} tweets, ${sink.users.size} users. Own handle: ${ownHandle || 'unknown'}`);

    // Tweets from X's API carry real names, avatars and video; DOM tweets only fill gaps (merged per tweet).
    const combined = [...sink.tweets, ...scrapedTweets];
    if (combined.length > 0) {
      await appendCachedTimelineToWorker(combined);
    }

    // Own profile: if the Worker never supplied it, fetch it from X once we know the handle.
    const ownStale = isPlaceholderUser(cachedAccountProfile) || cachedAccountProfile.screen_name.toLowerCase() !== String(ownHandle).toLowerCase() ||
      !ownRefreshedAt || Date.now() - ownRefreshedAt > 30 * 60 * 1000;
    if (ownHandle && ownStale) {
      ownRefreshedAt = Date.now();
      setTimeout(() => {
        scrapeProfile(ownHandle).then(entry => {
          if (entry && entry.user) saveOwnAccount(entry.user);
        }).catch(() => {});
      }, 1000);
    }
  } catch (err) {
    scrapeStats.lastError = `home: ${err && err.message ? err.message : err}`;
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
  let workerStatus = 'not configured';
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (workerUrl && secret) {
    try {
      const r = await fetch(`${workerUrl}/update-timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': secret },
        body: '[]'
      });
      workerStatus = `HTTP ${r.status}`;
    } catch (e) {
      workerStatus = `failed: ${e.message}`;
    }
  }
  localTimeline = [];
  localNotifications = [];
  globalUserMap.clear();
  knownUsers.clear();
  profileCache.clear();
  backgroundScrape();
  return res.send(`Cache cleared. Worker timeline wipe: ${workerStatus}. A fresh scrape has started; refresh your app in about a minute.`);
});

// Image proxy (X image hosts only, so it can't be used to fetch anything else).
app.get('/img', async (req, res) => {
  try {
    const u = new URL(String(req.query.u || ''));
    if (!IMAGE_HOSTS.includes(u.hostname)) return res.status(400).end();
    u.protocol = 'https:';
    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    return res.status(502).end();
  }
});

// Open on the PHONE's browser: shows the same pictures loaded directly from X and through this server.
app.get('/debug/images', async (req, res) => {
  const base = (process.env.PUBLIC_URL || `https://${req.headers.host}`).replace(/\/$/, '');
  const tweets = (await getCachedTimelineFromWorker()).slice(0, 60);
  const avatars = [], media = [];
  for (const t of tweets) {
    const a = t.user && t.user.profile_image_url_https;
    if (a && !a.includes('default_profile') && avatars.length < 3 && !avatars.includes(a)) avatars.push(a);
    const m = t.extended_entities && t.extended_entities.media && t.extended_entities.media[0];
    if (m && media.length < 3) media.push(m.media_url_https);
  }
  const esc = x => String(x).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const row = (label, url) => `<tr><td>${label}<br><small>${esc(url)}</small></td>
    <td><img src="${esc(url)}" width="80"></td><td><img src="${esc(proxiedImageUrl(url, base))}" width="80"></td></tr>`;
  const avatarRows = avatars.flatMap(a => [row('avatar as sent', a), row('avatar the way the app resizes it (_bigger)', a.replace('_normal', '_bigger'))]);
  const mediaRows = media.map(m => row('media', m));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"><title>Image test</title></head>
<body style="font-family:sans-serif"><h3>Image test</h3><p>Image proxy is currently <b>${IMAGE_PROXY ? 'ON' : 'OFF'}</b>.</p>
<table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th>picture</th><th>direct from X</th><th>through bridge</th></tr>
${avatarRows.join('')}${mediaRows.join('')}</table>
${avatars.length + media.length === 0 ? '<p>No pictures in the cached timeline yet. Refresh the app first.</p>' : ''}</body></html>`);
});

// Shows the raw user object X sent and what the bridge made of it: /debug/user?screen_name=brave
app.get('/debug/user', (req, res) => {
  const key = String(req.query.screen_name || '').toLowerCase();
  if (!key) return res.status(200).json({ error: 'add ?screen_name=someone' });
  return res.status(200).json({
    raw_from_x: rawGraphUsers.get(key) || null,
    bridge_user: knownUsers.get(key) || null,
    profile_fetch: profileCache.has(key) ? { ...profileCache.get(key), tweets: (profileCache.get(key).tweets || []).length } : null
  });
});

// Shows whether the scraper is getting real data from X. Open this after a refresh.
app.get('/debug/scrape-status', (req, res) => {
  return res.status(200).json({
    cookieSource: tokenSource,
    imageProxy: IMAGE_PROXY,
    videoMode: VIDEO_MODE,
    ownAccount: cachedAccountProfile ? cachedAccountProfile.screen_name : null,
    knownUsers: knownUsers.size,
    cachedProfiles: Array.from(profileCache.keys()),
    ...scrapeStats
  });
});

// TEMPORARY DEBUG: shows the raw `user` objects the Worker returns (before sanitizing). Delete when done.
app.get('/debug/raw-users', async (req, res) => {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.BRIDGE_SECRET;
  try {
    const r = await fetch(`${workerUrl}/get-timeline`, { headers: { 'X-Bridge-Secret': secret } });
    const data = await r.json();
    const raw = Array.isArray(data) ? data : [];
    // Prefer tweets that actually carry media, since that's what's broken; fall back to the first few otherwise.
    const withMedia = raw.filter(t => (t.extended_entities?.media?.length || t.entities?.media?.length));
    const pick = (withMedia.length ? withMedia : raw).slice(0, 3);
    return res.status(200).json(pick.map(t => ({
      id_str: t.id_str,
      raw_user: t.user,
      raw_media: t.extended_entities?.media || t.entities?.media || null,
      sanitized: sanitizeTweet(JSON.parse(JSON.stringify(t)))
    })));
  } catch (e) {
    return res.status(200).json({ error: String(e) });
  }
});

app.get('/debug/profile', async (req, res) => {
  const screenName = req.query.screen_name;
  if (!screenName) return res.status(200).json({ error: 'pass ?screen_name=someuser' });
  const steps = {};
  steps.globalUserMap_hit = globalUserMap.has(screenName.toLowerCase());
  const cachedTweets = await getCachedTimelineFromWorker();
  steps.cachedTweets_scanned = cachedTweets.length;
  const matchedTweet = cachedTweets.find(t => t.user?.screen_name?.toLowerCase() === screenName.toLowerCase());
  steps.cachedTweet_match_found = !!matchedTweet;
  steps.cachedTweet_match_raw_user = matchedTweet ? matchedTweet.user : null;
  steps.would_fall_back_to_synthetic = !steps.globalUserMap_hit && !matchedTweet;
  const userTimeline = cachedTweets.filter(t => t.user?.screen_name?.toLowerCase() === screenName.toLowerCase());
  steps.user_timeline_tweet_count = userTimeline.length;
  return res.status(200).json(steps);
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

  if (isPlaceholderUser(cachedAccountProfile)) {
    const acc = await getCachedAccountFromWorker();
    if (acc) cachedAccountProfile = acc;
  }
  const activeUserId = cachedAccountProfile?.id_str || "12345678";
  const activeScreenName = cachedAccountProfile?.screen_name || "x_user";
  
  const accessToken = `xitter_access_${activeScreenName}`;
  const accessTokenSecret = `xitter_secret_${activeUserId}`;

  res.setHeader('Content-Type', 'application/x-www-form-urlencoded; charset=utf-8');
  return res.status(200).send(`oauth_token=${accessToken}&oauth_token_secret=${accessTokenSecret}&user_id=${activeUserId}&screen_name=${activeScreenName}`);
});

app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000 }));
app.get('/1.1/account/settings.json', async (req, res) => {
  if (isPlaceholderUser(cachedAccountProfile)) {
    const acc = await getCachedAccountFromWorker();
    if (acc) cachedAccountProfile = acc;
  }
  return res.status(200).json({ screen_name: cachedAccountProfile?.screen_name || "x_user" });
});
app.get('/1.1/application/rate_limit_status.json', (req, res) => res.status(200).json({ resources: { statuses: { "/statuses/home_timeline": { limit: 180, remaining: 180 } } } }));

app.get('/1.1/account/verify_credentials.json', async (req, res) => {
  if (isPlaceholderUser(cachedAccountProfile)) {
    const acc = await getCachedAccountFromWorker();
    if (acc) cachedAccountProfile = acc;
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
  const handle = req.query.screen_name || handleForUserId(req.query.user_id) || (cachedAccountProfile && cachedAccountProfile.screen_name);
  const known = handle ? (knownUsers.get(handle.toLowerCase()) || (profileCache.get(handle.toLowerCase()) || {}).user) : null;
  const realBanner = known && known.profile_banner_url ? known.profile_banner_url.split('?')[0] : '';
  if (realBanner) {
    return res.status(200).json({
      sizes: {
        web: { w: 520, h: 260, url: `${realBanner}/web` },
        web_retina: { w: 1040, h: 520, url: `${realBanner}/web_retina` },
        mobile: { w: 320, h: 160, url: `${realBanner}/mobile` },
        mobile_retina: { w: 640, h: 320, url: `${realBanner}/mobile_retina` },
        '1500x500': { w: 1500, h: 500, url: `${realBanner}/1500x500` }
      }
    });
  }
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

app.get(['/1.1/friendships/lookup.json', '/1/friendships/lookup.json'], (req, res) => {
  const ids = String(req.query.user_id || '').split(',').map(s => s.trim()).filter(Boolean);
  const names = String(req.query.screen_name || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const id of ids) {
    const u = findUserById(id);
    out.push({ name: u ? u.name : '', screen_name: u ? u.screen_name : '', id: u ? u.id : Number(id), id_str: u ? u.id_str : String(id), connections: ['none'] });
  }
  for (const n of names) {
    const u = knownUsers.get(n.toLowerCase()) || globalUserMap.get(n.toLowerCase());
    out.push({ name: u ? u.name : n, screen_name: u ? u.screen_name : n, id: u ? u.id : 0, id_str: u ? u.id_str : '0', connections: ['none'] });
  }
  return res.status(200).json(out);
});

// Following isn't supported by the bridge yet: answer like the API so the app doesn't break.
app.post(['/1.1/friendships/create.json', '/1/friendships/create.json'], (req, res) => {
  const id = req.body?.user_id || req.query.user_id;
  const name = req.body?.screen_name || req.query.screen_name;
  const u = (id && findUserById(id)) || (name && (knownUsers.get(String(name).toLowerCase()) || globalUserMap.get(String(name).toLowerCase())));
  console.log('[XitterBridge] follow requested for', name || id, '- not sent to X (following is not supported yet).');
  return res.status(200).json(u || sanitizeUser({ id_str: String(id || '0'), screen_name: name || '' }));
});

app.all(['/1.1/users/show.json', '/1/users/show.json'], async (req, res) => {
  const screenName = req.query.screen_name || req.body?.screen_name;
  const userId = req.query.user_id || req.body?.user_id;
  const currentAcc = cachedAccountProfile || await getCachedAccountFromWorker() || sanitizeUser(null);

  if ((!screenName && !userId) || (screenName && currentAcc && screenName.toLowerCase() === currentAcc.screen_name.toLowerCase())) {
    console.log('[XitterBridge users/show] returning own account for', screenName || userId || '(none given)');
    return res.status(200).json(currentAcc);
  }

  if (userId && (String(userId) === '12345678' || String(userId) === '0' || (currentAcc && String(userId) === currentAcc.id_str)) && !isPlaceholderUser(currentAcc)) {
    console.log('[XitterBridge users/show] user_id', userId, 'is you -> @' + currentAcc.screen_name);
    return res.status(200).json(currentAcc);
  }
  const lookupHandle = screenName || handleForUserId(userId);
  if (lookupHandle) {
    const prof = await getProfile(lookupHandle);
    if (prof && prof.user && !isPlaceholderUser(prof.user)) {
      console.log('[XitterBridge users/show] real profile from X for', lookupHandle);
      return res.status(200).json(prof.user);
    }
    const known = knownUsers.get(lookupHandle.toLowerCase());
    if (known) {
      console.log('[XitterBridge users/show] known user (profile fetch pending/failed) for', lookupHandle);
      return res.status(200).json(known);
    }
  }

  if (screenName && globalUserMap.has(screenName.toLowerCase())) {
    console.log('[XitterBridge users/show] hit globalUserMap by screen_name:', screenName);
    return res.status(200).json(globalUserMap.get(screenName.toLowerCase()));
  }

  if (userId && globalUserMap.has(userId.toString())) {
    console.log('[XitterBridge users/show] hit globalUserMap by user_id:', userId);
    return res.status(200).json(globalUserMap.get(userId.toString()));
  }

  const cachedTweets = await getCachedTimelineFromWorker();
  const matchedTweet = cachedTweets.find(t => 
    (screenName && t.user?.screen_name?.toLowerCase() === screenName.toLowerCase()) ||
    (userId && idMatches(t.user?.id_str, userId))
  );

  if (matchedTweet && matchedTweet.user) {
    console.log('[XitterBridge users/show] found via cached tweet match for', screenName || userId);
    return res.status(200).json(sanitizeUser(matchedTweet.user));
  }

  if (screenName) {
    console.log('[XitterBridge users/show] NO MATCH for', screenName, '- returning synthetic placeholder profile. Scanned', cachedTweets.length, 'cached tweets, globalUserMap had', globalUserMap.size, 'entries.');
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

  if (userId) {
    // Unknown person: answer with a neutral placeholder rather than showing your own profile as theirs.
    console.log('[XitterBridge users/show] unknown user_id', userId, '- returning a placeholder (not your account).');
    return res.status(200).json(sanitizeUser({ id_str: String(userId), screen_name: '', name: '' }));
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
      const viaId = /^\d+$/.test(name) ? handleForUserId(name) : null;
      const known = knownUsers.get((viaId || name).toLowerCase()) || (profileCache.get((viaId || name).toLowerCase()) || {}).user;
      if (known && !isPlaceholderUser(known)) {
        matchedUsers.push(known);
        continue;
      }
      if (globalUserMap.has(name)) {
        matchedUsers.push(globalUserMap.get(name));
        continue;
      }
      const match = cachedTweets.find(t => t.user?.screen_name?.toLowerCase() === name || idMatches(t.user?.id_str, name));
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
  const currentAcc = cachedAccountProfile;

  const targetScreen = screenName || handleForUserId(req.query.user_id) || (isPlaceholderUser(currentAcc) ? '' : currentAcc.screen_name) || scrapeStats.lastHome?.ownHandle || '';
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets].map(t => sanitizeTweet(t));

  if (!targetScreen) {
    return res.status(200).json(filterByIdRange(allTweets, req.query).slice(0, 25));
  }

  const key = targetScreen.toLowerCase();
  const fromTimeline = allTweets.filter(t => t.user?.screen_name?.toLowerCase() === key);
  const prof = await getProfile(targetScreen);
  const fromProfile = prof && prof.tweets ? prof.tweets.map(t => sanitizeTweet(t)) : [];

  const byId = new Map();
  [...fromTimeline, ...fromProfile].forEach(t => byId.set(t.id_str, t));
  const userTweets = Array.from(byId.values()).sort((a, b) => {
    try { return Number(BigInt(b.id_str) - BigInt(a.id_str)); } catch (e) { return 0; }
  });
  console.log(`[XitterBridge user_timeline] @${targetScreen}: ${fromProfile.length} from profile fetch, ${fromTimeline.length} from home cache.`);
  return res.status(200).json(filterByIdRange(userTweets, req.query));
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
