const { STSClient, GetSessionTokenCommand, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const {makeAwsKey, noopLogger} = require('./utils');
const debug = require('debug')('jambonz:speech-utils');
const EXPIRY = process.env.AWS_STS_SESSION_DURATION || 3600;
// by default reset aws session before expiry time 10 mins
const CACHE_EXPIRY = process.env.AWS_STS_SESSION_RESET_EXPIRY || (EXPIRY - 600);

async function getAwsAuthToken(
  logger, createHash, retrieveHash,
  {speech_credential_sid, accessKeyId, secretAccessKey, region, roleArn}) {
  logger = logger || noopLogger;
  try {
    // if incase instance profile is used, speech_credential_sid will be used as key to lookup cache
    const key = makeAwsKey(roleArn || accessKeyId || speech_credential_sid);
    const obj = await retrieveHash(key);
    if (obj) return {...obj, servedFromCache: true};
    /* access token not found in cache, so generate it using STS */
    let data;
    let expiry = CACHE_EXPIRY;
    if (roleArn) {
      const stsClient = new STSClient({ region });
      const roleToAssume = { RoleArn: roleArn, RoleSessionName: 'Jambonz_Speech', DurationSeconds: EXPIRY};
      const command = new AssumeRoleCommand(roleToAssume);

      data = await stsClient.send(command);
    } else if (accessKeyId) {
      const stsClient = new STSClient({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        }
      });
      const command = new GetSessionTokenCommand({DurationSeconds: EXPIRY});
      data = await stsClient.send(command);
    } else {
      // instance profile is used.
      const stsClient = new STSClient({ region });
      const cred = await stsClient.config.credentials();
      // method in the AWS SDK automatically fetches credentials using the default credential
      // provider chain. If the credentials come from an instance profile or an environment
      // variable, their expiration is controlled by AWS and not explicitly by our code.
      if (cred && cred.expiration) {
        const currentTime = new Date();
        const expiryTime = new Date(cred.expiration);
        const remainingTimeInSeconds = Math.round((expiryTime - currentTime) / 1000);
        expiry = remainingTimeInSeconds;
      }
      data = {
        Credentials: {
          AccessKeyId: cred.accessKeyId,
          SecretAccessKey: cred.secretAccessKey,
          SessionToken: cred.sessionToken
        }
      };
    }

    const credentials = {
      accessKeyId: data.Credentials.AccessKeyId,
      secretAccessKey: data.Credentials.SecretAccessKey,
      sessionToken: data.Credentials.SessionToken,
      securityToken: data.Credentials.SessionToken
    };
    // Only cache if expiry is good
    if (expiry > 0) {
      createHash(key, credentials, expiry)
        .catch((err) => logger.error(err, `Error saving hash for key ${key}`));
    }

    return {...credentials, servedFromCache: false};
  } catch (err) {
    debug(err, 'getAwsAuthToken: Error retrieving AWS auth token');
    logger.error(err, 'getAwsAuthToken: Error retrieving AWS auth token');
    throw err;
  }
}

module.exports = getAwsAuthToken;
