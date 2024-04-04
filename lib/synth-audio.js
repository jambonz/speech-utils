const assert = require('assert');
const fs = require('fs');
const bent = require('bent');
const ttsGoogle = require('@google-cloud/text-to-speech');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');

const sdk = require('microsoft-cognitiveservices-speech-sdk');
const TextToSpeechV1 = require('ibm-watson/text-to-speech/v1');
const { IamAuthenticator } = require('ibm-watson/auth');
const {
  ResultReason,
  SpeechConfig,
  SpeechSynthesizer,
  CancellationDetails,
  SpeechSynthesisOutputFormat
} = sdk;
const {
  makeSynthKey,
  createNuanceClient,
  createKryptonClient,
  createRivaClient,
  noopLogger
} = require('./utils');
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
const EXPIRES = (process.env.JAMBONES_TTS_CACHE_DURATION_MINS || 4 * 60) * 60; // cache tts for 4 hours
const TMP_FOLDER = '/tmp';
const OpenAI = require('openai');


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
async function synthAudio(client, logger, stats, { account_sid,
  vendor, language, voice, gender, text, engine, salt, model, credentials, deploymentId,
  disableTtsCache, renderForCaching, disableTtsStreaming, options
}) {
  let audioBuffer;
  let servedFromCache = false;
  let rtt;
  logger = logger || noopLogger;

  assert.ok(['google', 'aws', 'polly', 'microsoft',
    'wellsaid', 'nuance', 'nvidia', 'ibm', 'elevenlabs', 'whisper', 'deepgram'].includes(vendor) ||
  vendor.startsWith('custom'),
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
    if (!credentials.nuance_tts_uri) {
      assert.ok(credentials.client_id, 'synthAudio requires client_id in credentials when nuance is used');
      assert.ok(credentials.secret, 'synthAudio requires client_id in credentials when nuance is used');
    }
  }
  else if ('nvidia' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when nvidia is used');
    assert.ok(language, 'synthAudio requires language when nvidia is used');
    assert.ok(credentials.riva_server_uri, 'synthAudio requires riva_server_uri in credentials when nvidia is used');
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
  } else if ('elevenlabs' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when elevenlabs is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when elevenlabs is used');
    assert.ok(credentials.model_id, 'synthAudio requires model_id when elevenlabs is used');
  } else if ('whisper' === vendor) {
    assert.ok(voice, 'synthAudio requires voice when whisper is used');
    assert.ok(credentials.model_id, 'synthAudio requires model when whisper is used');
    assert.ok(credentials.api_key, 'synthAudio requires api_key when whisper is used');
  } else  if (vendor.startsWith('custom')) {
    assert.ok(credentials.custom_tts_url, `synthAudio requires custom_tts_url in credentials when ${vendor} is used`);
  }
  const key = makeSynthKey({
    account_sid,
    vendor,
    language: language || '',
    voice: voice || deploymentId,
    engine,
    text
  });
  let filePath;
  if (['nuance', 'nvidia'].includes(vendor) ||
    (
      (process.env.JAMBONES_TTS_TRIM_SILENCE || !process.env.JAMBONES_DISABLE_TTS_STREAMING) &&
      ['microsoft', 'azure'].includes(vendor)
    ) ||
    (
      !process.env.JAMBONES_DISABLE_TTS_STREAMING &&
      ['elevenlabs', 'deepgram'].includes(vendor)
    )
  ) {
    filePath = `${TMP_FOLDER}/${key.replace('tts:', `tts-${salt || ''}`)}.r8`;
  }
  else filePath = `${TMP_FOLDER}/${key.replace('tts:', `tts-${salt || ''}`)}.mp3`;
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
    audioBuffer = Buffer.from(cached, 'base64');
    client.expire(key, EXPIRES).catch((err) => logger.info(err, 'Error setting expires'));
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
        audioBuffer = await synthMicrosoft(logger, {credentials, stats, language, voice, text, deploymentId,
          filePath, renderForCaching, disableTtsStreaming});
        if (audioBuffer?.filePath) return audioBuffer;
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
      case 'elevenlabs':
        audioBuffer = await synthElevenlabs(logger, {
          credentials, options, stats, language, voice, text, renderForCaching, disableTtsStreaming, filePath
        });
        if (audioBuffer?.filePath) return audioBuffer;
        break;
      case 'whisper':
        audioBuffer = await synthWhisper(logger, {
          credentials, stats, voice, text, renderForCaching, disableTtsStreaming});
        if (audioBuffer?.filePath) return audioBuffer;
        break;
      case 'deepgram':
        audioBuffer = await synthDeepgram(logger, {credentials, stats, model, text,
          renderForCaching, disableTtsStreaming});
        if (audioBuffer?.filePath) return audioBuffer;
        break;
      case vendor.startsWith('custom') ? vendor : 'cant_match_value':
        ({ audioBuffer, filePath } = await synthCustomVendor(logger,
          {credentials, stats, language, voice, text, filePath}));
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

    client.setex(key, EXPIRES, audioBuffer.toString('base64'))
      .catch((err) => logger.error(err, `error calling setex on key ${key}`));
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
    const {region, accessKeyId, secretAccessKey} = credentials;
    const polly = new PollyClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    });
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
      ...(typeof voice === 'string' && {name: voice}),
      ...(typeof voice === 'object' && {customVoice: voice}),
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

