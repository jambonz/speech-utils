const assert = require('assert');
const {noopLogger, createNuanceClient, createKryptonClient} = require('./utils');
const getNuanceAccessToken = require('./get-nuance-access-token');
const getVerbioAccessToken = require('./get-verbio-token');
const {GetVoicesRequest, Voice} = require('../stubs/nuance/synthesizer_pb');
const TextToSpeechV1 = require('ibm-watson/text-to-speech/v1');
const { IamAuthenticator } = require('ibm-watson/auth');
const ttsGoogle = require('@google-cloud/text-to-speech');
const { PollyClient, DescribeVoicesCommand } = require('@aws-sdk/client-polly');
const getAwsAuthToken = require('./get-aws-sts-token');
const {Pool} = require('undici');
const { HTTP_TIMEOUT } = require('./config');
const verbioVoicePool = new Pool('https://us.rest.speechcenter.verbio.com');

const getIbmVoices = async(client, logger, credentials) => {
  const {tts_region, tts_api_key} = credentials;
  console.log(`region: ${tts_region}, api_key: ${tts_api_key}`);

  const textToSpeech = new TextToSpeechV1({
    authenticator: new IamAuthenticator({
      apikey: tts_api_key,
    }),
    serviceUrl: `https://api.${tts_region}.text-to-speech.watson.cloud.ibm.com`
  });

  const voices = await textToSpeech.listVoices();
  return voices;
};

const getNuanceVoices = async(client, logger, credentials) => {
  const {client_id: clientId, secret: secret, nuance_tts_uri} = credentials;

  return new Promise(async(resolve, reject) => {
    /* get a nuance access token */
    let token, nuanceClient;
    try {
      if (nuance_tts_uri) {
        nuanceClient = await createKryptonClient(nuance_tts_uri);
      }
      else {
        const access_token = await getNuanceAccessToken(client, logger, clientId, secret, 'tts');
        token = access_token.access_token;
        nuanceClient = await createNuanceClient(token);
      }
    } catch (err) {
      logger.error({err}, 'getTtsVoices: error retrieving access token');
      return reject(err);
    }
    /* retrieve all voices */
    const v = new Voice();
    const request = new GetVoicesRequest();
    request.setVoice(v);

    nuanceClient.getVoices(request, (err, response) => {
      if (err) {
        logger.error({err, clientId, secret, token}, 'getTtsVoices: error retrieving voices');
        return reject(err);
      }

      /* return all the voices that are not restricted and eliminate duplicates */
      const voices = response.getVoicesList()
        .map((v) => {
          return {
            language: v.getLanguage(),
            name: v.getName(),
            model: v.getModel(),
            gender: v.getGender() === 1 ? 'male' : 'female',
            restricted: v.getRestricted()
          };
        });
      const v = voices
        .filter((v) => v.restricted === false)
        .map((v) => {
          delete v.restricted;
          return v;
        })
        .sort((a, b) => {
          if (a.language < b.language) return -1;
          if (a.language > b.language) return 1;
          if (a.name < b.name) return -1;
          return 1;
        });
      const arr = [...new Set(v.map((v) => JSON.stringify(v)))]
        .map((v) => JSON.parse(v));
      resolve(arr);
    });
  });
};

const getGoogleVoices = async(_client, logger, credentials) => {
  const client = new ttsGoogle.TextToSpeechClient({credentials});
  return await client.listVoices();
};

const getAwsVoices = async(_client, createHash, retrieveHash, logger, credentials) => {
  try {
    const {region, accessKeyId, secretAccessKey, roleArn} = credentials;
    let client = null;
    if (accessKeyId && secretAccessKey) {
      client = new PollyClient({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey
        }
      });
    } else if (roleArn) {
      client = new PollyClient({
        region,
        credentials: await getAwsAuthToken(
          logger, createHash, retrieveHash,
          {
            region,
            roleArn
          }),
      });
    } else {
      client = new PollyClient({region});
    }
    const command = new DescribeVoicesCommand({});
    const response = await client.send(command);
    return response;
  } catch (err) {
    logger.info({err}, 'testMicrosoftTts - failed to list voices for region ${region}');
    throw err;
  }
};

const getVerbioVoices = async(client, logger, credentials) => {
  try {
    const access_token = await getVerbioAccessToken(client, logger, credentials);
    const { body} =  await verbioVoicePool.request({
      path: '/api/v1/voices',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${access_token.access_token}`,
        'User-Agent': 'jambonz'
      },
      timeout: HTTP_TIMEOUT,
      followRedirects: false
    });
    return await body.json();
  } catch (err) {
    logger.info({err}, 'getVerbioVoices - failed to list voices for Verbio');
    throw err;
  }
};

/**
 * Synthesize speech to an mp3 file, and also cache the generated speech
 * in redis (base64 format) for 24 hours so as to avoid unnecessarily paying
 * time and again for speech synthesis of the same text.
 * It is the responsibility of the caller to unlink the mp3 file after use.
 *
 * @param {*} client - redis client
 * @param {*} logger - pino logger
 * @param {object} opts - options
 * @param {string} opts.vendor - 'google' or 'aws' ('polly' is an alias for 'aws')
 * @param {string} opt.language - language code
 * @param {string} opts.voice - voice identifier
 * @param {string} opts.text - text or ssml to synthesize
 * @returns object containing filepath to an mp3 file in the /tmp folder containing
 * the synthesized audio, and a variable indicating whether it was served from cache
 */
async function getTtsVoices(client, createHash, retrieveHash, logger, {vendor, credentials}) {
  logger = logger || noopLogger;

  assert.ok(['nuance', 'ibm', 'google', 'aws', 'polly', 'verbio'].includes(vendor),
    `getTtsVoices not supported for vendor ${vendor}`);

  switch (vendor) {
    case 'nuance':
      return getNuanceVoices(client, logger, credentials);
    case 'ibm':
      return getIbmVoices(client, logger, credentials);
    case 'google':
      return getGoogleVoices(client, logger, credentials);
    case 'aws':
    case 'polly':
      return getAwsVoices(client, createHash, retrieveHash, logger, credentials);
    case 'verbio':
      return getVerbioVoices(client, logger, credentials);
    default:
      break;
  }
}


module.exports = getTtsVoices;
