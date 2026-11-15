const crypto = require('crypto');
const {noopLogger} = require('./utils');

const DEFAULT_AUTH_URI = 'https://viaflow-dashboard.viadialog.com/gw/auth/login';
// refresh well before the token expires so a call never starts with a token about to lapse
const EXPIRY_MARGIN_SECS = 600;
// a token revoked early is replaced within an hour
const MAX_CACHE_SECS = 3600;

const makeKey = ({auth_uri, slug, username, password}) => {
  const hash = crypto.createHash('sha256')
    .update([auth_uri || DEFAULT_AUTH_URI, slug, username, password].join('\n'))
    .digest('hex');
  return `viadialog:token:${hash}`;
};

/**
 * Log in to Viadialog and return an access token, cached in redis until shortly before it expires.
 * @returns {Promise<{access_token: string, servedFromCache: boolean}>}
 */
async function getViadialogAccessToken(client, logger, {username, password, slug, auth_uri}) {
  logger = logger || noopLogger;
  if (!username || !password || !slug) throw new Error('viadialog credential requires username, password and slug');
  const key = makeKey({auth_uri, slug, username, password});
  const cached = await client.get(key);
  if (cached) return {access_token: cached, servedFromCache: true};

  const response = await fetch(auth_uri || DEFAULT_AUTH_URI, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username, password, slug}),
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.text();
  if (!response.ok) {
    logger.info({status: response.status, body: body.slice(0, 300)}, 'viadialog login failed');
    throw new Error(`viadialog login failed: ${response.status} ${response.statusText}`);
  }
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('viadialog login returned invalid json');
  }
  const {access_token, expires_in} = json;
  if (!access_token) throw new Error('viadialog login returned no access_token');
  const ttl = Math.max(60, Math.min(MAX_CACHE_SECS, (Number(expires_in) || 3600) - EXPIRY_MARGIN_SECS));
  await client.setex(key, ttl, access_token)
    .catch((err) => logger.info({err}, 'viadialog: failed to cache access token'));
  return {access_token, servedFromCache: false};
}

module.exports = getViadialogAccessToken;
