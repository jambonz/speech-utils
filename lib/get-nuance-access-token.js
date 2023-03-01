const formurlencoded = require('form-urlencoded');
const {Pool} = require('undici');
const pool = new Pool('https://auth.crt.nuance.com');
const {makeNuanceKey, makeBasicAuthHeader, noopLogger} = require('./utils');
const debug = require('debug')('jambonz:realtimedb-helpers');
const HTTP_TIMEOUT = 5000;

async function getNuanceAccessToken(client, logger, clientId, secret, scope) {
  logger = logger || noopLogger;
  try {
    const key = makeNuanceKey(clientId, secret, scope);
    const access_token = await client.getAsync(key);
    if (access_token) return {access_token, servedFromCache: true};

    /* access token not found in cache, so fetch it from Nuance */
    const payload = {
      grant_type: 'client_credentials',
      scope
    };
    const auth = makeBasicAuthHeader(clientId, secret);
    const {statusCode, headers, body} =  await pool.request({
      path: '/oauth2/token',
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formurlencoded(payload),
      timeout: HTTP_TIMEOUT,
      followRedirects: false
    });

    if (200 !== statusCode) {
      logger.debug({statusCode, headers, body: body.text()}, 'error fetching access token from Nuance');
      const err = new Error();
      err.statusCode = statusCode;
      throw err;
    }
    const json = await body.json();
    await client.set(key, json.access_token, 'EX', json.expires_in - 30);
    return {...json, servedFromCache: false};
  } catch (err) {
    debug(err, `getNuanceAccessToken: Error retrieving Nuance access token for client_id ${clientId}`);
    logger.error(err, `getNuanceAccessToken: Error retrieving Nuance access token for client_id ${clientId}`);
    throw err;
  }
}

module.exports = getNuanceAccessToken;
