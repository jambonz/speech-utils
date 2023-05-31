const test = require('tape').test ;
const config = require('config');
const opts = config.get('redis');
const fs = require('fs');
const logger = require('pino')({level: 'error'});
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const stats = {
  increment: () => {},
  histogram: () => {}
};

test('IBM - create access key', async(t) => {
  const fn = require('..');
  const {client, getIbmAccessToken} = fn(opts, logger);

  if (!process.env.IBM_API_KEY ) {
      t.pass('skipping IBM test since no IBM api_key provided');
      t.end();
      client.quit();
      return;
  }
  try {
    let obj = await getIbmAccessToken(process.env.IBM_API_KEY);
    //console.log({obj}, 'received access token from IBM');
    t.ok(obj.access_token && !obj.servedFromCache, 'successfull received access token from IBM');

    obj = await getIbmAccessToken(process.env.IBM_API_KEY);
    //console.log({obj}, 'received access token from IBM - second request');
    t.ok(obj.access_token && obj.servedFromCache, 'successfully received access token from cache');
 
    await client.flushall();
    t.end();
  }
  catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('IBM - retrieve tts voices test', async(t) => {
  const fn = require('..');
  const {client, getTtsVoices} = fn(opts, logger);

  if (!process.env.IBM_TTS_API_KEY || !process.env.IBM_TTS_REGION) {
      t.pass('skipping IBM test since no IBM api_key and/or region provided');
      t.end();
      client.quit();
      return;
  }
  try {
    const opts = {
      vendor: 'ibm',
      credentials: {
        tts_api_key: process.env.IBM_TTS_API_KEY,
        tts_region: process.env.IBM_TTS_REGION
      }
    };
    const obj = await getTtsVoices(opts);
    const {voices} = obj.result;
    //console.log(JSON.stringify(voices));
    t.ok(voices.length > 0 && voices[0].language, 
      `GetVoices: successfully retrieved ${voices.length} voices from IBM`);
 
    await client.flushall();

    t.end();

  }
  catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('Nuance hosted tests', async(t) => {
  const fn = require('..');
  const {client, getTtsVoices} = fn(opts, logger);

  if (!process.env.NUANCE_CLIENT_ID || !process.env.NUANCE_SECRET ) {
      t.pass('skipping Nuance hosted test since no Nuance client_id and secret provided');
      t.end();
      client.quit();
      return;
  }
  try {
    const opts = {
      vendor: 'nuance',
      credentials: {
        client_id: process.env.NUANCE_CLIENT_ID,
        secret: process.env.NUANCE_SECRET
      }
    };
    let voices = await getTtsVoices(opts);
    t.ok(voices.length > 0 && voices[0].language, 
      `GetVoices: successfully retrieved ${voices.length} voices from Nuance`);

    await client.flushall();

    t.end();

  }
  catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('Nuance on-prem tests', async(t) => {
  const fn = require('..');
  const {client, getTtsVoices} = fn(opts, logger);

  if (!process.env.NUANCE_TTS_URI ) {
      t.pass('skipping Nuance on-prem test since no Nuance uri provided');
      t.end();
      client.quit();
      return;
  }
  try {
    const opts = {
      vendor: 'nuance',
      credentials: {
        nuance_tts_uri: process.env.NUANCE_TTS_URI
      }
    };
    let voices = await getTtsVoices(opts);
    t.ok(voices.length > 0 && voices[0].language, 
      `GetVoices: successfully retrieved ${voices.length} voices from Nuance`);

    await client.flushall();

    t.end();

  }
  catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('Google tests', async(t) => {
  const fn = require('..');
  const {client, getTtsVoices} = fn(opts, logger);

  if (!process.env.GCP_FILE && !process.env.GCP_JSON_KEY) {
    t.pass('skipping google speech synth tests since neither GCP_FILE nor GCP_JSON_KEY provided');
    return t.end();
  }
  try {
    const str = process.env.GCP_JSON_KEY || fs.readFileSync(process.env.GCP_FILE);
    const credentials = JSON.parse(str);
    const opts = {
      vendor: 'google',
      credentials
    };
    let result = await getTtsVoices(opts);
    t.ok(result[0].voices.length > 0, `GetVoices: successfully retrieved ${result[0].voices.length} voices from Google`);

    await client.flushall();

    t.end();
  }
  catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

test('AWS tests', async(t) => {
  const fn = require('..');
  const {client, getTtsVoices} = fn(opts, logger);

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_REGION) {
    t.pass('skipping AWS speech synth tests since AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, or AWS_REGION not provided');
    return t.end();
  }
  try {
    const opts = {
      vendor: 'aws',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION,
      }
    };
    let result = await getTtsVoices(opts);
    t.ok(result?.Voices?.length > 0, `GetVoices: successfully retrieved ${result.Voices.length} voices from AWS`);

    await client.flushall();

    t.end();
  }
  catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});
