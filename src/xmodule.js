'use strict';
/* X (Twitter) module — follow/unfollow/like/RT/reply/tweet across many accounts,
 * per-account proxy, jitter delays, GraphQL query IDs. */
const store = require('./store');
const accounts = require('./accounts');
const proxies = require('./proxies');

const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const QID = {
  CreateTweet: 'R5EPiGHgSqbTYFyozd-gFw',
  CreateRetweet: 'ojPdsZsimiJrUGLR1sjUtA',
  DeleteRetweet: 'iQtK4dl5hBmXewYZuEOKVw',
  FavoriteTweet: 'lI07N6Otwv1PhnEgXILM7A',
  UnfavoriteTweet: 'ZYKSe-w7KEslx3JhSIk5LA',
  UserByScreenName: 'G3KGOASz96M-Qu0nwmGXNg',
  TweetDetail: 'xOhkmRac04YFZmOzU9PJHg',
};

const bus = new (require('events').EventEmitter)();
bus.setMaxListeners(0);
const runs = new Map();

function nid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function emit(runId, ev) {
  const r = runs.get(runId);
  if (r) { r.events.push({ t: Date.now(), ...ev }); if (r.events.length > 2000) r.events.shift(); }
  bus.emit('event', { runId, t: Date.now(), ...ev });
}

function headers(acc, ct0) {
  return {
    authorization: `Bearer ${BEARER}`,
    cookie: `auth_token=${acc.xToken}; ct0=${ct0}`,
    'x-csrf-token': ct0,
    'content-type': 'application/json',
    'User-Agent': UA,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    origin: 'https://x.com',
    referer: 'https://x.com/home',
  };
}

