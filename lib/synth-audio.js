const assert = require('assert');
const fs = require('fs');
const bent = require('bent');
const ttsGoogle = require('@google-cloud/text-to-speech');
//const Polly = require('aws-sdk/clients/polly');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');

const sdk = require('microsoft-cognitiveservices-speech-sdk');
const TextToSpeechV1 = require('ibm-watson/text-to-speech/v1');
const { IamAuthenticator } = require('ibm-watson/auth');
const {
  AudioConfig,
  ResultReason,
  SpeechConfig,
  SpeechSynthesizer,
  CancellationDetails,
  SpeechSynthesisOutputFormat
} = sdk;
const {makeSynthKey, createNuanceClient, noopLogger, createRivaClient} = require('./utils');
const getNuanceAccessToken = require('./get-nuance-access-token');
const {
  SynthesisRequest,
  Voice,
  AudioFormat,
  AudioParameters,
  PCM,
  Input,
  Text,
  SSML,
  EventParameters
} = require('../stubs/nuance/synthesizer_pb');
const {SynthesizeSpeechRequest} = require('../stubs/riva/proto/riva_tts_pb');
const {AudioEncoding} = require('../stubs/riva/proto/riva_audio_pb');
const debug = require('debug')('jambonz:realtimedb-helpers');
const EXPIRES = 3600 * 24; // cache tts for 24 hours
const TMP_FOLDER = '/tmp';

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
async function synthAudio(client, logger, stats, {
  vendor, language, voice, gender, text, engine, salt, model, credentials, deploymentId, disableTtsCache
}) {
  let audioBuffer;
  let servedFromCache = false;
  let rtt;
  logger = logger || noopLogger;

  assert.ok(['google', 'aws', 'polly', 'microsoft', 'wellsaid', 'nuance', 'nvidia', 'ibm'].includes(vendor),
    `synthAudio supported vendors are google, aws, microsoft, nuance, nvidia and wellsaid, not ${vendor}`);
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
  else if ('nuance' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when nuance is used');
    assert.ok(credentials.client_id, 'synthAudio requires client_id in credentials when nuance is used');
    assert.ok(credentials.secret, 'synthAudio requires client_id in credentials when nuance is used');
  }
  else if ('nvidia' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when nvidia is used');
    assert.ok(language, 'synthAudio requires language when nvidia is used');
    assert.ok(credentials.riva_uri, 'synthAudio requires riva_uri in credentials when nuance is used');
  }
  else if ('ibm' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when ibm is used');
    assert.ok(credentials.tts_region, 'synthAudio requires tts_region in credentials when ibm watson is used');
    assert.ok(credentials.tts_api_key, 'synthAudio requires tts_api_key in credentials when nuance is used');
  }
  else if ('wellsaid' === vendor) {
    language = 'en-US'; // WellSaid only supports English atm
    assert.ok(voice, 'synthAudio requires voice when wellsaid is used');
    assert.ok(!text.startsWith('<speak'), 'wellsaid does not support SSML tags');
  }

  const key = makeSynthKey({
    vendor,
    language: language || '',
    voice: voice || deploymentId,
    engine,
    text
  });
  let filePath;
  if (['nuance', 'nvidia'].includes(vendor)) {
    filePath = `${TMP_FOLDER}/${key.replace('tts:', `tts-${salt || ''}`)}.r8`;
  }
  else filePath = `${TMP_FOLDER}/${key.replace('tts:', `tts-${salt || ''}`)}.mp3`;
  debug(`synth key is ${key}`);
  let cached;
  if (!disableTtsCache) {
    cached = await client.getAsync(key);
  }
  if (cached) {
    // found in cache - extend the expiry and use it
    debug('result WAS found in cache');
    servedFromCache = true;
    stats.increment('tts.cache.requests', ['found:yes']);
    audioBuffer = Buffer.from(cached, 'base64');
    client.expireAsync(key, EXPIRES).catch((err) => logger.info(err, 'Error setting expires'));
  }
  if (!cached) {
    // not found in cache - go get it from speech vendor and add to cache
    debug('result was NOT found in cache');
    stats.increment('tts.cache.requests', ['found:no']);
    let vendorLabel = vendor;
    const startAt = process.hrtime();
    switch (vendor) {
      case 'google':
        audioBuffer = await synthGoogle(logger, {credentials, stats, language, voice, gender, text});
        break;
      case 'aws':
      case 'polly':
        vendorLabel = 'aws';
        audioBuffer = await synthPolly(logger, {credentials, stats, language, voice, text, engine});
        break;
      case 'azure':
      case 'microsoft':
        vendorLabel = 'microsoft';
        audioBuffer = await synthMicrosoft(logger, {credentials, stats, language, voice, text, deploymentId, filePath});
        break;
      case 'nuance':
        model = model || 'enhanced';
        audioBuffer = await synthNuance(client, logger, {credentials, stats, voice, model, text});
        break;
      case 'nvidia':
        audioBuffer = await synthNvidia(client, logger, {credentials, stats, language, voice, model, text});
        break;
      case 'ibm':
        audioBuffer = await synthIbm(logger, {credentials, stats, voice, text});
        break;
      case 'wellsaid':
        audioBuffer = await synthWellSaid(logger, {credentials, stats, language, voice, text, filePath});
        break;
      default:
        assert(`synthAudio: unsupported speech vendor ${vendor}`);
    }
    const diff = process.hrtime(startAt);
    const time = diff[0] * 1e3 + diff[1] * 1e-6;
    rtt = time.toFixed(0);
    stats.histogram('tts.response_time', rtt, [`vendor:${vendorLabel}`]);
    debug(`tts rtt time for ${text.length} chars on ${vendorLabel}: ${rtt}`);
    logger.info(`tts rtt time for ${text.length} chars on ${vendorLabel}: ${rtt}`);

    client.setexAsync(key, EXPIRES, audioBuffer.toString('base64'))
      .catch((err) => logger.error(err, `error calling setex on key ${key}`));

    if (['microsoft'].includes(vendor)) return {filePath, servedFromCache, rtt};
  }

  return new Promise((resolve, reject) => {
    fs.writeFile(filePath, audioBuffer, (err) => {
      if (err) return reject(err);
      resolve({filePath, servedFromCache, rtt});
    });
  });
}

