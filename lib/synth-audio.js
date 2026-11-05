const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');
const bent = require('bent');
const ttsGoogle = require('@google-cloud/text-to-speech');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const { CartesiaClient } = require('@cartesia/cartesia-js');

const sdk = require('microsoft-cognitiveservices-speech-sdk');

const {
  ResultReason,
  SpeechConfig,
  SpeechSynthesizer,
  CancellationDetails,
  SpeechSynthesisOutputFormat,
  PropertyId
} = sdk;
const {
  makeSynthKey,
  createRivaClient,
  noopLogger,
  makeFilePath
} = require('./utils');
const {SynthesizeSpeechRequest} = require('../stubs/riva/proto/riva_tts_pb');
const {AudioEncoding} = require('../stubs/riva/proto/riva_audio_pb');
const debug = require('debug')('jambonz:realtimedb-helpers');
const {
  JAMBONES_DISABLE_TTS_STREAMING,
  JAMBONES_DISABLE_AZURE_TTS_STREAMING,
  JAMBONES_HTTP_PROXY_IP,
  JAMBONES_HTTP_PROXY_PORT,
  JAMBONES_TTS_CACHE_DURATION_MINS,
  JAMBONES_TTS_TRIM_SILENCE,
  JAMBONES_AZURE_ENABLE_SSML,
  JAMBONES_AZURE_SPEECH_SYNTHESIS_FRAME_TIMEOUT_INTERVAL,
  JAMBONES_AZURE_SPEECH_SYNTHESIS_RTF_TIMEOUT_THRESHOLD
} = require('./config');
const EXPIRES = JAMBONES_TTS_CACHE_DURATION_MINS;
const OpenAI = require('openai');
const getAwsAuthToken = require('./get-aws-sts-token');

const trimTrailingSilence = (buffer) => {
  assert.ok(buffer instanceof Buffer, 'trimTrailingSilence - argument is not a Buffer');

  let offset = buffer.length;
  while (offset > 0) {
    // Get 16-bit value from the buffer (read in reverse)
    const value = buffer.readUInt16BE(offset - 2);
    if (value !== 0) {
      break;
    }
    offset -= 2;
  }

  // Trim the silence from the end
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
};

/**
 * Synthesize speech to an mp3 file, and also cache the generated speech
 * in redis (base64 format) for 24 hours so as to avoid unnecessarily paying
 * time and again for speech synthesis of the same text.
 * It is the responsibility of the caller to unlink the mp3 file after use.
 *
 * @param {*} client - redis client
 * @param {*} logger - pino logger
 * @param {object} opts - options
 * @param {string} opts.vendor - 'google' or 'aws' ('polly' is an alias for 'aws')
 * @param {string} opt.language - language code
 * @param {string} opts.voice - voice identifier
 * @param {string} opts.text - text or ssml to synthesize
 * @param {boolean} opts.disableTtsCache - disable TTS Cache retrieval
 * @returns object containing filepath to an mp3 file in the /tmp folder containing
 * the synthesized audio, and a variable indicating whether it was served from cache
 */
