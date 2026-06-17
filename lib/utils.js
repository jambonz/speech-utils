const crypto = require('crypto');
const {RivaSpeechSynthesisClient} = require('../stubs/riva/proto/riva_tts_grpc_pb');
const grpc = require('@grpc/grpc-js');
const { TMP_FOLDER } = require('./config');

function makeSynthKey({
  account_sid = '',
  vendor,
  language,
  voice,
  engine = '',
  model = '',
  text,
  instructions = '',
}) {
  const hash = crypto.createHash('sha1');
  hash.update(`${language}:${vendor}:${voice}:${engine}:${model}:${text}:${instructions}`);
  const hexHashKey = hash.digest('hex');
  const accountKey = account_sid ? `:${account_sid}` : '';
  const key = `tts${accountKey}:${hexHashKey}`;
  return key;
}

function makeFilePath({key, salt = '', extension}) {
  return `${TMP_FOLDER}/${key.replace('tts:', `tts-${salt}`)}.${extension}`;
}


const noopLogger = {
  info: () => {},
  debug: () => {},
  error: () => {}
};

function makeAwsKey(awsAccessKeyId) {
  const hash = crypto.createHash('sha1');
  hash.update(awsAccessKeyId);
  return `aws:${hash.digest('hex')}`;
}

const createRivaClient = async(rivaUri) => {
  const client = new RivaSpeechSynthesisClient(rivaUri, grpc.credentials.createInsecure());
  return client;
};

module.exports = {
  makeSynthKey,
  makeAwsKey,
  createRivaClient,
  noopLogger,
  makeFilePath
};
