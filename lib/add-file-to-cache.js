const fs = require('fs/promises');
const {noopLogger, makeSynthKey} = require('./utils');
const {JAMBONES_TTS_CACHE_DURATION_MINS} = require('./config');
const EXPIRES = JAMBONES_TTS_CACHE_DURATION_MINS;

function getExtensionAndSampleRate(path) {
  const match = path.match(/\.([^.]*)$/);
  if (!match) {
    //default should be wav file.
    return ['wav', 8000];
  }

  const extension = match[1];
  const sampleRateMap = {
    r8: 8000,
    r16: 16000,
    r24: 24000,
    r44: 44100,
    r48: 48000,
    r96: 96000,
  };

  const sampleRate = sampleRateMap[extension] || 8000;
  return [extension, sampleRate];
}

async function addFileToCache(client, logger, path,
  {account_sid, vendor, language, voice, deploymentId, engine, model, text}) {
  let key;
  logger = logger || noopLogger;

  try {
    key = makeSynthKey({
      account_sid,
      vendor,
      language: language || '',
      voice: voice || deploymentId,
      engine,
      model,
      text,
    });
    const [extension, sampleRate] = getExtensionAndSampleRate(path);
    const audioBuffer = await fs.readFile(path);
    await client.setex(key, EXPIRES, JSON.stringify(
      {
        audioContent: audioBuffer.toString('base64'),
        extension,
        sampleRate
      }
    ));
  } catch (err) {
    logger.error(err, 'addFileToCache: Error');
    return;
  }

  logger.debug(`addFileToCache: added ${path} to cache with key ${key}`);
  return key;
}

module.exports = addFileToCache;
