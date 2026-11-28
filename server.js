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
const PROFILE_WAIT_MS = Number(process.env.PROFILE_WAIT_MS) || 6000; // old apps give up after ~10-15s
const STORE = { forStorage: true };
// Profile pictures. Default "normal": the app gets addresses ending in "_normal" (so it can swap in the
// size it wants, like old Twitter), served through the bridge, which always answers with the sharp
// 400x400 picture - so they're never blurry. Other values send X's address directly at that size:
// 400x400, 200x200, bigger, original.
const AVATAR_SIZE = (process.env.AVATAR_SIZE || 'normal').toLowerCase();
let publicBase = (process.env.PUBLIC_URL || 'https://xitterbridge.onrender.com').replace(/\/$/, '');
// IMAGE_PROXY=on: pictures are fetched by this server and passed to the phone, so the phone never has to
// connect to X's image server itself (fixes phones that can't reach pbs.twimg.com).
const IMAGE_PROXY = /^(on|true|1|yes)$/i.test(process.env.IMAGE_PROXY || '');
const IMAGE_HOSTS = ['pbs.twimg.com', 'abs.twimg.com'];

// Real users captured from X's own API responses (handle -> sanitized user). Never cleared on refresh.
const knownUsers = new Map();
// Handles whose follower/tweet counts came from X itself (not the 100 placeholders in old saved tweets).
const realCountsFor = new Set();
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
  
  if (req.path.startsWith('/1.1/') || req.path.startsWith('/1/')) rememberBase(req);
  if (!req.path.startsWith('/img')) console.log(`[XitterBridge WP CLIENT] ${req.method} ${req.originalUrl || req.url}`);
  next();
});

// ---------- Guest mode -> force login ----------
// Old Twitter apps browse without an account by getting an app-only token (POST /oauth2/token) or a
// guest token (POST /1.1/guest/activate.json), then calling the API with "Authorization: Bearer ..."
// and/or an "x-guest-token" header instead of a signed-in (OAuth 1.0a) request. The bridge refuses
// all of that with the same 401 "Invalid or expired token" the real API used for a dead session,
// which makes apps show their sign-in screen. Guests are ALLOWED by default (they can read, and sign in
// from inside guest mode); set FORCE_LOGIN=on on Render to refuse guest mode.
const FORCE_LOGIN = /^(on|true|1|yes)$/i.test(process.env.FORCE_LOGIN || '');
const GUEST_TOKEN_PATHS = new Set(['/oauth2/token', '/oauth2/invalidate_token', '/1.1/guest/activate.json', '/1/guest/activate.json']);

function isGuestRequest(req) {
  if (GUEST_TOKEN_PATHS.has(req.path)) return true;
  if (!(req.path.startsWith('/1.1/') || req.path.startsWith('/1/'))) return false;
  const auth = String(req.headers['authorization'] || '');
  const signedIn = /oauth_token=/.test(auth) || !!(req.query && req.query.oauth_token) || !!(req.body && req.body.oauth_token);
  if (signedIn) return false;                      // a signed-in app: never treat as guest
  if (req.headers['x-guest-token']) return true;   // explicit guest session
  return /^Bearer\s/i.test(auth);                 // app-only token, no account
}