async function synthAudio(client, createHash, retrieveHash, logger, stats, { account_sid,
  vendor, language, voice, gender, text, engine, salt, model, credentials, deploymentId,
  disableTtsCache, renderForCaching = false, disableTtsStreaming, options, instructions
}) {
  let audioData;
  let servedFromCache = false;
  let rtt;
  logger = logger || noopLogger;

  let mistralRefAudio;
  assert.ok(['google', 'aws', 'polly', 'microsoft', 'wellsaid', 'nvidia', 'elevenlabs',
    'whisper', 'deepgram', 'deepgramflux', 'rimelabs', 'cartesia', 'gradium', 'kugelaudio', 'assemblyai', 'nineninesix',
    'inworld', 'resemble', 'murf', 'xai', 'fishaudio', 'speechify', 'giggy', 'mistral', 'svara', 'paxa',
    'sarvam', 'smallestai', 'azureopenai', 'gnani', 'minimax', 'neuphonic',
    'camb', 'asyncai', 'respeecher', 'bland', 'simplismart', 'spitch', 'kokoro', 'vakyam', 'groq', 'hume',
    'speechmatics', 'soniox']
    .includes(vendor) ||
  vendor.startsWith('custom'),
  `synthAudio supported vendors are google, aws, microsoft, nvidia and wellsaid ..etc, not ${vendor}`);
  if ('google' === vendor) {
    assert.ok(language, 'synthAudio requires language when google is used');
  }
  else if (['aws', 'polly'].includes(vendor))  {
    assert.ok(voice, 'synthAudio requires voice when aws polly is used');
  }
  else if ('microsoft' === vendor) {
    assert.ok(language || deploymentId, 'synthAudio requires language when microsoft is used');
    assert.ok(voice || deploymentId, 'synthAudio requires voice when microsoft is used');
  }
  else if ('nvidia' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when nvidia is used');
    assert.ok(language, 'synthAudio requires language when nvidia is used');
    assert.ok(credentials.riva_server_uri, 'synthAudio requires riva_server_uri in credentials when nvidia is used');
  }
  else if ('wellsaid' === vendor) {
    language = 'en-US'; // WellSaid only supports English atm
    assert.ok(voice, 'synthAudio requires voice when wellsaid is used');
    assert.ok(!text.startsWith('<speak'), 'wellsaid does not support SSML tags');
  } else if ('elevenlabs' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when elevenlabs is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when elevenlabs is used');
    assert.ok(credentials.model_id, 'synthAudio requires model_id when elevenlabs is used');
  } else if ('inworld' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when inworld is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when inworld is used');
    assert.ok(credentials.model_id, 'synthAudio requires model_id when inworld is used');
  } else if ('rimelabs' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when rimelabs is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when rimelabs is used');
    assert.ok(credentials.model_id, 'synthAudio requires model_id when rimelabs is used');
  } else if ('whisper' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when whisper is used');
    assert.ok(credentials.model_id, 'synthAudio requires model when whisper is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when whisper is used');
  } else  if (vendor.startsWith('custom')) {
    assert.ok(credentials.custom_tts_url, `synthAudio requires custom_tts_url in credentials when ${vendor} is used`);
  } else if ('deepgram' === vendor) {
    if (!credentials.deepgram_tts_uri) {
      assert.ok(credentials.api_key, 'synthAudio requires api_key when deepgram is used');
    }
  } else if ('deepgramflux' === vendor) {
    // Deepgram Flux TTS (/v2/speak); the flux model rides on `voice`/`model`
    if (!credentials.deepgram_tts_uri) {
      assert.ok(credentials.api_key, 'synthAudio requires api_key when deepgramflux is used');
    }
  } else if ('xai' === vendor) {
    assert.ok(credentials.api_key, 'synthAudio requires api_key when xai is used');
  } else if ('cartesia' === vendor) {
    assert.ok(credentials.api_key, 'synthAudio requires api_key when cartesia is used');
    assert.ok(credentials.model_id, 'synthAudio requires model_id when cartesia is used');
  } else if ('gradium' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when gradium is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when gradium is used');
  } else if ('speechify' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when speechify is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when speechify is used');
  } else if ('giggy' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when giggy is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when giggy is used');
  } else if ('mistral' === vendor) {
    mistralRefAudio = options?.ref_audio || parseCredOptions(credentials.options).ref_audio;
    /* a one-off cloned voice (ref_audio) replaces the voice */
    assert.ok(voice || mistralRefAudio, 'synthAudio requires voice or ref_audio when mistral is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when mistral is used');
  } else if ('svara' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when svara is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when svara is used');
  } else if ('paxa' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when paxa is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when paxa is used');
  } else if ('gnani' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when gnani is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when gnani is used');
  } else if ('minimax' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when minimax is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when minimax is used');
  } else if ('neuphonic' === vendor) {
    assert.ok(credentials.api_key, 'synthAudio requires api_key when neuphonic is used');
  } else if ('camb' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when camb is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when camb is used');
  } else if ('asyncai' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when asyncai is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when asyncai is used');
  } else if ('respeecher' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when respeecher is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when respeecher is used');
  } else if ('bland' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when bland is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when bland is used');
  } else if ('simplismart' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when simplismart is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when simplismart is used');
  } else if ('spitch' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when spitch is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when spitch is used');
  } else if ('kokoro' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when kokoro is used');
    assert.ok(credentials.api_uri || options?.api_uri, 'synthAudio requires api_uri when kokoro is used');
  } else if ('vakyam' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when vakyam is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when vakyam is used');
  } else if ('groq' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when groq is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when groq is used');
  } else if ('hume' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when hume is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when hume is used');
  } else if ('speechmatics' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when speechmatics is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when speechmatics is used');
  } else if ('soniox' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when soniox is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when soniox is used');
  } else if ('sarvam' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when sarvam is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when sarvam is used');
  } else if ('smallestai' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when smallestai is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when smallestai is used');
  } else if ('azureopenai' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when azureopenai is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when azureopenai is used');
  } else if ('kugelaudio' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when kugelaudio is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when kugelaudio is used');
  } else if ('assemblyai' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when assemblyai is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when assemblyai is used');
  } else if ('nineninesix' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when nineninesix is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when nineninesix is used');
    assert.ok(credentials.model_id, 'synthAudio requires model_id when nineninesix is used');
  } else if ('murf' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when murf is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when murf is used');
  } else if (vendor === 'resemble') {
    assert.ok(voice, 'synthAudio requires voice when resemble is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when resemble is used');
  } else if ('fishaudio' === vendor) {
    /* no voice assert: fish synthesizes with its own default voice when
       reference_id is omitted, which is what the 'default' selection means */
    assert.ok(credentials.api_key, 'synthAudio requires api_key when fishaudio is used');
  }

  const key = makeSynthKey({
    account_sid,
    vendor,
    language: language || '',
    /* a cloned voice is identified by its reference clip */
    voice: mistralRefAudio ?
      `ref_audio:${crypto.createHash('sha1').update(mistralRefAudio).digest('hex')}` :
      voice || deploymentId,
    engine,
    // model or model_id is used to identify the tts cache.
    model: model || credentials.model_id,
    text,
    instructions
  });

  debug(`synth key is ${key}`);
  let cached;
  if (!disableTtsCache) {
    cached = await client.get(key);
  }
  if (cached) {
    // found in cache - extend the expiry and use it
    debug('result WAS found in cache');
    servedFromCache = true;
    stats.increment('tts.cache.requests', ['found:yes']);
    audioData = JSON.parse(cached);
    // convert base64 audio to buffer
    audioData.audioContent = Buffer.from(audioData.audioContent, 'base64');
    client.expire(key, EXPIRES).catch((err) => logger.info(err, 'Error setting expires'));
  } else {
    // not found in cache - go get it from speech vendor and add to cache
    debug('result was NOT found in cache');
    stats.increment('tts.cache.requests', ['found:no']);
    let vendorLabel = vendor;
    const startAt = process.hrtime();
    switch (vendor) {
      case 'google':
        audioData = await synthGoogle(logger, {
          credentials, stats, language, voice, gender, key, text, model, options, instructions,
          renderForCaching, disableTtsStreaming, disableTtsCache
        });
        break;
      case 'aws':
      case 'polly':
        vendorLabel = 'aws';
        audioData = await synthPolly(createHash, retrieveHash, logger,
          {credentials, stats, language, voice, key, text, engine, renderForCaching, disableTtsStreaming,
            disableTtsCache});
        break;
      case 'azure':
      case 'microsoft':
        vendorLabel = 'microsoft';
        audioData = await synthMicrosoft(logger, {credentials, stats, language, voice, key, text, deploymentId,
          renderForCaching, disableTtsStreaming, disableTtsCache});
        break;
      case 'nvidia':
        audioData = await synthNvidia(client, logger, {credentials, stats, language, voice, model, key, text,
          renderForCaching, disableTtsStreaming, disableTtsCache});
        break;
      case 'wellsaid':
        audioData = await synthWellSaid(logger, {credentials, stats, language, voice, key, text});
        break;
      case 'elevenlabs':
        audioData = await synthElevenlabs(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'cartesia':
        audioData = await synthCartesia(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'fishaudio':
        audioData = await synthFishaudio(logger, {
          credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'gradium':
        audioData = await synthGradium(logger, {
          credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'kugelaudio':
        audioData = await synthKugelaudio(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'assemblyai':
        audioData = await synthAssemblyai(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'speechify':
        audioData = await synthSpeechify(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'giggy':
        audioData = await synthGiggy(logger, {
          credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'mistral':
        audioData = await synthMistral(logger, {
          credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'svara':
        audioData = await synthSvara(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'paxa':
        audioData = await synthPaxa(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'gnani':
        audioData = await synthGnani(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'minimax':
        audioData = await synthMinimax(logger, {
          credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'neuphonic':
        audioData = await synthNeuphonic(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'camb':
        audioData = await synthCamb(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'asyncai':
        audioData = await synthAsyncai(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'respeecher':
        audioData = await synthRespeecher(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'bland':
        audioData = await synthBland(logger, {
          credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'simplismart':
        audioData = await synthSimplismart(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'spitch':
        audioData = await synthSpitch(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'kokoro':
        audioData = await synthKokoro(logger, {
          credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'vakyam':
        audioData = await synthVakyam(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'groq':
        audioData = await synthGroq(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'hume':
        audioData = await synthHume(logger, {
          credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'speechmatics':
        audioData = await synthSpeechmatics(logger, {
          credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'soniox':
        audioData = await synthSoniox(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'sarvam':
        audioData = await synthSarvam(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'smallestai':
        audioData = await synthSmallestai(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'azureopenai':
        audioData = await synthAzureopenai(logger, {
          credentials, options, stats, language, voice, key, text, instructions, renderForCaching,
          disableTtsStreaming, disableTtsCache});
        break;
      case 'nineninesix':
        audioData = await synthNineninesix(logger, {
          credentials, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'inworld':
        audioData = await synthInworld(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'rimelabs':
        audioData = await synthRimelabs(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'murf':
        audioData = await synthMurf(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'whisper':
        audioData = await synthWhisper(logger, {
          credentials, stats, voice, key, text, instructions, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'deepgram':
        audioData = await synthDeepgram(logger, {credentials, stats, model, key, text,
          renderForCaching, disableTtsStreaming, disableTtsCache});
        break;
      case 'deepgramflux':
        audioData = await synthDeepgramFlux(logger, {credentials, stats, model: model || voice, key, text,
          renderForCaching, disableTtsStreaming, disableTtsCache});
        break;
      case 'xai':
        audioData = await synthXai(logger, {
          credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
          disableTtsCache});
        break;
      case 'resemble':
        audioData = await synthResemble(logger, {
          credentials, stats, voice, key, text, options, renderForCaching, disableTtsStreaming, disableTtsCache});
        break;
      case vendor.startsWith('custom') ? vendor : 'cant_match_value':
        audioData = await synthCustomVendor(logger,
          {credentials, stats, language, voice, key, text, renderForCaching, disableTtsStreaming, disableTtsCache});
        break;
      default:
        assert(`synthAudio: unsupported speech vendor ${vendor}`);
    }
    if ('filePath' in audioData) return audioData;
    const diff = process.hrtime(startAt);
    const time = diff[0] * 1e3 + diff[1] * 1e-6;
    rtt = time.toFixed(0);
    stats.histogram('tts.response_time', rtt, [`vendor:${vendorLabel}`]);
    debug(`tts rtt time for ${text.length} chars on ${vendorLabel}: ${rtt}`);
    logger.info(`tts rtt time for ${text.length} chars on ${vendorLabel}: ${rtt}`);
    // Save audio json to cache
    client.setex(key, EXPIRES, JSON.stringify({
      ...audioData,
      audioContent: audioData.audioContent?.toString('base64')
    }))
      .catch((err) => logger.error(err, `error calling setex on key ${key}`));
  }

  return new Promise((resolve, reject) => {
    const { audioContent, extension } = audioData;
    const filePath = makeFilePath({
      key,
      salt,
      extension
    });
    fs.writeFile(filePath, audioContent, (err) => {
      if (err) return reject(err);
      resolve({filePath, servedFromCache, rtt});
    });
  });
}

const synthPolly = async(createHash, retrieveHash, logger,
  {credentials, stats, language, voice, engine, key, text, renderForCaching, disableTtsStreaming, disableTtsCache}) => {
  const {region, accessKeyId, secretAccessKey, roleArn} = credentials;
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {

    let params = '{';
    params += `language=${language}`;
    params += `,playback_id=${key}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += ',vendor=aws';
    params += `,voice=${voice}`;
    if (accessKeyId && secretAccessKey) {
      if (accessKeyId) params += `,accessKeyId=${accessKeyId}`;
      if (secretAccessKey) params += `,secretAccessKey=${secretAccessKey}`;
    } else if (roleArn) {
      const cred = await getAwsAuthToken(
        logger, createHash, retrieveHash,
        {
          region,
          roleArn
        });

      if (cred) {
        params += `,accessKeyId=${cred.accessKeyId}`;
        params += `,secretAccessKey=${cred.secretAccessKey}`;
        params += `,sessionToken=${cred.sessionToken}`;
      }
    }
    if (region) params += `,region=${region}`;
    if (engine) params += `,engine=${engine}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }
  try {
    let polly;
    if (accessKeyId && secretAccessKey) {
      polly = new PollyClient({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey
        }
      });
    } else if (roleArn) {
      polly = new PollyClient({
        region,
        credentials: await getAwsAuthToken(
          logger, createHash, retrieveHash,
          {
            region,
            roleArn
          }),
      });
    } else {
      // AWS RoleArn assigned to Instance profile
      polly = new PollyClient({region});
    }
    const opts = {
      Engine: engine,
      OutputFormat: 'mp3',
      Text: text,
      LanguageCode: language,
      TextType: text.startsWith('<speak>') ? 'ssml' : 'text',
      VoiceId: voice
    };
    const command = new SynthesizeSpeechCommand(opts);
    const data = await polly.send(command);
    const chunks = [];
    return new Promise((resolve, reject) => {
      data.AudioStream
        .on('error', (err) => {
          logger.info({err}, 'synthAudio: Error synthesizing speech using aws polly');
          stats.increment('tts.count', ['vendor:aws', 'accepted:no']);
          reject(err);
        })
        .on('data', (chunk) => {
          chunks.push(chunk);
        })
        .on('end', () => resolve(
          {
            audioContent: Buffer.concat(chunks),
            extension: 'mp3',
            sampleRate: 8000
          }
        ));
    });
  } catch (err) {
    logger.info({err}, 'synthAudio: Error synthesizing speech using aws polly');
    stats.increment('tts.count', ['vendor:aws', 'accepted:no']);
    throw err;
  }
};

/* google AudioConfig settings we support, as [google camelCase name, freeswitch param name] */
const GOOGLE_AUDIO_SETTINGS = [
  ['speakingRate', 'speaking_rate'],
  ['pitch', 'pitch'],
  ['volumeGainDb', 'volume_gain_db']
];

/**
 * Extract google AudioConfig settings from the synthesizer options.  They may be supplied
 * nested under an audioConfig property (mirroring google's AudioConfig object) or flat at
 * the top level, and either google's camelCase or snake_case names are accepted.
 * @see https://cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize#AudioConfig
 * @returns object keyed by google's camelCase names, holding only valid numeric settings
 */
const googleAudioConfig = (options) => {
  const provided = {...options, ...(options?.audioConfig || {})};
  const audioConfig = {};
  for (const [name, snakeName] of GOOGLE_AUDIO_SETTINGS) {
    const value = provided[name] ?? provided[snakeName];
    /* note: 0 is meaningful for pitch and volumeGainDb, so check for absence explicitly */
    if (value === undefined || value === null || value === '') continue;
    const num = Number(value);
    if (Number.isFinite(num)) audioConfig[name] = num;
  }
  return audioConfig;
};

const synthGoogle = async(logger, {
  credentials, stats, language, voice, gender, key, text, model, options, instructions,
  renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const isGemini = !!model;
  const isVoiceCloning = typeof voice === 'object' && voice.voice_cloning_key;
  // HD voices have pattern like en-US-Chirp3-HD-Charon
  const isHDVoice = typeof voice === 'string' && voice.includes('-HD-');

  // Streaming support for Google TTS (Gemini, HD voices, and standard voices)
  // Voice cloning does not support streaming
  if (!isVoiceCloning && !JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    // Strip SSML tags for Gemini TTS (it doesn't support SSML)
    let inputText = text;
    if (isGemini && text.startsWith('<speak>')) {
      inputText = text.replace(/<[^>]*>/g, '').trim();
      logger.info('synthGoogle: Gemini TTS does not support SSML, stripped tags from input');
    }

    let params = '{';
    params += `credentials=${Buffer.from(JSON.stringify(credentials.credentials)).toString('base64')}`;
    params += `,playback_id=${key}`;
    params += ',vendor=google';
    params += `,voice=${voice}`;
    params += `,language_code=${language || 'en-US'}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    // api_mode: tts (standard), live (HD voices), gemini (Gemini TTS)
    const apiMode = options?.apiMode || (isGemini ? 'gemini' : (isHDVoice ? 'live' : 'tts'));
    params += `,api_mode=${apiMode}`;
    if (model) params += `,model_name=${model}`;
    if (gender) params += `,gender=${gender}`;
    // comma is used to separate parameters in freeswitch tts module
    const prompt = options?.prompt || instructions;
    if (prompt) params += `,prompt=${prompt.replace(/\n/g, ' ').replace(/,/g, ';')}`;
    /**
     * AudioConfig settings.  Note google only honors these in some api modes:
     * tts applies all of them, live (HD voices) applies speakingRate only,
     * and gemini ignores them entirely (use prompt instead for style control).
     */
    const audioSettings = googleAudioConfig(options);
    for (const [name, snakeName] of GOOGLE_AUDIO_SETTINGS) {
      if (name in audioSettings) params += `,${snakeName}=${audioSettings[name]}`;
    }
    params += '}';

    return {
      filePath: `say:${params}${(isGemini ? inputText : text).replace(/\n/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  const client = new ttsGoogle.TextToSpeechClient(credentials);

  // Build input based on voice type
  let input;
  if (isGemini) {
    // Gemini TTS does not support SSML - strip tags if present
    let inputText = text;
    if (text.startsWith('<speak>')) {
      inputText = text.replace(/<[^>]*>/g, '').trim();
      logger.info('synthGoogle: Gemini TTS does not support SSML, stripped tags from input');
    }
    // Use instructions as prompt for Gemini TTS style control, options.prompt can override
    const prompt = options?.prompt || instructions;
    input = {
      text: inputText,
      ...(prompt && { prompt })
    };
  } else {
    input = text.startsWith('<speak>') ? { ssml: text } : { text };
  }

  // Build voice selection params based on voice type
  let voiceParams;
  if (isGemini) {
    voiceParams = {
      languageCode: language || 'en-US',
      name: voice,
      modelName: model
    };
  } else if (isVoiceCloning) {
    voiceParams = {
      languageCode: language,
      voiceClone: {
        voiceCloningKey: voice.voice_cloning_key
      }
    };
  } else {
    voiceParams = {
      ...(typeof voice === 'string' && { name: voice }),
      ...(typeof voice === 'object' && { customVoice: voice }),
      languageCode: language,
      ssmlGender: gender || 'SSML_VOICE_GENDER_UNSPECIFIED'
    };
  }

  // Build audio config based on voice type
  let audioConfig;
  let extension;
  let sampleRate;
  if (isVoiceCloning) {
    audioConfig = { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 };
    extension = 'wav';
    sampleRate = 24000;
  } else {
    audioConfig = { audioEncoding: 'MP3' };
    extension = 'mp3';
    sampleRate = 8000;
  }

  /* gemini voices do not support the AudioConfig settings; they use prompt for style control */
  if (!isGemini) Object.assign(audioConfig, googleAudioConfig(options));

  const opts = { input, voice: voiceParams, audioConfig };

  try {
    logger.debug({ opts }, 'synthGoogle: request');
    const [response] = await client.synthesizeSpeech(opts);
    stats.increment('tts.count', ['vendor:google', 'accepted:yes']);
    client.close();
    return {
      audioContent: response.audioContent,
      extension,
      sampleRate
    };
  } catch (err) {
    logger.info({ err, opts }, 'synthAudio: Error synthesizing speech using google');
    stats.increment('tts.count', ['vendor:google', 'accepted:no']);
    client && client.close();
    throw err;
  }
};

async function _synthOnPremMicrosoft(logger, {
  credentials,
  language,
  voice,
  text
}) {
  const {use_custom_tts, custom_tts_endpoint_url, api_key} = credentials;
  let content = text;
  if (use_custom_tts && !content.startsWith('<speak')) {
    /**
     * Note: it seems that to use custom voice ssml is required with the voice attribute
     * Otherwise sending plain text we get "Voice does not match"
     */
    content = `<speak>${text}</speak>`;
  }

  if (content.startsWith('<speak>')) {
    /* microsoft enforces some properties and uses voice xml element so if the user did not supply do it for them */
    const words = content.slice(7, -8).trim().replace(/(\r\n|\n|\r)/gm, ' ');
    // eslint-disable-next-line max-len
    content = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${language}"><voice name="${voice}">${words}</voice></speak>`;
    logger.info({content}, 'synthMicrosoft');
  }
  else if (JAMBONES_AZURE_ENABLE_SSML && !content.startsWith('<speak')) {
    // eslint-disable-next-line max-len
    content = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${language}"><voice name="${voice}"><lang xml:lang="${language}">${text}</lang></voice></speak>`;
  }

  try {
    const trimSilence = JAMBONES_TTS_TRIM_SILENCE;
    const post = bent('POST', 'buffer', {
      'X-Microsoft-OutputFormat': trimSilence ? 'raw-8khz-16bit-mono-pcm' : 'audio-16khz-32kbitrate-mono-mp3',
      'Content-Type': 'application/ssml+xml',
      'User-Agent': 'Jambonz',
      ...(api_key && {'Ocp-Apim-Subscription-Key': api_key})
    });
    const audioContent = await post(custom_tts_endpoint_url, content);
    return {
      audioContent,
      extension: trimSilence ? 'r8' : 'mp3',
      sampleRate: 8000
    };
  } catch (err) {
    logger.info({err}, '_synthMicrosoftByHttp returned error');
    throw err;
  }
}

const synthMicrosoft = async(logger, {
  credentials,
  stats,
  language,
  voice,
  key,
  text,
  renderForCaching,
  disableTtsStreaming,
  disableTtsCache
}) => {
  try {
    const {api_key: apiKey, region, use_custom_tts, custom_tts_endpoint, custom_tts_endpoint_url} = credentials;
    // let clean up the text
    let content = text;
    if (use_custom_tts && !content.startsWith('<speak')) {
      /**
     * Note: it seems that to use custom voice ssml is required with the voice attribute
     * Otherwise sending plain text we get "Voice does not match"
     */
      content = `<speak>${text}</speak>`;
    }

    if (content.startsWith('<speak>')) {
    /* microsoft enforces some properties and uses voice xml element so if the user did not supply do it for them */
      const words = content.slice(7, -8).trim().replace(/(\r\n|\n|\r)/gm, ' ');
      // eslint-disable-next-line max-len
      content = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${language}"><voice name="${voice}">${words}</voice></speak>`;
      logger.info({content}, 'synthMicrosoft');
    }
    else if (JAMBONES_AZURE_ENABLE_SSML && !content.startsWith('<speak')) {
      // eslint-disable-next-line max-len
      content = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${language}"><voice name="${voice}"><lang xml:lang="${language}">${text}</lang></voice></speak>`;
    }
    if (!JAMBONES_DISABLE_TTS_STREAMING && !JAMBONES_DISABLE_AZURE_TTS_STREAMING &&
      !renderForCaching && !disableTtsStreaming) {
      let params = '{';
      params += `api_key=${apiKey}`;
      params += `,playback_id=${key}`;
      params += `,language=${language}`;
      params += ',vendor=microsoft';
      params += `,voice=${voice}`;
      params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
      if (region) params += `,region=${region}`;
      if (custom_tts_endpoint) params += `,endpointId=${custom_tts_endpoint}`;
      if (custom_tts_endpoint_url) params += `,endpoint=${custom_tts_endpoint_url}`;
      if (JAMBONES_HTTP_PROXY_IP) params += `,http_proxy_ip=${JAMBONES_HTTP_PROXY_IP}`;
      if (JAMBONES_HTTP_PROXY_PORT) params += `,http_proxy_port=${JAMBONES_HTTP_PROXY_PORT}`;
      params += '}';
      return {
        filePath: `say:${params}${content.replace(/\n/g, ' ')}`,
        servedFromCache: false,
        rtt: 0
      };
    }
    // Azure Onprem
    if (use_custom_tts && custom_tts_endpoint_url) {
      return await _synthOnPremMicrosoft(logger, {
        credentials,
        stats,
        language,
        voice,
        text
      });
    }
    // Azure hosted service
    const trimSilence = JAMBONES_TTS_TRIM_SILENCE;
    const speechConfig = SpeechConfig.fromSubscription(apiKey, region);
    speechConfig.speechSynthesisLanguage = language;
    speechConfig.speechSynthesisVoiceName = voice;
    if (use_custom_tts && custom_tts_endpoint) {
      speechConfig.endpointId = custom_tts_endpoint;
    }
    speechConfig.speechSynthesisOutputFormat = trimSilence ?
      SpeechSynthesisOutputFormat.Raw8Khz16BitMonoPcm :
      SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

    if (JAMBONES_HTTP_PROXY_IP && JAMBONES_HTTP_PROXY_PORT) {
      logger.debug(
        `synthMicrosoft: using proxy ${JAMBONES_HTTP_PROXY_IP}:${JAMBONES_HTTP_PROXY_PORT}`);
      speechConfig.setProxy(JAMBONES_HTTP_PROXY_IP, JAMBONES_HTTP_PROXY_PORT);
    }

    // Set speech synthesis timeout properties from environment variables
    logger.debug(`synthMicrosoft: setting frame timeout interval to ` +
      `${JAMBONES_AZURE_SPEECH_SYNTHESIS_FRAME_TIMEOUT_INTERVAL}ms`);
    speechConfig.setProperty(PropertyId.SpeechSynthesis_FrameTimeoutInterval,
      String(JAMBONES_AZURE_SPEECH_SYNTHESIS_FRAME_TIMEOUT_INTERVAL));

    logger.debug(`synthMicrosoft: setting RTF timeout threshold to ` +
      `${JAMBONES_AZURE_SPEECH_SYNTHESIS_RTF_TIMEOUT_THRESHOLD}`);
    speechConfig.setProperty(PropertyId.SpeechSynthesis_RtfTimeoutThreshold,
      String(JAMBONES_AZURE_SPEECH_SYNTHESIS_RTF_TIMEOUT_THRESHOLD));

    const synthesizer = new SpeechSynthesizer(speechConfig);

    return new Promise((resolve, reject) => {
      const speakAsync = content.startsWith('<speak') ?
        synthesizer.speakSsmlAsync.bind(synthesizer) :
        synthesizer.speakTextAsync.bind(synthesizer);
      speakAsync(
        content,
        async(result) => {
          switch (result.reason) {
            case ResultReason.Canceled:
              const cancellation = CancellationDetails.fromResult(result);
              logger.info({reason: cancellation.errorDetails}, 'synthAudio: (Microsoft) synthesis canceled');
              synthesizer.close();
              reject(cancellation.errorDetails);
              break;
            case ResultReason.SynthesizingAudioCompleted:
              let buffer = Buffer.from(result.audioData);
              if (trimSilence) buffer = trimTrailingSilence(buffer);
              resolve({
                audioContent: buffer,
                extension: trimSilence ? 'r8' : 'mp3',
                sampleRate: 8000
              });
              synthesizer.close();
              stats.increment('tts.count', ['vendor:microsoft', 'accepted:yes']);
              break;
            default:
              logger.info({result}, 'synthAudio: (Microsoft) unexpected result');
              break;
          }
        },
        (err) => {
          logger.info({err}, 'synthAudio: (Microsoft) error synthesizing');
          stats.increment('tts.count', ['vendor:microsoft', 'accepted:no']);
          synthesizer.close();
          reject(err);
        });
    });
  } catch (err) {
    logger.info({err}, 'synthAudio: Error synthesizing speech using Microsoft');
    stats.increment('tts.count', ['vendor:google', 'accepted:no']);
  }
};

const synthWellSaid = async(logger, {credentials, stats, language, voice, gender, text}) => {
  const {api_key} = credentials;
  try {
    const post = bent('https://api.wellsaidlabs.com', 'POST', 'buffer', {
      'X-Api-Key': api_key,
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/v1/tts/stream', {
      text,
      speaker_id: voice
    });
    return {
      audioContent,
      extension: 'mp3',
      sampleRate: 8000
    };
  } catch (err) {
    logger.info({err}, 'testWellSaidTts returned error');
    throw err;
  }
};

const synthNvidia = async(client, logger, {
  credentials, stats, language,  voice, model, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {riva_server_uri} = credentials;
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '';
    params += `{riva_server_uri=${riva_server_uri}`;
    params += `,playback_id=${key}`;
    params += `,voice=${voice}`;
    params += `,language=${language}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }
  let rivaClient, request;
  const sampleRate = 8000;
  try {
    rivaClient = await createRivaClient(riva_server_uri);
    request = new SynthesizeSpeechRequest();
    request.setVoiceName(voice);
    request.setLanguageCode(language);
    request.setSampleRateHz(sampleRate);
    request.setEncoding(AudioEncoding.LINEAR_PCM);
    request.setText(text);
  } catch (err) {
    logger.info({err}, 'error creating riva client');
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    rivaClient.synthesize(request, (err, response) => {
      if (err) {
        logger.info({err, voice, language}, 'error synthesizing speech using Nvidia');
        return reject(err);
      }
      resolve({
        audioContent: Buffer.from(response.getAudio()),
        extension: 'r8',
        sampleRate
      });
    });
  });
};


const synthCustomVendor = async(logger, {credentials, stats, language, voice,
  text, filePath, renderForCaching, disableTtsStreaming, key, disableTtsCache}) => {
  const {vendor, auth_token, custom_tts_url} = credentials;

  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `auth_token=${auth_token}`;
    params += `,playback_id=${key}`;
    params += `,custom_tts_url=${custom_tts_url}`;
    params += ',vendor=custom';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const post = bent('POST', {
      'Authorization': `Bearer ${auth_token}`,
      'Content-Type': 'application/json'
    });

    const response = await post(custom_tts_url, {
      language,
      voice,
      type: text.startsWith('<speak>') ? 'ssml' : 'text',
      text
    });

    const mime = response.headers['content-type'];
    const buffer = await response.arrayBuffer();
    const [extension, sampleRate] = getFileExtFromMime(mime);
    return {
      audioContent: buffer,
      extension,
      sampleRate
    };
  } catch (err) {
    logger.info({err}, `Vendor ${vendor} returned error`);
    throw err;
  }
};

const synthElevenlabs = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {api_key, model_id, api_uri, options: credOpts} = credentials;
  const opts = !!options && Object.keys(options).length !== 0 ? options : JSON.parse(credOpts || '{}');

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=elevenlabs';
    params += `,voice=${voice}`;
    params += `,model_id=${model_id}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (opts.optimize_streaming_latency !== null && opts.optimize_streaming_latency !== undefined) {
      params += `,optimize_streaming_latency=${opts.optimize_streaming_latency}`;
    }
    if (opts.voice_settings?.similarity_boost) params += `,similarity_boost=${opts.voice_settings.similarity_boost}`;
    if (opts.voice_settings?.stability) params += `,stability=${opts.voice_settings.stability}`;
    if (opts.voice_settings?.style) params += `,style=${opts.voice_settings.style}`;
    if (opts.voice_settings?.speed !== null && opts.voice_settings?.speed !== undefined)
      params += `,speed=${opts.voice_settings.speed}`;
    if (opts.voice_settings?.use_speaker_boost === false) params += ',use_speaker_boost=false';
    if (opts.previous_text) params += `,previous_text=${opts.previous_text}`;
    if (opts.next_text) params += `,next_text=${opts.next_text}`;
    if (opts.pronunciation_dictionary_locators && Array.isArray(opts.pronunciation_dictionary_locators))
      params += `,pronunciation_dictionary_locators=${JSON.stringify(opts.pronunciation_dictionary_locators)}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  const optimize_streaming_latency = opts.optimize_streaming_latency ?
    `?optimize_streaming_latency=${opts.optimize_streaming_latency}` : '';
  try {
    const post = bent(`https://${api_uri || 'api.elevenlabs.io'}`, 'POST', 'buffer', {
      'xi-api-key': api_key,
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json'
    });
    const audioContent = await post(`/v1/text-to-speech/${voice}${optimize_streaming_latency}`, {
      text,
      model_id,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.5
      },
      ...opts
    });
    return {
      audioContent,
      extension: 'mp3',
      sampleRate: 8000
    };
  } catch (err) {
    logger.info({err}, 'synth Elevenlabs returned error');
    stats.increment('tts.count', ['vendor:elevenlabs', 'accepted:no']);
    throw err;
  }
};

const synthInworld = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {api_key, model_id, options: credOpts} = credentials;
  const opts = !!options && Object.keys(options).length !== 0 ? options : JSON.parse(credOpts || '{}');

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += `,model_id=${model_id}`;
    params += ',vendor=inworld';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (opts.temperature) params += `,temperature=${opts.temperature}`;
    /* pitch and speakingRate are nested under audioConfig, matching Inworld's API */
    if (opts.audioConfig?.pitch) params += `,pitch=${opts.audioConfig.pitch}`;
    if (opts.audioConfig?.speakingRate) params += `,speakingRate=${opts.audioConfig.speakingRate}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const url = 'https://api.inworld.ai/tts/v1/voice';
    const sampleRate = 8000;
    const options = {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        voiceId: voice,
        modelId: model_id,
        audioConfig: {
          ...(opts.audioConfig || {}),
          audioEncoding: 'MP3',
        }
      })
    };

    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(await response.text());
    }
    const json = await response.json();
    return {
      audioContent: Buffer.from(json.audioContent, 'base64'),
      extension: 'mp3',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth inworld returned error');
    stats.increment('tts.count', ['vendor:inworld', 'accepted:no']);
    throw err;
  }
};

const synthRimelabs = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {api_key, model_id, options: credOpts} = credentials;
  const opts = !!options && Object.keys(options).length !== 0 ? options : JSON.parse(credOpts || '{}');

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += `,model_id=${model_id}`;
    params += ',vendor=rimelabs';
    params += `,language=${language}`;
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (opts.speedAlpha) params += `,speed_alpha=${opts.speedAlpha}`;
    if (opts.reduceLatency) params += `,reduce_latency=${opts.reduceLatency}`;
    // Arcana model parameters
    if (opts.temperature) params += `,temperature=${opts.temperature}`;
    if (opts.repetition_penalty) params += `,repetition_penalty=${opts.repetition_penalty}`;
    if (opts.top_p) params += `,top_p=${opts.top_p}`;
    if (opts.max_tokens) params += `,max_tokens=${opts.max_tokens}`;
    // Coda model parameters
    if (opts.timeScaleFactor) params += `,time_scale_factor=${opts.timeScaleFactor}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const post = bent('https://users.rime.ai', 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Accept': 'audio/mp3',
      'Content-Type': 'application/json'
    });
    const sampleRate = 8000;
    const audioContent = await post('/v1/rime-tts', {
      speaker: voice,
      text,
      modelId: model_id,
      samplingRate: sampleRate,
      lang: language,
      ...opts
    });
    return {
      audioContent,
      extension: 'mp3',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth rimelabs returned error');
    stats.increment('tts.count', ['vendor:rimelabs', 'accepted:no']);
    throw err;
  }
};

const synthMurf = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {api_key, model_id, api_uri, options: credOpts} = credentials;
  const opts = !!options && Object.keys(options).length !== 0 ? options : JSON.parse(credOpts || '{}');

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    /* param keys here must match mod_murf_tts's text_param handler */
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=murf';
    params += `,voice=${voice}`;
    if (model_id) params += `,model_id=${model_id}`;
    if (language) params += `,language=${language}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (opts.style) params += `,style=${opts.style}`;
    if (opts.rate !== undefined && opts.rate !== null) params += `,rate=${opts.rate}`;
    if (opts.pitch !== undefined && opts.pitch !== null) params += `,pitch=${opts.pitch}`;
    if (opts.variation !== undefined && opts.variation !== null) params += `,variation=${opts.variation}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    /* no Accept header: murf returns 406 if it doesn't match; the response
       container is selected by the `format` field in the body instead */
    const post = bent(api_uri || 'https://global.api.murf.ai', 'POST', 'buffer', {
      'api-key': api_key,
      'Content-Type': 'application/json'
    });
    /* murf REST schema is documented loosely; field names follow the SDK params
       (voice_id/model/format/sample_rate) plus the websocket voice fields. */
    const audioContent = await post('/v1/speech/stream', {
      text,
      voice_id: voice,
      ...(model_id && {model: model_id}),
      ...(language && {locale: language}),
      ...(opts.style && {style: opts.style}),
      ...(opts.rate !== undefined && opts.rate !== null && {rate: opts.rate}),
      ...(opts.pitch !== undefined && opts.pitch !== null && {pitch: opts.pitch}),
      ...(opts.variation !== undefined && opts.variation !== null && {variation: opts.variation}),
      format: 'WAV',
      sample_rate: sampleRate,
      channel_type: 'MONO'
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth murf returned error');
    stats.increment('tts.count', ['vendor:murf', 'accepted:no']);
    throw err;
  }
};
const synthWhisper = async(logger, {credentials, stats, voice, key, text, instructions,
  renderForCaching, disableTtsStreaming, disableTtsCache}) => {
  const {api_key, model_id, baseURL, timeout, speed} = credentials;
  /* if the env is set to stream then bag out, unless we are specifically rendering to generate a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += `,model_id=${model_id}`;
    params += ',vendor=whisper';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (speed) params += `,speed=${speed}`;
    // comma is used to separated parameters in freeswitch tts module
    if (instructions) params += `,instructions=${instructions.replace(/\n/g, ' ').replace(/,/g, ';')}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }
  try {
    const openai = new OpenAI.OpenAI({
      apiKey: api_key,
      timeout: timeout || 5000,
      ...(baseURL && {baseURL})
    });

    const mp3 = await openai.audio.speech.create({
      model: model_id,
      voice,
      input: text,
      ...(instructions && {instructions}),
      response_format: 'mp3'
    });
    return {
      audioContent: Buffer.from(await mp3.arrayBuffer()),
      extension: 'mp3',
      sampleRate: 8000
    };
  } catch (err) {
    logger.info({err}, 'synth whisper returned error');
    stats.increment('tts.count', ['vendor:openai', 'accepted:no']);
    throw err;
  }
};

const synthDeepgram = async(logger, {credentials, stats, model, key, text, renderForCaching,
  disableTtsStreaming, disableTtsCache}) => {
  const {api_key, deepgram_tts_uri} = credentials;
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=deepgram';
    params += `,voice=${model}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (deepgram_tts_uri) params += `,endpoint=${deepgram_tts_uri}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }
  try {
    const post = bent(deepgram_tts_uri || 'https://api.deepgram.com', 'POST', 'buffer', {
      // on-premise deepgram does not  require to have api_key
      ...(api_key && {'Authorization': `Token ${api_key}`}),
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json'
    });
    const audioContent = await post(`/v1/speak?model=${model}`, {
      text
    });
    return {
      audioContent,
      extension: 'mp3',
      sampleRate: 8000
    };
  } catch (err) {
    logger.info({err}, 'synth Deepgram returned error');
    stats.increment('tts.count', ['vendor:deepgram', 'accepted:no']);
    throw err;
  }
};

// Deepgram Flux TTS — the conversation-native model served from /v2/speak.
// Streaming rides the mediajam deepgramflux dialect via a say: filePath; the
// batch/cache path POSTs to /v2/speak (mp3 is batch-only for Flux).
const synthDeepgramFlux = async(logger, {credentials, stats, model, key, text, renderForCaching,
  disableTtsStreaming, disableTtsCache}) => {
  const {api_key, deepgram_tts_uri} = credentials;
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=deepgramflux';
    params += `,voice=${model}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (deepgram_tts_uri) params += `,endpoint=${deepgram_tts_uri}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }
  try {
    const post = bent(deepgram_tts_uri || 'https://api.deepgram.com', 'POST', 'buffer', {
      // on-premise deepgram does not require to have api_key
      ...(api_key && {'Authorization': `Token ${api_key}`}),
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json'
    });
    const audioContent = await post(`/v2/speak?model=${model}`, {
      text
    });
    return {
      audioContent,
      extension: 'mp3',
      sampleRate: 8000
    };
  } catch (err) {
    logger.info({err}, 'synth Deepgram Flux returned error');
    stats.increment('tts.count', ['vendor:deepgramflux', 'accepted:no']);
    throw err;
  }
};

const synthXai = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {api_key, api_uri, options: credOpts} = credentials;
  const opts = !!options && Object.keys(options).length !== 0 ? options : JSON.parse(credOpts || '{}');
  const speed = opts.speed;
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=xai';
    if (voice) params += `,voice=${voice}`;
    if (language) params += `,language=${language}`;
    if (speed !== null && speed !== undefined) params += `,speed=${speed}`;
    if (opts.optimize_streaming_latency != null) {
      params += `,optimize_streaming_latency=${opts.optimize_streaming_latency}`;
    }
    if (opts.text_normalization != null) params += `,text_normalization=${opts.text_normalization}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }
  try {
    const post = bent(`https://${api_uri || 'api.x.ai'}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/v1/tts', {
      text,
      language: language || 'auto',
      ...(voice && {voice_id: voice}),
      ...(speed !== null && speed !== undefined && {speed}),
      ...(opts.optimize_streaming_latency != null && {optimize_streaming_latency: opts.optimize_streaming_latency}),
      ...(opts.text_normalization != null && {text_normalization: opts.text_normalization}),
      output_format: {
        codec: 'wav',
        sample_rate: 8000
      }
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate: 8000
    };
  } catch (err) {
    // xAI errors are JSON {code, error} - read the body so the surfaced message isn't 'undefined'
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth xai: failed to read error response body');
      }
    }
    logger.info({err}, 'synth xai returned error');
    stats.increment('tts.count', ['vendor:xai', 'accepted:no']);
    throw err;
  }
};

const synthCartesia = async(logger, {
  credentials, options, stats, voice, language, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {api_key, model_id, embedding, options: credOpts} = credentials;
  const opts = !!options && Object.keys(options).length !== 0 ? options : JSON.parse(credOpts || '{}');

  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += `,model_id=${model_id}`;
    params += ',vendor=cartesia';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,language=${language}`;
    params += `,voice_mode=${embedding ? 'embedding' : 'id'}`;
    if (embedding) params += `,embedding=${embedding}`;
    if (opts.speed) params += `,speed=${opts.speed}`;
    if (opts.emotion) params += `,emotion=${opts.emotion}`;
    if (opts.volume) params += `,volume=${opts.volume}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const client = new CartesiaClient({ apiKey: api_key });
    const sampleRate = 48000;

    // omit a control unless explicitly provided (0 is a valid value, so test for nullish only)
    const has = (v) => v !== null && v !== undefined;
    /* Voice controls (speed, emotion, volume) go in `generationConfig`, which only the
       sonic-3 family (sonic-3, sonic-3.5, sonic-3.6, pinned sonic-3.x snapshots) accepts;
       other models get no controls. mediajam uses the same "starts with sonic-3" check
       (internal/tts/cartesia.go), so cached and streamed synthesis behave identically. */
    const isSonic3 = model_id?.startsWith('sonic-3');
    const mp3Stream = await client.tts.bytes({
      modelId: model_id,
      transcript: text,
      voice: {
        mode: embedding ? 'embedding' : 'id',
        ...(embedding ?
          {
            embedding: embedding.split(',').map(Number)
          } :
          {
            id: voice
          }
        ),
      },
      ...(isSonic3 && (has(opts.speed) || has(opts.emotion) || has(opts.volume)) && {
        generationConfig: {
          ...(has(opts.volume) && {volume: opts.volume}),
          ...(has(opts.speed) && {speed: opts.speed}),
          ...(has(opts.emotion) && {emotion: opts.emotion}),
        }
      }),
      language: language,
      outputFormat: {
        container: 'mp3',
        bitRate: 128000,
        sampleRate
      },
    });

    // bytes() returns a ReadableStream - collect all chunks
    const chunks = [];
    for await (const chunk of mp3Stream) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    return {
      audioContent: audioBuffer,
      extension: 'mp3',
      sampleRate
    };
  } catch (err) {
    /* Cartesia's tts.bytes() uses a streaming response, so on an HTTP error the SDK
       throws a CartesiaError whose `body` is an unconsumed stream-wrapper object
       (async-iterable, yielding Uint8Array chunks) rather than the parsed error
       JSON. Read it so callers get a meaningful message instead of a serialized
       stream object. */
    if (err && err.body && typeof err.body !== 'string' && typeof err.body[Symbol.asyncIterator] === 'function') {
      try {
        const chunks = [];
        for await (const chunk of err.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        if (text) {
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          err.message = (parsed && (parsed.error || parsed.message)) || text;
          err.body = parsed || text;
        }
      } catch (readErr) {
        logger.info({readErr}, 'synth Cartesia: failed to read error response body');
      }
    }
    logger.info({err}, 'synth Cartesia returned error');
    stats.increment('tts.count', ['vendor:cartesia', 'accepted:no']);
    throw err;
  }

};

/* gradium.ai — json websocket for streaming, and a POST endpoint for the cache
   render. only_audio:true + pcm_8000 returns bare little-endian 16-bit samples,
   which is exactly the r8 container, so we avoid gradium's streaming wav header
   (it carries 0xffffffff as the RIFF size, since length is unknown up front).
*/
const synthGradium = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {json_config, pronunciation_id} = options || {};

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=gradium';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (model_id) params += `,model_id=${model_id}`;
    if (pronunciation_id) params += `,pronunciation_id=${pronunciation_id}`;
    /* the say: param parser is brace-aware, so a nested json object survives intact */
    if (json_config) {
      params += `,json_config=${typeof json_config === 'string' ? json_config : JSON.stringify(json_config)}`;
    }
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    const post = bent('https://api.gradium.ai', 'POST', 'buffer', {
      'x-api-key': api_key,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/api/post/speech/tts', {
      text,
      voice_id: voice,
      model_name: model_id || 'default',
      output_format: `pcm_${sampleRate}`,
      only_audio: true,
      ...(json_config && {json_config}),
      ...(pronunciation_id && {pronunciation_id})
    });
    return {
      audioContent,
      extension: 'r8',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth gradium returned error');
    stats.increment('tts.count', ['vendor:gradium', 'accepted:no']);
    throw err;
  }
};

/* kugelaudio — json websocket (/ws/tts/stream) for streaming, and POST /v1/tts/generate
   for the cache render. the POST streams back bare little-endian 16-bit samples at the
   requested sample_rate, which is exactly the r8 container at 8000.

   voices are numeric ids (or public handles). language is an ISO 639-1 code that drives
   text normalization; jambonz carries BCP-47, so only the primary subtag is sent. the
   api rejects codes outside its list, so an unsupported or unset language is omitted
   and the voice's own language applies. options.api_uri pins a region
   (e.g. api.eu.kugelaudio.com).
*/
const KUGELAUDIO_LANGUAGES = ['ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi',
  'hr', 'hu', 'id', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'ta', 'th',
  'tr', 'uk', 'ur', 'vi', 'yue', 'zh'];
const synthKugelaudio = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {api_uri, speed, cfg_scale, temperature, normalize, project_id, dictionary_ids} = options || {};
  const isSet = (v) => v !== null && v !== undefined;

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=kugelaudio';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model_id || 'kugel-3'}`;
    if (language) params += `,language=${language}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (isSet(cfg_scale)) params += `,cfg_scale=${cfg_scale}`;
    if (isSet(temperature)) params += `,temperature=${temperature}`;
    if (isSet(normalize)) params += `,normalize=${normalize}`;
    if (isSet(project_id)) params += `,project_id=${project_id}`;
    /* the say: param parser is bracket-aware, so the json array survives intact */
    if (Array.isArray(dictionary_ids)) params += `,dictionary_ids=${JSON.stringify(dictionary_ids)}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    const host = (api_uri || 'api.kugelaudio.com').replace(/^[a-z]+:\/\//, '').replace(/\/$/, '');
    const post = bent(`https://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json; charset=utf-8'
    });
    const voiceId = /^\d+$/.test(`${voice}`) ? Number(voice) : voice;
    const lang = language && language.split('-')[0].toLowerCase();
    const audioContent = await post('/v1/tts/generate', {
      text,
      voice_id: voiceId,
      model_id: model_id || 'kugel-3',
      sample_rate: sampleRate,
      ...(KUGELAUDIO_LANGUAGES.includes(lang) && {language: lang}),
      ...(isSet(speed) && {speed: Number(speed)}),
      ...(isSet(cfg_scale) && {cfg_scale: Number(cfg_scale)}),
      ...(isSet(temperature) && {temperature: Number(temperature)}),
      ...(isSet(normalize) && {normalize: normalize === true || normalize === 'true'}),
      ...(isSet(project_id) && {project_id: Number(project_id)}),
      ...(Array.isArray(dictionary_ids) && {dictionary_ids})
    });
    return {
      audioContent,
      extension: 'r8',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth kugelaudio returned error');
    stats.increment('tts.count', ['vendor:kugelaudio', 'accepted:no']);
    throw err;
  }
};

/* assemblyai: websocket /v1/ws for streaming, POST /v1/speech (mp3) for the cache render.
   language is the service's own name (english, ...), sent as given */
const synthAssemblyai = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id, api_uri, options: credOpts} = credentials;
  const opts = !!options && Object.keys(options).length !== 0 ? options : JSON.parse(credOpts || '{}');
  const {speed, extend_biometric_consent} = opts;
  const isSet = (v) => v !== null && v !== undefined;

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=assemblyai';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model_id || 'assemblyai-tts-1'}`;
    if (language) params += `,language=${language}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (isSet(extend_biometric_consent)) params += `,extend_biometric_consent=${extend_biometric_consent}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const host = (api_uri || 'tts.us.assemblyai.com').replace(/^[a-z]+:\/\//, '').replace(/\/$/, '');
    const post = bent(`https://${host}`, 'POST', 'buffer', {
      'Authorization': api_key,
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json; charset=utf-8'
    });
    const audioContent = await post('/v1/speech', {
      text,
      voice_id: voice,
      model_id: model_id || 'assemblyai-tts-1',
      sample_rate: 8000,
      encoding: 'mp3',
      ...(language && {language}),
      ...(isSet(speed) && {speed: Number(speed)}),
      ...(isSet(extend_biometric_consent) &&
        {extend_biometric_consent: extend_biometric_consent === true || extend_biometric_consent === 'true'})
    });
    return {
      audioContent,
      extension: 'mp3',
      sampleRate: 8000
    };
  } catch (err) {
    logger.info({err}, 'synth assemblyai returned error');
    stats.increment('tts.count', ['vendor:assemblyai', 'accepted:no']);
    throw err;
  }
};

/* simba-3.2 is English only; with no model set, other languages get simba-3.0 */
const speechifyModel = (model_id, language) => {
  if (model_id) return model_id;
  return !language || /^en/i.test(language) ? 'simba-3.2' : 'simba-3.0';
};
const synthSpeechify = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  let credOptions = credentials.options || {};
  if (typeof credOptions === 'string') {
    try {
      credOptions = JSON.parse(credOptions);
    } catch {
      credOptions = {};
    }
  }
  const {api_uri, loudness_normalization, text_normalization} = {...credOptions, ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const model = speechifyModel(options?.model_id || model_id, language);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=speechify';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (language) params += `,language=${language}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (isSet(loudness_normalization)) params += `,loudness_normalization=${loudness_normalization}`;
    if (isSet(text_normalization)) params += `,text_normalization=${text_normalization}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    /* other pcm rates are mislabelled 24 kHz on workspaces pinned before 2026-09-30 */
    const sampleRate = 24000;
    const host = (api_uri || 'api.speechify.ai').replace(/^[a-z]+:\/\//, '').replace(/\/$/, '');
    const post = bent(`https://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json',
      'Speechify-Caller': 'jambonz'
    });
    const toBool = (v) => v === true || v === 'true';
    const speechOptions = {
      ...(isSet(loudness_normalization) && {loudness_normalization: toBool(loudness_normalization)}),
      ...(isSet(text_normalization) && {text_normalization: toBool(text_normalization)})
    };
    const audioContent = await post('/v1/audio/stream', {
      input: text,
      voice_id: voice,
      model,
      output_format: `pcm_${sampleRate}`,
      ...(language && {language}),
      ...(Object.keys(speechOptions).length && {options: speechOptions})
    });
    return {
      audioContent,
      extension: 'r24',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth speechify returned error');
    stats.increment('tts.count', ['vendor:speechify', 'accepted:no']);
    throw err;
  }
};

/* language_code is never sent: Giggy rejects one that differs from the voice's own */
const synthGiggy = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  let credOptions = credentials.options || {};
  if (typeof credOptions === 'string') {
    try {
      credOptions = JSON.parse(credOptions);
    } catch {
      credOptions = {};
    }
  }
  const {api_uri, speed, seed} = {...credOptions, ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const model = options?.model_id || model_id || 'giggyspeech';

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=giggy';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (isSet(seed)) params += `,seed=${seed}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    /* streaming mode is the only one that returns raw pcm (fast/batch are mp3) */
    const sampleRate = 24000;
    const host = (api_uri || 'giggy.ai').replace(/^[a-z]+:\/\//, '').replace(/\/$/, '');
    const post = bent(`https://${host}`, 'POST', 'buffer', {
      'xi-api-key': api_key,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/v1/text-to-speech', {
      text,
      voice_id: voice,
      model_id: model,
      mode: 'streaming',
      output_format: `pcm_${sampleRate}`,
      ...(isSet(speed) && {voice_settings: {speed: Number(speed)}}),
      ...(isSet(seed) && {seed: Number(seed)})
    });
    return {
      audioContent,
      extension: 'r24',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth giggy returned error');
    stats.increment('tts.count', ['vendor:giggy', 'accepted:no']);
    throw err;
  }
};

const synthSvara = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  let credOptions = credentials.options || {};
  if (typeof credOptions === 'string') {
    try {
      credOptions = JSON.parse(credOptions);
    } catch {
      credOptions = {};
    }
  }
  const {
    api_uri, speed, pronunciation_dictionary_id, normalize, temperature, top_p, top_k, min_p,
    repetition_penalty, presence_penalty, max_tokens, chunk_size, buffer_ms, chunk_codes
  } = {...credOptions, ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const model = options?.model_id || model_id || 'svara-tts-turbo';

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=svara';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (language) params += `,language=${language}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (pronunciation_dictionary_id) params += `,pronunciation_dictionary_id=${pronunciation_dictionary_id}`;
    if (isSet(normalize)) params += `,normalize=${normalize}`;
    if (isSet(temperature)) params += `,temperature=${temperature}`;
    if (isSet(top_p)) params += `,top_p=${top_p}`;
    if (isSet(top_k)) params += `,top_k=${top_k}`;
    if (isSet(min_p)) params += `,min_p=${min_p}`;
    if (isSet(repetition_penalty)) params += `,repetition_penalty=${repetition_penalty}`;
    if (isSet(presence_penalty)) params += `,presence_penalty=${presence_penalty}`;
    if (isSet(max_tokens)) params += `,max_tokens=${max_tokens}`;
    if (isSet(chunk_size)) params += `,chunk_size=${chunk_size}`;
    if (isSet(buffer_ms)) params += `,buffer_ms=${buffer_ms}`;
    if (isSet(chunk_codes)) params += `,chunk_codes=${chunk_codes}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const host = (api_uri || 'api.kenpathlabs.com').replace(/^[a-z]+:\/\//, '').replace(/\/$/, '');
    const post = bent(`https://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/v1/audio/speech', {
      input: text,
      voice,
      model,
      response_format: 'wav',
      sample_rate: 8000,
      ...(language && {lang: language}),
      ...(isSet(speed) && {speed: Number(speed)}),
      ...(pronunciation_dictionary_id && {pronunciation_dictionary_id}),
      ...(isSet(normalize) && {normalize: normalize === true || normalize === 'true'}),
      ...(isSet(temperature) && {temperature: Number(temperature)}),
      ...(isSet(top_p) && {top_p: Number(top_p)}),
      ...(isSet(top_k) && {top_k: Number(top_k)}),
      ...(isSet(min_p) && {min_p: Number(min_p)}),
      ...(isSet(repetition_penalty) && {repetition_penalty: Number(repetition_penalty)}),
      ...(isSet(presence_penalty) && {presence_penalty: Number(presence_penalty)}),
      ...(isSet(max_tokens) && {max_tokens: Number(max_tokens)}),
      ...(isSet(chunk_size) && {chunk_size: Number(chunk_size)}),
      ...(isSet(buffer_ms) && {buffer_ms: Number(buffer_ms)}),
      ...(isSet(chunk_codes) && {chunk_codes: Number(chunk_codes)})
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate: 8000
    };
  } catch (err) {
    /* errors are JSON {detail: {status, message}}; surface the body instead of 'undefined' */
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth svara: failed to read error response body');
      }
    }
    logger.info({err}, 'synth svara returned error');
    stats.increment('tts.count', ['vendor:svara', 'accepted:no']);
    throw err;
  }
};

const synthPaxa = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {speed, language: paxaLanguage, api_uri = credentials.api_uri} =
    {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const model = options?.model_id || model_id || 'paxa-tts-flash-v2';
  /* Paxa only takes auto|th|en|zh; unmatched jambonz languages fall back to its auto */
  const prefix = (language || '').toLowerCase().split('-')[0];
  const lang = paxaLanguage || {th: 'th', en: 'en', zh: 'zh', cmn: 'zh'}[prefix];

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=paxa';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (lang) params += `,language=${lang}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    /* paxa-tts-flash-v1 serves 24 kHz only */
    const sampleRate = model === 'paxa-tts-flash-v1' ? 24000 : 8000;
    const host = (api_uri || 'api.paxalabs.com').replace(/^[a-z]+:\/\//, '').replace(/\/$/, '');
    const post = bent(`https://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/v1/tts', {
      text,
      voice,
      model,
      format: 'wav',
      sample_rate: sampleRate,
      stream: false,
      ...(isSet(speed) && {speed: Number(speed)}),
      ...(lang && {language: lang})
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate
    };
  } catch (err) {
    /* errors are problem+json; surface the body instead of 'undefined' */
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth paxa: failed to read error response body');
      }
    }
    logger.info({err}, 'synth paxa returned error');
    stats.increment('tts.count', ['vendor:paxa', 'accepted:no']);
    throw err;
  }
};

/* gnani takes auto, hi-en or <lang>-IN; anything else falls to auto */
const gnaniTtsLanguage = (l) => {
  const lv = (l || '').trim().replace(/_/g, '-').toLowerCase();
  if (lv === 'auto' || lv === 'hi-en') return lv;
  const p = lv.split('-')[0];
  return ['bn', 'en', 'gu', 'hi', 'kn', 'ml', 'mr', 'pa', 'ta', 'te'].includes(p) ? `${p}-IN` : 'auto';
};

const synthGnani = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {speed, language: optLang, api_uri = credentials.api_uri} =
    {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const model = options?.model_id || model_id || 'timbre-v2.5';
  const lang = gnaniTtsLanguage(optLang || language);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=gnani';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    params += `,language=${lang}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    const host = (api_uri || 'api.vachana.ai').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    /* http:// or ws:// in api_uri means a plain-text proxy, as mediajam reads it */
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'X-API-Key-ID': api_key,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/api/v1/tts/inference', {
      text,
      voice,
      model,
      language: lang,
      /* the API 400s on a non-numeric speed */
      ...(isSet(speed) && !isNaN(Number(speed)) && {speed: Number(speed)}),
      audio_config: {
        sample_rate: sampleRate,
        num_channels: 1,
        sample_width: 2,
        encoding: 'linear_pcm',
        container: 'wav'
      }
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate
    };
  } catch (err) {
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth gnani: failed to read error response body');
      }
    }
    logger.info({err}, 'synth gnani returned error');
    stats.increment('tts.count', ['vendor:gnani', 'accepted:no']);
    throw err;
  }
};

const SARVAM_TTS_LANGUAGES = ['bn-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN',
  'ta-IN', 'te-IN'];

/* Sarvam only takes its Indian locales (Odia as od-IN); anything else falls back to en-IN */
const mapSarvamTtsLanguage = (lang) => {
  const input = (lang || '').trim().toLowerCase();
  const exact = SARVAM_TTS_LANGUAGES.find((l) => l.toLowerCase() === input);
  if (exact) return exact;
  let sub = input.split(/[-_]/)[0];
  if (sub === 'or') sub = 'od';
  return SARVAM_TTS_LANGUAGES.find((l) => l.toLowerCase() === `${sub}-in`) || 'en-IN';
};

const synthSarvam = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const merged = {...parseCredOptions(credentials.options), ...options};
  const {
    pace, pitch, loudness, temperature, enable_preprocessing, dict_id, enable_cached_responses
  } = merged;
  const api_uri = merged.api_uri ?? credentials.api_uri;
  const isSet = (v) => v !== null && v !== undefined;
  const model = options?.model_id || model_id || 'bulbul:v4-flash';
  const lang = mapSarvamTtsLanguage(options?.language || language);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=sarvam';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    params += `,language=${lang}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (isSet(pace)) params += `,pace=${pace}`;
    if (isSet(pitch)) params += `,pitch=${pitch}`;
    if (isSet(loudness)) params += `,loudness=${loudness}`;
    if (isSet(temperature)) params += `,temperature=${temperature}`;
    if (isSet(enable_preprocessing)) params += `,enable_preprocessing=${enable_preprocessing}`;
    if (dict_id) params += `,dict_id=${dict_id}`;
    if (isSet(enable_cached_responses)) params += `,enable_cached_responses=${enable_cached_responses}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const host = (api_uri || 'api.sarvam.ai').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'json', {
      'api-subscription-key': api_key,
      'Content-Type': 'application/json'
    });
    const asBool = (v) => v === true || v === 'true' || v === '1' || v === 1;
    const json = await post('/text-to-speech', {
      text,
      language_code: lang,
      speaker: voice,
      model,
      speech_sample_rate: 8000,
      output_audio_codec: 'wav',
      ...(isSet(pace) && {pace: Number(pace)}),
      ...(isSet(pitch) && {pitch: Number(pitch)}),
      ...(isSet(loudness) && {loudness: Number(loudness)}),
      ...(isSet(temperature) && {temperature: Number(temperature)}),
      ...(isSet(enable_preprocessing) && {enable_preprocessing: asBool(enable_preprocessing)}),
      ...(dict_id && {dict_id}),
      ...(isSet(enable_cached_responses) && {enable_cached_responses: asBool(enable_cached_responses)})
    });
    const b64 = json?.audios?.[0];
    if (!b64) throw new Error('Sarvam returned no audio');
    return {
      audioContent: Buffer.from(b64, 'base64'),
      extension: 'wav',
      sampleRate: 8000
    };
  } catch (err) {
    /* errors are JSON {error: {message, code}}; surface the body instead of 'undefined' */
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth sarvam: failed to read error response body');
      }
    }
    logger.info({err}, 'synth sarvam returned error');
    stats.increment('tts.count', ['vendor:sarvam', 'accepted:no']);
    throw err;
  }
};

const SMALLESTAI_TTS_LANGUAGES = ['en', 'hi', 'mr', 'kn', 'ta', 'bn', 'gu', 'te', 'ml', 'pa', 'or', 'es', 'de',
  'fr', 'it', 'nl', 'sv', 'pt', 'ru', 'el', 'fi', 'no', 'pl', 'ar', 'zh', 'id', 'ja', 'ko', 'ms', 'tr', 'vi'];

/* unsupported languages are omitted so Lightning uses its own default */
const mapSmallestaiTtsLanguage = (lang) => {
  const prefix = (lang || '').toLowerCase().split('-')[0];
  const mapped = {cmn: 'zh', nb: 'no', nn: 'no'}[prefix] || prefix;
  return SMALLESTAI_TTS_LANGUAGES.includes(mapped) ? mapped : undefined;
};

const synthSmallestai = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const merged = {...parseCredOptions(credentials.options), ...options};
  const {
    speed, number_pronunciation_language, date_format, math_notation, pronunciation_dicts, content_filter,
    session_id, request_id, expire_content
  } = merged;
  const api_uri = merged.api_uri ?? credentials.api_uri;
  const isSet = (v) => v !== null && v !== undefined;
  const asJson = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const model = options?.model_id || model_id || 'lightning_v3.1_pro';
  const lang = options?.language || mapSmallestaiTtsLanguage(language);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=smallestai';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (lang) params += `,language=${lang}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (number_pronunciation_language) params += `,number_pronunciation_language=${number_pronunciation_language}`;
    if (date_format) params += `,date_format=${date_format}`;
    if (isSet(math_notation)) params += `,math_notation=${math_notation}`;
    if (isSet(pronunciation_dicts)) params += `,pronunciation_dicts=${asJson(pronunciation_dicts)}`;
    if (isSet(content_filter)) params += `,content_filter=${asJson(content_filter)}`;
    if (session_id) params += `,session_id=${session_id}`;
    if (request_id) params += `,request_id=${request_id}`;
    if (isSet(expire_content)) params += `,expire_content=${expire_content}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const host = (api_uri || 'api.smallest.ai').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json',
      'Accept': 'audio/wav',
      ...(isSet(expire_content) && {'x-expire-content': String(expire_content)})
    });
    const asBool = (v) => v === true || v === 'true' || v === '1' || v === 1;
    /* invalid JSON is dropped, as on the streaming path */
    const parseJson = (v) => {
      if (typeof v !== 'string') return v;
      try {
        return JSON.parse(v);
      } catch {
        return undefined;
      }
    };
    const dicts = isSet(pronunciation_dicts) ? parseJson(pronunciation_dicts) : undefined;
    const filter = isSet(content_filter) ? parseJson(content_filter) : undefined;
    const audioContent = await post('/waves/v1/tts', {
      text,
      voice_id: voice,
      model,
      sample_rate: 8000,
      output_format: 'wav',
      ...(lang && {language: lang}),
      ...(isSet(speed) && {speed: Number(speed)}),
      ...(number_pronunciation_language && {number_pronunciation_language}),
      ...(date_format && {date_format}),
      ...(isSet(math_notation) && {math_notation: asBool(math_notation)}),
      ...(isSet(dicts) && {pronunciation_dicts: dicts}),
      ...(isSet(filter) && {content_filter: filter}),
      ...(session_id && {session_id}),
      ...(request_id && {request_id})
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate: 8000
    };
  } catch (err) {
    /* surface the error body instead of 'undefined' */
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth smallestai: failed to read error response body');
      }
    }
    logger.info({err}, 'synth smallestai returned error');
    stats.increment('tts.count', ['vendor:smallestai', 'accepted:no']);
    throw err;
  }
};

/* api_uri is the Azure resource endpoint; the deployment name goes in model */
const synthAzureopenai = async(logger, {
  credentials, options, stats, voice, key, text, instructions, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {
    speed, api_uri = credentials.api_uri, instructions: optInstr
  } = {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined && v !== '';
  const model = options?.model_id || model_id || 'gpt-4o-mini-tts';
  const instr = optInstr || instructions;

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=azureopenai';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (instr) params += `,instructions=${instr.replace(/\n/g, ' ').replace(/,/g, ';')}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 24000;
    const host = (api_uri || '').replace(/^[a-z]+:\/\//i, '').replace(/\/openai.*$/, '').replace(/\/+$/, '');
    /* http:// or ws:// in api_uri means a plain-text proxy, as mediajam reads it */
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'api-key': api_key,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/openai/v1/audio/speech', {
      model,
      voice,
      input: text,
      response_format: 'pcm',
      ...(isSet(speed) && {speed: Number(speed)}),
      ...(instr && {instructions: instr})
    });
    return {
      audioContent,
      extension: 'r24',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth azureopenai returned error');
    stats.increment('tts.count', ['vendor:azureopenai', 'accepted:no']);
    throw err;
  }
};

const synthMinimax = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const opts = {...parseCredOptions(credentials.options), ...options};
  const {api_uri = credentials.api_uri, voice_modify = {}, pronunciation_dict, timbre_weights} = opts;
  const isSet = (v) => v !== null && v !== undefined && v !== '';
  const isTrue = (v) => v === true || v === 'true' || v === '1' || v === 1;
  const model = options?.model_id || model_id || 'speech-2.8-turbo';
  const voiceKeys = ['speed', 'vol', 'pitch', 'emotion', 'text_normalization', 'english_normalization', 'latex_read'];
  const topKeys = ['text_normalization_mode', 'continuous_sound'];
  const modifyKeys = ['pitch', 'intensity', 'timbre', 'sound_effects'];

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    const asJson = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=minimax';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    [...voiceKeys, ...topKeys].forEach((k) => {
      if (isSet(opts[k])) params += `,${k}=${opts[k]}`;
    });
    /* say: params split on commas, so 'Chinese,Yue' travels as 'Chinese;Yue' */
    if (isSet(opts.language_boost)) params += `,language_boost=${String(opts.language_boost).replace(/,/g, ';')}`;
    modifyKeys.forEach((k) => {
      if (isSet(voice_modify[k])) params += `,voice_modify_${k}=${voice_modify[k]}`;
    });
    if (isSet(pronunciation_dict)) params += `,pronunciation_dict=${asJson(pronunciation_dict)}`;
    if (isSet(timbre_weights)) params += `,timbre_weights=${asJson(timbre_weights)}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const num = (v) => (isNaN(Number(v)) ? v : Number(v));
    /* mixed voices: voice_id must be present but empty (live: 2013 without it) */
    const voice_setting = {voice_id: isSet(timbre_weights) ? '' : voice};
    ['speed', 'vol', 'pitch'].forEach((k) => isSet(opts[k]) && (voice_setting[k] = num(opts[k])));
    if (isSet(opts.emotion)) voice_setting.emotion = opts.emotion;
    ['text_normalization', 'latex_read'].forEach((k) => {
      if (isSet(opts[k])) voice_setting[k] = isTrue(opts[k]);
    });
    const modify = {};
    ['pitch', 'intensity', 'timbre'].forEach((k) => isSet(voice_modify[k]) && (modify[k] = num(voice_modify[k])));
    if (isSet(voice_modify.sound_effects)) modify.sound_effects = voice_modify.sound_effects;
    const host = (api_uri || 'api.minimax.io').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'json', 200, {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const res = await post('/v1/t2a_v2', {
      model,
      text,
      stream: false,
      output_format: 'hex',
      voice_setting,
      audio_setting: {format: 'wav', sample_rate: sampleRate, channel: 1},
      ...(isSet(opts.language_boost) && {language_boost: opts.language_boost}),
      ...(isSet(opts.text_normalization_mode) && {text_normalization_mode: opts.text_normalization_mode}),
      ...(Object.keys(modify).length && {voice_modify: modify}),
      ...(isSet(pronunciation_dict) && {pronunciation_dict: asObj(pronunciation_dict)}),
      ...(isSet(timbre_weights) && {timbre_weights: asObj(timbre_weights)})
    });
    /* errors come back as HTTP 200 with a non-zero base_resp */
    if (res?.base_resp?.status_code !== 0) {
      throw new Error(`minimax tts: ${res?.base_resp?.status_code} ${res?.base_resp?.status_msg}`);
    }
    const audioContent = Buffer.from(res?.data?.audio || '', 'hex');
    if (!audioContent.length) throw new Error('minimax tts: empty audio');
    return {
      audioContent,
      extension: 'wav',
      sampleRate
    };
  } catch (err) {
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth minimax: failed to read error response body');
      }
    }
    logger.info({err}, 'synth minimax returned error');
    stats.increment('tts.count', ['vendor:minimax', 'accepted:no']);
    throw err;
  }
};

const NEUPHONIC_LANGUAGE_MAP = {'ar-sa': 'ar_sa', 'ar-ma': 'ar_maghrebi', 'nb': 'no', 'nn': 'no', 'cmn': 'zh'};
const neuphonicLanguage = (language) => {
  const l = `${language || ''}`.toLowerCase();
  if (!l) return;
  if (l.includes('_')) return l;
  const prefix = l.split('-')[0];
  return NEUPHONIC_LANGUAGE_MAP[l] || NEUPHONIC_LANGUAGE_MAP[prefix] || prefix;
};

const synthNeuphonic = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key} = credentials;
  const {
    language: neuphonicLang, speed, temperature, ipa_key, api_uri = credentials.api_uri
  } = {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined && v !== '';
  const lang = neuphonicLang || neuphonicLanguage(language);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=neuphonic';
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (voice) params += `,voice=${voice}`;
    if (lang) params += `,language=${lang}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (isSet(temperature)) params += `,temperature=${temperature}`;
    if (isSet(ipa_key)) params += `,ipa_key=${ipa_key}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    const langCode = lang || 'en';
    const host = (api_uri || 'api.neuphonic.com').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', 200, {
      'X-API-KEY': api_key,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    });
    const body = await post(`/sse/speak/${langCode}`, {
      text,
      lang_code: langCode,
      encoding: 'pcm_linear',
      sampling_rate: sampleRate,
      ...(voice && {voice_id: voice}),
      ...(isSet(speed) && {speed: Number(speed)}),
      ...(isSet(temperature) && {temperature: Number(temperature)}),
      ...(isSet(ipa_key) && {ipa_key})
    });
    /* SSE body; auth and request errors arrive as HTTP 200 error frames */
    const chunks = [];
    let event;
    for (const raw of body.toString('utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let msg;
      try {
        msg = JSON.parse(payload);
      } catch {
        if (event === 'error') throw new Error(payload);
        continue;
      }
      const errors = Array.isArray(msg?.errors) ? msg.errors : [];
      if (event === 'error' || errors.length || msg?.status_code >= 400) {
        throw new Error(errors.join('; ') || msg?.message || `status ${msg?.status_code}`);
      }
      if (msg?.data?.audio) chunks.push(Buffer.from(msg.data.audio, 'base64'));
    }
    const audioContent = Buffer.concat(chunks);
    if (!audioContent.length) throw new Error('neuphonic returned no audio');
    return {
      audioContent,
      extension: 'r8',
      sampleRate
    };
  } catch (err) {
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const errBody = await err.text();
        if (errBody) err.message = errBody;
      } catch (readErr) {
        logger.info({readErr}, 'synth neuphonic: failed to read error response body');
      }
    }
    logger.info({err}, 'synth neuphonic returned error');
    stats.increment('tts.count', ['vendor:neuphonic', 'accepted:no']);
    throw err;
  }
};

/* option keys sent on say: and in the REST body; each only when set */
const CAMB_OPTION_KEYS = [
  'speaking_rate', 'idle_timeout', 'word_timestamps', 'enhance_named_entities_pronunciation',
  'apply_enhancement', 'enhance_reference_audio_quality', 'maintain_source_accent', 'inference_steps',
  'user_instructions', 'stability', 'temperature', 'speaker_similarity', 'localize_speaker_weight',
  'acoustic_quality_boost'
];
/* documented native output rate per MARS model */
const cambRate = (model) => (model === 'mars-flash' ? 22050 : 48000);

const synthCamb = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const opts = {...parseCredOptions(credentials.options), ...options};
  const {language: cambLanguage, api_uri = credentials.api_uri} = opts;
  const isSet = (v) => v !== null && v !== undefined && v !== '';
  const asBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
  const model = options?.model_id || model_id || 'mars-flash';
  const lang = `${cambLanguage || language || 'en-us'}`.toLowerCase();

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=camb';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    params += `,language=${lang}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    for (const k of CAMB_OPTION_KEYS) {
      if (!isSet(opts[k])) continue;
      // comma is used to separated parameters in the say: url
      if (k === 'user_instructions') {
        params += `,user_instructions=${String(opts[k]).replace(/\n/g, ' ').replace(/,/g, ';')}`;
      }
      else params += `,${k}=${opts[k]}`;
    }
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const {
      user_instructions, enhance_named_entities_pronunciation, apply_enhancement, speaking_rate,
      enhance_reference_audio_quality, maintain_source_accent, inference_steps, stability, temperature,
      speaker_similarity, localize_speaker_weight, acoustic_quality_boost
    } = opts;
    const voiceSettings = {
      ...(isSet(speaking_rate) && {speaking_rate: Number(speaking_rate)}),
      ...(isSet(enhance_reference_audio_quality) &&
        {enhance_reference_audio_quality: asBool(enhance_reference_audio_quality)}),
      ...(isSet(maintain_source_accent) && {maintain_source_accent: asBool(maintain_source_accent)})
    };
    const inferenceOptions = {
      ...(isSet(inference_steps) && {inference_steps: parseInt(inference_steps, 10)}),
      ...(isSet(stability) && {stability: Number(stability)}),
      ...(isSet(temperature) && {temperature: Number(temperature)}),
      ...(isSet(speaker_similarity) && {speaker_similarity: Number(speaker_similarity)}),
      ...(isSet(localize_speaker_weight) && {localize_speaker_weight: Number(localize_speaker_weight)}),
      ...(isSet(acoustic_quality_boost) && {acoustic_quality_boost: asBool(acoustic_quality_boost)})
    };
    const voiceId = /^\d+$/.test(`${voice}`) ? Number(voice) : voice;
    const host = (api_uri || 'client.camb.ai').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'x-api-key': api_key,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/apis/tts-stream', {
      text,
      language: lang,
      voice_id: voiceId,
      speech_model: model,
      ...(isSet(user_instructions) && {user_instructions}),
      ...(isSet(enhance_named_entities_pronunciation) &&
        {enhance_named_entities_pronunciation: asBool(enhance_named_entities_pronunciation)}),
      output_configuration: {
        format: 'wav',
        ...(isSet(apply_enhancement) && {apply_enhancement: asBool(apply_enhancement)})
      },
      ...(Object.keys(voiceSettings).length && {voice_settings: voiceSettings}),
      ...(Object.keys(inferenceOptions).length && {inference_options: inferenceOptions})
    });
    if (!audioContent.length) throw new Error('camb returned no audio');
    return {
      audioContent,
      extension: 'wav',
      sampleRate: cambRate(model)
    };
  } catch (err) {
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth camb: failed to read error response body');
      }
    }
    logger.info({err}, 'synth camb returned error');
    stats.increment('tts.count', ['vendor:camb', 'accepted:no']);
    throw err;
  }
};

const ASYNCAI_LANGUAGES = ['en', 'fr', 'es', 'de', 'it', 'pt', 'ar', 'ru', 'ro', 'ja', 'he', 'hy', 'tr', 'hi', 'zh'];

const synthAsyncai = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {speed_control, stability, language: asyncaiLanguage, api_uri = credentials.api_uri} =
    {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const model = options?.model_id || model_id || 'async_flash_v1.5';
  /* unsupported languages are omitted so the vendor auto-detects */
  const prefix = (language || '').toLowerCase().split('-')[0];
  const mapped = {cmn: 'zh', iw: 'he'}[prefix] || prefix;
  const lang = asyncaiLanguage || (ASYNCAI_LANGUAGES.includes(mapped) ? mapped : undefined);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=asyncai';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (lang) params += `,language=${lang}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (isSet(speed_control)) params += `,speed_control=${speed_control}`;
    if (isSet(stability)) params += `,stability=${stability}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    const host = (api_uri || 'api.async.com').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'x-api-key': api_key,
      'version': 'v1',
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/text_to_speech', {
      model_id: model,
      transcript: text,
      voice: {mode: 'id', id: voice},
      output_format: {container: 'wav', encoding: 'pcm_s16le', sample_rate: sampleRate},
      ...(lang && {language: lang}),
      ...(isSet(speed_control) && {speed_control: Number(speed_control)}),
      ...(isSet(stability) && {stability: Number(stability)})
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate
    };
  } catch (err) {
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth asyncai: failed to read error response body');
      }
    }
    logger.info({err}, 'synth asyncai returned error');
    stats.increment('tts.count', ['vendor:asyncai', 'accepted:no']);
    throw err;
  }
};

/* the model is the URL path segment; no language field on the wire */
const respeecherModel = (language) => {
  const prefix = (language || '').toLowerCase().split('-')[0];
  return {en: 'en-rt', uk: 'ua-rt', ar: 'ar-rt', de: 'de-rt', pt: 'pt-br-rt', sv: 'sv-rt'}[prefix] || 'en-rt';
};

const RESPEECHER_SAMPLING_PARAMS = ['seed', 'temperature', 'top_k', 'top_p', 'min_p',
  'presence_penalty', 'repetition_penalty', 'frequency_penalty'];

const synthRespeecher = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {api_uri = credentials.api_uri, ...rest} = {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined && v !== '';
  const model = options?.model_id || model_id || respeecherModel(language);
  const sampling = RESPEECHER_SAMPLING_PARAMS.filter((k) => isSet(rest[k]));

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=respeecher';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    sampling.forEach((k) => params += `,${k}=${rest[k]}`);
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 24000;
    const host = (api_uri || 'api.respeecher.com').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'X-API-Key': api_key,
      'Content-Type': 'application/json'
    });
    const audioContent = await post(`/v1/public/tts/${model}/tts/bytes`, {
      transcript: text,
      voice: {
        id: voice,
        ...(sampling.length && {
          sampling_params: Object.fromEntries(sampling.map((k) => [k, Number(rest[k])]))
        })
      },
      output_format: {sample_rate: sampleRate}
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate
    };
  } catch (err) {
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth respeecher: failed to read error response body');
      }
    }
    logger.info({err}, 'synth respeecher returned error');
    stats.increment('tts.count', ['vendor:respeecher', 'accepted:no']);
    throw err;
  }
};

const synthBland = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key} = credentials;
  const {expressiveness, stability, api_uri = credentials.api_uri} =
    {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined;

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=bland';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (isSet(expressiveness)) params += `,expressiveness=${expressiveness}`;
    if (isSet(stability)) params += `,stability=${stability}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    const host = (api_uri || 'api.bland.ai').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const controls = {
      ...(isSet(expressiveness) && {expressiveness: Number(expressiveness)}),
      ...(isSet(stability) && {stability: Number(stability)})
    };
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/v2/tts', {
      text,
      voice,
      audio: {encoding: 'pcm_s16le', sample_rate: sampleRate, container: 'wav'},
      ...(Object.keys(controls).length && {controls})
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate
    };
  } catch (err) {
    /* errors are {"error":{code,message}}; surface the body instead of 'undefined' */
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth bland: failed to read error response body');
      }
    }
    logger.info({err}, 'synth bland returned error');
    stats.increment('tts.count', ['vendor:bland', 'accepted:no']);
    throw err;
  }
};

/* with no model set, Hindi gets Veena and everything else Orpheus */
const simplismartModel = (model_id, language) => {
  if (model_id) return model_id;
  return language && /^hi/i.test(language) ? 'maya-research/Veena' : 'canopylabs/orpheus-3b-0.1-ft';
};
/* Qwen takes a language name, not a code; unknown codes fall back to English */
const simplismartQwenLanguage = (language) => {
  const names = {
    en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', de: 'German',
    fr: 'French', ru: 'Russian', pt: 'Portuguese', es: 'Spanish', it: 'Italian'
  };
  const prefix = (language || '').split(/[-_]/)[0].toLowerCase();
  return names[prefix] || 'English';
};
const synthSimplismart = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {
    api_uri = credentials.api_uri, temperature, top_p, repetition_penalty, max_tokens,
    language: qwenLanguage, leading_silence
  } = {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const model = simplismartModel(options?.model_id || model_id, language);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=simplismart';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (language) params += `,language=${language}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (isSet(temperature)) params += `,temperature=${temperature}`;
    if (isSet(top_p)) params += `,top_p=${top_p}`;
    if (isSet(repetition_penalty)) params += `,repetition_penalty=${repetition_penalty}`;
    if (isSet(max_tokens)) params += `,max_tokens=${max_tokens}`;
    if (qwenLanguage) params += `,qwen_language=${qwenLanguage}`;
    if (isSet(leading_silence)) params += `,leading_silence=${leading_silence}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 24000;
    const host = (api_uri || 'api.simplismart.live').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const isQwen = /qwen/i.test(model);
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json',
      ...(isQwen && {'Accept': 'audio/L16'})
    });
    let audioContent;
    if (isQwen) {
      audioContent = await post('/v1/audio/speech', {
        model,
        text,
        voice,
        language: qwenLanguage || simplismartQwenLanguage(language),
        ...(isSet(leading_silence) && {leading_silence: leading_silence === true || leading_silence === 'true'})
      });
    } else {
      audioContent = await post('/tts', {
        prompt: text,
        voice,
        model,
        ...(isSet(temperature) && {temperature: Number(temperature)}),
        ...(isSet(top_p) && {top_p: Number(top_p)}),
        ...(isSet(repetition_penalty) && {repetition_penalty: Number(repetition_penalty)}),
        ...(isSet(max_tokens) && {max_tokens: parseInt(max_tokens, 10)})
      });
    }
    /* output is assumed headerless PCM; strip a WAV header defensively */
    if (audioContent.length > 12 && audioContent.toString('ascii', 0, 4) === 'RIFF' &&
      audioContent.toString('ascii', 8, 12) === 'WAVE') {
      const dataIdx = audioContent.indexOf('data', 12);
      if (dataIdx !== -1) audioContent = audioContent.subarray(dataIdx + 8);
    }
    return {
      audioContent,
      extension: 'r24',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth simplismart returned error');
    stats.increment('tts.count', ['vendor:simplismart', 'accepted:no']);
    throw err;
  }
};

/* only documented codes are sent; anything else (incl. Pidgin) lets the voice speak the text */
const spitchLanguage = (language) => {
  const prefix = (language || '').split(/[-_]/)[0].toLowerCase();
  return ['en', 'yo', 'ha', 'ig', 'am'].includes(prefix) ? prefix : undefined;
};
const synthSpitch = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key} = credentials;
  const {api_uri = credentials.api_uri, speed} = {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined;

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=spitch';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (language) params += `,language=${language}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 24000;
    const host = (api_uri || 'api.spitch.app').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const lang = spitchLanguage(language);
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/v1/speech', {
      text,
      voice,
      format: 'pcm_s16le',
      sample_rate: sampleRate,
      ...(lang && {language: lang}),
      ...(isSet(speed) && {speed: Number(speed)})
    });
    return {
      audioContent,
      extension: 'r24',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth spitch returned error');
    stats.increment('tts.count', ['vendor:spitch', 'accepted:no']);
    throw err;
  }
};

/* lang_code is never derived from jambonz language: Kokoro infers it from the voice prefix */
const synthKokoro = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {
    api_uri = credentials.api_uri, api_key = credentials.api_key, lang_code, speed, volume_multiplier,
    normalization_options, voice_aliases, allow_voice_tags, ssml
  } = {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined && v !== '';
  const json = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const model = options?.model_id || credentials.model_id || 'kokoro';

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `playback_id=${key}`;
    params += ',vendor=kokoro';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    params += `,api_uri=${api_uri}`;
    if (api_key) params += `,api_key=${api_key}`;
    if (lang_code) params += `,lang_code=${lang_code}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (isSet(volume_multiplier)) params += `,volume_multiplier=${volume_multiplier}`;
    if (isSet(normalization_options)) params += `,normalization_options=${json(normalization_options)}`;
    if (isSet(voice_aliases)) params += `,voice_aliases=${json(voice_aliases)}`;
    if (isSet(allow_voice_tags)) params += `,allow_voice_tags=${allow_voice_tags}`;
    if (isSet(ssml)) params += `,ssml=${ssml}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    /* response_format pcm is headerless s16le mono at a fixed 24 kHz */
    const sampleRate = 24000;
    const scheme = /^(http|ws):\/\//i.test(api_uri) ? 'http' : 'https';
    /* api_uri may be given OpenAI base_url style, ending in /v1 */
    const host = api_uri.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').replace(/\/v1$/, '');
    const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;
    const obj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'Content-Type': 'application/json',
      ...(api_key && {'Authorization': `Bearer ${api_key}`})
    });
    const audioContent = await post('/v1/audio/speech', {
      model,
      input: text,
      voice,
      response_format: 'pcm',
      stream: true,
      ...(lang_code && {lang_code}),
      ...(isSet(speed) && {speed: Number(speed)}),
      ...(isSet(volume_multiplier) && {volume_multiplier: Number(volume_multiplier)}),
      ...(isSet(normalization_options) && {normalization_options: obj(normalization_options)}),
      ...(isSet(voice_aliases) && {voice_aliases: obj(voice_aliases)}),
      ...(isSet(allow_voice_tags) && {allow_voice_tags: bool(allow_voice_tags)}),
      ...(isSet(ssml) && {ssml: bool(ssml)})
    });
    return {
      audioContent,
      extension: 'r24',
      sampleRate
    };
  } catch (err) {
    /* FastAPI errors carry {detail: ...}; surface the body instead of 'undefined' */
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body.slice(0, 512);
      } catch (readErr) {
        logger.info({readErr}, 'synth kokoro: failed to read error response body');
      }
    }
    logger.info({err}, 'synth kokoro returned error');
    stats.increment('tts.count', ['vendor:kokoro', 'accepted:no']);
    throw err;
  }
};

/* Vakyam rejects any language outside its eight *-IN codes */
const vakyamLanguage = (language) => {
  const prefix = (language || '').toLowerCase().split('-')[0];
  return {
    en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN', mr: 'mr-IN', gu: 'gu-IN', bn: 'bn-IN'
  }[prefix] || 'en-IN';
};

const synthVakyam = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {speed, language: vakyamLang, api_uri = credentials.api_uri} =
    {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const model = options?.model_id || model_id || 'raaga-v1';
  const lang = vakyamLang || vakyamLanguage(language);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=vakyam';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    params += `,language=${lang}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    /* pcm output is headerless; rate pinned to match the streaming path */
    const sampleRate = 24000;
    const host = (api_uri || 'api.vakyam.ai').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/v1/tts/stream', {
      text,
      model_id: model,
      voice,
      language: lang,
      output_format: 'pcm',
      sample_rate: sampleRate,
      ...(isSet(speed) && {speed: Number(speed)})
    });
    return {
      audioContent,
      extension: 'r24',
      sampleRate
    };
  } catch (err) {
    /* errors are {error:{code,message}}; surface the body instead of 'undefined' */
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth vakyam: failed to read error response body');
      }
    }
    logger.info({err}, 'synth vakyam returned error');
    stats.increment('tts.count', ['vendor:vakyam', 'accepted:no']);
    throw err;
  }
};

/* Orpheus has no language field; Arabic needs its own model */
const groqModel = (model_id, language) => {
  if (model_id) return model_id;
  return /^ar/i.test(language || '') ? 'canopylabs/orpheus-arabic-saudi' : 'canopylabs/orpheus-v1-english';
};

const synthGroq = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {speed, sample_rate, api_uri = credentials.api_uri} =
    {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const model = groqModel(options?.model_id || model_id, language);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=groq';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (language) params += `,language=${language}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (isSet(sample_rate)) params += `,sample_rate=${sample_rate}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const host = (api_uri || 'api.groq.com').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/openai/v1/audio/speech', {
      model,
      voice,
      input: text,
      response_format: 'wav',
      /* sample_rate is not sent: the audio is always 24 kHz and it only relabels the header */
      ...(isSet(speed) && {speed: Number(speed)})
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate: 24000
    };
  } catch (err) {
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth groq: failed to read error response body');
      }
    }
    logger.info({err}, 'synth groq returned error');
    stats.increment('tts.count', ['vendor:groq', 'accepted:no']);
    throw err;
  }
};

/* Hume Octave: no language field, the voice carries it */
const synthHume = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {
    voice_provider, description, speed, trailing_silence, instant_mode, temperature,
    context_generation_id, split_utterances, api_uri = credentials.api_uri
  } = {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined && v !== '';
  const asBool = (v) => v === true || v === 'true' || v === '1' || v === 1;
  const model = options?.model_id || model_id;

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=hume';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (model) params += `,model_id=${model}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (voice_provider) params += `,voice_provider=${voice_provider}`;
    /* free text would break the say param string */
    if (description) params += `,description=${String(description).replace(/[,{}]/g, ' ')}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (isSet(trailing_silence)) params += `,trailing_silence=${trailing_silence}`;
    if (isSet(instant_mode)) params += `,instant_mode=${instant_mode}`;
    if (isSet(temperature)) params += `,temperature=${temperature}`;
    if (context_generation_id) params += `,context_generation_id=${context_generation_id}`;
    if (isSet(split_utterances)) params += `,split_utterances=${split_utterances}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const host = (api_uri || 'api.hume.ai').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'X-Hume-Api-Key': api_key,
      'Content-Type': 'application/json'
    });
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(voice);
    /* Hume's default provider is CUSTOM_VOICE; library voices need HUME_AI */
    const humeVoice = {...(isUuid ? {id: voice} : {name: voice}), provider: voice_provider || 'HUME_AI'};
    /* instant_mode is only valid on the streaming endpoints */
    const audioContent = await post('/v0/tts/file', {
      utterances: [{
        text,
        voice: humeVoice,
        ...(description && {description}),
        ...(isSet(speed) && {speed: Number(speed)}),
        ...(isSet(trailing_silence) && {trailing_silence: Number(trailing_silence)})
      }],
      format: {type: 'mp3'},
      num_generations: 1,
      ...(model && {version: String(model)}),
      ...(isSet(temperature) && {temperature: Number(temperature)}),
      ...(context_generation_id && {context: {generation_id: context_generation_id}}),
      ...(isSet(split_utterances) && {split_utterances: asBool(split_utterances)})
    });
    if (!audioContent || audioContent.length === 0) throw new Error('hume returned no audio');
    return {
      audioContent,
      extension: 'mp3',
      sampleRate: 8000
    };
  } catch (err) {
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth hume: failed to read error response body');
      }
    }
    logger.info({err}, 'synth hume returned error');
    stats.increment('tts.count', ['vendor:hume', 'accepted:no']);
    throw err;
  }
};

/* Speechmatics: language is never sent, the voice carries it; output is headerless 16 kHz pcm */
const synthSpeechmatics = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key} = credentials;
  const {api_uri = credentials.api_uri, sm_app} = {...parseCredOptions(credentials.options), ...options};

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=speechmatics';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (sm_app) params += `,sm_app=${sm_app}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 16000;
    const host = (api_uri || 'preview.tts.speechmatics.com').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const qs = `output_format=pcm_${sampleRate}${sm_app ? `&sm-app=${encodeURIComponent(sm_app)}` : ''}`;
    const audioContent = await post(`/generate/${encodeURIComponent(voice)}?${qs}`, {text});
    if (!audioContent || audioContent.length === 0) throw new Error('speechmatics returned no audio');
    return {
      audioContent,
      extension: 'r16',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth speechmatics returned error');
    stats.increment('tts.count', ['vendor:speechmatics', 'accepted:no']);
    throw err;
  }
};

