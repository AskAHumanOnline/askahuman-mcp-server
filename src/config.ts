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
  const config: Config = {
    askahumanApiUrl: requireEnv('ASKAHUMAN_API_URL'),
    lndRestUrl: requireEnv('LND_REST_URL'),
    lndMacaroonHex: requireEnv('LND_MACAROON_HEX'),
    lndTlsCertPath: optionalEnv('LND_TLS_CERT_PATH'),
    logLevel: optionalEnv('LOG_LEVEL', 'info') ?? 'info',
  };

  // WARNING-1: Warn if API URL does not use HTTPS
  if (!config.askahumanApiUrl.startsWith('https://')) {
    console.warn(
      '[Config] WARNING: ASKAHUMAN_API_URL does not use https:// — API credentials will be sent in cleartext.',
    );
  }

  return config;
}
