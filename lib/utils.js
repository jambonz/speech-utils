const crypto = require('crypto');
const {SynthesizerClient} = require('../stubs/nuance/synthesizer_grpc_pb');
const {RivaSpeechSynthesisClient} = require('../stubs/riva/proto/riva_tts_grpc_pb');
const {Pool} = require('undici');
const pool = new Pool('https://auth.crt.nuance.com');
const NUANCE_AUTH_ENDPOINT = 'tts.api.nuance.com:443';
const grpc = require('@grpc/grpc-js');
const formurlencoded = require('form-urlencoded');
const { TMP_FOLDER, HTTP_TIMEOUT } = require('./config');

const debug = require('debug')('jambonz:realtimedb-helpers');
/**
 * Future TODO: cache recently used connections to providers
 * to avoid connection overhead during a call.
 * Will need to periodically age them out to avoid memory leaks.
 */
//const nuanceClientMap = new Map();

function makeSynthKey({
  account_sid = '',
  vendor,
  language,
  voice,
  engine = '',
  model = '',
  text,
  instructions = '',
}) {
  const hash = crypto.createHash('sha1');
  hash.update(`${language}:${vendor}:${voice}:${engine}:${model}:${text}:${instructions}`);
  const hexHashKey = hash.digest('hex');
  const accountKey = account_sid ? `:${account_sid}` : '';
  const key = `tts${accountKey}:${hexHashKey}`;
  return key;
}

function makeFilePath({key, salt = '', extension}) {
  return `${TMP_FOLDER}/${key.replace('tts:', `tts-${salt}`)}.${extension}`;
}


const noopLogger = {
  info: () => {},
  debug: () => {},
  error: () => {}
};

const toBase64 = (str) => Buffer.from(str || '', 'utf8').toString('base64');

function makeBasicAuthHeader(username, password) {
  if (!username || !password) return {};
  const creds = `${encodeURIComponent(username)}:${password || ''}`;
  const header = `Basic ${toBase64(creds)}`;
  return {Authorization: header};
}

function makeIbmKey(apiKey) {
  const hash = crypto.createHash('sha1');
  hash.update(apiKey);
  return `ibm:${hash.digest('hex')}`;
}

function makeAwsKey(awsAccessKeyId) {
  const hash = crypto.createHash('sha1');
  hash.update(awsAccessKeyId);
  return `aws:${hash.digest('hex')}`;
}

function makePlayhtKey(apiKey) {
  const hash = crypto.createHash('sha1');
  hash.update(apiKey);
  return `playht:${hash.digest('hex')}`;
}
function makeVerbioKey(client_id) {
  const hash = crypto.createHash('sha1');
  hash.update(client_id);
  return `verbio:${hash.digest('hex')}`;
}

function makeNuanceKey(clientId, secret, scope) {
  const hash = crypto.createHash('sha1');
  hash.update(`${clientId}:${secret}:${scope}`);
  return `nuance:${hash.digest('hex')}`;
}

const getNuanceAccessToken = async(clientId, secret, scope = 'asr tts') => {
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
    debug({statusCode, headers, body: body.text()}, 'error fetching access token from Nuance');
    const err = new Error();
    err.statusCode = statusCode;
    throw err;
  }
  const json = await body.json();
  return json.access_token;
};

const createKryptonClient = async(uri) => {
  const client = new SynthesizerClient(uri, grpc.credentials.createInsecure());
  return client;
};

const createNuanceClient = async(access_token) => {

  //if (nuanceClientMap.has(access_token)) return nuanceClientMap.get(access_token);

  const generateMetadata = (params, callback) => {
    var metadata = new grpc.Metadata();
    metadata.add('authorization', `Bearer ${access_token}`);
    callback(null, metadata);
  };

  const sslCreds = grpc.credentials.createSsl();
  const authCreds = grpc.credentials.createFromMetadataGenerator(generateMetadata);
  const combined_creds = grpc.credentials.combineChannelCredentials(sslCreds, authCreds);
  const client = new SynthesizerClient(NUANCE_AUTH_ENDPOINT, combined_creds);

  //if (process.env.NUANCE_CACHE_TTS_CONNECTIONS) nuanceClientMap.set(access_token, client);
  return client;
};

const createRivaClient = async(rivaUri) => {
  const client = new RivaSpeechSynthesisClient(rivaUri, grpc.credentials.createInsecure());
  return client;
};

module.exports = {
  makeSynthKey,
  makeNuanceKey,
  makeIbmKey,
  makePlayhtKey,
  makeAwsKey,
  makeVerbioKey,
  getNuanceAccessToken,
  createNuanceClient,
  createKryptonClient,
  createRivaClient,
  makeBasicAuthHeader,
  NUANCE_AUTH_ENDPOINT,
  noopLogger,
  makeFilePath
};