function guestGate(req, res, next) {
  if (!FORCE_LOGIN || !isGuestRequest(req)) return next();
  console.log(`[XitterBridge] Guest mode refused (${req.method} ${req.path}) -> app should show its login screen.`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('WWW-Authenticate', 'OAuth realm="https://api.twitter.com", api_error_code=89');
  return res.status(401).send(JSON.stringify({ errors: [{ code: 89, message: 'Invalid or expired token.' }] }));
}
app.use(guestGate);

// ---------- Sign-in key for anything that changes your X account ----------
// Reading is open (guest mode). Posting, liking, retweeting, deleting, following and DMs only work for a
// signed-in app holding the key handed out at login. The key is derived from BRIDGE_SECRET, so it
// can't be guessed from your username.
function bridgeAccessToken() {
  return 'xb' + crypto.createHmac('sha256', String(process.env.BRIDGE_SECRET || 'xitterbridge')).update('access-token-v1').digest('hex').slice(0, 38);
}
function bridgeAccessSecret() {
  return crypto.createHmac('sha256', String(process.env.BRIDGE_SECRET || 'xitterbridge')).update('access-secret-v1').digest('hex').slice(0, 40);
}
function requestAccessToken(req) {
  const auth = String(req.headers['authorization'] || '');
  const m = auth.match(/oauth_token="([^"]+)"/);
  return (m && decodeURIComponent(m[1])) || (req.body && req.body.oauth_token) || (req.query && req.query.oauth_token) || '';
}
const WRITE_ALLOWED_WITHOUT_KEY = /push_destinations|\/scribe|\/oauth\//;
function writeGate(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return next();
  if (!(req.path.startsWith('/1.1/') || req.path.startsWith('/1/'))) return next();
  if (WRITE_ALLOWED_WITHOUT_KEY.test(req.path)) return next();
  if (requestAccessToken(req) === bridgeAccessToken()) return next();
  console.log(`[XitterBridge] Refused ${req.method} ${req.path}: not signed in with this bridge (guests can read only). Sign in to post.`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(401).send(JSON.stringify({ errors: [{ code: 89, message: 'Invalid or expired token.' }] }));
}
app.use(writeGate);

// Your timeline, notifications, messages and "who am I" are personal: only an app signed in with this
// bridge's key gets them. Everyone else (guest mode, or an app still holding an old login) gets what a
// logged-out Twitter app saw: empty personal lists and "not signed in" for "who am I". Moments, search,
// trends, profiles and single tweets stay open.
const PERSONAL_EMPTY_LIST = [
  /^\/1(\.1)?\/statuses\/(home_timeline|mentions_timeline)\.json$/,
  /^\/1(\.1)?\/activity\/about_me\.json$/,
  /^\/1(\.1)?\/direct_messages(\/sent)?\.json$/,
  /^\/1(\.1)?\/(friends|followers)\/ids\.json$/,
  /^\/1(\.1)?\/saved_searches\/list\.json$/
];
const PERSONAL_NOT_SIGNED_IN = [
  /^\/1(\.1)?\/account\/verify_credentials\.json$/,
  /^\/1(\.1)?\/account\/settings\.json$/,
  /^\/1(\.1)?\/dm\//,
  /^\/1(\.1)?\/direct_messages\//
];
function isSignedIn(req) { return requestAccessToken(req) === bridgeAccessToken(); }
function personalGate(req, res, next) {
  if (req.method !== 'GET' || isSignedIn(req)) return next();
  const p = req.path;
  if (/^\/1(\.1)?\/timeline\/home\.json$/.test(p)) {
    console.log(`[XitterBridge] Not signed in -> logged-out (empty) home timeline`);
    return res.status(200).json({ twitter_objects: { tweets: {}, users: {}, events: {} }, response: { timeline: [], cursor: { top: '0', bottom: '0' } } });
  }
  if (PERSONAL_EMPTY_LIST.some(rx => rx.test(p))) {
    console.log(`[XitterBridge] Not signed in -> empty ${p}`);
    if (/\/ids\.json$/.test(p)) return res.status(200).json({ ids: [], next_cursor: 0, next_cursor_str: '0', previous_cursor: 0, previous_cursor_str: '0' });
    return res.status(200).json([]);
  }
  if (PERSONAL_NOT_SIGNED_IN.some(rx => rx.test(p))) {
    console.log(`[XitterBridge] Not signed in -> "please sign in" for ${p}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(401).send(JSON.stringify({ errors: [{ code: 89, message: 'Invalid or expired token.' }] }));
  }
  return next();
}
app.use(personalGate);

// Guest settings the Windows 10 app asks for before showing guest mode.
app.get(['/1.1/mobile/settings/guest.json', '/1/mobile/settings/guest.json'], (req, res) => res.status(200).json({}));

// Guest tokens, so guest mode works in apps that ask for one first.
app.post(['/oauth2/token'], (req, res) => {
  return res.status(200).json({ token_type: 'bearer', access_token: 'AAAAAAAAAAAAAAAAAAAAAXitterBridgeGuestBearerToken' });
});
app.post(['/1.1/guest/activate.json', '/1/guest/activate.json'], (req, res) => {
  return res.status(200).json({ guest_token: String(1500000000000000000 + Math.floor(Math.random() * 1e15)) });
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

// JavaScript numbers can't hold 19-digit IDs exactly (1731289699753291776 becomes ...291800), so the app
// saw your account number differently at login and on your profile. Write every numeric id exactly as its
// *_str twin, the way the real Twitter API did.
const ID_PAIRS = [['id', 'id_str'], ['user_id', 'user_id_str'], ['in_reply_to_status_id', 'in_reply_to_status_id_str'],
  ['in_reply_to_user_id', 'in_reply_to_user_id_str'], ['quoted_status_id', 'quoted_status_id_str']];
function exactJsonStringify(body) {
  const clone = JSON.parse(JSON.stringify(body === undefined ? null : body));
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    for (const [num, str] of ID_PAIRS) {
      if (typeof n[num] === 'number' && typeof n[str] === 'string' && /^\d{1,19}$/.test(n[str])) n[num] = `__XB_EXACT_${n[str]}__`;
    }
    for (const k of Object.keys(n)) if (n[k] && typeof n[k] === 'object') walk(n[k]);
  };
  walk(clone);
  return JSON.stringify(clone).replace(/"__XB_EXACT_(\d+)__"/g, '$1');
}

app.use((req, res, next) => {
  if (!(req.path.startsWith('/1.1/') || req.path.startsWith('/1/'))) return next();
  const base = (process.env.PUBLIC_URL || `https://${req.headers.host}`).replace(/\/$/, '');
  res.json = body => {
    let out = body;
    if (IMAGE_PROXY) out = rewriteImagesForClient(JSON.parse(JSON.stringify(out === undefined ? null : out)), base);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.send(exactJsonStringify(out));
  };
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

// https://<bridge>/img/a/<hex of the picture's address>_normal.jpg  (hex: no "_" inside the code, so
// whatever size the app swaps in after it is easy to strip)
function bridgeAvatarUrl(base, ext) {
  const e = /png/i.test(ext) ? 'png' : 'jpg';
  return `${publicBase}/img/a/${Buffer.from(`${base}|${ext}`).toString('hex')}_normal.${e}`;
}
function decodeBridgeAvatar(url) {
  const m = String(url).match(/\/img\/a\/([0-9a-f]+)(?:_[a-z0-9_]+)?(?:\.[a-z]+)?(?::[a-z]+)?$/i);
  if (!m) return null;
  const [base, ext] = Buffer.from(m[1], 'hex').toString('utf8').split('|');
  return base && ext && base.startsWith('https://pbs.twimg.com/profile_images/') ? { base, ext } : null;
}

function forceJpgAvatarUrl(url) {
  const defaultAvatar = "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png";
  if (!url) return defaultAvatar;
  let fixed = fixUrl(url);
  // Already one of ours (e.g. read back from the Worker): rebuild it so it stays consistent.
  const mine = fixed.includes('/img/a/') ? decodeBridgeAvatar(fixed) : null;
  if (mine) {
    if (AVATAR_SIZE === 'normal') return bridgeAvatarUrl(mine.base, mine.ext);
    fixed = `${mine.base}.${mine.ext}`;
  }
  if (fixed.includes('pbs.twimg.com/profile_images/')) {
    // Size comes from AVATAR_SIZE (default 400x400, the format the app displayed correctly).
    // Keep the picture's real file type: a .png avatar asked for as .jpg can fail to load.
    const m = fixed.split('?')[0].match(/^(.*?)(?:_(?:normal|mini|bigger|reasonably_small|200x200|x96|400x400))?\.(jpe?g|png|gif|webp)$/i);
    if (m && AVATAR_SIZE === 'normal') return bridgeAvatarUrl(m[1], m[2].toLowerCase());
    if (m) return AVATAR_SIZE === 'original' ? `${m[1]}.${m[2].toLowerCase()}` : `${m[1]}_${AVATAR_SIZE}.${m[2].toLowerCase()}`;
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
    for (const k of ['description', 'location', 'url', 'created_at', 'verified', 'protected', 'entities']) {
      if (u[k] === undefined || u[k] === null || u[k] === '') u = { ...u, [k]: knownReal[k] };
    }
    for (const k of ['followers_count', 'friends_count', 'listed_count', 'favourites_count', 'statuses_count']) {
      if (typeof knownReal[k] === 'number' && knownReal[k] !== 100) u = { ...u, [k]: knownReal[k] };
      else if (u[k] === undefined || u[k] === null) u = { ...u, [k]: knownReal[k] };
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
    // The original code always said "no profile picture" here, which tells the app to skip downloading it.
    default_profile_image: avatar.includes('default_profile'),
    default_profile: avatar.includes('default_profile') && !banner,
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

function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
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
    // X's current layout (seen live): banner.image_url, relationship_counts.{followers,following},
    // tweet_counts.tweets, action_counts.favorites_count, website.url. Older layout kept as a fallback.
    profile_banner_url: (u.banner && u.banner.image_url) || legacy.profile_banner_url || '',
    description: (u.profile_bio && u.profile_bio.description) || legacy.description || '',
    location: (u.location && u.location.location) || (typeof legacy.location === 'string' ? legacy.location : '') || '',
    url: (u.website && u.website.url) || legacy.url || null,
    followers_count: num(u.relationship_counts && u.relationship_counts.followers) ?? findCount(legacy, ['followers_count']) ?? findCount(u, ['followers_count', 'normal_followers_count']),
    friends_count: num(u.relationship_counts && u.relationship_counts.following) ?? findCount(legacy, ['friends_count']) ?? findCount(u, ['friends_count', 'following_count']),
    listed_count: findCount(legacy, ['listed_count']) ?? findCount(u, ['listed_count']),
    favourites_count: num(u.action_counts && u.action_counts.favorites_count) ?? findCount(legacy, ['favourites_count']) ?? findCount(u, ['favourites_count', 'likes_count', 'like_count']),
    statuses_count: num(u.tweet_counts && u.tweet_counts.tweets) ?? findCount(legacy, ['statuses_count']) ?? findCount(u, ['statuses_count', 'tweet_count', 'tweets_count']),
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

// First picture URL inside a trend/story object (X attaches a thumbnail to many of them).
function firstImageUrl(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (typeof node === 'string') return /^https:\/\/pbs\.twimg\.com\/(?!profile_images|profile_banners)/.test(node) ? node : null;
  if (typeof node !== 'object') return null;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const r = firstImageUrl(v, depth + 1);
    if (r) return r;
  }
  return null;
}

function newSink() {
  return { tweets: [], users: new Map(), userItems: [], trends: [], notifications: [], ops: [], raw: [], seen: new Set(), pending: [], responses: 0, profileUser: null, created: null, createdError: null, retweetedId: null };
}

// Render's small instance can only run ONE headless browser. Every job waits for its turn; nothing forces
// its way in (that caused "Timed out ... waiting for the WS endpoint" when two started at once).
const BROWSER_JOB_LIMIT_MS = 110000; // a stuck job gets its browser closed after this
async function acquireBrowser(maxWaitMs) {
  const start = Date.now();
  while (isScraping) {
    if (Date.now() - start > maxWaitMs) return false;
    await new Promise(r => setTimeout(r, 500));
  }
  isScraping = true;
  lastScrapeTime = Date.now();
  return true;
}
function startWatchdog(getBrowser, label) {
  return setTimeout(() => {
    const b = getBrowser();
    if (b) {
      console.log(`[XitterBridge] ${label} ran too long; closing its browser.`);
      b.close().catch(() => {});
    }
  }, BROWSER_JOB_LIMIT_MS);
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
    // Notifications (GraphQL layout): TimelineNotification { notification_icon, timestamp_ms, template: { from_users, target_objects } }
    if (node.__typename === 'TimelineNotification' || node.itemType === 'TimelineNotification') {
      const icon = node.notification_icon || (node.icon && node.icon.id) || '';
      const tpl = node.template || {};
      const fromRefs = tpl.from_users || tpl.fromUsers || [];
      const targetRefs = tpl.target_objects || tpl.targetObjects || [];
      const users = fromRefs.map(x => userFromGraphQL(x && x.user_results && x.user_results.result)).filter(Boolean);
      const tweets = targetRefs.map(x => tweetFromGraphQL(x && x.tweet_results && x.tweet_results.result)).filter(Boolean);
      const type = notificationTypeFromIcon(icon);
      if (type && !sink.notifications.some(n => n.id === node.id)) {
        sink.notifications.push({ id: String(node.id || ''), type, at: Number(node.timestamp_ms || node.timestampMs) || Date.now(), users, tweets, text: (node.rich_message && node.rich_message.text) || '' });
      }
    }
    // Trends (Explore page): { name, trend_metadata: { meta_description: "12.3K posts" }, trend_url: { url } }
    if ((node.itemType === 'TimelineTrend' || node.__typename === 'TimelineTrend') && typeof node.name === 'string' && node.name) {
      if (!sink.trends.some(x => x.name === node.name)) {
        let query = node.name;
        const turl = node.trend_url && node.trend_url.url;
        if (typeof turl === 'string') {
          const m = turl.match(/[?&]query=([^&]+)/);
          if (m) { try { query = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) {} }
        }
        const meta = node.trend_metadata || {};
        sink.trends.push({ name: node.name, query, volumeText: meta.meta_description || '', context: meta.domain_context || '', image: firstImageUrl(node) });
      }
    }
    // News / event stories on Explore tabs: they have a title and usually a picture.
    const tn = String(node.__typename || node.itemType || '');
    if (/Event(Summary)?$|NewsArticle|Story/.test(tn) && typeof node.title === 'string' && node.title && !sink.trends.some(x => x.name === node.title)) {
      sink.trends.push({ name: node.title, query: node.title, volumeText: '', context: typeof node.supportingText === 'string' ? node.supportingText : (typeof node.timeString === 'string' ? node.timeString : ''), image: firstImageUrl(node), isStory: true });
    }
    // People results (search "People" tab): keep them in the order X lists them.
    if ((node.itemType === 'TimelineUser' || node.__typename === 'TimelineUser') && node.user_results && node.user_results.result) {
      const pu = userFromGraphQL(node.user_results.result);
      if (pu && !sink.userItems.some(x => x.id_str === pu.id_str)) sink.userItems.push(pu);
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
    const isNotifRest = /\/i\/api\/2\/notifications\//.test(url);
    if (!url.includes('/i/api/graphql/') && !isNotifRest) return;
    try { if (resp.request().method() === 'OPTIONS') return; } catch (e) {}
    sink.pending.push(resp.json().then(json => {
      sink.responses++;
      const op = (url.match(/\/graphql\/[^/]+\/([A-Za-z0-9_]+)/) || [])[1] || url;
      sink.ops.push(op);
      if (sink.keepRaw && sink.raw.length < 4) sink.raw.push({ op, body: JSON.stringify(json).slice(0, 6000) });
      const trendsBefore = sink.trends.length;
      collectFromGraphQL(json, sink);
      if (sink.keepRaw && sink.trends.length > trendsBefore && !sink.trendSnippet) {
        // Keep X's own data around the first trend in this reply, to see where its picture lives.
        const text = JSON.stringify(json);
        const at = text.indexOf(JSON.stringify(sink.trends[trendsBefore].name).slice(1, -1));
        sink.trendSnippet = { op, around_first_trend: text.slice(Math.max(0, at - 2500), at + 3500) };
      }
      if (isNotifRest) parseNotificationsV2(json, sink);
      if (/\/CreateTweet\b/.test(url)) {
        const r = json && json.data && json.data.create_tweet && json.data.create_tweet.tweet_results && json.data.create_tweet.tweet_results.result;
        if (r) sink.created = tweetFromGraphQL(r);
        else sink.createdError = (json && json.errors && json.errors[0] && json.errors[0].message) || 'X did not return the new tweet';
      }
      const actionOp = (url.match(/\/(FavoriteTweet|UnfavoriteTweet|DeleteRetweet|DeleteTweet)\b/) || [])[1];
      if (actionOp) {
        sink.actionOp = actionOp;
        sink.actionOk = !(json && json.errors && json.errors.length);
        if (!sink.actionOk) sink.createdError = json.errors[0].message || `${actionOp} failed`;
      }
      if (/\/CreateRetweet\b/.test(url)) {
        const rr = json && json.data && json.data.create_retweet && json.data.create_retweet.retweet_results && json.data.create_retweet.retweet_results.result;
        if (rr && rr.rest_id) sink.retweetedId = rr.rest_id;
        else sink.createdError = (json && json.errors && json.errors[0] && json.errors[0].message) || 'X did not confirm the retweet';
      }
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
    if (s && s.screen_name && !s.screen_name.startsWith('user_')) {
      knownUsers.set(s.screen_name.toLowerCase(), s);
      if (u.followers_count !== undefined) realCountsFor.add(s.screen_name.toLowerCase());
    }
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
  if (profileInFlight.size >= 3) return Promise.resolve(null); // don't let background fetches pile up
  const job = (async () => {
    const tokens = await getTokens();
    if (!tokens.auth_token || !tokens.ct0) return null;
    if (!(await acquireBrowser(90000))) return null; // busy for too long: skip, try again next time
    let browser;
    const sink = newSink();
    const watchdog = startWatchdog(() => browser, `Profile fetch @${handle}`);
    try {
      const opened = await openXPage(tokens);
      browser = opened.browser;
      const page = opened.page;
      attachGraphQLCapture(page, sink);
      // Start waiting for X's profile and tweet data before navigating, so a fast reply isn't missed.
      const gotTweets = page.waitForResponse(r => /\/UserTweets\b/.test(r.url()), { timeout: 30000 }).catch(() => null);
      const gotUser = page.waitForResponse(r => /\/UserByScreenName\b/.test(r.url()), { timeout: 30000 }).catch(() => null);
      await page.goto(`https://x.com/${encodeURIComponent(handle)}`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await Promise.all([gotTweets, gotUser]);
      await page.waitForSelector('article[data-testid="tweet"], [data-testid="emptyState"]', { timeout: 10000 }).catch(() => {});
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await new Promise(r => setTimeout(r, 2500));
      await Promise.allSettled(sink.pending);
    } catch (e) {
      scrapeStats.lastError = `profile ${handle}: ${e && e.message ? e.message : e}`;
    } finally {
      clearTimeout(watchdog);
      if (browser) await browser.close().catch(() => {});
      isScraping = false;
    }
    registerSinkUsers(sink);
    const user = sink.profileUser ? sanitizeUser(sink.profileUser) : (knownUsers.get(key) || null);
    if (user && !isPlaceholderUser(user)) knownUsers.set(key, user);
    if (sink.profileUser && sink.profileUser.followers_count !== undefined) realCountsFor.add(key);
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

// ---------- Notifications ----------
// Real notifications from x.com/notifications. X has used two layouts; both are read:
//  - REST /i/api/2/notifications/all.json: globalObjects.{notifications,users,tweets} + timeline entries
//  - GraphQL: TimelineNotification items (see collectFromGraphQL)
function notificationTypeFromIcon(icon) {
  const i = String(icon || '').toLowerCase();
  if (i.includes('heart')) return 'favorite';
  if (i.includes('retweet')) return 'retweet';
  if (i.includes('person') || i.includes('follow')) return 'follow';
  return null; // recommendations, "new posts from", security notices... not shown
}

function parseNotificationsV2(json, sink) {
  const go = json && json.globalObjects;
  if (!go) return;
  const users = go.users || {}, tweets = go.tweets || {};
  const tweetFrom = id => {
    const t = id && tweets[id];
    if (!t) return null;
    return { ...t, id_str: t.id_str || String(id), text: t.full_text || t.text || '', full_text: t.full_text || t.text || '', user: users[t.user_id_str] || null };
  };
  for (const n of Object.values(go.notifications || {})) {
    const type = notificationTypeFromIcon(n.icon && n.icon.id);
    if (!type) continue;
    const tpl = (n.template && (n.template.aggregateUserActionsV1 || n.template.aggregate_user_actions_v1)) || {};
    const from = (tpl.fromUsers || []).map(x => users[x && x.user && x.user.id]).filter(Boolean);
    const targ = (tpl.targetObjects || []).map(x => tweetFrom(x && x.tweet && x.tweet.id)).filter(Boolean);
    if (!sink.notifications.some(x => x.id === n.id)) {
      sink.notifications.push({ id: String(n.id), type, at: Number(n.timestampMs) || Date.now(), users: from, tweets: targ, text: (n.message && n.message.text) || '' });
    }
  }
  // Mentions and replies arrive as plain tweet entries in the timeline.
  const instructions = (json.timeline && json.timeline.instructions) || [];
  for (const ins of instructions) {
    const entries = (ins.addEntries && ins.addEntries.entries) || [];
    for (const e of entries) {
      const tid = e.content && e.content.item && e.content.item.content && e.content.item.content.tweet && e.content.item.content.tweet.id;
      const t = tweetFrom(tid);
      if (!t || !t.user || sink.notifications.some(x => x.id === 'tweet-' + t.id_str)) continue;
      sink.notifications.push({ id: 'tweet-' + t.id_str, type: 'mentionTweet', at: Date.parse(t.created_at) || Number(e.sortIndex) || Date.now(), users: [t.user], tweets: [t], parent: tweetFrom(t.in_reply_to_status_id_str) });
    }
  }
}

const notificationsCache = { items: null, fetchedAt: 0 };
let notificationsInFlight = null;
let lastNotificationsRaw = [];

function scrapeNotifications() {
  if (notificationsInFlight) return notificationsInFlight;
  notificationsInFlight = (async () => {
    const tokens = await getTokens();
    if (!tokens.auth_token || !tokens.ct0) return null;
    if (!(await acquireBrowser(60000))) return null;
    let browser, landedUrl = '';
    const sink = newSink();
    sink.keepRaw = true;
    const watchdog = startWatchdog(() => browser, 'Notifications fetch');
    try {
      const opened = await openXPage(tokens);
      browser = opened.browser;
      const page = opened.page;
      attachGraphQLCapture(page, sink);
      await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      landedUrl = page.url();
      for (let i = 0; i < 40 && sink.notifications.length === 0 && sink.tweets.length === 0; i++) await new Promise(r => setTimeout(r, 500));
      await new Promise(r => setTimeout(r, 2000));
      await Promise.allSettled(sink.pending);
    } catch (e) {
      scrapeStats.lastError = `notifications: ${e && e.message ? e.message : e}`;
    } finally {
      clearTimeout(watchdog);
      if (browser) await browser.close().catch(() => {});
      isScraping = false;
    }
    registerSinkUsers(sink);
    // GraphQL layout: mentions/replies come through as ordinary tweets on the notifications page.
    const me = cachedAccountProfile && cachedAccountProfile.screen_name ? cachedAccountProfile.screen_name.toLowerCase() : '';
    for (const t of sink.tweets) {
      if (!t.user || (me && t.user.screen_name && t.user.screen_name.toLowerCase() === me)) continue;
      if (sink.notifications.some(x => x.id === 'tweet-' + t.id_str)) continue;
      sink.notifications.push({ id: 'tweet-' + t.id_str, type: 'mentionTweet', at: Date.parse(t.created_at) || Date.now(), users: [t.user], tweets: [t], parent: null });
    }
    sink.notifications.sort((a, b) => b.at - a.at);
    lastNotificationsRaw = sink.raw;
    scrapeStats.lastNotifications = { at: new Date().toISOString(), landedUrl, apiResponses: sink.responses, operations: sink.ops, notifications: sink.notifications.length };
    console.log(`[XitterBridge Notifications] ${sink.responses} API responses, ${sink.notifications.length} notifications.`);
    if (sink.notifications.length || sink.responses) {
      notificationsCache.items = sink.notifications;
      notificationsCache.fetchedAt = Date.now();
    }
    return notificationsCache;
  })().finally(() => { notificationsInFlight = null; });
  return notificationsInFlight;
}

// Old activity/about_me item. The app shows "<first source> and <sources_size - 1> others ...",
// so sources_size must be present. Liked/retweeted items point at YOUR tweet in targets.
function activityItem(action, at, sources, targets, targetObjects) {
  return {
    action,
    max_position: String(at),
    min_position: String(at),
    created_at: formatTwitterDate(new Date(at)),
    sources, sources_size: sources.length,
    targets, targets_size: targets.length,
    target_objects: targetObjects, target_objects_size: targetObjects.length
  };
}

function notificationToActivity(n, me) {
  const sources = (n.users || []).map(u => sanitizeUser(u)).filter(u => !isPlaceholderUser(u));
  if (!sources.length) return null;
  const tweets = (n.tweets || []).map(t => sanitizeTweet(t));
  if (n.type === 'follow') return activityItem('follow', n.at, sources, [me], []);
  if (n.type === 'favorite' || n.type === 'retweet') {
    if (!tweets.length) return null;
    return activityItem(n.type, n.at, sources, tweets, []);
  }
  if (n.type === 'mentionTweet') {
    const t = tweets[0];
    if (!t) return null;
    if (t.in_reply_to_status_id_str) return activityItem('reply', n.at, sources.slice(0, 1), [t], n.parent ? [sanitizeTweet(n.parent)] : []);
    if (t.quoted_status) return activityItem('quote', n.at, sources.slice(0, 1), [t], [t.quoted_status]);
    return activityItem('mention', n.at, sources.slice(0, 1), [t], []);
  }
  return null;
}

// ---------- Conversations (replies) ----------
const conversationCache = new Map(); // tweet id -> { tweets, fetchedAt }
const conversationInFlight = new Map();

function scrapeConversation(tweetId) {
  const id = String(tweetId);
  if (conversationInFlight.has(id)) return conversationInFlight.get(id);
  if (conversationInFlight.size >= 3) return Promise.resolve(null);
  const job = (async () => {
    const tokens = await getTokens();
    if (!tokens.auth_token || !tokens.ct0) return null;
    if (!(await acquireBrowser(60000))) return null;
    let browser;
    const sink = newSink();
    const watchdog = startWatchdog(() => browser, `Replies for ${id}`);
    try {
      const opened = await openXPage(tokens);
      browser = opened.browser;
      const page = opened.page;
      attachGraphQLCapture(page, sink);
      const got = page.waitForResponse(r => /\/TweetDetail\b/.test(r.url()), { timeout: 30000 }).catch(() => null);
      await page.goto(`https://x.com/i/status/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await got;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      await Promise.allSettled(sink.pending);
    } catch (e) {
      scrapeStats.lastError = `replies ${id}: ${e && e.message ? e.message : e}`;
    } finally {
      clearTimeout(watchdog);
      if (browser) await browser.close().catch(() => {});
      isScraping = false;
    }
    registerSinkUsers(sink);
    const entry = { tweets: sink.tweets.map(t => sanitizeTweet(t, STORE)), fetchedAt: Date.now() };
    conversationCache.set(id, entry);
    if (conversationCache.size > 100) conversationCache.delete(conversationCache.keys().next().value);
    scrapeStats.lastConversation = { id, at: new Date().toISOString(), apiResponses: sink.responses, tweets: entry.tweets.length };
    console.log(`[XitterBridge Replies] tweet ${id}: ${sink.responses} API responses, ${entry.tweets.length} tweets in the conversation.`);
    return entry;
  })().finally(() => conversationInFlight.delete(id));
  conversationInFlight.set(id, job);
  return job;
}

function findInConversations(tweetId) {
  const id = String(tweetId);
  // Exact id first; the rounded match (for ids the app has rounded) only if nothing matches exactly.
  for (const c of conversationCache.values()) {
    const t = c.tweets.find(x => x.id_str === id);
    if (t) return t;
  }
  for (const c of conversationCache.values()) {
    const t = c.tweets.find(x => idMatches(x.id_str, id));
    if (t) return t;
  }
  return null;
}

async function getConversation(tweetId) {
  const id = String(tweetId);
  const cached = conversationCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < 2 * 60 * 1000) return cached;
  const fresh = await Promise.race([scrapeConversation(id), new Promise(r => setTimeout(() => r(null), SEARCH_WAIT_MS))]);
  return fresh || cached || null;
}

// Splits a conversation into the tweets above the one you opened, that tweet, and the replies below it.
function splitConversation(list, focalId) {
  const tweets = list.map(t => sanitizeTweet(t)).sort((a, b) => { try { return BigInt(a.id_str) < BigInt(b.id_str) ? -1 : 1; } catch (e) { return 0; } });
  const focal = tweets.find(t => t.id_str === String(focalId)) || null;
  const ancestors = [];
  if (focal) {
    let cur = focal;
    while (cur && cur.in_reply_to_status_id_str) {
      const parent = tweets.find(t => t.id_str === cur.in_reply_to_status_id_str);
      if (!parent || ancestors.includes(parent)) break;
      ancestors.unshift(parent);
      cur = parent;
    }
  }
  const descendants = tweets.filter(t => t !== focal && !ancestors.includes(t));
  return { ancestors, focal, descendants };
}

// ---------- Posting to X ----------
// The app gets an answer straight away (old apps give up after ~15s, and posting takes longer);
// the server then posts on x.com in the background. Nothing is retried automatically, so a slow
// post can never turn into a double post. Results are listed at /debug/posts.
const postLog = [];       // newest first
let postQueue = Promise.resolve();
const recentPostKeys = new Map();

function logPost(entry) {
  postLog.unshift({ at: new Date().toISOString(), ...entry });
  if (postLog.length > 30) postLog.pop();
  console.log(`[XitterBridge Post] ${entry.kind} ${entry.ok ? 'OK' : 'FAILED'}: ${entry.detail || ''}`);
}

function toXUrl(text) {
  return String(text || '').replace(/https?:\/\/(?:www\.|mobile\.)?twitter\.com\//gi, 'https://x.com/');
}

function enqueuePost(job) {
  // Same post text, or the same action on the same tweet twice in a row within 2 minutes, is a
  // double-send by the app. A different action in between (like, unlike, like) is allowed.
  const key = job.tweetId ? `tweet:${job.tweetId}` : `post:${job.text || ''}:${job.replyTo || ''}`;
  const last = recentPostKeys.get(key);
  if (last && last.kind === job.kind && Date.now() - last.at < 2 * 60 * 1000) {
    logPost({ kind: job.kind, ok: false, detail: 'skipped: identical request within 2 minutes (the app probably sent it twice)' });
    return;
  }
  recentPostKeys.set(key, { kind: job.kind, at: Date.now() });
  if (recentPostKeys.size > 200) recentPostKeys.delete(recentPostKeys.keys().next().value);
  postQueue = postQueue.then(() => runPostJob(job)).catch(() => {});
}

// Stand-in ids the app was given -> what they really are on X.
const localPostIds = new Map();     // stand-in id of a posted tweet -> real tweet id (once X confirms)
const localRetweetIds = new Map();  // stand-in id of a retweet -> id of the tweet that was retweeted

// Presses a button (by data-testid) on one specific tweet on its page.
function clickInTweet(page, id, testid) {
  return page.evaluate((id, testid) => {
    const arts = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const own = a => Array.from(a.querySelectorAll('a[href*="/status/"]')).some(l => {
      const h = (l.getAttribute('href') || '').split('?')[0].replace(/\/(photo|video|analytics|quotes|retweets|likes).*$/, '');
      return h.endsWith('/status/' + id);
    });
    const art = arts.find(a => own(a) && a.querySelector('time')) || arts.find(a => a.getAttribute('tabindex') === '-1');
    if (!art) return 'no-tweet';
    const b = art.querySelector(`[data-testid="${testid}"]`);
    if (!b) return 'no-button';
    b.click();
    return 'ok';
  }, String(id), testid);
}

const ACTIONS = {
  like:      { button: 'like',      done: 'unlike',  op: 'FavoriteTweet' },
  unlike:    { button: 'unlike',    done: 'like',    op: 'UnfavoriteTweet' },
  unretweet: { button: 'unretweet', done: 'retweet', op: 'DeleteRetweet', confirm: '[data-testid="unretweetConfirm"]' },
  delete:    { button: 'caret',                      op: 'DeleteTweet', menu: 'Delete', confirm: '[data-testid="confirmationSheetConfirm"]' }
};

// mode 'delete': drop that tweet. mode 'unretweet': drop only YOUR retweets of it (the original stays).
async function removeFromWorker(id, mode) {
  const workerUrl = process.env.WORKER_URL, secret = process.env.BRIDGE_SECRET;
  const me = cachedAccountProfile && cachedAccountProfile.id_str;
  const isMyRetweetOf = t => !!(t && t.retweeted_status && String(t.retweeted_status.id_str) === id && t.user && me && t.user.id_str === me);
  const drop = t => mode === 'unretweet' ? isMyRetweetOf(t) : (t && String(t.id_str) === id);
  for (let i = localTimeline.length - 1; i >= 0; i--) if (drop(localTimeline[i])) localTimeline.splice(i, 1);
  if (!workerUrl || !secret) return;
  try {
    const raw = await getRawTimelineFromWorker();
    const kept = raw.filter(t => !drop(t));
    if (kept.length !== raw.length) {
      await fetch(`${workerUrl}/update-timeline`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': secret }, body: JSON.stringify(kept) });
    }
  } catch (e) {}
}

async function runTweetAction(page, sink, job) {
  const a = ACTIONS[job.kind];
  await page.goto(`https://x.com/i/status/${encodeURIComponent(job.tweetId)}`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
  await page.waitForSelector('article[data-testid="tweet"]', { timeout: 25000 });
  await new Promise(r => setTimeout(r, 1500));
  const done = page.waitForResponse(r => new RegExp('/' + a.op + '\\b').test(r.url()), { timeout: 20000 }).catch(() => null);
  const clicked = await clickInTweet(page, job.tweetId, a.button);
  if (clicked !== 'ok') {
    // Already in the wanted state (e.g. liking a tweet you already liked) counts as done.
    if (a.done && (await page.evaluate(t => !!document.querySelector(`article [data-testid="${t}"]`), a.done).catch(() => false))) {
      return { ok: true, detail: `already ${job.kind === 'like' ? 'liked' : job.kind === 'unlike' ? 'not liked' : 'not retweeted'}` };
    }
    return { ok: false, detail: clicked === 'no-tweet' ? 'tweet not found on X (deleted or not visible)' : `no "${a.button}" button on that tweet` };
  }
  if (a.menu) {
    await page.waitForSelector('[role="menuitem"]', { timeout: 10000 });
    const picked = await page.evaluate(label => {
      const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(m => (m.textContent || '').trim().startsWith(label));
      if (!item) return false;
      item.click();
      return true;
    }, a.menu);
    if (!picked) return { ok: false, detail: `no "${a.menu}" in the tweet's menu (only your own tweets can be deleted)` };
  }
  if (a.confirm) {
    await page.waitForSelector(a.confirm, { timeout: 10000 });
    await page.click(a.confirm);
  }
  await done;
  await Promise.allSettled(sink.pending);
  if (sink.actionOp === a.op && sink.actionOk) return { ok: true, detail: `${job.kind} ${job.tweetId} done` };
  return { ok: false, detail: sink.createdError || `pressed the button but X did not confirm` };
}

async function runPostJob(job) {
  const tokens = await getTokens();
  if (!tokens.auth_token || !tokens.ct0) return logPost({ kind: job.kind, ok: false, detail: 'no X cookies' });
  if (!(await acquireBrowser(180000))) return logPost({ kind: job.kind, ok: false, detail: 'browser was busy for 3 minutes; not posted' });
  let browser;
  const sink = newSink();
  const watchdog = startWatchdog(() => browser, `Posting (${job.kind})`);
  try {
    const opened = await openXPage(tokens);
    browser = opened.browser;
    const page = opened.page;
    attachGraphQLCapture(page, sink);
    if (ACTIONS[job.kind]) {
      const r = await runTweetAction(page, sink, job);
      if (r.ok && (job.kind === 'delete' || job.kind === 'unretweet')) removeFromWorker(job.tweetId, job.kind).catch(() => {});
      return logPost({ kind: job.kind, ok: r.ok, detail: r.detail });
    }
    if (job.kind === 'retweet') {
      await page.goto(`https://x.com/intent/retweet?tweet_id=${encodeURIComponent(job.tweetId)}`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      const btn = '[data-testid="confirmationSheetConfirm"]';
      await page.waitForSelector(btn, { timeout: 25000 });
      const done = page.waitForResponse(r => /\/CreateRetweet\b/.test(r.url()), { timeout: 20000 }).catch(() => null);
      await page.click(btn);
      await done;
      await Promise.allSettled(sink.pending);
      if (sink.retweetedId) return logPost({ kind: 'retweet', ok: true, detail: `retweeted ${job.tweetId}` });
      return logPost({ kind: 'retweet', ok: false, detail: sink.createdError || 'clicked Repost but X did not confirm' });
    }
    let url = `https://x.com/intent/post?text=${encodeURIComponent(job.text)}`;
    if (job.replyTo) url += `&in_reply_to=${encodeURIComponent(job.replyTo)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    const btn = '[data-testid="tweetButton"]:not([aria-disabled="true"])';
    await page.waitForSelector(btn, { timeout: 25000 });
    const done = page.waitForResponse(r => /\/CreateTweet\b/.test(r.url()), { timeout: 20000 }).catch(() => null);
    await page.click(btn);
    await done;
    await Promise.allSettled(sink.pending);
    if (sink.created && sink.created.id_str) {
      const real = sanitizeTweet(sink.created, STORE);
      // Swap the stand-in the app was given for the real tweet.
      const i = localTimeline.findIndex(t => t.id_str === job.localId);
      if (i >= 0) localTimeline.splice(i, 1);
      if (job.localId) localPostIds.set(job.localId, real.id_str);
      localTimeline.unshift(real);
      appendCachedTimelineToWorker([real]).catch(() => {});
      return logPost({ kind: job.kind, ok: true, detail: `posted as ${real.id_str}${job.replyTo ? ' (reply to ' + job.replyTo + ')' : ''}` });
    }
    return logPost({ kind: job.kind, ok: false, detail: sink.createdError || 'clicked Post but X did not confirm' });
  } catch (e) {
    return logPost({ kind: job.kind, ok: false, detail: `could not post: ${e && e.message ? e.message : e}` });
  } finally {
    clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
    isScraping = false;
  }
}

// ---------- Search ----------
// Opens x.com/search in the shared browser and keeps X's own results (tweets, or people).
const SEARCH_WAIT_MS = Number(process.env.SEARCH_WAIT_MS) || 12000; // old apps give up after ~15s
const searchCache = new Map();    // "mode:query" -> { tweets, users, fetchedAt }
const searchInFlight = new Map();

function scrapeSearch(query, mode) {
  const key = `${mode}:${query.toLowerCase()}`;
  if (searchInFlight.has(key)) return searchInFlight.get(key);
  const job = (async () => {
    const tokens = await getTokens();
    if (!tokens.auth_token || !tokens.ct0) return null;
    if (!(await acquireBrowser(60000))) return null;
    let browser;
    const sink = newSink();
    const watchdog = startWatchdog(() => browser, `Search "${query}"`);
    try {
      const opened = await openXPage(tokens);
      browser = opened.browser;
      const page = opened.page;
      attachGraphQLCapture(page, sink);
      const gotResults = page.waitForResponse(r => /\/SearchTimeline\b/.test(r.url()), { timeout: 30000 }).catch(() => null);
      const tab = mode === 'users' ? '&f=user' : (mode === 'recent' ? '&f=live' : '');
      await page.goto(`https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query${tab}`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await gotResults;
      await new Promise(r => setTimeout(r, 1500));
      await Promise.allSettled(sink.pending);
    } catch (e) {
      scrapeStats.lastError = `search "${query}": ${e && e.message ? e.message : e}`;
    } finally {
      clearTimeout(watchdog);
      if (browser) await browser.close().catch(() => {});
      isScraping = false;
    }
    registerSinkUsers(sink);
    const entry = {
      tweets: sink.tweets.map(t => sanitizeTweet(t, STORE)),
      users: sink.userItems.map(u => sanitizeUser(u)),
      fetchedAt: Date.now()
    };
    searchCache.set(key, entry);
    if (searchCache.size > 50) searchCache.delete(searchCache.keys().next().value);
    scrapeStats.lastSearch = { query, mode, at: new Date().toISOString(), graphqlResponses: sink.responses, tweets: entry.tweets.length, users: entry.users.length };
    console.log(`[XitterBridge Search] "${query}" (${mode}): ${sink.responses} API responses, ${entry.tweets.length} tweets, ${entry.users.length} people.`);
    return entry;
  })().finally(() => searchInFlight.delete(key));
  searchInFlight.set(key, job);
  return job;
}

// Fresh cached results answer instantly; otherwise wait up to SEARCH_WAIT_MS, and if X is slower the
// results are kept, so searching again shows them.
async function getSearch(query, mode) {
  const key = `${mode}:${query.toLowerCase()}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) return cached;
  const job = scrapeSearch(query, mode);
  const fresh = await Promise.race([job, new Promise(r => setTimeout(() => r(null), SEARCH_WAIT_MS))]);
  return fresh || cached || null;
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
          // (Old saved copies are NOT added to knownUsers: their counts are placeholders from older versions.)
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
    // Another browser job is running. Never start a second browser; only recover from a flag left stuck.
    if (now - lastScrapeTime > BROWSER_JOB_LIMIT_MS + 30000) { isScraping = false; } else { return; }
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
  const watchdog = startWatchdog(() => browser, 'Timeline scrape');
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
    clearTimeout(watchdog);
    isScraping = false;
  }
}

setTimeout(() => {
  scrapeTrends('trending').then(() => scrapeTrends('for-you')).then(r => { if (r && r.trends) prefetchMomentCovers(r.trends, 'today'); }).catch(() => {});
}, 20000);

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
  realCountsFor.clear();
  profileCache.clear();
  backgroundScrape();
  return res.send(`Cache cleared. Worker timeline wipe: ${workerStatus}. A fresh scrape has started; refresh your app in about a minute.`);
});

// ---------- Pictures for Moments ----------
// Served as https://<bridge>/img/c/<code>.jpg: no "?format=..." in the address (old apps append ":large",
// which breaks those), a phone-sized version, and any ":size" the app adds is ignored.
function rememberBase(req) {
  if (process.env.PUBLIC_URL || !req || !req.headers || !req.headers.host) return;
  publicBase = `https://${req.headers.host}`;
}
function cleanPictureUrl(url) {
  return `${publicBase}/img/c/${Buffer.from(String(url)).toString('base64url')}.jpg`;
}
// Ask X for a medium-size version (originals can be 4096px, too big for a phone).
function phoneSizedPicture(url) {
  try {
    const u = new URL(url);
    if (!IMAGE_HOSTS.includes(u.hostname)) return null;
    if (u.searchParams.has('format') || u.searchParams.has('name')) {
      u.searchParams.set('name', 'medium');
      if (!u.searchParams.has('format')) u.searchParams.set('format', 'jpg');
      return u.toString();
    }
    if (/\/media\//.test(u.pathname)) { u.pathname = u.pathname.replace(/:(small|medium|large|orig|thumb)$/, ''); return u.toString() + ':medium'; }
    return u.toString();
  } catch (e) { return null; }
}

// Real width/height of a picture (reads only the start of the file).
const pictureSizeCache = new Map();
function sizeFromBytes(b) {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };     // PNG
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {                                                              // JPEG
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {              // WebP (VP8X)
    if (b.toString('ascii', 12, 16) === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}
async function pictureSize(url) {
  if (pictureSizeCache.has(url)) return pictureSizeCache.get(url);
  const src = phoneSizedPicture(url);
  if (!src) return null;
  try {
    const r = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-65535' } });
    if (!r.ok && r.status !== 206) return null;
    const size = sizeFromBytes(Buffer.from(await r.arrayBuffer()));
    if (size && size.w > 0 && size.h > 0) { pictureSizeCache.set(url, size); if (pictureSizeCache.size > 500) pictureSizeCache.delete(pictureSizeCache.keys().next().value); }
    return size;
  } catch (e) { return null; }
}
async function measurePictures(trends) {
  for (const t of trends) if (t.image && !pictureSizeCache.has(t.image)) await pictureSize(t.image);
}

app.get('/img/a/:file', async (req, res) => {
  const pic = decodeBridgeAvatar('/img/a/' + String(req.params.file));
  if (!pic) return res.status(400).end();
  try {
    for (const candidate of [`${pic.base}_400x400.${pic.ext}`, `${pic.base}.${pic.ext}`, `${pic.base}_normal.${pic.ext}`]) {
      const r = await fetch(candidate, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      res.setHeader('Content-Type', r.headers.get('content-type') || (pic.ext === 'png' ? 'image/png' : 'image/jpeg'));
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.status(200).send(Buffer.from(await r.arrayBuffer()));
    }
    return res.status(404).end();
  } catch (e) {
    return res.status(502).end();
  }
});

app.get('/img/c/:file', async (req, res) => {
  try {
    const code = String(req.params.file).replace(/:[a-z]+$/i, '').replace(/\.(jpe?g|png)$/i, '');
    const original = Buffer.from(code, 'base64url').toString('utf8');
    const src = phoneSizedPicture(original);
    if (!src) return res.status(400).end();
    const r = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    return res.status(502).end();
  }
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
    has_real_counts_from_x: realCountsFor.has(key),
    profile_fetch: profileCache.has(key) ? { ...profileCache.get(key), tweets: (profileCache.get(key).tweets || []).length } : null
  });
});

// What happened to the last posts/retweets: /debug/posts
app.get('/debug/posts', (req, res) => res.status(200).json({ queued_or_recent: postLog }));

// What the server got from x.com/notifications: /debug/notifications
app.get('/debug/notifications', async (req, res) => {
  if (!scrapeStats.lastNotifications) await Promise.race([scrapeNotifications(), new Promise(r => setTimeout(r, 60000))]);
  return res.status(200).json({
    last_fetch: scrapeStats.lastNotifications || 'no fetch finished yet, reload in a minute',
    first_items: (notificationsCache.items || []).slice(0, 5).map(n => ({ type: n.type, at: new Date(n.at).toISOString(), from: (n.users || []).map(u => u.screen_name), tweet: n.tweets && n.tweets[0] ? (n.tweets[0].text || '').slice(0, 80) : null })),
    last_error: scrapeStats.lastError,
    raw_samples_from_x: lastNotificationsRaw
  });
});

// What the server got from X's Explore page: /debug/trends (starts a fetch if none has run yet)
app.get('/debug/trends', async (req, res) => {
  // /debug/trends?tab=for-you (or trending, news, sports, entertainment)
  const tab = Object.values(EXPLORE_TABS).includes(req.query.tab) ? req.query.tab : 'for-you';
  if (!tabCache.get(tab)) await Promise.race([scrapeTrends(tab), new Promise(r => setTimeout(r, 70000))]);
  const entry = tabCache.get(tab);
  return res.status(200).json({
    tab,
    last_fetch: scrapeStats.lastTrends || 'no fetch finished yet, reload in a minute',
    trends_found: entry ? entry.trends.slice(0, 6).map(t => ({ name: t.name, context: t.context, volume: t.volumeText, picture: t.image || null, story: !!t.isStory })) : [],
    with_pictures: entry ? entry.trends.filter(t => t.image).length + ' of ' + entry.trends.length : null,
    x_data_around_first_trend: entry ? entry.snippet : null,
    last_error: scrapeStats.lastError
  });
});

// Shows whether the scraper is getting real data from X. Open this after a refresh.
app.get('/debug/scrape-status', (req, res) => {
  return res.status(200).json({
    cookieSource: tokenSource,
    signInPassword: process.env.BRIDGE_PASSWORD ? 'set' : 'not set (any username/password signs in)',
    forceLogin: FORCE_LOGIN,
    imageProxy: IMAGE_PROXY,
    avatarSize: AVATAR_SIZE,
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
  const mode = req.body.x_auth_mode || req.query.x_auth_mode || (req.body.oauth_verifier || req.query.oauth_verifier ? 'oauth_verifier' : 'none');
  console.log(`[XitterBridge Login] ${req.method} /oauth/access_token: mode=${mode}, username ${usernameInput ? 'given' : 'missing'}, password ${passwordInput ? 'given' : 'missing'}`);

  // BRIDGE_PASSWORD (optional, set on Render): username/password sign-ins must use it, so only you can
  // sign in. Any username works; X's own password is never needed or checked.
  const required = process.env.BRIDGE_PASSWORD;
  if (usernameInput && required && passwordInput !== required) {
    console.log('[XitterBridge Login] Refused: wrong bridge password.');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(401).send(JSON.stringify({ errors: [{ code: 32, message: 'Could not authenticate you.' }] }));
  }

  if (usernameInput.length > 5 && passwordInput.length > 5) {
    backgroundScrape();
  }

  if (isPlaceholderUser(cachedAccountProfile)) {
    const acc = await getCachedAccountFromWorker();
    if (acc) cachedAccountProfile = acc;
  }
  const activeUserId = cachedAccountProfile?.id_str || "12345678";
  const activeScreenName = cachedAccountProfile?.screen_name || "x_user";
  
  const accessToken = bridgeAccessToken();
  const accessTokenSecret = bridgeAccessSecret();

  console.log(`[XitterBridge Login] ${usernameInput ? 'username/password (xAuth)' : 'OAuth'} sign-in -> @${activeScreenName} (${activeUserId})`);
  res.setHeader('Content-Type', 'application/x-www-form-urlencoded; charset=utf-8');
  return res.status(200).send(`oauth_token=${accessToken}&oauth_token_secret=${accessTokenSecret}&user_id=${activeUserId}&screen_name=${encodeURIComponent(activeScreenName)}&x_auth_expires=0`);
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
    const lk = lookupHandle.toLowerCase();
    const fresh = profileCache.get(lk);
    const knownNow = (fresh && fresh.user && realCountsFor.has(lk) ? fresh.user : null) || (realCountsFor.has(lk) ? knownUsers.get(lk) : null);
    if (knownNow && !isPlaceholderUser(knownNow)) {
      // Answer instantly; fetch the full profile in the background for next time.
      if (!fresh || Date.now() - fresh.fetchedAt >= fresh.ttl) getProfile(lookupHandle, false).catch(() => {});
      console.log('[XitterBridge users/show] answered instantly for', lookupHandle);
      return res.status(200).json(knownNow);
    }
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
  // Send only as many tweets as the app asked for (Twitter's default 20, max 200). The whole cache
  // (up to 500 tweets, several MB) is more than the phone app can take in one reply.
  const want = Math.min(Math.max(Number(req.query.count) || 20, 1), 200);
  timeline = timeline.slice(0, want);
  const body = exactJsonStringify(timeline);
  console.log(`[XitterBridge home_timeline] ${timeline.length} tweets (asked for ${req.query.count || 'default'}), ${Math.round(body.length / 1024)} KB`);
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
  // Only real mentions (it used to fill the list with random timeline tweets when there were none).
  const want = Math.min(Math.max(Number(req.query.count) || 20, 1), 200);
  return res.status(200).json(filterByIdRange(mentions.map(t => sanitizeTweet(t)), req.query).slice(0, want));
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
  // Only wait for X if there's nothing to show yet; otherwise answer now and refresh in the background.
  const cachedProf = profileCache.get(key);
  const prof = (fromTimeline.length || (cachedProf && cachedProf.tweets && cachedProf.tweets.length))
    ? (getProfile(targetScreen, false).catch(() => {}), cachedProf)
    : await getProfile(targetScreen);
  const fromProfile = prof && prof.tweets ? prof.tweets.map(t => sanitizeTweet(t)) : [];

  const byId = new Map();
  [...fromTimeline, ...fromProfile].forEach(t => byId.set(t.id_str, t));
  const userTweets = Array.from(byId.values()).sort((a, b) => {
    try { return Number(BigInt(b.id_str) - BigInt(a.id_str)); } catch (e) { return 0; }
  });
  console.log(`[XitterBridge user_timeline] @${targetScreen}: ${fromProfile.length} from profile fetch, ${fromTimeline.length} from home cache.`);
  return res.status(200).json(filterByIdRange(userTweets, req.query));
});

// ---------- Windows 10 Twitter app ----------
// Layouts below were read from the app itself (Twitter.Windows.dll data classes + its bundled
// js/Hometimeline.json sample). The app parses with Newtonsoft (case-insensitive, unknown keys ignored).

// Timelines use Twitter's "timeline" format (the app's TimelineResponse class):
//   { twitter_objects: { tweets: { id: tweet }, users: { id: user }, events: {} },
//     response: { timeline: [{ entity_id, tweet: { id } }], cursor: { top, bottom } } }
function timelineResponse(tweets) {
  const tw = {}, us = {};
  const add = t => {
    if (!t || tw[t.id_str]) return;
    tw[t.id_str] = t;
    if (t.user) us[t.user.id_str] = t.user;
    if (t.retweeted_status) add(t.retweeted_status);
    if (t.quoted_status) add(t.quoted_status);
  };
  tweets.forEach(add);
  return {
    twitter_objects: { tweets: tw, users: us, events: {} },
    response: {
      timeline: tweets.map(t => ({ entity_id: t.id_str, tweet: { id: t.id_str } })),
      cursor: { top: tweets.length ? tweets[0].id_str : '0', bottom: tweets.length ? tweets[tweets.length - 1].id_str : '0' }
    }
  };
}

function cursorQuery(q) {
  // The app pages with up_cursor (newer) / down_cursor (older), or the usual since_id / max_id.
  return { since_id: q.since_id || q.up_cursor, max_id: q.max_id || q.down_cursor };
}

app.get(['/1.1/timeline/home.json', '/1/timeline/home.json'], async (req, res) => {
  backgroundScrape();
  let timeline = [...localTimeline, ...(await getCachedTimelineFromWorker())].map(t => sanitizeTweet(t));
  const byId = new Map(); timeline.forEach(t => byId.set(t.id_str, t));
  timeline = Array.from(byId.values()).sort((a, b) => { try { return Number(BigInt(b.id_str) - BigInt(a.id_str)); } catch (e) { return 0; } });
  timeline = filterByIdRange(timeline, cursorQuery(req.query)).slice(0, Number(req.query.count) || 50);
  console.log(`[XitterBridge timeline/home] ${timeline.length} tweets (Windows 10 app)`);
  return res.status(200).json(timelineResponse(timeline));
});

// A person's tweets on their profile (Windows 10 app).
app.get(['/1.1/timeline/user.json', '/1/timeline/user.json'], async (req, res) => {
  const target = req.query.screen_name || handleForUserId(req.query.user_id) || (req.query.user_id && cachedAccountProfile && idMatches(req.query.user_id, cachedAccountProfile.id_str) ? cachedAccountProfile.screen_name : '');
  if (!target) return res.status(200).json(timelineResponse([]));
  const key = String(target).toLowerCase();
  const fromHome = (await getCachedTimelineFromWorker()).filter(t => t.user?.screen_name?.toLowerCase() === key);
  const cachedProf = profileCache.get(key);
  const prof = (fromHome.length || (cachedProf && cachedProf.tweets && cachedProf.tweets.length)) ? (getProfile(target, false).catch(() => {}), cachedProf) : await getProfile(target);
  const fromProfile = prof && prof.tweets ? prof.tweets.map(t => sanitizeTweet(t)) : [];
  const byId = new Map(); [...fromHome, ...fromProfile].forEach(t => byId.set(t.id_str, t));
  let list = Array.from(byId.values()).sort((a, b) => { try { return Number(BigInt(b.id_str) - BigInt(a.id_str)); } catch (e) { return 0; } });
  list = filterByIdRange(list, cursorQuery(req.query)).slice(0, Number(req.query.count) || 20);
  console.log(`[XitterBridge timeline/user] @${target}: ${list.length} tweets (Windows 10 app)`);
  return res.status(200).json(timelineResponse(list));
});

// statuses/show.json?id=... (the Windows 10 app's way of opening one tweet)
app.get(['/1.1/statuses/show.json', '/1/statuses/show.json'], async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(200).json({});
  const found = (await findAnyTweet(id)) || ((await getConversation(id)) || { tweets: [] }).tweets.find(t => t.id_str === id);
  return res.status(200).json(found ? sanitizeTweet(found) : {});
});

// ---------- Moments (rebuilt from trending topics) ----------
// X ended Moments in 2022, so each current trend becomes a Moment: title = trend, cover = the first
// picture among its top tweets, pages/tweets = its top search results.
//   categories.json -> MomentCategoryResponseModel { nav: { default_category_id, categories: [{ category_id, name }] } }
//   guide.json      -> MomentGuideResponseModel    { modules: [{ module_type, moments: [MomentModuleModel] }] }
//   capsule.json    -> MomentModuleModel           { moment, tweets: [...], pages: [MomentMedia] }
//   MomentModel     { id, title, description, url, is_live, time_string, subcategory_string,
//                     subcategory_favicon_url, sensitive, can_subscribe, is_subscribed, cover_media }
//   MomentMedia     { tweet_id, type, media: { media_id, size, url, display_url }, render: { crops } }
// Same tabs as the original Twitter app. "Fun" shows what's trending (X has no Fun tab).
const MOMENT_CATEGORIES = [
  { category_id: 'today', name: 'Today' },
  { category_id: 'news', name: 'News' },
  { category_id: 'sports', name: 'Sports' },
  { category_id: 'entertainment', name: 'Entertainment' },
  { category_id: 'fun', name: 'Fun' }
];
const momentIndex = new Map(); // moment id -> trend

function momentIdFor(trend) {
  return String(parseInt(crypto.createHash('sha1').update(String(trend.name).toLowerCase()).digest('hex').slice(0, 12), 16));
}

// The Windows 10 app waits much longer than the phone app, so Moments can wait for real trends
// instead of showing placeholders.
const MOMENTS_WAIT_MS = Number(process.env.MOMENTS_WAIT_MS) || 45000;
// Real trends/stories for one Moments tab. Never placeholders: if X hasn't answered, the list is empty
// and the app shows its own "couldn't load Moments" message (pull to refresh tries again).
async function ensureTrends(category = 'today') {
  const tab = EXPLORE_TABS[category] || 'for-you';
  const cached = tabCache.get(tab);
  if (!(cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000)) {
    const job = scrapeTrends(tab);
    if (!cached) await Promise.race([job, new Promise(r => setTimeout(r, MOMENTS_WAIT_MS))]);
  }
  const fresh = tabCache.get(tab);
  if (fresh) return fresh.trends;
  if (category === 'trending' && trendsCache.trends) return trendsCache.trends;
  return [];
}

function cropsFor(w, h) {
  const sq = Math.min(w, h);
  const pw = Math.min(w, Math.round(h * 9 / 16)), ph = Math.min(h, Math.round(w * 16 / 9));
  return {
    no_crop: { x: 0, y: 0, w, h },
    square: { x: Math.round((w - sq) / 2), y: Math.round((h - sq) / 2), w: sq, h: sq },
    portrait_9_16: { x: Math.round((w - pw) / 2), y: Math.round((h - ph) / 2), w: pw, h: ph }
  };
}

// One page / cover of a Moment, built from a tweet (with its first picture if it has one).
function momentMediaFromTweet(t) {
  const m = t.extended_entities && t.extended_entities.media && t.extended_entities.media[0];
  if (!m) return { tweet_id: t.id_str, type: 'text' };
  // Crops are worked out on the medium-size picture the app is actually given (longest side 1200).
  const big = (m.sizes && (m.sizes.large || m.sizes.medium)) || { w: 1200, h: 1200 };
  const scale = Math.min(1, 1200 / Math.max(Number(big.w) || 1200, Number(big.h) || 1200));
  const w = Math.round((Number(big.w) || 1200) * scale), h = Math.round((Number(big.h) || 1200) * scale);
  const pic = cleanPictureUrl(m.media_url_https);
  return {
    tweet_id: t.id_str,
    type: m.type === 'video' || m.type === 'animated_gif' ? 'video' : 'image',
    media: { media_id: m.id_str, size: { w, h }, url: pic, display_url: m.display_url, media_url_https: pic, media_url: pic },
    render: { crops: cropsFor(w, h) }
  };
}

// A cover made from a picture URL alone (X's trend/story thumbnails are 16:9 crops).
function momentMediaFromImage(url, momentId) {
  // Real size if we've measured it (crops must fit inside the picture), else X's usual 16:9 thumbnail.
  const real = pictureSizeCache.get(url);
  const w = real ? real.w : 1200, h = real ? real.h : 675;
  const pic = cleanPictureUrl(url);
  return {
    tweet_id: null,
    type: 'image',
    media: { media_id: momentId, size: { w, h }, url: pic, display_url: pic, media_url_https: pic, media_url: pic },
    render: { crops: cropsFor(w, h) }
  };
}

function momentTweets(trend) {
  const found = searchCache.get(`top:${String(trend.query).toLowerCase()}`);
  return found ? found.tweets.map(t => sanitizeTweet(t)).slice(0, 25) : [];
}

function isHeadline(trend) {
  return trend.isStory || String(trend.name).length > 40 || String(trend.name).split(/\s+/).length >= 5;
}

function momentModel(trend, tweets) {
  const id = momentIdFor(trend);
  const headline = isHeadline(trend);
  momentIndex.set(id, trend);
  const coverTweet = tweets.find(t => t.extended_entities && t.extended_entities.media && t.extended_entities.media.length);
  // Prefer the picture X shows with the trend/story; otherwise the first picture among its top tweets.
  const cover = trend.image ? momentMediaFromImage(trend.image, id) : (coverTweet ? momentMediaFromTweet(coverTweet) : null);
  return {
    id,
    title: trend.name,
    description: headline ? (trend.context && trend.context !== trend.name ? trend.context : (trend.volumeText || '')) : (trend.volumeText ? `${trend.name} · ${trend.volumeText}` : `What people are saying about ${trend.name}`),
    url: `https://twitter.com/i/moments/${id}`,
    is_live: false, // the app draws a "Now" badge on top of the time text for live Moments
    time_string: trend.volumeText || (headline ? 'Today' : 'Trending'),
    subcategory_string: (headline ? '' : trend.context) || (headline ? 'News' : 'Trending'),
    subcategory_favicon_url: null,
    sensitive: false,
    can_subscribe: false,
    is_subscribed: false,
    cover_media: cover
  };
}

function momentModuleModel(trend, withContents) {
  const tweets = momentTweets(trend);
  const out = { moment: momentModel(trend, tweets) };
  if (withContents) {
    out.tweets = tweets;
    out.pages = tweets.map(momentMediaFromTweet);
  }
  return out;
}

// Covers come from each trend's top tweets: fetch the first few trends' results in the background.
const momentPrefetchAt = new Map(); // tab -> time
function prefetchMomentCovers(trends, key = 'today') {
  if (Date.now() - (momentPrefetchAt.get(key) || 0) < 10 * 60 * 1000) return;
  momentPrefetchAt.set(key, Date.now());
  // Only trends without their own picture need a search to find one; do the first few, one at a time.
  trends.filter(t => !t.image).slice(0, 4).reduce((p, t) => p.then(() => searchCache.has(`top:${String(t.query).toLowerCase()}`) ? null : scrapeSearch(t.query, 'top')).catch(() => {}), Promise.resolve());
}

app.get(['/1.1/moments/categories.json', '/1/moments/categories.json'], async (req, res) => {
  console.log(`[XitterBridge Moments] categories requested`);
  return res.status(200).json({ nav: { default_category_id: 'today', categories: MOMENT_CATEGORIES } });
});

app.get(['/1.1/moments/guide.json', '/1/moments/guide.json'], async (req, res) => {
  rememberBase(req);
  const asked = req.query.guide_category_id || req.query.category_id || req.query.category || '';
  const category = EXPLORE_TABS[asked] ? asked : 'today';
  const trends = (await ensureTrends(category)).map(t => ({ ...t, category }));
  // Measure the pictures we don't know yet (a few seconds at most) so the hero's crop fits.
  await Promise.race([measurePictures(trends.slice(0, 25)), new Promise(r => setTimeout(r, 4000))]);
  prefetchMomentCovers(trends, category);
  const items = trends.slice(0, 25).map(t => momentModuleModel(t, false));
  const modules = [];
  if (items.length) modules.push({ module_type: 'hero', moments: items.slice(0, 1) });
  if (items.length > 1) modules.push({ module_type: 'list', moments: items.slice(1) });
  const withCover = items.filter(i => i.moment.cover_media).length;
  console.log(`[XitterBridge Moments] guide "${category}" (app asked: ${req.originalUrl}): ${items.length} moments, ${withCover} with cover pictures${items.length ? '' : ' (X has not answered yet - pull to refresh in a minute)'}`);
  return res.status(200).json({ modules });
});

app.get(['/1.1/moments/capsule.json', '/1/moments/capsule.json', '/1.1/moments/capsule/:id.json'], async (req, res) => {
  rememberBase(req);
  const id = String(req.query.moment_id || req.query.id || (req.params && req.params.id) || '').replace('.json', '');
  let trend = momentIndex.get(id);
  if (!trend) {
    for (const entry of tabCache.values()) { trend = entry.trends.find(t => momentIdFor(t) === id); if (trend) break; }
  }
  if (!trend) {
    console.log(`[XitterBridge Moments] moment ${id} isn't a current trend anymore`);
    return res.status(200).json({ errors: [{ code: 34, message: 'Sorry, that page does not exist.' }] });
  }
  await getSearch(trend.query, 'top'); // loads (or reuses) the trend's top tweets
  const body = momentModuleModel(trend, true);
  console.log(`[XitterBridge Moments] opened "${trend.name}": ${body.pages.length} pages${body.pages.length ? '' : ' (X still loading, open it again shortly)'}`);
  return res.status(200).json(body);
});

// Profile "media" section: that person's tweets with pictures or videos.
app.get(['/1.1/statuses/media_timeline.json', '/1/statuses/media_timeline.json'], async (req, res) => {
  const target = req.query.screen_name || handleForUserId(req.query.user_id) || (req.query.user_id && cachedAccountProfile && idMatches(req.query.user_id, cachedAccountProfile.id_str) ? cachedAccountProfile.screen_name : '');
  if (!target) return res.status(200).json([]);
  const key = String(target).toLowerCase();
  const fromHome = (await getCachedTimelineFromWorker()).filter(t => t.user?.screen_name?.toLowerCase() === key);
  const cachedProf = profileCache.get(key);
  const fromProfile = cachedProf && cachedProf.tweets ? cachedProf.tweets.map(t => sanitizeTweet(t)) : [];
  const byId = new Map();
  [...fromHome, ...fromProfile].forEach(t => { if (t.extended_entities && t.extended_entities.media && t.extended_entities.media.length) byId.set(t.id_str, t); });
  const list = Array.from(byId.values()).sort((a, b) => { try { return Number(BigInt(b.id_str) - BigInt(a.id_str)); } catch (e) { return 0; } });
  return res.status(200).json(filterByIdRange(list, req.query).slice(0, Number(req.query.count) || 25));
});

// Suggestion lists the app shows on profiles and in Discover. The bridge has none yet, so answer with
// the empty list the app expects (an empty {} isn't a list and can break the page).
app.get(['/1/users/recommendations.json', '/1.1/users/recommendations.json'], (req, res) => res.status(200).json([]));
// ---------- Browse categories ("who to follow" by topic) ----------
// Old API: users/suggestions.json -> [{ name, slug, size }], users/suggestions/<slug>.json -> { name, slug,
// size, users: [...] }, users/suggestions/<slug>/members.json -> [...]. Each topic's people come from X's
// people search for that topic; "Suggested" is the most-followed accounts the bridge has seen.
const SUGGESTION_CATEGORIES = [
  { name: 'Suggested', slug: 'suggested', query: null },
  { name: 'News', slug: 'news', query: 'news' },
  { name: 'Sports', slug: 'sports', query: 'sports' },
  { name: 'Music', slug: 'music', query: 'music' },
  { name: 'Entertainment', slug: 'entertainment', query: 'entertainment' },
  { name: 'Gaming', slug: 'gaming', query: 'gaming' },
  { name: 'Technology', slug: 'technology', query: 'technology' },
  { name: 'Funny', slug: 'funny', query: 'funny' }
];

async function suggestionUsers(cat) {
  const me = cachedAccountProfile && cachedAccountProfile.id_str;
  const known = [...knownUsers.values()].filter(u => !isPlaceholderUser(u) && u.id_str !== me);
  if (!cat.query) {
    return known.filter(u => realCountsFor.has(u.screen_name.toLowerCase()))
      .sort((a, b) => (b.followers_count || 0) - (a.followers_count || 0)).slice(0, 20);
  }
  const found = await getSearch(cat.query, 'users');
  if (found && found.users.length) return found.users.filter(u => u.id_str !== me).slice(0, 20);
  // X hasn't answered yet: people already known whose name/bio mention the topic.
  const q = cat.query.toLowerCase();
  return known.filter(u => (u.description || '').toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q)).slice(0, 20);
}

app.get(['/1.1/users/suggestions.json', '/1/users/suggestions.json'], (req, res) => {
  console.log('[XitterBridge Suggestions] categories listed');
  return res.status(200).json(SUGGESTION_CATEGORIES.map(c => ({ name: c.name, slug: c.slug, size: 20 })));
});

async function suggestionCategory(req, res, membersOnly) {
  const slug = String(req.params.slug || '').replace('.json', '').toLowerCase();
  const cat = SUGGESTION_CATEGORIES.find(c => c.slug === slug) || { name: slug.replace(/^./, c => c.toUpperCase()), slug, query: slug.replace(/-/g, ' ') };
  const users = await suggestionUsers(cat);
  console.log(`[XitterBridge Suggestions] "${cat.name}": ${users.length} people${users.length ? '' : ' (X still loading, try again shortly)'}`);
  if (membersOnly) return res.status(200).json(users);
  return res.status(200).json({ name: cat.name, slug: cat.slug, size: users.length, users });
}
app.get(['/1.1/users/suggestions/:slug/members.json', '/1/users/suggestions/:slug/members.json'], (req, res) => suggestionCategory(req, res, true));
app.get(['/1.1/users/suggestions/:slug.json', '/1/users/suggestions/:slug.json', '/1.1/users/suggestions/:slug', '/1/users/suggestions/:slug'], (req, res) => suggestionCategory(req, res, false));
app.get(['/1.1/saved_searches/list.json', '/1/saved_searches/list.json'], (req, res) => res.status(200).json([]));

// Notifications tab: real notifications from X (no more made-up ones).
app.get(['/1.1/activity/about_me.json', '/1/activity/about_me.json'], async (req, res) => {
  const fresh = notificationsCache.items && Date.now() - notificationsCache.fetchedAt < 2 * 60 * 1000;
  if (!fresh) {
    const job = scrapeNotifications();
    if (!notificationsCache.items) await Promise.race([job, new Promise(r => setTimeout(r, SEARCH_WAIT_MS))]);
  }
  const me = sanitizeUser(cachedAccountProfile);
  let items = (notificationsCache.items || []).map(n => notificationToActivity(n, me)).filter(Boolean);
  // Positions are millisecond times. Only honour ones that look like times (older app values were tweet ids).
  const since = Number(req.query.since_id), max = Number(req.query.max_id);
  if (since > 1e12) items = items.filter(a => Number(a.max_position) > since);
  if (req.query.max_id) items = max > 1e12 ? items.filter(a => Number(a.max_position) < max) : [];
  items = items.slice(0, Number(req.query.count) || 30);
  console.log(`[XitterBridge about_me] ${notificationsCache.items ? items.length + ' real notifications' : 'X still loading notifications (reopen shortly)'}`);
  return res.status(200).json(items);
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

// Replies under a tweet, fetched from the tweet's page on X.
async function resolveConversation(rawId) {
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  const known = findTweetById(allTweets, rawId);
  const fullId = known ? String(known.id_str) : String(rawId);
  const conv = await getConversation(fullId);
  const list = conv && conv.tweets.length ? conv.tweets : allTweets.filter(t => t.id_str === fullId || t.in_reply_to_status_id_str === fullId);
  const parts = splitConversation(list, fullId);
  if (!parts.focal && known) parts.focal = sanitizeTweet(known);
  console.log(`[XitterBridge replies] tweet ${fullId}: ${parts.descendants.length} replies, ${parts.ancestors.length} above ${conv && conv.tweets.length ? '(from X)' : '(X still loading, open again shortly)'}`);
  return parts;
}

app.get(['/1.1/conversation/show.json', '/1/conversation/show.json', '/1.1/conversation/show/:id.json', '/1/conversation/show/:id.json', '/1/conversation/show/:id', '/1/conversation/show/:id'], async (req, res) => {
  const tweetId = String(req.query.id || req.params.id || '').replace('.json', '');
  if (!tweetId) return res.status(200).json([]);
  const { ancestors, focal, descendants } = await resolveConversation(tweetId);
  const statuses = [...ancestors, ...(focal ? [focal] : []), ...descendants];
  return res.status(200).json({
    ids: statuses.map(s => s.id_str),
    statuses,
    conversation: statuses,
    ancestors,
    descendants,
    globalObjects: {
      tweets: statuses.reduce((acc, t) => { acc[t.id_str] = t; return acc; }, {}),
      users: statuses.reduce((acc, t) => { if (t.user) acc[t.user.id_str] = t.user; return acc; }, {})
    }
  });
});

// Older apps ask for replies this way: a list of groups, each with results annotated Ancestor/Descendant.
app.get(['/1/related_results/show/:id.json', '/1.1/related_results/show/:id.json', '/1/related_results/show/:id', '/1.1/related_results/show/:id'], async (req, res) => {
  const tweetId = String(req.params.id || '').replace('.json', '');
  const { ancestors, descendants } = await resolveConversation(tweetId);
  const asResult = role => t => ({ kind: 'Tweet', score: 1, value: t, annotations: { ConversationRole: role } });
  const results = [...ancestors.map(asResult('Ancestor')), ...descendants.map(asResult('Descendant'))];
  return res.status(200).json(results.length ? [{ resultType: 'Tweet', groupName: 'TweetsWithConversation', score: 1, results }] : []);
});

app.get(['/1.1/statuses/show/:id.json', '/1.1/statuses/show/:id', '/1/statuses/show/:id.json'], async (req, res) => {
  const tweetId = String(req.params.id).replace('.json', '');
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  let found = findTweetById(allTweets, tweetId) || findInConversations(tweetId);
  if (!found) {
    // Not loaded anywhere yet (e.g. a tweet you opened from a notification): get it from X.
    const conv = await getConversation(tweetId);
    found = conv ? conv.tweets.find(t => t.id_str === tweetId) : null;
  }
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

// ---------- Trends ----------
// Real trends from X's Explore page (the ones X shows your account), refreshed every 15 minutes.
const trendsCache = { trends: null, fetchedAt: 0 };
let lastTrendsRaw = [];
let trendsInFlight = null;

function parseVolume(text) {
  const m = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*([KkMm])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (/k/i.test(m[2] || '')) n *= 1000;
  if (/m/i.test(m[2] || '')) n *= 1000000;
  return Math.round(n);
}

// Explore tabs -> Moments tabs. Each tab is fetched and cached on its own.
const EXPLORE_TABS = { today: 'for-you', news: 'news', sports: 'sports', entertainment: 'entertainment', fun: 'trending', trending: 'trending' };
const tabCache = new Map();      // tab -> { trends, fetchedAt }
const tabInFlight = new Map();

function scrapeTrends(tab = 'trending') {
  if (tab === 'trending' && trendsInFlight) return trendsInFlight;
  if (tab !== 'trending' && tabInFlight.has(tab)) return tabInFlight.get(tab);
  const job = (async () => {
    const tokens = await getTokens();
    if (!tokens.auth_token || !tokens.ct0) return null;
    if (!(await acquireBrowser(60000))) return null;
    let browser;
    const sink = newSink();
    const watchdog = startWatchdog(() => browser, `Explore "${tab}" fetch`);
    sink.keepRaw = true;
    let landedUrl = '';
    try {
      const opened = await openXPage(tokens);
      browser = opened.browser;
      const page = opened.page;
      attachGraphQLCapture(page, sink);
      await page.goto(`https://x.com/explore/tabs/${tab}`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      landedUrl = page.url();
      // Wait until a trend has been captured (or give up after ~25s).
      for (let i = 0; i < 50 && sink.trends.length === 0; i++) await new Promise(r => setTimeout(r, 500));
      // Stories further down load as you scroll.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      await Promise.allSettled(sink.pending);
    } catch (e) {
      scrapeStats.lastError = `trends: ${e && e.message ? e.message : e}`;
    } finally {
      clearTimeout(watchdog);
      if (browser) await browser.close().catch(() => {});
      isScraping = false;
    }
    const withPics = sink.trends.filter(t => t.image).length;
    scrapeStats.lastTrends = { tab, at: new Date().toISOString(), landedUrl, graphqlResponses: sink.responses, operations: sink.ops, trends: sink.trends.length, withPictures: withPics };
    lastTrendsRaw = sink.raw;
    console.log(`[XitterBridge Trends] Explore "${tab}": ${sink.responses} API responses, ${sink.trends.length} trends/stories (${withPics} with pictures).`);
    if (!sink.trends.length) return null;
    const entry = { trends: sink.trends, fetchedAt: Date.now(), snippet: sink.trendSnippet || null };
    tabCache.set(tab, entry);
    measurePictures(sink.trends.slice(0, 25)).catch(() => {});
    if (tab === 'trending') {
      // The plain trends list (trends/place) only uses real trends, not news stories.
      const real = sink.trends.filter(t => !t.isStory);
      if (real.length) { trendsCache.trends = real; trendsCache.fetchedAt = Date.now(); }
    }
    return entry;
  })().finally(() => { if (tab === 'trending') trendsInFlight = null; else tabInFlight.delete(tab); });
  if (tab === 'trending') trendsInFlight = job; else tabInFlight.set(tab, job);
  return job;
}

function toApiTrend(t) {
  return {
    name: t.name,
    url: `http://twitter.com/search?q=${encodeURIComponent(t.query)}`,
    promoted_content: null,
    query: encodeURIComponent(t.query),
    tweet_volume: parseVolume(t.volumeText)
  };
}

const FALLBACK_TRENDS = [
  { name: '#WindowsPhone', query: '#WindowsPhone', volumeText: '' },
  { name: 'Nokia Lumia', query: 'Nokia Lumia', volumeText: '' },
  { name: 'Windows 10 Mobile', query: 'Windows 10 Mobile', volumeText: '' }
];

app.get(['/1.1/trends/closest.json', '/1/trends/closest.json'], (req, res) => {
  return res.status(200).json([{ country: '', countryCode: null, name: 'Worldwide', parentid: 0, placeType: { code: 19, name: 'Supername' }, url: 'http://where.yahooapis.com/v1/place/1', woeid: 1 }]);
});

app.get(['/1.1/trends/place.json', '/1/trends/place.json'], async (req, res) => {
  const fresh = trendsCache.trends && Date.now() - trendsCache.fetchedAt < 15 * 60 * 1000;
  if (!fresh) {
    const job = scrapeTrends();
    // First time: wait a little; after that, answer with the last trends and refresh in the background.
    if (!trendsCache.trends) await Promise.race([job, new Promise(r => setTimeout(r, SEARCH_WAIT_MS))]);
  }
  const list = trendsCache.trends || FALLBACK_TRENDS;
  const asOf = new Date((trendsCache.fetchedAt || Date.now())).toISOString().replace(/\.\d{3}Z$/, 'Z');
  console.log(`[XitterBridge trends/place] ${trendsCache.trends ? list.length + ' real trends' : 'X still loading, placeholder trends (reopen search shortly)'}`);
  return res.status(200).json([{
    trends: list.slice(0, 30).map(toApiTrend),
    as_of: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    created_at: asOf,
    locations: [{ name: 'Worldwide', woeid: Number(req.query.id) || 1 }]
  }]);
});

app.get(['/1.1/trends/available.json', '/1/trends/available.json'], (req, res) => {
  return res.status(200).json([
    { country: '', countryCode: null, name: 'Worldwide', parentid: 0, placeType: { code: 19, name: 'Supername' }, url: 'http://where.yahooapis.com/v1/place/1', woeid: 1 }
  ]);
});

// Old Twitter "universal" search, used by the app's search button. It answers with a list of modules:
// { status: { data: tweet, metadata } } for each tweet, and { user_gallery: { data: [{ user: { data } }] } } for people.
app.get(['/1.1/search/universal.json', '/1/search/universal.json', '/1.1/discover/universal.json'], async (req, res) => {
  let q = String(req.query.q || req.query.query || '');
  try { q = decodeURIComponent(q); } catch (e) {}
  q = q.trim();
  const lq = q.toLowerCase();
  const wanted = String(req.query.modules || 'status,user_gallery').split(',').map(x => x.trim());
  const count = Number(req.query.count) || 20;

  let tweets = [], people = [], fromX = false;
  if (q) {
    const found = await getSearch(q, 'top');
    if (found && found.tweets.length) {
      fromX = true;
      tweets = found.tweets.map(t => sanitizeTweet(t));
      people = found.users.slice();
    } else {
      const cached = [...localTimeline, ...(await getCachedTimelineFromWorker())];
      tweets = cached.filter(t =>
        (t.text && t.text.toLowerCase().includes(lq)) ||
        (t.user?.screen_name && t.user.screen_name.toLowerCase().includes(lq)) ||
        (t.user?.name && t.user.name.toLowerCase().includes(lq))
      ).map(t => sanitizeTweet(t));
    }
    // People gallery: accounts X listed, then known accounts whose name or handle matches.
    const lqNoAt = lq.replace(/^@/, '').replace(/\s+/g, '');
    for (const u of knownUsers.values()) {
      if (people.length >= 6) break;
      if (people.some(x => x.id_str === u.id_str)) continue;
      if (u.screen_name.toLowerCase().includes(lqNoAt) || String(u.name || '').toLowerCase().replace(/\s+/g, '').includes(lqNoAt)) people.push(u);
    }
  }
  tweets = filterByIdRange(tweets, req.query).slice(0, count);

  const modules = [];
  if (people.length && (wanted.includes('user_gallery') || wanted.includes('user'))) {
    modules.push({ user_gallery: { metadata: { result_type: 'top' }, data: people.slice(0, 6).map(u => ({ user: { data: u, metadata: {} } })) } });
  }
  if (wanted.includes('status')) {
    for (const t of tweets) modules.push({ status: { data: t, metadata: { result_type: fromX ? 'top' : 'recent' } } });
  }
  const maxId = tweets.length ? tweets[tweets.length - 1].id_str : '0';
  console.log(`[XitterBridge universal search] "${q}": ${tweets.length} tweets ${fromX ? 'from X' : 'from cache (X still loading, search again shortly)'}, ${Math.min(people.length, 6)} people`);
  return res.status(200).json({
    metadata: { cursor: maxId, refresh_cursor: tweets.length ? tweets[0].id_str : '0' },
    modules,
    // Plain lists too, for app screens that read these instead of modules.
    statuses: tweets,
    search_metadata: { query: q, count: tweets.length, max_id_str: maxId }
  });
});

app.get(['/1.1/search/tweets.json', '/1/search/tweets.json', '/1/search.json'], async (req, res) => {
  const rawQuery = req.query.q || req.query.query || "";
  let originalQuery = String(rawQuery);
  try { originalQuery = decodeURIComponent(originalQuery); } catch (e) {}
  originalQuery = originalQuery.trim();
  const query = originalQuery.toLowerCase();
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];

  let matching = [];
  if (query !== '') {
    const mode = String(req.query.result_type || '').toLowerCase() === 'recent' ? 'recent' : 'top';
    const found = await getSearch(originalQuery, mode);
    if (found && found.tweets.length) {
      matching = found.tweets.map(t => sanitizeTweet(t));
      console.log(`[XitterBridge search] "${originalQuery}": ${matching.length} results from X`);
    } else {
      // X didn't answer in time: show matches from the timeline cache for now.
      matching = allTweets.filter(t =>
        (t.text && t.text.toLowerCase().includes(query)) ||
        (t.user?.screen_name && t.user.screen_name.toLowerCase().includes(query)) ||
        (t.user?.name && t.user.name.toLowerCase().includes(query))
      );
      console.log(`[XitterBridge search] "${originalQuery}": X still loading, ${matching.length} matches from cache (search again shortly)`);
    }
    matching = filterByIdRange(matching, req.query);
  } else {
    matching = allTweets;
  }

  const finalStatuses = matching.slice(0, Number(req.query.count) || 25).map(t => sanitizeTweet(t));
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

// People search ("users" tab)
app.get(['/1.1/users/search.json', '/1/users/search.json'], async (req, res) => {
  let q = String(req.query.q || '');
  try { q = decodeURIComponent(q); } catch (e) {}
  q = q.trim();
  if (!q) return res.status(200).json([]);
  const found = await getSearch(q, 'users');
  if (found && found.users.length) {
    console.log(`[XitterBridge users/search] "${q}": ${found.users.length} people from X`);
    return res.status(200).json(found.users.slice(0, Number(req.query.count) || 20));
  }
  const lq = q.toLowerCase().replace(/^@/, '');
  const local = [...knownUsers.values()].filter(u => u.screen_name.toLowerCase().includes(lq) || String(u.name || '').toLowerCase().includes(lq));
  console.log(`[XitterBridge users/search] "${q}": X still loading, ${local.length} known matches`);
  return res.status(200).json(local.slice(0, 20));
});

app.get(['/1.1/search/typeahead.json', '/1/search/typeahead.json'], async (req, res) => {
  const rawQuery = req.query.q || "";
  const query = decodeURIComponent(rawQuery).trim().toLowerCase();
  const cachedTweets = await getCachedTimelineFromWorker();
  const allTweets = [...localTimeline, ...cachedTweets];
  
  const q = query.replace(/^@/, '');
  const seen = new Set();
  const users = [];
  const candidates = [...knownUsers.values(), ...allTweets.map(t => sanitizeUser(t.user))];
  for (const u of candidates) {
    if (!u || isPlaceholderUser(u) || seen.has(u.id_str)) continue;
    if (q && !(u.screen_name.toLowerCase().startsWith(q) || String(u.name || '').toLowerCase().includes(q))) continue;
    seen.add(u.id_str);
    users.push(u);
    if (users.length >= 8) break;
  }
  const matchingStatuses = allTweets.filter(t => query === '' || t.text?.toLowerCase().includes(query)).slice(0, 5);

  const tags = new Map();
  for (const t of allTweets) {
    for (const h of (t.entities && t.entities.hashtags) || []) {
      const tag = '#' + h.text;
      if (q && !h.text.toLowerCase().startsWith(q.replace(/^#/, ''))) continue;
      tags.set(tag.toLowerCase(), tag);
    }
  }
  const topics = Array.from(tags.values()).slice(0, 5).map(topic => ({ topic, rounded_score: 0, tokens: [], inline: false }));
  return res.status(200).json({
    num_results: users.length + topics.length,
    users: users,
    topics,
    hashtags: topics.map(t => ({ hashtag: t.topic, rounded_score: 0 })),
    oneclick: [],
    statuses: matchingStatuses.map(t => sanitizeTweet(t)),
    completed_in: 0.01,
    query: rawQuery
  });
});

// Post a tweet, reply, or quote tweet to X for real.
app.post(['/1.1/statuses/update.json', '/1/statuses/update.json'], async (req, res) => {
  const tweetText = String(req.body.status || req.query.status || '');
  let inReplyTo = req.body.in_reply_to_status_id || req.query.in_reply_to_status_id || null;
  const attachmentUrl = req.body.attachment_url || req.query.attachment_url || '';
  if (!tweetText.trim() && !attachmentUrl) return res.status(200).json({ errors: [{ code: 170, message: 'Missing required parameter: status.' }] });

  // The app may send a rounded or shortened id; use the full one if we know the tweet.
  const allTweets = [...localTimeline, ...(await getCachedTimelineFromWorker())];
  let quoted = null;
  if (inReplyTo) {
    const parent = findTweetById(allTweets, inReplyTo) || allTweets.find(t => idMatches(t.id_str, inReplyTo));
    if (parent) inReplyTo = parent.id_str;
  }
  // Quote tweets: old apps put the tweet's link in the text, newer ones send attachment_url.
  let text = toXUrl(tweetText);
  const quoteLink = attachmentUrl ? toXUrl(attachmentUrl) : (text.match(/https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+\S*$/) || [])[0];
  if (attachmentUrl && !text.includes(quoteLink)) text = `${text} ${quoteLink}`.trim();
  if (quoteLink) {
    const qid = (quoteLink.match(/status\/(\d+)/) || [])[1];
    quoted = qid ? (findTweetById(allTweets, qid) || null) : null;
  }

  const localId = String(Date.now());
  const stand_in = sanitizeTweet({
    created_at: new Date().toISOString(), id_str: localId,
    text, full_text: text, source: '<a href="http://twitter.com" rel="nofollow">Twitter for Windows Phone</a>',
    in_reply_to_status_id_str: inReplyTo ? String(inReplyTo) : null,
    user: cachedAccountProfile, retweet_count: 0, favorite_count: 0,
    entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] },
    quoted_status: quoted || undefined
  });
  localTimeline.unshift(stand_in);
  enqueuePost({ kind: quoted ? 'quote' : (inReplyTo ? 'reply' : 'tweet'), text, replyTo: inReplyTo, localId });
  return res.status(200).json(stand_in);
});

// Retweet for real.
app.post(['/1.1/statuses/retweet/:id.json', '/1/statuses/retweet/:id.json', '/1.1/statuses/retweet/:id', '/1/statuses/retweet/:id'], async (req, res) => {
  const rawId = String(req.params.id || '').replace('.json', '');
  const allTweets = [...localTimeline, ...(await getCachedTimelineFromWorker())];
  const original = findTweetById(allTweets, rawId) || allTweets.find(t => idMatches(t.id_str, rawId));
  const targetId = original ? original.id_str : rawId;
  enqueuePost({ kind: 'retweet', tweetId: targetId });
  const orig = original ? sanitizeTweet(original) : null;
  const rt = sanitizeTweet({
    created_at: new Date().toISOString(), id_str: String(Date.now()),
    text: orig && orig.user ? `RT @${orig.user.screen_name}: ${orig.text}` : '', user: cachedAccountProfile,
    retweet_count: 0, favorite_count: 0, entities: {}, retweeted: true,
    retweeted_status: orig ? { ...orig, retweeted: true, retweet_count: (orig.retweet_count || 0) + 1 } : undefined
  });
  localRetweetIds.set(rt.id_str, targetId);
  return res.status(200).json({ ...rt, retweeted: true });
});

// Finds a tweet the app refers to (full, shortened or rounded id) in everything the server has loaded.
async function findAnyTweet(rawId) {
  const id = String(rawId || '').replace('.json', '');
  const all = [...localTimeline, ...(await getCachedTimelineFromWorker())];
  return all.find(t => t.id_str === id) || findInConversations(id) || findTweetById(all, id) || all.find(t => idMatches(t.id_str, id)) || null;
}

// Like / unlike for real.
async function likeEndpoint(req, res, kind) {
  const rawId = String(req.body?.id || req.query.id || '');
  if (!rawId) return res.status(200).json({ errors: [{ code: 170, message: 'Missing required parameter: id.' }] });
  const t = await findAnyTweet(rawId);
  const targetId = t ? t.id_str : rawId;
  enqueuePost({ kind, tweetId: targetId });
  const out = t ? sanitizeTweet(t) : sanitizeTweet({ id_str: targetId, text: '', user: null, entities: {} });
  const liked = kind === 'like';
  return res.status(200).json({ ...out, favorited: liked, favorite_count: Math.max(0, (out.favorite_count || 0) + (liked ? 1 : -1)) });
}
app.post(['/1.1/favorites/create.json', '/1/favorites/create.json'], (req, res) => likeEndpoint(req, res, 'like'));
app.post(['/1.1/favorites/destroy.json', '/1/favorites/destroy.json'], (req, res) => likeEndpoint(req, res, 'unlike'));

// Undo a retweet. The app may send the original tweet's id or the id of its retweet.
app.post(['/1.1/statuses/unretweet/:id.json', '/1/statuses/unretweet/:id.json', '/1.1/statuses/unretweet/:id', '/1/statuses/unretweet/:id'], async (req, res) => {
  const rawId = String(req.params.id || '').replace('.json', '');
  let targetId = localRetweetIds.get(rawId);
  const t = await findAnyTweet(targetId || rawId);
  if (!targetId) targetId = t && t.retweeted_status ? t.retweeted_status.id_str : (t ? t.id_str : rawId);
  enqueuePost({ kind: 'unretweet', tweetId: targetId });
  const orig = t ? sanitizeTweet(t.retweeted_status || t) : sanitizeTweet({ id_str: targetId, text: '', user: null, entities: {} });
  return res.status(200).json({ ...orig, retweeted: false, retweet_count: Math.max(0, (orig.retweet_count || 0) - 1) });
});

// Delete. Old apps also "delete" a retweet to undo it, so retweets become an unretweet.
app.post(['/1.1/statuses/destroy/:id.json', '/1/statuses/destroy/:id.json', '/1.1/statuses/destroy/:id', '/1/statuses/destroy/:id'], async (req, res) => {
  const rawId = String(req.params.id || '').replace('.json', '');
  const me = cachedAccountProfile && cachedAccountProfile.id_str;
  if (localRetweetIds.has(rawId)) {
    const target = localRetweetIds.get(rawId);
    enqueuePost({ kind: 'unretweet', tweetId: target });
    localRetweetIds.delete(rawId);
    const i = localTimeline.findIndex(x => x.id_str === rawId);
    if (i >= 0) localTimeline.splice(i, 1);
    return res.status(200).json(sanitizeTweet({ id_str: rawId, text: '', user: cachedAccountProfile, entities: {} }));
  }
  const t = await findAnyTweet(localPostIds.get(rawId) || rawId);
  if (t && t.retweeted_status && t.user && me && t.user.id_str === me) {
    enqueuePost({ kind: 'unretweet', tweetId: t.retweeted_status.id_str });
    return res.status(200).json(sanitizeTweet(t));
  }
  const realId = localPostIds.get(rawId) || (t ? t.id_str : rawId);
  if (/^\d{13}$/.test(realId) && !localPostIds.has(rawId)) {
    // A stand-in whose real post hasn't been confirmed yet: there is nothing on X to delete yet.
    logPost({ kind: 'delete', ok: false, detail: `not deleted: that post (${rawId}) hasn't finished posting yet - try again in a minute` });
    return res.status(200).json(t ? sanitizeTweet(t) : {});
  }
  if (t && t.user && me && t.user.id_str !== me) {
    logPost({ kind: 'delete', ok: false, detail: `not deleted: ${realId} isn't your tweet` });
    return res.status(200).json(sanitizeTweet(t));
  }
  enqueuePost({ kind: 'delete', tweetId: realId });
  return res.status(200).json(t ? sanitizeTweet(t) : sanitizeTweet({ id_str: realId, text: '', user: cachedAccountProfile, entities: {} }));
});

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
  if (path.includes('/moments')) console.log(`[XitterBridge Moments] UNHANDLED Moments request: ${req.method} ${req.originalUrl} - paste this line so it can be added`);
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
