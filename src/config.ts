/**
 * Environment variable parsing and validation.
 * Throws a descriptive error on startup if required variables are missing.
 */

export interface Config {
  askahumanApiUrl: string;
  lndRestUrl: string;
  lndMacaroonHex: string;
  lndTlsCertPath?: string;
  logLevel: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `See .env.example for configuration reference.`,
    );
  }
  return value.trim();
}

function optionalEnv(name: string, defaultValue?: string): string | undefined {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return defaultValue;
  }
  return value.trim();
}

export function loadConfig(): Config {
  return {
    askahumanApiUrl: requireEnv('ASKAHUMAN_API_URL'),
    lndRestUrl: requireEnv('LND_REST_URL'),
    lndMacaroonHex: requireEnv('LND_MACAROON_HEX'),
    lndTlsCertPath: optionalEnv('LND_TLS_CERT_PATH'),
    logLevel: optionalEnv('LOG_LEVEL', 'info') ?? 'info',
  };
}
