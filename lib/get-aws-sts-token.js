const { STSClient, GetSessionTokenCommand } = require('@aws-sdk/client-sts');
const {makeAwsKey, noopLogger} = require('./utils');
const debug = require('debug')('jambonz:speech-utils');
const EXPIRY = 3600;

async function getAwsAuthToken(
  logger,
  createHash, retrieveHash,
  awsAccessKeyId, awsSecretAccessKey, awsRegion) {
  logger = logger || noopLogger;
  try {
    const key = makeAwsKey(awsAccessKeyId);
    const obj = await retrieveHash(key);
    if (obj) return {...obj, servedFromCache: true};

    /* access token not found in cache, so generate it using STS */
    const stsClient = new STSClient({
      region: awsRegion,
      credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey,
      }
    });
    const command = new GetSessionTokenCommand({DurationSeconds: EXPIRY});
    const data = await stsClient.send(command);

    const credentials = {
      accessKeyId: data.Credentials.AccessKeyId,
      secretAccessKey: data.Credentials.SecretAccessKey,
      securityToken: data.Credentials.SessionToken
    };

    /* expire 10 minutes before the hour, so we don't lose the use of it during a call */
    createHash(key, credentials, EXPIRY - 600)
      .catch((err) => logger.error(err, `Error saving hash for key ${key}`));

    return {...credentials, servedFromCache: false};
  } catch (err) {
    debug(err, 'getAwsAuthToken: Error retrieving AWS auth token');
    logger.error(err, 'getAwsAuthToken: Error retrieving AWS auth token');
    throw err;
  }
}

module.exports = getAwsAuthToken;
