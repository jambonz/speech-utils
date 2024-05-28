const {Pool} = require('undici');
const { noopLogger, makeVerbioKey } = require('./utils');
const { HTTP_TIMEOUT } = require('./config');
const pool = new Pool('https://auth.speechcenter.verbio.com:444');
const debug = require('debug')('jambonz:realtimedb-helpers');

async function getVerbioAccessToken(client, logger, credentials) {
  logger = logger || noopLogger;
  const { client_id, client_secret } = credentials;
  try {
    const key = makeVerbioKey(client_id);
    const access_token = await client.get(key);
    if (access_token) {
      return {access_token, servedFromCache: true};
    }

    const payload = {
      client_id,
      client_secret
    };

    const {statusCode, headers, body} =  await pool.request({
      path: '/api/v1/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'jambonz'
      },
      body: JSON.stringify(payload),
      timeout: HTTP_TIMEOUT,
      followRedirects: false
    });

    if (200 !== statusCode) {
      logger.debug({statusCode, headers, body: await body.text()}, 'error fetching access token from Verbio');
      const err = new Error();
      err.statusCode = statusCode;
      throw err;
    }
    const json = await body.json();
    const expiry =  Math.floor(json.expiration_time - Date.now() / 1000 - 30);
    await client.set(key, json.access_token, 'EX', expiry);
    return {...json, servedFromCache: false};
  } catch (err) {
    debug(err, `getVerbioAccessToken: Error retrieving Verbio access token for client_id ${client_id}`);
    logger.error(err, `getVerbioAccessToken: Error retrieving Verbio access token for client_id ${client_id}`);
    throw err;
  }
}

module.exports = getVerbioAccessToken;
