const assert = require('assert');
const {noopLogger} = require('./utils');
const ttsGoogle = require('@google-cloud/text-to-speech');
const { PollyClient, DescribeVoicesCommand } = require('@aws-sdk/client-polly');
const getAwsAuthToken = require('./get-aws-sts-token');

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

  assert.ok(['google', 'aws', 'polly'].includes(vendor),
    `getTtsVoices not supported for vendor ${vendor}`);

  switch (vendor) {
    case 'google':
      return getGoogleVoices(client, logger, credentials);
    case 'aws':
    case 'polly':
      return getAwsVoices(client, createHash, retrieveHash, logger, credentials);
    default:
      break;
  }
}


module.exports = getTtsVoices;
