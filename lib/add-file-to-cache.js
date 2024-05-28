const fs = require('fs/promises');
const {noopLogger, makeSynthKey} = require('./utils');
const {JAMBONES_TTS_CACHE_DURATION_MINS} = require('./config');
const EXPIRES = JAMBONES_TTS_CACHE_DURATION_MINS;

async function addFileToCache(client, logger, path,
  {account_sid, vendor, language, voice, deploymentId, engine, text}) {
  let key;
  logger = logger || noopLogger;

  try {
    key = makeSynthKey({
      account_sid,
      vendor,
      language: language || '',
      voice: voice || deploymentId,
      engine,
      text,
    });
    const audioBuffer = await fs.readFile(path);
    await client.setex(key, EXPIRES, audioBuffer.toString('base64'));
  } catch (err) {
    logger.error(err, 'addFileToCache: Error');
    return;
  }

  logger.debug(`addFileToCache: added ${path} to cache with key ${key}`);
  return key;
}

module.exports = addFileToCache;
