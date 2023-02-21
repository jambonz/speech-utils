const assert = require('assert');
const {noopLogger, createNuanceClient} = require('./utils');
const getNuanceAccessToken = require('./get-nuance-access-token');
const {GetVoicesRequest, Voice} = require('../stubs/nuance/synthesizer_pb');
const TextToSpeechV1 = require('ibm-watson/text-to-speech/v1');
const { IamAuthenticator } = require('ibm-watson/auth');

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
  const {client_id: clientId, secret: secret} = credentials;

  return new Promise(async(resolve, reject) => {
    /* get a nuance access token */
    let token, nuanceClient;
    try {
      const access_token = await getNuanceAccessToken(client, logger, clientId, secret, 'tts');
      token = access_token.access_token;
      nuanceClient = await createNuanceClient(token);
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
async function getTtsVoices(client, logger, {vendor, credentials}) {
  logger = logger || noopLogger;

  assert.ok(['nuance', 'ibm'].includes(vendor),
    `getTtsVoices not supported for vendor ${vendor}`);

  switch (vendor) {
    case 'nuance':
      return getNuanceVoices(client, logger, credentials);
    case 'ibm':
      return getIbmVoices(client, logger, credentials);
    default:
      break;
  }
}


module.exports = getTtsVoices;