/* Soniox takes bare ISO 639-1 codes; unsupported ones pass through and Soniox rejects them */
const sonioxLanguage = (language) => {
  const prefix = String(language || '').toLowerCase().split(/[-_]/)[0];
  const lang = {cmn: 'zh', nb: 'no', nn: 'no', fil: 'tl', iw: 'he'}[prefix] || prefix;
  return lang || undefined;
};

const synthSoniox = async(logger, {
  credentials, options, stats, language, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {speed, reduce_silence, client_reference_id, language: optLang, api_uri = credentials.api_uri} =
    {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const model = options?.model_id || model_id || 'tts-rt-v2';
  const lang = optLang || sonioxLanguage(language);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=soniox';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (lang) params += `,language=${lang}`;
    if (api_uri) params += `,endpoint=${api_uri}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (isSet(reduce_silence)) params += `,reduce_silence=${reduce_silence}`;
    if (client_reference_id) params += `,client_reference_id=${client_reference_id}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    const host = (api_uri || 'tts-rt.soniox.com').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const scheme = /^(http|ws):\/\//i.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/tts', {
      text,
      model,
      language: lang || 'en',
      voice,
      audio_format: 'wav',
      sample_rate: sampleRate,
      ...(isSet(speed) && {speed: Number(speed)}),
      ...(isSet(reduce_silence) && {reduce_silence: reduce_silence === true || reduce_silence === 'true'}),
      ...(client_reference_id && {client_reference_id})
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate
    };
  } catch (err) {
    /* errors are JSON; surface the body instead of 'undefined' */
    if (err.name === 'StatusError' && typeof err.text === 'function') {
      try {
        const body = await err.text();
        if (body) err.message = body;
      } catch (readErr) {
        logger.info({readErr}, 'synth soniox: failed to read error response body');
      }
    }
    logger.info({err}, 'synth soniox returned error');
    stats.increment('tts.count', ['vendor:soniox', 'accepted:no']);
    throw err;
  }
};

