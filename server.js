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

let localTimeline = [];
let dynamicAuthToken = '';
let dynamicCt0 = '';

/**
 * Automated Login via Lightweight Mobile Twitter Layout
 */
async function performPuppeteerLogin(username, password) {
  console.log(`[Puppeteer Login] Launching stealth mobile browser for: ${username}`);
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    await page.setViewport({ width: 375, height: 812, isMobile: true });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');

    // Use mobile site login to avoid heavy SPA bot-walls
    await page.goto('https://mobile.twitter.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

    // Wait for mobile form inputs
    const usernameSelector = 'input[name="session[username_or_email]"]';
    const passwordSelector = 'input[name="session[password]"]';

    await page.waitForSelector(usernameSelector, { timeout: 15000 });
    await page.type(usernameSelector, username, { delay: 70 + Math.random() * 40 });
    await new Promise(r => setTimeout(r, 1000));

    await page.waitForSelector(passwordSelector, { timeout: 15000 });
    await page.type(passwordSelector, password, { delay: 70 + Math.random() * 40 });
    await new Promise(r => setTimeout(r, 1000));

    // Submit login form
    await page.evaluate(() => {
      const submitBtn = document.querySelector('div[data-testid="LoginForm_Login_Button"]') || 
                        Array.from(document.querySelectorAll('button, div[role="button"]')).find(el => el.innerText.includes('Log in') || el.innerText.includes('Iniciar sesión'));
      if (submitBtn) submitBtn.click();
    });

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });

    const cookies = await page.cookies();
    const authCookie = cookies.find(c => c.name === 'auth_token');
    const ct0Cookie = cookies.find(c => c.name === 'ct0');

    await browser.close();

    if (authCookie && ct0Cookie) {
      dynamicAuthToken = authCookie.value;
      dynamicCt0 = ct0Cookie.value;
      console.log('[Puppeteer Login] Successfully harvested session cookies via mobile login.');
      return true;
    }

    console.log('[Puppeteer Login] Failed to extract session cookies.');
    return false;
  } catch (err) {
    console.error('[Puppeteer Login Error]:', err.message);
    if (browser) await browser.close();
    return false;
  }
}

/**
 * Headless Browser Timeline Scraping Engine
 */
