const express = require('express');
const multer = require('multer');
require('dotenv').config();

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

// Direct HTTP API Fetch (No Puppeteer/Chromium overhead = No Render OOM crashes)
async function fetchTimelineDirectly() {
  const tokens = await getTokensFromCloudflareWorker();
  if (!tokens.auth_token || !tokens.ct0) {
    console.log('[API Error] Missing auth_token or ct0!');
    return [];
  }

  console.log('[API Fetch] Requesting home timeline directly from X GraphQL...');
  
  // X's public HomeTimeline GraphQL query ID and features payload
  const queryId = "7jT5ab_KAUI8qxhO_xUB_Q"; 
  const variables = encodeURIComponent(JSON.stringify({
    count: 20,
    includePromotedContent: false,
    latestControlAvailable: true,
    requestContext: "launch",
    withCommunityNotes: true
  }));
  const features = encodeURIComponent(JSON.stringify({
    rph_chat_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    communities_web_enable_tweet_community_result_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: true
  }));

  const url = `https://x.com/i/api/graphql/${queryId}/HomeTimeline?variables=${variables}&features=${features}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'x-csrf-token': tokens.ct0.trim(),
        'cookie': `auth_token=${tokens.auth_token.trim()}; ct0=${tokens.ct0.trim()}`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'referer': 'https://x.com/home'
      }
    });

    if (!response.ok) {
      console.log('[API Fetch Error] Status:', response.status, response.statusText);
      return [];
    }

    const json = await response.json();
    let parsedTweets = [];

    // Parse instructions
    const instructions = json?.data?.home?.home_timeline_urt?.instructions || [];
    for (const instr of instructions) {
      const entries = instr.entries || [];
      for (const entry of entries) {
        const tweetResult = entry?.content?.itemContent?.tweet_results?.result;
        if (!tweetResult) continue;

        const legacy = tweetResult?.legacy || tweetResult?.tweet?.legacy;
        const userResults = tweetResult?.core?.user_results?.result || tweetResult?.tweet?.core?.user_results?.result;
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
    }

    if (parsedTweets.length > 0) {
      const uniqueTweets = Array.from(new Map(parsedTweets.map(t => [t.id_str, t])).values());
      await saveCachedTimelineToWorker(uniqueTweets);
      console.log(`[API Fetch] Success! Fetched and cached ${uniqueTweets.length} live tweets.`);
      return uniqueTweets;
    }
  } catch (err) {
    console.error('[API Fetch Exception]:', err.message);
  }
  return [];
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/clear-cache', async (req, res) => {
  await saveCachedTimelineToWorker([]);
  return res.send('KV Cache wiped successfully!');
});

app.get('/refresh-now', async (req, res) => {
  console.log('[Direct Refresh] Triggering API fetch...');
  const newTweets = await fetchTimelineDirectly();
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
  fetchTimelineDirectly(); // Trigger background sync
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