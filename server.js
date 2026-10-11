const express = require('express');
const axios = require('axios');
const multer = require('multer');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Log incoming requests for Render console debugging
app.use((req, res, next) => {
  console.log(`[XitterBridge] ${req.method} ${req.path}`);
  next();
});

const defaultUser = {
  id: 12345678,
  id_str: "12345678",
  name: "Daniel's Doodles",
  screen_name: "daniels_doodles",
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

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

/**
 * 1. OAuth Handshake & PIN Auth Support
 */
app.all('/oauth/request_token', (req, res) => res.send('oauth_token=mock_req_token&oauth_token_secret=mock_req_secret&oauth_callback_confirmed=true'));
app.all('/oauth/authorize', (req, res) => {
  const callback = req.query.oauth_callback || 'oob';
  if (callback === 'oob') {
    return res.send(`<html><body><h2>XitterBridge PIN Authorization</h2><p>Your authorization PIN is: <b>1234567</b></p></body></html>`);
  }
  res.redirect(`${callback}?oauth_token=mock_req_token&oauth_verifier=1234567`);
});
app.all('/oauth/authenticate', (req, res) => {
  const callback = req.query.oauth_callback || 'oob';
  if (callback === 'oob') {
    return res.send(`<html><body><h2>XitterBridge PIN Authorization</h2><p>Your authorization PIN is: <b>1234567</b></p></body></html>`);
  }
  res.redirect(`${callback}?oauth_token=mock_req_token&oauth_verifier=1234567`);
});
app.all('/oauth/access_token', (req, res) => res.send(`oauth_token=mock_access_token&oauth_token_secret=mock_access_secret&user_id=12345678&screen_name=daniels_doodles`));

/**
 * 2. Settings & Configuration
 */
app.get('/1.1/help/configuration.json', (req, res) => res.status(200).json({ dm_text_character_limit: 10000, max_media_per_upload: 1, photo_size_limit: 3145728 }));
app.get('/1.1/account/settings.json', (req, res) => res.status(200).json({ screen_name: "daniels_doodles", always_use_https: true }));
app.get('/1.1/application/rate_limit_status.json', (req, res) => res.status(200).json({ resources: { statuses: { "/statuses/home_timeline": { limit: 180, remaining: 180 } } } }));

/**
 * 3. User Profiles & Credentials
 */
app.get('/1.1/account/verify_credentials.json', (req, res) => res.status(200).json(defaultUser));
app.get('/1.1/users/show.json', (req, res) => res.status(200).json(defaultUser));
app.get('/1.1/users/lookup.json', (req, res) => res.status(200).json([defaultUser]));

/**
 * 4. Timelines (Home Timeline with Cloud-Accessible Live Feed Bridge)
 */
app.get('/1.1/statuses/home_timeline.json', async (req, res) => {
  let liveTweets = [];

  try {
    console.log('[XitterBridge] Fetching live timeline via cloud gateway on Render...');
    
    // Pulls real live feed from public JSON gateway accessible from cloud IPs
    const response = await axios.get('https://rsshub.app/twitter/user/daniels_doodles?format=json', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 6000
    });

    if (response.data && response.data.items) {
      liveTweets = response.data.items.map((item, index) => ({
        created_at: item.date_published ? new Date(item.date_published).toUTCString() : new Date().toUTCString(),
        id: Date.now() + index,
        id_str: (Date.now() + index).toString(),
        text: item.title || item.content_text || "",
        truncated: false,
        user: defaultUser,
        retweet_count: 0,
        favorite_count: 0,
        favorited: false,
        retweeted: false
      }));
      console.log(`[XitterBridge] Successfully parsed ${liveTweets.length} live tweets on Render!`);
    }
  } catch (err) {
    console.error('[XitterBridge] Cloud gateway fetch note:', err.message);
  }

  return res.status(200).json([...localTimeline, ...liveTweets]);
});

app.get('/1.1/statuses/mentions_timeline.json', (req, res) => res.status(200).json([]));
app.get('/1.1/statuses/user_timeline.json', (req, res) => res.status(200).json(localTimeline));
app.get('/1.1/statuses/show/:id.json', (req, res) => res.status(200).json(localTimeline[0] || {
  id: 999999999,
  id_str: "999999999",
  text: "Sample status detail",
  user: defaultUser
}));

/**
 * 5. Tweet Engagement & Posting
 */
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
  console.log(`[XitterBridge] Tweet posted successfully: "${tweetText}"`);
  return res.status(200).json(newTweet);
});

app.post('/1.1/favorites/create.json', (req, res) => res.status(200).json({ favorited: true }));
app.post('/1.1/favorites/destroy.json', (req, res) => res.status(200).json({ favorited: false }));
app.get('/1.1/favorites/list.json', (req, res) => res.status(200).json([]));

/**
 * 6. Search & Trends
 */
app.get('/1.1/search/tweets.json', (req, res) => res.status(200).json({ statuses: [], search_metadata: {} }));
app.get('/1.1/trends/place.json', (req, res) => res.status(200).json([{ trends: [{ name: "#WindowsPhone", query: "%23WindowsPhone" }] }]));

/**
 * 7. Friends & Followers Lists
 */
app.get('/1.1/friends/list.json', (req, res) => res.status(200).json({ users: [defaultUser], next_cursor: 0, next_cursor_str: "0" }));
app.get('/1.1/followers/list.json', (req, res) => res.status(200).json({ users: [defaultUser], next_cursor: 0, next_cursor_str: "0" }));
app.get('/1.1/friends/ids.json', (req, res) => res.status(200).json({ ids: [12345678] }));
app.get('/1.1/followers/ids.json', (req, res) => res.status(200).json({ ids: [12345678] }));

/**
 * 8. Direct Messages (DMs) & Activity
 */
app.get('/1.1/direct_messages/events/list.json', (req, res) => res.status(200).json({ events: [] }));
app.post('/1.1/direct_messages/events/new.json', (req, res) => res.status(200).json({ event: { type: "message_create", id: "12345" } }));
app.get('/1.1/direct_messages.json', (req, res) => res.status(200).json([]));
app.get('/1.1/direct_messages/sent.json', (req, res) => res.status(200).json([]));
app.get('/1.1/activity/about_me.json', (req, res) => res.status(200).json([]));

/**
 * 9. Universal Catch-All Handler
 */
app.all('/1.1/*', (req, res) => {
  const path = req.path;
  if (path.includes('users/show') || path.includes('account/verify_credentials')) {
    return res.status(200).json(defaultUser);
  }
  if (path.includes('favorites/create')) return res.status(200).json({ favorited: true });
  if (path.includes('favorites/destroy')) return res.status(200).json({ favorited: false });
  if (path.includes('list') || path.includes('timeline') || path.includes('search')) return res.status(200).json([]);
  return res.status(200).json({});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XitterBridge listening on port ${PORT}`));