const {noopLogger} = require('./lib/utils');

module.exports = (opts, logger) => {
  logger = logger || noopLogger;
  const {
    client,
    createHash,
    retrieveHash
  } = require('@jambonz/realtimedb-helpers')(opts, logger);

  return {
    client,
    getTtsSize: require('./lib/get-tts-size').bind(null, client, logger),
    purgeTtsCache: require('./lib/purge-tts-cache').bind(null, client, logger),
    addFileToCache: require('./lib/add-file-to-cache').bind(null, client, logger),
    synthAudio: require('./lib/synth-audio').bind(null, client, createHash, retrieveHash, logger),

    getAwsAuthToken: require('./lib/get-aws-sts-token').bind(null, logger, createHash, retrieveHash),
    getTtsVoices: require('./lib/get-tts-voices').bind(null, client, createHash, retrieveHash, logger),
  };
};
