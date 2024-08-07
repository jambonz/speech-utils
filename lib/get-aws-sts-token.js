const { STSClient, GetSessionTokenCommand, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const {makeAwsKey, noopLogger} = require('./utils');
const debug = require('debug')('jambonz:speech-utils');
const EXPIRY = process.env.AWS_STS_SESSION_DURATION || 3600;
// by default reset aws session before expiry time 10 mins
const CACHE_EXPIRY = process.env.AWS_STS_SESSION_RESET_EXPIRY || (EXPIRY - 600);

async function getAwsAuthToken(
  logger, createHash, retrieveHash,
  {accessKeyId, secretAccessKey, region, roleArn}) {
  logger = logger || noopLogger;
  try {
    const key = makeAwsKey(roleArn || accessKeyId);
    const obj = await retrieveHash(key);
    if (obj) return {...obj, servedFromCache: true};

    let data;
    if (roleArn) {
      const stsClient = new STSClient({ region });
      const roleToAssume = { RoleArn: roleArn, RoleSessionName: 'Jambonz_Speech', DurationSeconds: EXPIRY};
      const command = new AssumeRoleCommand(roleToAssume);

      data = await stsClient.send(command);
    } else {
      /* access token not found in cache, so generate it using STS */
      const stsClient = new STSClient({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        }
      });
      const command = new GetSessionTokenCommand({DurationSeconds: EXPIRY});
      data = await stsClient.send(command);
    }

    const credentials = {
      accessKeyId: data.Credentials.AccessKeyId,
      secretAccessKey: data.Credentials.SecretAccessKey,
      sessionToken: data.Credentials.SessionToken,
      securityToken: data.Credentials.SessionToken
    };

    createHash(key, credentials, CACHE_EXPIRY)
      .catch((err) => logger.error(err, `Error saving hash for key ${key}`));

    return {...credentials, servedFromCache: false};
  } catch (err) {
    debug(err, 'getAwsAuthToken: Error retrieving AWS auth token');
    logger.error(err, 'getAwsAuthToken: Error retrieving AWS auth token');
    throw err;
  }
}

module.exports = getAwsAuthToken;
