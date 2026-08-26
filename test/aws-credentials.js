/**
 * Resolve AWS credentials for the test suite.
 *
 * Returns null when AWS is not configured, so the caller skips.
 *
 * When AWS_SESSION_TOKEN is set the credentials are temporary -- GitHub OIDC in CI, or
 * `aws sso login` locally -- and the key pair must not be passed through. Doing so sends
 * lib/get-aws-sts-token.js down its accessKeyId branch, which calls GetSessionToken, and
 * AWS rejects GetSessionToken when it is called with session credentials. Returning the
 * region alone routes to the SDK's default credential provider chain instead, which
 * handles temporary credentials correctly.
 */
module.exports = () => {
  const region = process.env.AWS_REGION;
  if (!region) return null;

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (process.env.AWS_SESSION_TOKEN) return {region};
  if (accessKeyId && secretAccessKey) return {accessKeyId, secretAccessKey, region};
  return {region};
};