async function call(acc, method, url, body) {
  const { fetch } = require('undici');
  const ct0 = acc.xCt0 || require('crypto').randomBytes(16).toString('hex');
  const r = await fetch(url, {
    method, headers: headers(acc, ct0),
    body: body ? JSON.stringify(body) : undefined,
    dispatcher: proxies.agentFor(acc.proxyId),
    signal: AbortSignal.timeout(25000),
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { /* html */ }
  if (!r.ok) {
    const detail = data?.errors?.[0]?.message || text.slice(0, 160);
    const err = new Error(`HTTP ${r.status}: ${detail}`);
    err.xCode = Number(data?.errors?.[0]?.code) || 0;
    err.status = r.status;
    throw err;
  }
  if (data?.errors?.length) {
    // A GraphQL error envelope arrives with HTTP 200; the numeric code is the
    // only reliable discriminator (messages are localised by exit-IP geo).
    const err = new Error(data.errors[0].message || 'x api error');
    err.xCode = Number(data.errors[0].code) || 0;
    err.status = 200;
    throw err;
  }
  return data;
}

async function resolveUser(acc, handle) {
  const clean = String(handle).replace(/^@/, '').trim();
  const vars = encodeURIComponent(JSON.stringify({ screen_name: clean, withSafetyModeUserFields: true }));
  const feats = encodeURIComponent(JSON.stringify({
    hidden_profile_likes_enabled: true, hidden_profile_subscriptions_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true, highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true, creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  }));
  const d = await call(acc, 'GET', `https://api.x.com/graphql/${QID.UserByScreenName}/UserByScreenName?variables=${vars}&features=${feats}`);
  const u = d?.data?.user?.result;
  if (!u) throw new Error(`user not found: ${clean}`);
  return { id: u.rest_id, handle: u.legacy?.screen_name, followers: u.legacy?.followers_count };
}

/* ---------------- primitives ---------------- */

async function follow(acc, handle) {
  const u = await resolveUser(acc, handle);
  const { fetch } = require('undici');
  const ct0 = acc.xCt0 || require('crypto').randomBytes(16).toString('hex');
  const body = new URLSearchParams({
    include_profile_interstitial_type: '1', include_blocking: '1', include_blocked_by: '1',
    include_followed_by: '1', include_want_retweets: '1', include_mute_edge: '1',
    include_can_dm: '1', include_can_media_tag: '1', skip_status: '1', user_id: u.id,
  });
  const r = await fetch('https://api.x.com/1.1/friendships/create.json', {
    method: 'POST',
    headers: { ...headers(acc, ct0), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(), dispatcher: proxies.agentFor(acc.proxyId), signal: AbortSignal.timeout(25000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`follow HTTP ${r.status}: ${t.slice(0, 120)}`);
  return { handle: u.handle, userId: u.id };
}

async function unfollow(acc, handle) {
  const u = await resolveUser(acc, handle);
  const { fetch } = require('undici');
  const ct0 = acc.xCt0 || require('crypto').randomBytes(16).toString('hex');
  const r = await fetch('https://api.x.com/1.1/friendships/destroy.json', {
    method: 'POST',
    headers: { ...headers(acc, ct0), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_id: u.id }).toString(),
    dispatcher: proxies.agentFor(acc.proxyId), signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`unfollow HTTP ${r.status}`);
  return { handle: u.handle };
}

function tweetIdFrom(input) {
  const m = /status\/(\d+)/.exec(String(input));
  if (m) return m[1];
  if (/^\d{5,25}$/.test(String(input).trim())) return String(input).trim();
  throw new Error(`cannot parse tweet id from: ${String(input).slice(0, 40)}`);
}

/* X answers HTTP 200 + an error envelope for no-op writes. These codes mean the
   desired end state already holds, so a quest checker sees them as done:
   139 already favorited · 327 already retweeted · 34/144 target gone. */
const ALREADY = { 139: 'already liked', 327: 'already retweeted' };

async function callIdem(acc, url, body) {
  try {
    return await call(acc, 'POST', url, body);
  } catch (e) {
    if (ALREADY[e.xCode]) return { _already: ALREADY[e.xCode] };
    throw e;
  }
}

async function like(acc, tweet) {
  const id = tweetIdFrom(tweet);
  const d = await callIdem(acc, `https://api.x.com/graphql/${QID.FavoriteTweet}/FavoriteTweet`, { variables: { tweet_id: id }, queryId: QID.FavoriteTweet });
  return { tweetId: id, ...(d?._already ? { already: d._already } : {}) };
}

async function retweet(acc, tweet) {
  const id = tweetIdFrom(tweet);
  const d = await callIdem(acc, `https://api.x.com/graphql/${QID.CreateRetweet}/CreateRetweet`, { variables: { tweet_id: id, dark_request: false }, queryId: QID.CreateRetweet });
  return { tweetId: id, ...(d?._already ? { already: d._already } : {}) };
}

const TWEET_FEATURES = {
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  articles_preview_enabled: true,
  rweb_video_timestamps_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  premium_content_api_read_enabled: false,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: false,
};

async function tweet(acc, text, replyTo, quoteUrl) {
  const variables = {
    tweet_text: text,
    dark_request: false,
    media: { media_entities: [], possibly_sensitive: false },
    semantic_annotation_ids: [],
  };
  if (replyTo) variables.reply = { in_reply_to_tweet_id: tweetIdFrom(replyTo), exclude_reply_user_ids: [] };
  if (quoteUrl) variables.attachment_url = quoteUrl;
  const d = await call(acc, 'POST', `https://api.x.com/graphql/${QID.CreateTweet}/CreateTweet`, {
    variables, features: TWEET_FEATURES, queryId: QID.CreateTweet,
  });
  const res = d?.data?.create_tweet?.tweet_results?.result;
  const id = res?.rest_id;
  return { tweetId: id, url: id ? `https://x.com/${acc.xHandle || 'i'}/status/${id}` : null };
}

/* ---------------- batch runner ---------------- */

/*
cfg = { action:'follow'|'unfollow'|'like'|'retweet'|'reply'|'tweet'|'quote',
        accountGroup, accountIds[], targets:[handles or tweet urls],
        text, minDelayMs, maxDelayMs, concurrency }
*/
async function start(cfg) {
  const runId = nid('xrun');
  const accs = (cfg.accountIds && cfg.accountIds.length
    ? cfg.accountIds.map((id) => accounts.getAccount(id))
    : accounts.listSafe([cfg.accountGroup]).map((a) => accounts.getAccount(a.id))
  ).filter((a) => a && a.xToken);
  if (!accs.length) throw new Error('no accounts with X auth token');
  const state = { id: runId, cfg, status: 'running', started: Date.now(), events: [], results: [], stopped: false, counts: { total: accs.length, ok: 0, fail: 0 } };
  runs.set(runId, state);

  (async () => {
    const minD = Number(cfg.minDelayMs ?? 60000);
    const maxD = Number(cfg.maxDelayMs ?? 90000);
    const conc = Math.max(1, Number(cfg.concurrency || 1));
    emit(runId, { level: 'info', msg: `X ${cfg.action} · ${accs.length} accounts · delay ${minD}-${maxD}ms · conc ${conc}` });

    const doOne = async (acc, idx) => {
      if (state.stopped) return;
      const targets = cfg.targets && cfg.targets.length ? cfg.targets : [null];
      for (const target of targets) {
        if (state.stopped) return;
        try {
          const text = cfg.text ? accounts.expand(cfg.text, acc) : null;
          let res;
          switch (cfg.action) {
            case 'follow': res = await follow(acc, target); break;
            case 'unfollow': res = await unfollow(acc, target); break;
            case 'like': res = await like(acc, target); break;
            case 'retweet': res = await retweet(acc, target); break;
            case 'reply': res = await tweet(acc, text, target); break;
            case 'quote': res = await tweet(acc, text, null, target); break;
            case 'tweet': res = await tweet(acc, text); break;
            default: throw new Error(`unknown action ${cfg.action}`);
          }
          state.counts.ok++;
          state.results.push({ ok: true, account: acc.name, handle: acc.xHandle, target, ...res });
          emit(runId, { level: 'ok', account: acc.name, msg: `${cfg.action} ${res && res.already ? `(${res.already})` : 'ok'}${target ? ' → ' + String(target).slice(0, 44) : ''}` });
        } catch (e) {
          state.counts.fail++;
          const msg = String(e.message || e).slice(0, 160);
          state.results.push({ ok: false, account: acc.name, target, error: msg });
          emit(runId, { level: 'fail', account: acc.name, msg });
        }
        const wait = minD + Math.random() * Math.max(0, maxD - minD);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    };

    for (let i = 0; i < accs.length; i += conc) {
      if (state.stopped) break;
      await Promise.all(accs.slice(i, i + conc).map((a, j) => doOne(a, i + j)));
    }
    state.status = state.stopped ? 'stopped' : 'done';
    emit(runId, { level: 'info', msg: `done · ok ${state.counts.ok} fail ${state.counts.fail}` });
    store.appendLog('x-module.log', `${runId} ${cfg.action} ok=${state.counts.ok} fail=${state.counts.fail}`);
  })();

  return { runId };
}

function stop(id) { const r = runs.get(id); if (!r) return false; r.stopped = true; r.status = 'stopped'; emit(id, { level: 'warn', msg: 'STOPPED' }); return true; }
function status(id) { const r = runs.get(id); return r ? { id, status: r.status, counts: r.counts, action: r.cfg.action, results: r.results.slice(-300) } : null; }
function list() { return [...runs.values()].map((r) => ({ id: r.id, action: r.cfg.action, status: r.status, counts: r.counts, started: r.started })); }
function events(id, since) { const r = runs.get(id); return r ? r.events.filter((e) => !since || e.t > since) : []; }

module.exports = { start, stop, status, list, events, bus, follow, unfollow, like, retweet, tweet, resolveUser, QID };
