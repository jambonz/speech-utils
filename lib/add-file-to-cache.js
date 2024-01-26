const fs = require('fs/promises');
const {noopLogger, makeSynthKey} = require('./utils');
const EXPIRES = (process.env.JAMBONES_TTS_CACHE_DURATION_MINS || 4 * 60) * 60; // cache tts for 4 hours

async function addFileToCache(client, logger, path,
  {account_sid, vendor, language, voice, deploymentId, engine, text}) {
  logger = logger || noopLogger;

  try {
    const key = makeSynthKey({
      account_sid,
      vendor,
      language: language || '',
      voice: voice || deploymentId,
      engine,
      text,
    });
    const audioBuffer = fs.readFile(path);
    await client.setex(key, EXPIRES, audioBuffer.toString('base64'));
  } catch (err) {
    logger.error(err, 'addFileToCache: Error');
    return false;
  }

  logger.debug(`addFileToCache: added ${path} to cache`);
  return true;
}

module.exports = addFileToCache;