async function _synthOnPremMicrosoft(logger, {
  credentials,
  stats,
  language,
  voice,
  text,
  filePath
}) {
  const {use_custom_tts, custom_tts_endpoint_url} = credentials;
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

  try {
    const trimSilence = filePath.endsWith('.r8');
    const post = bent('POST', 'buffer', {
      'X-Microsoft-OutputFormat': trimSilence ? 'raw-8khz-16bit-mono-pcm' : 'audio-16khz-32kbitrate-mono-mp3',
      'Content-Type': 'application/ssml+xml',
      'User-Agent': 'Jambonz'
    });
    const mp3 = await post(custom_tts_endpoint_url, content);
    return mp3;
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
  text,
  filePath,
  renderForCaching,
  disableTtsStreaming
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
    if (!process.env.JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
      let params = '';
      params += `{api_key=${apiKey}`;
      params += `,language=${language}`;
      params += ',vendor=microsoft';
      params += `,voice=${voice}`;
      params += ',write_cache_file=1';
      if (region) params += `,region=${region}`;
      if (custom_tts_endpoint) params += `,endpointId=${custom_tts_endpoint}`;
      if (process.env.JAMBONES_HTTP_PROXY_IP) params += `,http_proxy_ip=${process.env.JAMBONES_HTTP_PROXY_IP}`;
      if (process.env.JAMBONES_HTTP_PROXY_PORT) params += `,http_proxy_port=${process.env.JAMBONES_HTTP_PROXY_PORT}`;
      params += '}';
      return {
        filePath: `say:${params}${content.replace(/\n/g, ' ')}`,
        servedFromCache: false,
        rtt: 0
      };
    }
    if (use_custom_tts && custom_tts_endpoint_url) {
      return await _synthOnPremMicrosoft(logger, {
        credentials,
        stats,
        language,
        voice,
        text,
        filePath
      });
    }
    const trimSilence = filePath.endsWith('.r8');
    const speechConfig = SpeechConfig.fromSubscription(apiKey, region);
    speechConfig.speechSynthesisLanguage = language;
    speechConfig.speechSynthesisVoiceName = voice;
    if (use_custom_tts && custom_tts_endpoint) {
      speechConfig.endpointId = custom_tts_endpoint;
    }
    speechConfig.speechSynthesisOutputFormat = trimSilence ?
      SpeechSynthesisOutputFormat.Raw8Khz16BitMonoPcm :
      SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

    if (process.env.JAMBONES_HTTP_PROXY_IP && process.env.JAMBONES_HTTP_PROXY_PORT) {
      logger.debug(
        `synthMicrosoft: using proxy ${process.env.JAMBONES_HTTP_PROXY_IP}:${process.env.JAMBONES_HTTP_PROXY_PORT}`);
      speechConfig.setProxy(process.env.JAMBONES_HTTP_PROXY_IP, process.env.JAMBONES_HTTP_PROXY_PORT);
    }
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
              resolve(buffer);
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
  let nuanceClient;
  const {client_id, secret, nuance_tts_uri} = credentials;
  if (nuance_tts_uri) {
    nuanceClient = await createKryptonClient(nuance_tts_uri);
  }
  else {
    /* get a nuance access token */
    const {access_token} = await getNuanceAccessToken(client, logger, client_id, secret, 'tts');
    nuanceClient = await createNuanceClient(access_token);
  }

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
  const {riva_server_uri} = credentials;
  let rivaClient, request;
  try {
    rivaClient = await createRivaClient(riva_server_uri);
    request = new SynthesizeSpeechRequest();
    request.setVoiceName(voice);
    request.setLanguageCode(language);
    request.setSampleRateHz(8000);
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
      resolve(Buffer.from(response.getAudio()));
    });
  });
};


