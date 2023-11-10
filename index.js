const {noopLogger} = require('./lib/utils');

module.exports = (opts, logger) => {
  logger = logger || noopLogger;
  let client = opts.redis_client;
  if (!client) {
    const {client: redisClient} = require('@jambonz/realtimedb-helpers')(opts, logger);
    client = redisClient;
  }

  return {
    client,
    getTtsSize: require('./lib/get-tts-size').bind(null, client, logger),
    purgeTtsCache: require('./lib/purge-tts-cache').bind(null, client, logger),
    synthAudio: require('./lib/synth-audio').bind(null, client, logger),
    getNuanceAccessToken: require('./lib/get-nuance-access-token').bind(null, client, logger),
    getIbmAccessToken: require('./lib/get-ibm-access-token').bind(null, client, logger),
    getTtsVoices: require('./lib/get-tts-voices').bind(null, client, logger),
  };
};
