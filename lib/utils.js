const crypto = require('crypto');
/**
 * Future TODO: cache recently used connections to providers
 * to avoid connection overhead during a call.
 * Will need to periodically age them out to avoid memory leaks.
 */
//const nuanceClientMap = new Map();

function makeSynthKey({vendor, language, voice, engine = '', text}) {
  const hash = crypto.createHash('sha1');
  hash.update(`${language}:${vendor}:${voice}:${engine}:${text}`);
  return `tts:${hash.digest('hex')}`;
}

const noopLogger = {
  info: () => {},
  debug: () => {},
  error: () => {}
};


module.exports = {
  makeSynthKey,
  noopLogger
};
