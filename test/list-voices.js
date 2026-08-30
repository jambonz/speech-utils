const test = require('tape').test ;
const awsCredentials = require('./aws-credentials');
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

  const credentials = awsCredentials();
  if (!credentials) {
    t.pass('skipping AWS speech synth tests since AWS_REGION not provided');
    return t.end();
  }
  try {
    const opts = {
      vendor: 'aws',
      credentials
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

test('gandr tests', async(t) => {
  const fn = require('..');
  const {client, getTtsVoices} = fn(opts, logger);

  try {
    const opts = {
      vendor: 'gandr',
      credentials: {}
    };
    let result = await getTtsVoices(opts);
    t.ok(result?.voices?.length === 6, `GetVoices: successfully retrieved ${result.voices.length} voices from gandr`);

    await client.flushall();

    t.end();
  }
  catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});