const synthPolly = async(logger, {credentials, stats, language, voice, engine, text}) => {
  try {
    const polly = new PollyClient(credentials);
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
        .on('end', () => resolve(Buffer.concat(chunks)));
    });
  } catch (err) {
    logger.info({err}, 'synthAudio: Error synthesizing speech using aws polly');
    stats.increment('tts.count', ['vendor:aws', 'accepted:no']);
    throw err;
  }
};

const synthGoogle = async(logger, {credentials, stats, language, voice, gender, text}) => {
  const client = new ttsGoogle.TextToSpeechClient(credentials);
  const opts = {
    voice: {
      name: voice,
      languageCode: language,
      ssmlGender: gender || 'SSML_VOICE_GENDER_UNSPECIFIED'
    },
    audioConfig: {audioEncoding: 'MP3'}
  };
  Object.assign(opts, {input: text.startsWith('<speak>') ? {ssml: text} : {text}});
  try {
    const responses = await client.synthesizeSpeech(opts);
    stats.increment('tts.count', ['vendor:google', 'accepted:yes']);
    client.close();
    return responses[0].audioContent;
  } catch (err) {
    console.error(err);
    logger.info({err, opts}, 'synthAudio: Error synthesizing speech using google');
    stats.increment('tts.count', ['vendor:google', 'accepted:no']);
    client && client.close();
    throw err;
  }
};

const synthIbm = async(logger, {credentials, stats, voice, text}) => {
  const {tts_api_key, tts_region} = credentials;
  const params = {
    text,
    voice,
    accept: 'audio/mp3'
  };

  try {
    const textToSpeech = new TextToSpeechV1({
      authenticator: new IamAuthenticator({
        apikey: tts_api_key,
      }),
      serviceUrl: `https://api.${tts_region}.text-to-speech.watson.cloud.ibm.com`
    });

    const r = await textToSpeech.synthesize(params);
    const chunks = [];
    for await (const chunk of r.result) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    logger.info({err, params}, 'synthAudio: Error synthesizing speech using ibm');
    stats.increment('tts.count', ['vendor:ibm', 'accepted:no']);
    throw new Error(err.statusText || err.message);
  }
};

