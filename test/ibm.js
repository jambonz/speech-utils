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
 
    await client.flushallAsync();
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
 
    await client.flushallAsync();

    t.end();

  }
  catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});