const synthCustomVendor = async(logger, {credentials, stats, language, voice, text, filePath}) => {
  const {vendor, auth_token, custom_tts_url} = credentials;

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

    const regex = /\.[^\.]*$/g;
    const mime = response.headers['content-type'];
    const buffer = await response.arrayBuffer();
    return {
      audioBuffer: buffer,
      filePath: filePath.replace(regex, getFileExtFromMime(mime))
    };
  } catch (err) {
    logger.info({err}, `Vendor ${vendor} returned error`);
    throw err;
  }
};

const synthElevenlabs = async(logger, {
  credentials, options, stats, voice, text, renderForCaching, disableTtsStreaming
}) => {
  const {api_key, model_id, options: credOpts} = credentials;
  const opts = !!options && Object.keys(options).length !== 0 ? options : JSON.parse(credOpts || '{}');

  /* default to using the streaming interface, unless disabled by env var OR we want just a cache file */
  if (!process.env.JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '';
    params += `{api_key=${api_key}`;
    params += ',vendor=elevenlabs';
    params += `,voice=${voice}`;
    params += `,model_id=${model_id}`;
    params += `,optimize_streaming_latency=${opts.optimize_streaming_latency || 2}`;
    params += ',write_cache_file=1';
    if (opts.voice_settings?.similarity_boost) params += `,similarity_boost=${opts.voice_settings.similarity_boost}`;
    if (opts.voice_settings?.stability) params += `,stability=${opts.voice_settings.stability}`;
    if (opts.voice_settings?.style) params += `,style=${opts.voice_settings.style}`;
    if (opts.voice_settings?.use_speaker_boost === false) params += ',use_speaker_boost=false';
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
    const post = bent('https://api.elevenlabs.io', 'POST', 'buffer', {
      'xi-api-key': api_key,
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json'
    });
    const mp3 = await post(`/v1/text-to-speech/${voice}${optimize_streaming_latency}`, {
      text,
      model_id,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.5
      },
      ...opts
    });
    return mp3;
  } catch (err) {
    logger.info({err}, 'synth Elevenlabs returned error');
    stats.increment('tts.count', ['vendor:elevenlabs', 'accepted:no']);
    throw err;
  }
};

const synthWhisper = async(logger, {credentials, stats, voice, text, renderForCaching, disableTtsStreaming}) => {
  const {api_key, model_id, baseURL, timeout, speed} = credentials;
  /* if the env is set to stream then bag out, unless we are specifically rendering to generate a cache file */
  if (!process.env.JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '';
    params += `{api_key=${api_key}`;
    params += `,model_id=${model_id}`;
    params += ',vendor=whisper';
    params += `,voice=${voice}`;
    params += ',write_cache_file=1';
    if (speed) params += `,speed=${speed}`;
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
      response_format: 'mp3'
    });
    return Buffer.from(await mp3.arrayBuffer());
  } catch (err) {
    logger.info({err}, 'synth whisper returned error');
    stats.increment('tts.count', ['vendor:openai', 'accepted:no']);
    throw err;
  }
};

const synthDeepgram = async(logger, {credentials, stats, model, text, renderForCaching, disableTtsStreaming}) => {
  const {api_key} = credentials;
  if (!process.env.JAMBONES_DISABLE_TTS_STREAMING && !renderForCaching && !disableTtsStreaming) {
    let params = '';
    params += `{api_key=${api_key}`;
    params += ',vendor=deepgram';
    params += `,voice=${model}`;
    params += ',write_cache_file=1';
    params += '}';

    return {
      filePath: `say:${params}${text.replace(/\n/g, ' ')}`,
      servedFromCache: false,
      rtt: 0
    };
  }
  try {
    const post = bent('https://api.deepgram.com', 'POST', 'buffer', {
      'Authorization': `Token ${api_key}`,
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json'
    });
    const mp3 = await post(`/v1/speak?model=${model}`, {
      text
    });
    return mp3;
  } catch (err) {
    logger.info({err}, 'synth Deepgram returned error');
    stats.increment('tts.count', ['vendor:deepgram', 'accepted:no']);
    throw err;
  }
};

const getFileExtFromMime = (mime) => {
  switch (mime) {
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case /audio\/l16.*rate=8000/.test(mime) ? mime : 'cant match value':
      return '.r8';
    case /audio\/l16.*rate=16000/.test(mime) ? mime : 'cant match value':
      return '.r16';
    case /audio\/l16.*rate=24000/.test(mime) ? mime : 'cant match value':
      return '.r24';
    case /audio\/l16.*rate=32000/.test(mime) ? mime : 'cant match value':
      return '.r32';
    case /audio\/l16.*rate=48000/.test(mime) ? mime : 'cant match value':
      return '.r48';
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3';
    default:
      return '.wav';
  }
};

module.exports = synthAudio;
