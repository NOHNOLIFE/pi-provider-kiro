// ABOUTME: Reads credentials written by the Kiro IDE.
// ABOUTME: The IDE stores its auth token at ~/.aws/sso/cache/kiro-auth-token.json
// ABOUTME: on all platforms (Windows, macOS, Linux) after every successful login,
// ABOUTME: including IAM Identity Center (authMethod: "IdC") and Builder ID.
// ABOUTME: A companion file, ~/.aws/sso/cache/{clientIdHash}.json, holds the
// ABOUTME: OIDC clientId/clientSecret needed to silently refresh the access token
// ABOUTME: via the standard AWS OIDC /token endpoint — no extra login flow needed.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KiroCredentials } from "./oauth.js";

// ~/.aws/sso/cache is the standard AWS SSO cache directory on all platforms.
// Node's os.homedir() returns the correct home directory on Windows, macOS and Linux.
const SSO_CACHE_DIR = join(homedir(), ".aws", "sso", "cache");
const KIRO_IDE_TOKEN_PATH = join(SSO_CACHE_DIR, "kiro-auth-token.json");

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

function readKiroIdeToken(allowExpired: boolean): KiroCredentials | undefined {
  try {
    if (!existsSync(KIRO_IDE_TOKEN_PATH)) return undefined;

    const tokenData = JSON.parse(readFileSync(KIRO_IDE_TOKEN_PATH, "utf-8")) as KiroIdeTokenFile;
    if (!tokenData.accessToken || !tokenData.refreshToken) return undefined;

    const expiresAt = new Date(tokenData.expiresAt).getTime();
    if (!allowExpired && Date.now() >= expiresAt - 2 * 60 * 1000) return undefined;

    const profileRegion = tokenData.profileArn?.split(":")[3];
    const region = tokenData.region || profileRegion || "us-east-1";
    const authMethod = tokenData.authMethod?.toLowerCase();
    const provider = tokenData.provider?.toLowerCase();
    const isSocial =
      authMethod === "social" ||
      provider === "google" ||
      provider === "github";

    if (isSocial) {
      return {
        refresh: `${tokenData.refreshToken}|desktop`,
        access: tokenData.accessToken,
        expires: expiresAt - 2 * 60 * 1000,
        clientId: "",
        clientSecret: "",
        region,
        authMethod: "desktop",
        profileArn: tokenData.profileArn,
        credentialSource: "ide",
      };
    }

    // IdC / Builder ID sessions use the AWS OIDC client registration stored in
    // the companion cache file.
    let clientId = "";
    let clientSecret = "";
    if (tokenData.clientIdHash) {
      const regPath = join(SSO_CACHE_DIR, `${tokenData.clientIdHash}.json`);
      if (existsSync(regPath)) {
        try {
          const reg = JSON.parse(readFileSync(regPath, "utf-8")) as KiroIdeClientFile;
          clientId = reg.clientId ?? "";
          clientSecret = reg.clientSecret ?? "";
        } catch {
          // Ignore — we can still use the access token until it expires.
        }
      }
    }

    return {
      refresh: `${tokenData.refreshToken}|${clientId}|${clientSecret}|idc`,
      access: tokenData.accessToken,
      expires: expiresAt - 2 * 60 * 1000,
      clientId,
      clientSecret,
      region,
      authMethod: "idc",
      profileArn: tokenData.profileArn,
      credentialSource: "ide",
    };
  } catch {
    return undefined;
  }
}

/**
 * Returns valid (non-expired) Kiro IDE credentials read from
 * ~/.aws/sso/cache/kiro-auth-token.json, or undefined if the IDE has not
 * logged in or the token has already expired.
 */
export function getKiroIdeCredentials(): KiroCredentials | undefined {
  return readKiroIdeToken(false);
}

/**
 * Like getKiroIdeCredentials but also returns expired tokens so the caller can
 * attempt a silent OIDC refresh before falling back to the full login flow.
 */
export function getKiroIdeCredentialsAllowExpired(): KiroCredentials | undefined {
  return readKiroIdeToken(true);
}
