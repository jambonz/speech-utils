const {noopLogger} = require('./lib/utils');
const promisify = require('@jambonz/promisify-redis');
const redis = promisify(require('redis'));

module.exports = (opts, logger) => {
  const {host = '127.0.0.1', port = 6379, tls = false} = opts;
  logger = logger || noopLogger;

  const url = process.env.JAMBONES_REDIS_USERNAME && process.env.JAMBONES_REDIS_PASSWORD ?
    `${process.env.JAMBONES_REDIS_USERNAME}:${process.env.JAMBONES_REDIS_PASSWORD}@${host}:${port}` :
    `${host}:${port}`;
  const client = redis.createClient(tls ? `rediss://${url}` : `redis://${url}`);
  ['ready', 'connect', 'reconnecting', 'error', 'end', 'warning']
    .forEach((event) => {
      client.on(event, (...args) => {
        if ('error' === event) {
          if (process.env.NODE_ENV === 'test' && args[0]?.code === 'ECONNREFUSED') return;
          logger.error({...args}, '@jambonz/realtimedb-helpers - redis error');
        }
        else logger.debug({args}, `redis event ${event}`);
      });
    });

  return {
    client,
    purgeTtsCache: require('./lib/purge-tts-cache').bind(null, client, logger),
    synthAudio: require('./lib/synth-audio').bind(null, client, logger),
    getNuanceAccessToken: require('./lib/get-nuance-access-token').bind(null, client, logger),
    getIbmAccessToken: require('./lib/get-ibm-access-token').bind(null, client, logger),
    getTtsVoices: require('./lib/get-tts-voices').bind(null, client, logger),
  };
};
