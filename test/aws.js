const test = require('tape').test ;
const config = require('config');
const opts = config.get('redis');
const logger = require('pino')({level: 'error'});
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('AWS - create and cache auth token', async(t) => {
  const fn = require('..');
  const {client, getAwsAuthToken} = fn(opts, logger);

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_REGION) {
      t.pass('skipping AWS auth token tests since no AWS credentials provided');
      t.end();
      client.quit();
      return;
  }
  try {
    let obj = await getAwsAuthToken({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION
    });
    //console.log({obj}, 'received auth token from AWS');
    t.ok(obj.securityToken && !obj.servedFromCache, 'successfullY generated auth token from AWS');

    await sleep(250);
    obj = await getAwsAuthToken({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION
    });
    //console.log({obj}, 'received auth token from AWS - second request');
    t.ok(obj.securityToken && obj.servedFromCache, 'successfully received access token from cache');
 
    await client.flushall();
    t.end();
  }
  catch (err) {
    console.error(err);
    t.end(err);
  }
  client.quit();
});

