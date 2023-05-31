const {noopLogger} = require('./utils');
const debug = require('debug')('jambonz:realtimedb-helpers');

async function getTtsSize(client, logger, pattern = null) {
  let keys;
  if (pattern) {
    keys = await client.keys(pattern);
  } else {
    keys = await client.keys('tts:*');
  }
  return keys.length;
}

module.exports = getTtsSize;