/* Mistral Voxtral: no language field, the voice carries it; output is mono 24 kHz */
/* credential Extra Options are stored as a JSON string or an object */
const parseCredOptions = (opts) => {
  if (typeof opts !== 'string') return opts || {};
  try {
    return JSON.parse(opts);
  } catch {
    return {};
  }
};

const synthMistral = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming,
  disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  const {
    api_uri, expressiveness, prompt_cache_key, ref_audio, phoneme_hints, conversation_history
  } = {...parseCredOptions(credentials.options), ...options};
  const isSet = (v) => v !== null && v !== undefined;
  const asJson = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const model = options?.model_id || model_id || 'voxtral-mini-tts-3-0';

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=mistral';
    if (voice) params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    params += `,model_id=${model}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    if (isSet(expressiveness)) params += `,expressiveness=${expressiveness}`;
    if (prompt_cache_key) params += `,prompt_cache_key=${prompt_cache_key}`;
    if (ref_audio) params += `,ref_audio=${ref_audio}`;
    if (isSet(phoneme_hints)) params += `,phoneme_hints=${asJson(phoneme_hints)}`;
    if (isSet(conversation_history)) params += `,conversation_history=${asJson(conversation_history)}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 24000;
    const host = (api_uri || 'api.mistral.ai').replace(/^[a-z]+:\/\//, '').replace(/\/$/, '');
    /* http:// or ws:// in api_uri means a plain-text proxy, as mediajam reads it */
    const scheme = /^(http|ws):\/\//.test(api_uri || '') ? 'http' : 'https';
    const post = bent(`${scheme}://${host}`, 'POST', 'json', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    /* invalid JSON is dropped, as on the streaming path */
    const parseJson = (v) => {
      if (typeof v !== 'string') return v;
      try {
        return JSON.parse(v);
      } catch {
        return undefined;
      }
    };
    const hints = isSet(phoneme_hints) ? parseJson(phoneme_hints) : undefined;
    const history = isSet(conversation_history) && !ref_audio ? parseJson(conversation_history) : undefined;
    const {audio_data} = await post('/v1/audio/speech', {
      model,
      input: text,
      response_format: 'pcm',
      ...(ref_audio ? {ref_audio} : {voice_id: voice}),
      ...(isSet(expressiveness) && {expressiveness: Number(expressiveness)}),
      ...(prompt_cache_key && {prompt_cache_key}),
      ...(isSet(hints) && {phoneme_hints: hints}),
      ...(isSet(history) && {conversation_history: history})
    });
    /* Voxtral pcm is float32; the r24 cache is s16 */
    const f32 = Buffer.from(audio_data, 'base64');
    const audioContent = Buffer.alloc(Math.floor(f32.length / 4) * 2);
    for (let i = 0; i < audioContent.length / 2; i++) {
      const v = Math.max(-1, Math.min(1, f32.readFloatLE(i * 4)));
      audioContent.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    return {
      audioContent,
      extension: 'r24',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth mistral returned error');
    stats.increment('tts.count', ['vendor:mistral', 'accepted:no']);
    throw err;
  }
};

/* nineninesix.ai — a Cartesia-compatible API, but only raw/wav come back
   (mp3 is rejected), so the cache render asks for wav rather than mp3. */
/* fish.audio — msgpack websocket for streaming, and a POST endpoint for the cache
   render. format:pcm + sample_rate:8000 returns bare little-endian 16-bit samples,
   which is exactly the r8 container. we avoid fish's wav output because its RIFF
   header carries a placeholder size (0xffffff24) — length is unknown up front, as
   with gradium.

   fish is a voice-cloning vendor: the "voice" is a reference_id returned by
   POST /model, and omitting it entirely synthesizes with fish's default voice.
   the sentinel value 'default' (the bundled fallback entry in the portal) means
   exactly that — send no reference_id.
*/
const synthFishaudio = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {api_key, model_id} = credentials;
  let credOptions = credentials.options || {};
  if (typeof credOptions === 'string') {
    try {
      credOptions = JSON.parse(credOptions);
    } catch {
      credOptions = {};
    }
  }
  /* Extra Options on the credential apply to every request; the verb's options win */
  const {reference_id, latency, chunk_length, speed, volume, api_uri} = {...credOptions, ...options};
  const isSet = (v) => v !== null && v !== undefined && v !== '';

  /* free-text reference_id in the vendor options wins over the voice selector */
  const refId = reference_id || (voice && voice !== 'default' ? voice : null);

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=fishaudio';
    params += `,voice=${refId || 'default'}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (model_id) params += `,model_id=${model_id}`;
    if (latency) params += `,latency=${latency}`;
    if (isSet(chunk_length)) params += `,chunk_length=${chunk_length}`;
    if (isSet(speed)) params += `,speed=${speed}`;
    if (isSet(volume)) params += `,volume=${volume}`;
    if (api_uri) params += `,api_uri=${api_uri}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    const host = (api_uri || 'api.fish.audio').replace(/^[a-z]+:\/\//, '').replace(/\/$/, '');
    const post = bent(`https://${host}`, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json',
      /* the model is selected by header, not in the body */
      'model': model_id || 's2.1-pro'
    });
    const audioContent = await post('/v1/tts', {
      text,
      format: 'pcm',
      sample_rate: sampleRate,
      ...(refId && {reference_id: refId}),
      ...(latency && {latency}),
      ...(isSet(chunk_length) && {chunk_length: parseInt(chunk_length, 10)}),
      ...((isSet(speed) || isSet(volume)) && {prosody: {
        ...(isSet(speed) && {speed: parseFloat(speed)}),
        ...(isSet(volume) && {volume: parseFloat(volume)})
      }})
    });
    return {
      audioContent,
      extension: 'r8',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth fishaudio returned error');
    stats.increment('tts.count', ['vendor:fishaudio', 'accepted:no']);
    throw err;
  }
};

const synthNineninesix = async(logger, {
  credentials, stats, voice, language, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {api_key, model_id} = credentials;

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += `,model_id=${model_id}`;
    params += ',vendor=nineninesix';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (language) params += `,language=${language}`;
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const sampleRate = 8000;
    const post = bent('https://api.nineninesix.ai', 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const audioContent = await post('/tts/bytes', {
      model_id,
      transcript: text,
      voice: {mode: 'id', id: voice},
      ...(language && {language}),
      output_format: {
        container: 'wav',
        encoding: 'pcm_s16le',
        sample_rate: sampleRate
      }
    });
    return {
      audioContent,
      extension: 'wav',
      sampleRate
    };
  } catch (err) {
    logger.info({err}, 'synth nineninesix returned error');
    stats.increment('tts.count', ['vendor:nineninesix', 'accepted:no']);
    throw err;
  }
};

const synthResemble = async(logger, {
  credentials, options, stats, voice, key, text, renderForCaching, disableTtsStreaming, disableTtsCache
}) => {
  const {api_key, resemble_tts_uri, resemble_tts_use_tls} = credentials;
  const {project_uuid, use_hd} = options || {};

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '{';
    params += `api_key=${api_key}`;
    params += `,playback_id=${key}`;
    params += ',vendor=resemble';
    params += `,voice=${voice}`;
    params += `,write_cache_file=${disableTtsCache ? 0 : 1}`;
    if (project_uuid) params += `,project_uuid=${project_uuid}`;
    if (use_hd) params += `,use_hd=${use_hd}`;
    if (resemble_tts_uri) params += `,endpoint=${resemble_tts_uri}`;
    if (resemble_tts_use_tls) params += `,use_tls=${resemble_tts_use_tls}`;

    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ').replace(/\r/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }

  try {
    const baseUrl = resemble_tts_uri || 'https://f.cluster.resemble.ai';
    const post = bent(baseUrl, 'POST', 'buffer', {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    });
    const response = await post('/synthesize', {
      voice_uuid: voice,
      data: text,
      sample_rate: 8000,
      output_format: 'mp3',
      ...(project_uuid && {project_uuid}),
      ...(use_hd && {use_hd}),
    });

    const json = JSON.parse(response.toString('utf8'));
    const audioContent = Buffer.from(json.audio_content, 'base64');
    return {
      audioContent,
      extension: 'mp3',
      sampleRate: 8000
    };
  } catch (err) {
    logger.info({err}, 'synth Elevenlabs returned error');
    stats.increment('tts.count', ['vendor:elevenlabs', 'accepted:no']);
    throw err;
  }
};

const getFileExtFromMime = (mime) => {
  switch (mime) {
    case 'audio/wav':
    case 'audio/x-wav':
      return ['wav', 8000];
    case /audio\/l16.*rate=8000/.test(mime) ? mime : 'cant match value':
      return ['r8', 8000];
    case /audio\/l16.*rate=16000/.test(mime) ? mime : 'cant match value':
      return ['r16', 16000];
    case /audio\/l16.*rate=24000/.test(mime) ? mime : 'cant match value':
      return ['r24', 24000];
    case /audio\/l16.*rate=32000/.test(mime) ? mime : 'cant match value':
      return ['r32', 32000];
    case /audio\/l16.*rate=48000/.test(mime) ? mime : 'cant match value':
      return ['r48', 48000];
    case 'audio/mpeg':
    case 'audio/mp3':
      return ['mp3', 8000];
    default:
      return ['wav', 8000];
  }
};

module.exports = synthAudio;