async function fetchLiveTimelineViaPuppeteer() {
  const authToken = dynamicAuthToken || process.env.X_AUTH_TOKEN;
  const ct0 = dynamicCt0 || process.env.X_CT0;

  if (!authToken || !ct0) {
    console.log('[Puppeteer] Skipping live fetch: No active session cookies available.');
    return [];
  }

  console.log('[Puppeteer] Launching headless browser instance for timeline...');
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    await page.setCookie(
      { name: 'auth_token', value: authToken, domain: '.x.com', path: '/' },
      { name: 'ct0', value: ct0, domain: '.x.com', path: '/' }
    );

    let parsedTweets = [];

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/graphql/') && (url.includes('HomeTimeline') || url.includes('UserTweets') || url.includes('ProfileTimeline'))) {
        try {
          const json = await response.json();
          const instructions = json?.data?.home?.home_timeline_urt?.instructions || 
                               json?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];

          for (const instr of instructions) {
            if (instr.type === 'TimelineAddEntries') {
              const entries = instr.entries || [];
              entries.forEach((entry, idx) => {
                const tweetResult = entry?.content?.itemContent?.tweet_results?.result;
                const legacy = tweetResult?.legacy || tweetResult?.tweet?.legacy;
                const userLegacy = tweetResult?.core?.user_results?.result?.legacy;

                if (legacy) {
                  parsedTweets.push({
                    created_at: legacy.created_at || new Date().toUTCString(),
                    id: legacy.id_str ? parseInt(legacy.id_str) : Date.now() + idx,
                    id_str: legacy.id_str || (Date.now() + idx).toString(),
                    text: legacy.full_text || legacy.text || "",
                    truncated: false,
                    user: {
                      ...defaultUser,
                      name: userLegacy?.name || defaultUser.name,
                      screen_name: userLegacy?.screen_name || defaultUser.screen_name,
                      profile_image_url_https: userLegacy?.profile_image_url_https || defaultUser.profile_image_url_https
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

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await browser.close();
    return parsedTweets;
  } catch (err) {
    console.error('[Puppeteer Error]:', err.message);
    if (browser) await browser.close();
    return [];
  }
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.all('/oauth/request_token', (req, res) => res.send('oauth_token=mock_req_token&oauth_token_secret=mock_req_secret&oauth_callback_confirmed=true'));
app.all('/oauth/authorize', (req, res) => res.send(`<html><body><h2>PIN</h2><p><b>1234567</b></p></body></html>`));
app.all('/oauth/authenticate', (req, res) => res.send(`<html><body><h2>PIN</h2><p><b>1234567</b></p></body></html>`));

app.all('/oauth/access_token', async (req, res) => {
  const username = req.body.x_auth_username || req.query.x_auth_username;
  const password = req.body.x_auth_password || req.query.x_auth_password;

  if (username && password) {
    console.log(`[XitterBridge] Processing app login for: ${username}`);
    const success = await performPuppeteerLogin(username, password);
    if (success) {
      return res.send(`oauth_token=mock_access_token&oauth_token_secret=mock_access_secret&user_id=12345678&screen_name=${username}`);
    } else {
      return res.status(401).json({ error: "Automated mobile browser login failed." });
    }
  }

  return res.send(`oauth_token=mock_access_token&oauth_token_secret=mock_access_secret&user_id=12345678&screen_name=danieldoodl5802`);
});

app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000 }));
app.get('/1.1/account/settings.json', (req, res) => res.status(200).json({ screen_name: "danieldoodl5802" }));
app.get('/1.1/application/rate_limit_status.json', (req, res) => res.status(200).json({ resources: { statuses: { "/statuses/home_timeline": { limit: 180, remaining: 180 } } } }));

app.get('/1.1/account/verify_credentials.json', (req, res) => res.status(200).json(defaultUser));
app.get('/1.1/users/show.json', (req, res) => res.status(200).json(defaultUser));
app.get('/1.1/users/lookup.json', (req, res) => res.status(200).json([defaultUser]));

app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  let liveTweets = await fetchLiveTimelineViaPuppeteer();
  return res.status(200).json([...localTimeline, ...liveTweets]);
});

app.get('/1.1/statuses/mentions_timeline.json', (req, res) => res.status(200).json([]));
app.get('/1.1/statuses/user_timeline.json', (req, res) => res.status(200).json(localTimeline));
app.get('/1.1/statuses/show/:id.json', (req, res) => res.status(200).json(localTimeline[0] || defaultUser));

app.post('/1.1/statuses/update.json', (req, res) => {
  const tweetText = req.body.status || req.query.status || "Posted from Lumia!";
  const newTweet = {
    created_at: new Date().toUTCString(),
    id: Date.now(),
    id_str: Date.now().toString(),
    text: tweetText,
    truncated: false,
    user: defaultUser,
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

app.get('/1.1/friends/list.json', (req, res) => res.status(200).json({ users: [defaultUser], next_cursor: 0 }));
app.get('/1.1/followers/list.json', (req, res) => res.status(200).json({ users: [defaultUser], next_cursor: 0 }));
app.get('/1.1/friends/ids.json', (req, res) => res.status(200).json({ ids: [12345678] }));
app.get('/1.1/followers/ids.json', (req, res) => res.status(200).json({ ids: [12345678] }));

app.get('/1.1/direct_messages/events/list.json', (req, res) => res.status(200).json({ events: [] }));
app.post('/1.1/direct_messages/events/new.json', (req, res) => res.status(200).json({ event: { type: "message_create", id: "12345" } }));
app.get('/1.1/direct_messages.json', (req, res) => res.status(200).json([]));
app.get('/1.1/direct_messages/sent.json', (req, res) => res.status(200).json([]));
app.get('/1.1/activity/about_me.json', (req, res) => res.status(200).json([]));

app.all('/1.1/*', (req, res) => {
  return res.status(200).json({});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XitterBridge listening on port ${PORT}`));