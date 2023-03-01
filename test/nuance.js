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

test('Nuance tests', async(t) => {
  const fn = require('..');
  const {client, getTtsVoices} = fn(opts, logger);

  if (!process.env.NUANCE_CLIENT_ID || !process.env.NUANCE_SECRET ) {
      t.pass('skipping Nuance test since no Nuance client_id and secret provided');
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
    //console.log(`received ${voices.length} voices from Nuance`);
    //console.log(JSON.stringify(voices));
    t.ok(voices.length > 0 && voices[0].language, 
      `GetVoices: successfully retrieved ${voices.length} voices from Nuance`);

    await client.flushallAsync();

    t.end();

  }
  catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

