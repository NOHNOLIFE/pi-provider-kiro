// ABOUTME: Reads credentials written by the Kiro IDE (including KAM-injected sessions).
// ABOUTME: Treats the IDE cache as a bootstrap source only; Pi owns refresh-token rotation after import.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KiroCredentials } from "./oauth.js";

const SSO_CACHE_DIR = join(homedir(), ".aws", "sso", "cache");
const KIRO_IDE_TOKEN_PATH = join(SSO_CACHE_DIR, "kiro-auth-token.json");
const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

interface KiroIdeTokenFile {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  region?: string;
  clientIdHash?: string;
  authMethod?: string;
  provider?: string;
  profileArn?: string;
}

interface KiroIdeClientFile {
  clientId: string;
  clientSecret: string;
  expiresAt?: string;
}

function isSocialIdeToken(tokenData: KiroIdeTokenFile): boolean {
  const authMethod = tokenData.authMethod?.trim().toLowerCase();
  const provider = tokenData.provider?.trim().toLowerCase();

  if (authMethod === "social" || authMethod === "desktop") return true;
  if (authMethod === "idc") return false;

  if (provider === "google" || provider === "github") return true;
  if (provider === "builderid" || provider === "builder-id" || provider === "enterprise") return false;

  // Legacy social cache files may omit authMethod/provider. IdC sessions need
  // clientIdHash so the IDE can locate the companion OIDC client registration.
  return !tokenData.clientIdHash;
}

/**
 * Convert Kiro IDE's on-disk token shape into the provider's OAuth shape.
 *
 * KAM writes the same two families as Kiro IDE:
 * - social: authMethod="social", no clientIdHash, refreshes via Kiro desktop auth
 * - IdC:    authMethod="IdC", clientIdHash + companion client registration
 */
export function parseKiroIdeCredentials(
  tokenData: KiroIdeTokenFile,
  clientData: KiroIdeClientFile | undefined,
  allowExpired: boolean,
): KiroCredentials | undefined {
  if (!tokenData.accessToken || !tokenData.refreshToken || !tokenData.expiresAt) return undefined;

  const realExpiresAt = new Date(tokenData.expiresAt).getTime();
  if (!Number.isFinite(realExpiresAt)) return undefined;

  const expires = realExpiresAt - EXPIRES_BUFFER_MS;
  if (!allowExpired && Date.now() >= expires) return undefined;

  const region = tokenData.region || "us-east-1";
  if (isSocialIdeToken(tokenData)) {
    return {
      refresh: `${tokenData.refreshToken}|desktop`,
      access: tokenData.accessToken,
      expires,
      clientId: "",
      clientSecret: "",
      region: "us-east-1",
      authMethod: "desktop",
      profileArn: tokenData.profileArn,
    };
  }

  const clientId = clientData?.clientId ?? "";
  const clientSecret = clientData?.clientSecret ?? "";
  return {
    refresh: `${tokenData.refreshToken}|${clientId}|${clientSecret}|idc`,
    access: tokenData.accessToken,
    expires,
    clientId,
    clientSecret,
    region,
    authMethod: "idc",
    profileArn: tokenData.profileArn,
  };
}

function readKiroIdeToken(allowExpired: boolean): KiroCredentials | undefined {
  try {
    if (!existsSync(KIRO_IDE_TOKEN_PATH)) return undefined;

    const tokenData = JSON.parse(readFileSync(KIRO_IDE_TOKEN_PATH, "utf-8")) as KiroIdeTokenFile;
    let clientData: KiroIdeClientFile | undefined;

    if (tokenData.clientIdHash) {
      const regPath = join(SSO_CACHE_DIR, `${tokenData.clientIdHash}.json`);
      if (existsSync(regPath)) {
        try {
          clientData = JSON.parse(readFileSync(regPath, "utf-8")) as KiroIdeClientFile;
        } catch {
          clientData = undefined;
        }
      }
    }

    return parseKiroIdeCredentials(tokenData, clientData, allowExpired);
  } catch {
    return undefined;
  }
}

/** Returns a usable Kiro IDE/KAM credential for one-time import into Pi. */
export function getKiroIdeCredentials(): KiroCredentials | undefined {
  return readKiroIdeToken(false);
}

/** Returns the IDE/KAM credential even near/after expiry so Pi can refresh it once during import. */
export function getKiroIdeCredentialsAllowExpired(): KiroCredentials | undefined {
  return readKiroIdeToken(true);
}