const synthMicrosoft = async(logger, {
  credentials,
  stats,
  language,
  voice,
  text,
  filePath
}) => {
  try {
    const {api_key: apiKey, region, use_custom_tts, custom_tts_endpoint} = credentials;
    let content = text;
    const speechConfig = SpeechConfig.fromSubscription(apiKey, region);
    speechConfig.speechSynthesisLanguage = language;
    speechConfig.speechSynthesisVoiceName = voice;
    if (use_custom_tts && custom_tts_endpoint) {
      speechConfig.endpointId = custom_tts_endpoint;

      /**
       * Note: it seems that to use custom voice ssml is required with the voice attribute
       * Otherwise sending plain text we get "Voice does not match"
       */
      if (!content.startsWith('<speak')) content = `<speak>${text}</speak>`;
    }
    speechConfig.speechSynthesisOutputFormat = SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;
    const config = AudioConfig.fromAudioFileOutput(filePath);
    const synthesizer = new SpeechSynthesizer(speechConfig, config);

    if (content.startsWith('<speak>')) {
      /* microsoft enforces some properties and uses voice xml element so if the user did not supply do it for them */
      const words = content.slice(7, -8).trim().replace(/(\r\n|\n|\r)/gm, ' ');
      // eslint-disable-next-line max-len
      content = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${language}"><voice name="${voice}">${words}</voice></speak>`;
      logger.info({content}, 'synthMicrosoft');
    }

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
              stats.increment('tts.count', ['vendor:microsoft', 'accepted:yes']);
              synthesizer.close();
              fs.readFile(filePath, (err, data) => {
                if (err) return reject(err);
                resolve(data);
              });
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
    const mp3 = await post('/v1/tts/stream', {
      text,
      speaker_id: voice
    });
    return mp3;
  } catch (err) {
    logger.info({err}, 'testWellSaidTts returned error');
    throw err;
  }
};

const synthNuance = async(client, logger, {credentials, stats, voice, model, text}) => {
  /* get a nuance access token */
  const {client_id, secret} = credentials;
  const {access_token} = await getNuanceAccessToken(client, logger, client_id, secret, 'tts');
  const nuanceClient = await createNuanceClient(access_token);

  const v = new Voice();
  const p = new AudioParameters();
  const f = new AudioFormat();
  const pcm = new PCM();
  const params  = new EventParameters();
  const request = new SynthesisRequest();
  const input = new Input();

  if (text.startsWith('<speak')) {
    const ssml = new SSML();
    ssml.setText(text);
    input.setSsml(ssml);
  }
  else {
    const t = new Text();
    t.setText(text);
    input.setText(t);
  }

  pcm.setSampleRateHz(8000);
  f.setPcm(pcm);
  p.setAudioFormat(f);
  v.setName(voice);
  v.setModel(model);
  request.setVoice(v);
  request.setAudioParams(p);
  request.setInput(input);
  request.setEventParams(params);
  request.setUserId('jambonz');

  return new Promise((resolve, reject) => {
    nuanceClient.unarySynthesize(request, (err, response) => {
      if (err) {
        console.error(err);
        return reject(err);
      }
      const status = response.getStatus();
      const code = status.getCode();
      if (code !== 200) {
        const message = status.getMessage();
        const details = status.getDetails();
        return reject({code, message, details});
      }
      resolve(Buffer.from(response.getAudio()));
    });
  });
};

const synthNvidia = async(client, logger, {credentials, stats, language,  voice, model, text}) => {
  const {riva_uri} = credentials;
  const rivaClient = await createRivaClient(riva_uri);

  const request = new SynthesizeSpeechRequest();
  request.setVoiceName(voice);
  request.setLanguageCode(language);
  request.setSampleRateHz(8000);
  request.setEncoding(AudioEncoding.LINEAR_PCM);
  request.setText(text);

  return new Promise((resolve, reject) => {
    console.log(`language ${language} voice ${voice} model ${model} text ${text}`);
    rivaClient.synthesize(request, (err, response) => {
      if (err) {
        console.error(err);
        return reject(err);
      }
      resolve(Buffer.from(response.getAudio()));
    });
  });
};

module.exports = synthAudio;
