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

// NVCF cloud TTS function-id default: ai-magpie-tts-multilingual (public)
const NVIDIA_TTS_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969';

const createRivaClient = async(rivaUri, {apiKey, functionId} = {}) => {
  if (apiKey) {
    /* NVCF cloud: TLS to grpc.nvcf.nvidia.com:443 with per-RPC metadata
       (function-id + Bearer api key) baked into the channel credentials */
    const callCreds = grpc.credentials.createFromMetadataGenerator((_params, cb) => {
      const md = new grpc.Metadata();
      md.add('function-id', functionId || NVIDIA_TTS_FUNCTION_ID);
      md.add('authorization', `Bearer ${apiKey}`);
      cb(null, md);
    });
    const creds = grpc.credentials.combineChannelCredentials(
      grpc.credentials.createSsl(), callCreds);
    return new RivaSpeechSynthesisClient('grpc.nvcf.nvidia.com:443', creds);
  }
  return new RivaSpeechSynthesisClient(rivaUri, grpc.credentials.createInsecure());
};

module.exports = {
  makeSynthKey,
  makeAwsKey,
  createRivaClient,
  noopLogger,
  makeFilePath
};
