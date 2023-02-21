const formurlencoded = require('form-urlencoded');
const {Pool} = require('undici');
const pool = new Pool('https://iam.cloud.ibm.com');
const {makeIbmKey, noopLogger} = require('./utils');
const debug = require('debug')('jambonz:realtimedb-helpers');
const HTTP_TIMEOUT = 5000;

async function getIbmAccessToken(client, logger, apiKey) {
  logger = logger || noopLogger;
  try {
    const key = makeIbmKey(apiKey);
    const access_token = await client.getAsync(key);
    if (access_token) return {access_token, servedFromCache: true};

    /* access token not found in cache, so fetch it from Ibm */
    const payload = {
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: apiKey
    };
    const {statusCode, headers, body} =  await pool.request({
      path: '/identity/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formurlencoded(payload),
      timeout: HTTP_TIMEOUT,
      followRedirects: false
    });

    if (200 !== statusCode) {
      const json = await body.json();
      logger.debug({statusCode, headers, body: json}, 'error fetching access token from Ibm');
      const err = new Error();
      err.statusCode = statusCode;
      throw err;
    }
    const json = await body.json();
    await client.set(key, json.access_token, 'EX', json.expires_in - 30);
    return {...json, servedFromCache: false};
  } catch (err) {
    debug(err, 'getIbmAccessToken: Error retrieving Ibm access token');
    logger.error(err, 'getIbmAccessToken: Error retrieving Ibm access token for client_id ${clientId}');
    throw err;
  }
}

module.exports = getIbmAccessToken;
