const {noopLogger, makeSynthKey} = require('./utils');
const debug = require('debug')('jambonz:realtimedb-helpers');

/**
 * Scan TTS Cache and purge records, use specific settings to purge just one
 * @param {object} opts - options
 * @param {boolean} opts.all - purge all records or only one specific, true by default
 * @param {string} opts.vendor - 'google' or 'aws' ('polly' is an alias for 'aws')
 * @param {string} opts.language - language code
 * @param {string} opts.voice - voice identifier
 * @param {string} opts.text - text or ssml to synthesize
 * @returns {object} result - {error, purgedCount}
 */
async function purgeTtsCache(client, logger, {all, vendor, language, voice, deploymentId, engine, text} = {all: true}) {
  logger = logger || noopLogger;

  let purgedCount = 0, error;

  try {
    if (all) {
      const keys = await client.keysAsync('tts:*');
      purgedCount = await client.delAsync(keys);

    } else {
      const key = makeSynthKey({
        vendor,
        language: language || '',
        voice: voice || deploymentId,
        engine,
        text,
      });
      purgedCount = await client.delAsync(key);
      if (purgedCount === 0) error = 'Specified item not found';
    }

  } catch (err) {
    debug(err, 'purgeTtsCache: Error');
    logger.error(err, 'purgeTtsCache: Error');
    error = err.message ?? 'Unknown Error';
  }

  logger.info(`purgeTtsCache: purged ${purgedCount} records`);
  return {error, purgedCount};
}

module.exports = purgeTtsCache;
