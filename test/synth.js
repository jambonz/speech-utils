const test = require('tape').test;
const config = require('config');
const opts = config.get('redis');
const fs = require('fs');
const {makeSynthKey} = require('../lib/utils');
const logger = require('pino')();
const bent = require('bent');
const getJSON = bent('json')

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const stats = {
  increment: () => {
  },
  histogram: () => {
  },
};

test('Google speech synth tests', async(t) => {
  const fn = require('..');
  const {synthAudio, client} = fn(opts, logger);

  if (!process.env.GCP_FILE && !process.env.GCP_JSON_KEY) {
    t.pass('skipping google speech synth tests since neither GCP_FILE nor GCP_JSON_KEY provided');
    return t.end();
  }
  try {
    const str = process.env.GCP_JSON_KEY || fs.readFileSync(process.env.GCP_FILE);
    const creds = JSON.parse(str);
    let opts = await synthAudio(stats, {
      vendor: 'google',
      credentials: {
        credentials: {
          client_email: creds.client_email,
          private_key: creds.private_key,
        },
      },
      language: 'en-GB',
      gender: 'MALE',
      text: 'This is a test.  This is only a test',
      salt: 'foo.bar',
    });
    t.ok(!opts.servedFromCache, `successfully synthesized google audio to ${opts.filePath}`);

    opts = await synthAudio(stats, {
      vendor: 'google',
      credentials: {
        credentials: {
          client_email: creds.client_email,
          private_key: creds.private_key,
        },
      },
      language: 'en-GB',
      gender: 'MALE',
      text: 'This is a test.  This is only a test',
    });
    t.ok(opts.servedFromCache, `successfully retrieved cached google audio from ${opts.filePath}`);

    opts = await synthAudio(stats, {
      vendor: 'google',
      credentials: {
        credentials: {
          client_email: creds.client_email,
          private_key: creds.private_key,
        },
      },
      disableTtsCache: true,
      language: 'en-GB',
      gender: 'MALE',
      text: 'This is a test.  This is only a test',
    });
    t.ok(!opts.servedFromCache, `successfully synthesized google audio regardless of current cache to ${opts.filePath}`);
  } catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('AWS speech synth tests', async(t) => {
  const fn = require('..');
  const {synthAudio, client} = fn(opts, logger);

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_REGION) {
    t.pass('skipping AWS speech synth tests since AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, or AWS_REGION not provided');
    return t.end();
  }
  try {
    let opts = await synthAudio(stats, {
      vendor: 'aws',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION,
      },
      language: 'en-US',
      voice: 'Joey',
      text: 'This is a test.  This is only a test',
    });
    t.ok(!opts.servedFromCache, `successfully synthesized aws audio to ${opts.filePath}`);

    opts = await synthAudio(stats, {
      vendor: 'aws',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION,
      },
      language: 'en-US',
      voice: 'Joey',
      text: 'This is a test.  This is only a test',
    });
    t.ok(opts.servedFromCache, `successfully retrieved aws audio from cache ${opts.filePath}`);
  } catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('Azure speech synth tests', async(t) => {
  const fn = require('..');
  const {synthAudio, client} = fn(opts, logger);

  if (!process.env.MICROSOFT_API_KEY || !process.env.MICROSOFT_REGION) {
    t.pass('skipping Microsoft speech synth tests since MICROSOFT_API_KEY or MICROSOFT_REGION not provided');
    return t.end();
  }
  try {
    const longText = `Henry is best known for his six marriages, including his efforts to have his first marriage 
    (to Catherine of Aragon) annulled. His disagreement with Pope Clement VII about such an 
    annulment led Henry to initiate the English Reformation, 
    separating the Church of England from papal authority. He appointed himself Supreme Head of the Church of England 
    and dissolved convents and monasteries, for which he was excommunicated. 
    Henry is also known as "the father of the Royal Navy," as he invested heavily in the navy, 
    increasing its size from a few to more than 50 ships, and established the Navy Board.`;

    let opts = await synthAudio(stats, {
      vendor: 'microsoft',
      credentials: {
        api_key: process.env.MICROSOFT_API_KEY,
        region: process.env.MICROSOFT_REGION,
      },
      language: 'en-US',
      voice: 'en-US-ChristopherNeural',
      text: longText,
    });
    t.ok(!opts.servedFromCache, `successfully synthesized microsoft audio to ${opts.filePath}`);


    opts = await synthAudio(stats, {
      vendor: 'microsoft',
      credentials: {
        api_key: process.env.MICROSOFT_API_KEY,
        region: process.env.MICROSOFT_REGION,
      },
      language: 'en-US',
      voice: 'en-US-ChristopherNeural',
      text: longText,
    });
    t.ok(opts.servedFromCache, `successfully retrieved microsoft audio from cache ${opts.filePath}`);
  } catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('Azure custom voice speech synth tests', async(t) => {
  const fn = require('..');
  const {synthAudio, client} = fn(opts, logger);

  if (!process.env.MICROSOFT_CUSTOM_API_KEY || !process.env.MICROSOFT_DEPLOYMENT_ID || !process.env.MICROSOFT_CUSTOM_REGION) {
    t.pass('skipping Microsoft speech synth custom voice tests since MICROSOFT_CUSTOM_API_KEY or MICROSOFT_DEPLOYMENT_ID or MICROSOFT_CUSTOM_REGION not provided');
    return t.end();
  }
  try {
    const text = 'Hi, this is my custom voice. How does it sound to you?  Do I have a future as a virtual bot?';
    let opts = await synthAudio(stats, {
      vendor: 'microsoft',
      credentials: {
        api_key: process.env.MICROSOFT_CUSTOM_API_KEY,
        region: process.env.MICROSOFT_CUSTOM_REGION,
        use_custom_tts: true,
        custom_tts_endpoint: process.env.MICROSOFT_DEPLOYMENT_ID,
      },
      language: 'en-US',
      voice: process.env.MICROSOFT_CUSTOM_VOICE,
      text,
    });
    t.ok(!opts.servedFromCache, `successfully synthesized microsoft audio to ${opts.filePath}`);

    opts = await synthAudio(stats, {
      vendor: 'microsoft',
      credentials: {
        api_key: process.env.MICROSOFT_CUSTOM_API_KEY,
        region: process.env.MICROSOFT_CUSTOM_REGION,
        use_custom_tts: true,
        custom_tts_endpoint: process.env.MICROSOFT_DEPLOYMENT_ID,
      },
      language: 'en-US',
      voice: process.env.MICROSOFT_CUSTOM_VOICE,
      text,
    });
    t.ok(opts.servedFromCache, `successfully retrieved microsoft custom voice audio from cache ${opts.filePath}`);
  } catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('Nuance speech synth tests', async(t) => {
  const fn = require('..');
  const {synthAudio, client} = fn(opts, logger);

  if (!process.env.NUANCE_CLIENT_ID || !process.env.NUANCE_SECRET) {
    t.pass('skipping Nuance speech synth tests since NUANCE_CLIENT_ID or NUANCE_SECRET not provided');
    return t.end();
  }
  try {
    let opts = await synthAudio(stats, {
      vendor: 'nuance',
      credentials: {
        client_id: process.env.NUANCE_CLIENT_ID,
        secret: process.env.NUANCE_SECRET,
      },
      language: 'en-US',
      voice: 'Evan',
      text: 'This is a test.  This is only a test',
    });
    t.ok(!opts.servedFromCache, `successfully synthesized nuance audio to ${opts.filePath}`);

    opts = await synthAudio(stats, {
      vendor: 'nuance',
      credentials: {
        client_id: process.env.NUANCE_CLIENT_ID,
        secret: process.env.NUANCE_SECRET,
      },
      language: 'en-US',
      voice: 'Evan',
      text: 'This is a test.  This is only a test',
    });
    t.ok(opts.servedFromCache, `successfully retrieved nuance audio from cache ${opts.filePath}`);
  } catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('Nvidia speech synth tests', async(t) => {
  const fn = require('..');
  const {synthAudio, client} = fn(opts, logger);

  if (!process.env.RIVA_URI) {
    t.pass('skipping Nvidia speech synth tests since RIVA_URI not provided');
    return t.end();
  }
  try {
    let opts = await synthAudio(stats, {
      vendor: 'nvidia',
      credentials: {
        riva_uri: process.env.RIVA_URI,
      },
      language: 'en-US',
      voice: 'English-US.Female-1',
      text: 'This is a test.  This is only a test',
    });
    t.ok(!opts.servedFromCache, `successfully synthesized nuance audio to ${opts.filePath}`);

    opts = await synthAudio(stats, {
      vendor: 'nvidia',
      credentials: {
        riva_uri: process.env.RIVA_URI,
      },
      language: 'en-US',
      voice: 'English-US.Female-1',
      text: 'This is a test.  This is only a test',
    });
    t.ok(opts.servedFromCache, `successfully retrieved nuance audio from cache ${opts.filePath}`);
  } catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('IBM watson speech synth tests', async(t) => {
  const fn = require('..');
  const {synthAudio, client} = fn(opts, logger);

  if (!process.env.IBM_TTS_API_KEY || !process.env.IBM_TTS_REGION) {
    t.pass('skipping IBM Watson speech synth tests since IBM_TTS_API_KEY or IBM_TTS_API_KEY not provided');
    return t.end();
  }
  const text = `<speak> Hi there and welcome to jambones! jambones is the <sub alias="seapass">CPaaS</sub> designed with the needs of communication service providers in mind. This is an example of simple text-to-speech, but there is so much more you can do. Try us out!</speak>`;
  try {
    let opts = await synthAudio(stats, {
      vendor: 'ibm',
      credentials: {
        tts_api_key: process.env.IBM_TTS_API_KEY,
        tts_region: process.env.IBM_TTS_REGION,
      },
      language: 'en-US',
      voice: 'en-US_AllisonV2Voice',
      text,
    });
    t.ok(!opts.servedFromCache, `successfully synthesized ibm audio to ${opts.filePath}`);

    opts = await synthAudio(stats, {
      vendor: 'ibm',
      credentials: {
        tts_api_key: process.env.IBM_TTS_API_KEY,
        tts_region: process.env.IBM_TTS_REGION,
      },
      language: 'en-US',
      voice: 'en-US_AllisonV2Voice',
      text,
    });
    t.ok(opts.servedFromCache, `successfully retrieved ibm audio from cache ${opts.filePath}`);
  } catch (err) {
    console.error(JSON.stringify(err));
    t.end(err);
  }
  client.quit();
});

test('Custom Vendor speech synth tests', async(t) => {
  const fn = require('..');
  const {synthAudio, client} = fn(opts, logger);

  try {
    let opts = await synthAudio(stats, {
      vendor: 'custom:somethingnew',
      credentials: {
        use_for_tts: 1,
        custom_tts_url: "http://127.0.0.1:3100/somethingnew",
        auth_token: 'some_jwt_token'
      },
      language: 'en-US',
      voice: 'English-US.Female-1',
      text: 'This is a test.  This is only a test',
    });
    t.ok(!opts.servedFromCache, `successfully synthesized custom vendor audio to ${opts.filePath}`);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/somethingnew`);
    t.ok(obj.headers.Authorization == 'Bearer some_jwt_token', 'Custom Vendor Authentication Header is correct');
    t.ok(obj.body.language == 'en-US', 'Custom Vendor Language is correct');
    t.ok(obj.body.format == 'audio/mpeg', 'Custom Vendor format is correct');
    t.ok(obj.body.voice == 'English-US.Female-1', 'Custom Vendor voice is correct');
    t.ok(obj.body.type == 'text', 'Custom Vendor type is correct');
    t.ok(obj.body.text == 'This is a test.  This is only a test', 'Custom Vendor text is correct');

    opts = await synthAudio(stats, {
      vendor: 'custom:somethingnew2',
      credentials: {
        use_for_tts: 1,
        custom_tts_url: "http://127.0.0.1:3100/somethingnew2",
        auth_token: 'some_jwt_token'
      },
      language: 'en-US',
      voice: 'English-US.Female-1',
      text: '<speak>This is a test.  This is only a test</speak>',
    });
    t.ok(!opts.servedFromCache, `successfully synthesized Custom Vendor audio to ${opts.filePath}`);
    obj = await getJSON(`http://127.0.0.1:3100/lastRequest/somethingnew2`);
    t.ok(obj.body.type == 'ssml', 'Custom Vendor type is correct');
    t.ok(obj.body.text == '<speak>This is a test.  This is only a test</speak>');
  } catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('TTS Cache tests', async(t) => {
  const fn = require('..');
  const {purgeTtsCache, client} = fn(opts, logger);

  try {
    // save some random tts keys to cache
    const minRecords = 8;
    for (const i in Array(minRecords).fill(0)) {
      await client.setAsync(makeSynthKey({vendor: i, language: i, voice: i, engine: i, text: i}), i);
    }
    const {purgedCount} = await purgeTtsCache();
    t.ok(purgedCount >= minRecords, `successfully purged at least ${minRecords} tts records from cache`);

    const cached = (await client.keysAsync('tts:*')).length;
    t.equal(cached, 0, `successfully purged all tts records from cache`);

  } catch (err) {
    console.error(JSON.stringify(err));
    t.end(err);
  }

  try {
    // save some random tts keys to cache
    for (const i in Array(10).fill(0)) {
      await client.setAsync(makeSynthKey({vendor: i, language: i, voice: i, engine: i, text: i}), i);
    }
    // save a specific key to tts cache
    const opts = {vendor: 'aws', language: 'en-US', voice: 'MALE', engine: 'Engine', text: 'Hello World!'};
    await client.setAsync(makeSynthKey(opts), opts.text);

    const {purgedCount} = await purgeTtsCache({all: false, ...opts});
    t.ok(purgedCount === 1, `successfully purged one specific tts record from cache`);

    // returns error for unknown key
    const {purgedCount: purgedCountWhenErrored, error} = await purgeTtsCache({
      all: false,
      vendor: 'non-existing',
      language: 'non-existing',
      voice: 'non-existing',
    });
    t.ok(purgedCountWhenErrored === 0, `purged no records when specified key was not found`);
    t.ok(error, `error returned when specified key was not found`);

    // make sure other tts keys are still there
    const cached = (await client.keysAsync('tts:*')).length;
    t.ok(cached >= 1, `successfully kept all non-specified tts records in cache`);

  } catch (err) {
    console.error(JSON.stringify(err));
    t.end(err);
  }

  client.quit();
});
