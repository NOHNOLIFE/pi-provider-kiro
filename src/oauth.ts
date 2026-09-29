// Feature 3: OAuth — Kiro Authentication
//
// Supports multiple auth methods:
//   - "idc": AWS Builder ID or IAM Identity Center (SSO) via device code flow
//   - "desktop": Google/GitHub social login via Kiro auth service (delegates to kiro-cli)
//
// When no existing credentials are found (no Kiro IDE, no kiro-cli), falls back
// to the interactive login flow in login.ts (Feature 10).

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { formatSafeError } from "./debug.js";
import { resolveApiRegion } from "./endpoints.js";
import { getKiroIdeCredentials, getKiroIdeCredentialsAllowExpired } from "./kiro-ide.js";
import { interactiveLogin, runSocialLoginFlow } from "./login.js";
import { getPiHostKiroCredentials, getPiHostKiroCredentialsAllowExpired } from "./pi-auth-store.js";

export const SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const KIRO_DESKTOP_REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

export type KiroAuthMethod = "idc" | "desktop" | "external-idp" | "apikey";
export type KiroLoginMethod = "auto" | "builder-id" | "google" | "github";
export type KiroCredentialSource = "ide" | "pi" | "direct";

export interface KiroCredentials extends OAuthCredentials {
  clientId: string;
  clientSecret: string;
  region: string;
  authMethod: KiroAuthMethod;
  /** Required for Google/GitHub social profiles; ListAvailableProfiles may return empty for these tokens. */
  profileArn?: string;
  startUrl?: string;
  isEnterprise?: boolean;
  /** Where the credential originated. Used to avoid cross-account refresh adoption. */
  credentialSource?: KiroCredentialSource;
}

export const KIRO_DESKTOP_USER_AGENT = "Kiro-Desktop/0.2.13 (darwin; arm64)";

export function kiroUserAgent(service: string, sdkVersion: string): Record<string, string> {
  return {
    "User-Agent": `aws-sdk-js/3.714.0 os/macos/24.3.0 lang/js md/nodejs/22.14.0 api/${service}/3.714.0 exec-env/kiro-cli/2.7.0 m/E`,
    "amz-sdk-invocation-id": "00000000-0000-0000-0000-000000000000",
    "amz-sdk-request": `attempt=1; max=${sdkVersion}`,
  };
}

export function kiroAuthHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (isApiKey(token)) {
    headers.tokentype = "API_KEY";
  }
  return headers;
}

export function isApiKey(token: string): boolean {
  return token.startsWith("ksk_");
}

export async function loginKiroWithApiKey(callbacks: OAuthLoginCallbacks, apiKey: string): Promise<OAuthCredentials> {
  if (!apiKey.startsWith("ksk_")) {
    throw new Error("Invalid API key format. Kiro API keys start with 'ksk_'.");
  }

  (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.("Validating API key...");

  const { resolveApiRegion } = await import("./endpoints.js");
  // API keys are issued for the us-east-1 control plane.
  const region = "us-east-1";
  const apiRegion = resolveApiRegion(region);
  const managementUrl = `https://management.${apiRegion}.kiro.dev/`;

  // GetProfile with an empty body returns the API key's own profile.
  const resp = await fetch(managementUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": "AmazonCodeWhispererService.GetProfile",
      ...kiroAuthHeaders(apiKey),
      ...kiroUserAgent("codewhispererruntime", "F,C"),
    },
    body: "{}",
  });

  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      detail = "";
    }
    if (resp.status === 401 || resp.status === 403 || /Invalid token/i.test(detail)) {
      throw new Error("API key was rejected by Kiro. Check that the key is valid and not expired.");
    }
    throw new Error(`Kiro GetProfile failed: ${resp.status} ${resp.statusText} ${detail}`.trim());
  }

  const data = (await resp.json()) as { profile?: { arn?: string } };
  const profileArn = data.profile?.arn;

  const kiroCreds: KiroCredentials = {
    access: apiKey,
    refresh: `${apiKey}|apikey`,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    clientId: "",
    clientSecret: "",
    region,
    authMethod: "apikey",
    credentialSource: "direct",
    ...(profileArn ? { profileArn } : {}),
  };

  return kiroCreds;
}

/**
 * Login to Kiro using the specified method.
 *
 * - "auto": Reuse Pi/Kiro IDE credentials when available
 * - "builder-id": AWS Builder ID via device code flow
 * - "google" | "github": Native browser PKCE login (no kiro-cli required)
 */
export async function loginKiro(
  callbacks: OAuthLoginCallbacks,
  preferredMethod: KiroLoginMethod = "auto",
): Promise<OAuthCredentials> {
  const creds = await loginKiroInternal(callbacks, preferredMethod);
  if (!process.env.VITEST) {
    try {
      const { updateKiroModelsCache } = await import("./models.js");
      const region = resolveApiRegion((creds as KiroCredentials).region);
      updateKiroModelsCache(creds.access, region, (creds as KiroCredentials).profileArn).catch((error) => {
        console.warn(`[pi-provider-kiro] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
      });
    } catch (error) {
      console.warn(`[pi-provider-kiro] Failed to start Kiro model catalog refresh: ${formatSafeError(error)}`);
    }
  }
  return creds;
}

async function loginKiroInternal(
  callbacks: OAuthLoginCallbacks,
  preferredMethod: KiroLoginMethod = "auto",
): Promise<OAuthCredentials> {
  // Social login is implemented directly against Kiro's browser PKCE flow.
  if (preferredMethod === "google" || preferredMethod === "github") {
    return runSocialLoginFlow(callbacks, preferredMethod);
  }

  const ideCreds = getKiroIdeCredentials();
  const piCreds = getPiHostKiroCredentials();
  const expiredIdeCreds = getKiroIdeCredentialsAllowExpired();
  const expiredPiCreds = getPiHostKiroCredentialsAllowExpired();
  const hasCached = Boolean(ideCreds || piCreds || expiredIdeCreds || expiredPiCreds);

  const result = await interactiveLogin(callbacks, hasCached);
  if (result !== "use-cached-credentials") {
    return result;
  }

  return useCachedCascade(callbacks);
}

async function useCachedCascade(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const ideCreds = getKiroIdeCredentials();
  if (ideCreds) {
    (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
      "Using existing Kiro IDE credentials",
    );
    return ideCreds;
  }

  const piCreds = getPiHostKiroCredentials();
  if (piCreds) {
    (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
      "Using existing Pi Kiro credentials",
    );
    return { ...piCreds, credentialSource: piCreds.credentialSource ?? "pi" };
  }

  const expiredIdeCreds = getKiroIdeCredentialsAllowExpired();
  if (expiredIdeCreds) {
    try {
      (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
        "Refreshing Kiro IDE credentials...",
      );
      return await refreshKiroTokenDirect(expiredIdeCreds);
    } catch {
      // Continue to Pi's own cached credential.
    }
  }

  const expiredPiCreds = getPiHostKiroCredentialsAllowExpired();
  if (expiredPiCreds) {
    try {
      (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
        "Refreshing existing Pi Kiro credentials...",
      );
      return await refreshKiroTokenDirect({ ...expiredPiCreds, credentialSource: expiredPiCreds.credentialSource ?? "pi" });
    } catch {
      // Fall through to a clean login error.
    }
  }

  throw new Error("No valid cached Kiro credentials found");
}

/**
 * Backward-compatible alias for loginKiro with Builder ID.
 * @deprecated Use loginKiro instead.
 */
export async function loginKiroBuilderID(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return loginKiro(callbacks, "builder-id");
}

// Token refresh buffer (5 minutes) baked into our expires timestamps at creation time.
// The actual AWS token is valid for this much longer than credentials.expires indicates.
const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

export async function refreshKiroToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const refreshed = await refreshKiroTokenInternal(credentials);
  if (!process.env.VITEST) {
    try {
      const { updateKiroModelsCache } = await import("./models.js");
      const region = resolveApiRegion((refreshed as KiroCredentials).region);
      updateKiroModelsCache(refreshed.access, region, (refreshed as KiroCredentials).profileArn).catch((error) => {
        console.warn(`[pi-provider-kiro] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
      });
    } catch (error) {
      console.warn(`[pi-provider-kiro] Failed to start Kiro model catalog refresh: ${formatSafeError(error)}`);
    }
  }
  return refreshed;
}

async function refreshKiroTokenInternal(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const kiroCredentials = credentials as KiroCredentials;
  const credentialAuthMethod =
    kiroCredentials.authMethod ??
    (credentials.refresh.split("|").at(-1) === "desktop" ? "desktop" : "idc");

  if (credentialAuthMethod === "apikey" || isApiKey(credentials.access)) {
    return credentials;
  }

  // Credentials explicitly sourced from the IDE may be refreshed by Kiro/KAM
  // out-of-process. Re-read that file first, but never adopt IDE credentials for
  // a Pi/direct credential: that could silently switch accounts.
  if (kiroCredentials.credentialSource === "ide") {
    const ideCreds = getKiroIdeCredentials();
    if (ideCreds) return ideCreds;
  }

  try {
    return await refreshKiroTokenDirect(credentials);
  } catch (refreshError) {
    if (kiroCredentials.credentialSource === "ide") {
      const retryIdeCreds = getKiroIdeCredentials();
      if (retryIdeCreds) return retryIdeCreds;
    }

    // Our expires timestamp includes an early-refresh buffer. If refresh fails
    // inside that buffer, keep using the still-valid access token until its real
    // expiry instead of failing the turn early.
    const actualExpiry = credentials.expires + EXPIRES_BUFFER_MS;
    if (credentials.access && Date.now() < actualExpiry) {
      return { ...credentials, expires: actualExpiry };
    }

    throw refreshError;
  }
}

async function refreshKiroTokenDirect(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] ?? "";
  const authMethod = (parts[parts.length - 1] ?? "idc") as KiroAuthMethod;
  const region = (credentials as KiroCredentials).region || "us-east-1";

  if (authMethod === "apikey") {
    // API keys are long-lived bearer tokens — no refresh needed.
    return credentials;
  }

  if (authMethod === "desktop") {
    // Kiro desktop app tokens use a different refresh endpoint
    const url = KIRO_DESKTOP_REFRESH_URL.replace("{region}", region);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": KIRO_DESKTOP_USER_AGENT },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) throw new Error(`Desktop token refresh failed: ${response.status}`);
    const data = (await response.json()) as {
      accessToken: string;
      refreshToken?: string;
      expiresIn: number;
      profileArn?: string;
    };
    if (!data.accessToken) throw new Error("Desktop token refresh: missing accessToken");
    return {
      refresh: `${data.refreshToken || refreshToken}|desktop`,
      access: data.accessToken,
      expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop" as KiroAuthMethod,
      profileArn: data.profileArn || (credentials as KiroCredentials).profileArn,
      startUrl: (credentials as KiroCredentials).startUrl,
      credentialSource: (credentials as KiroCredentials).credentialSource ?? "direct",
    };
  }

  // External IdP (enterprise OIDC, e.g. Okta) — standard public-client refresh
  // against the customer's own token endpoint. kiro-cli does the same:
  // form-encoded grant_type/client_id/refresh_token, snake_case response, and
  // no client secret because the OIDC app is a public PKCE client.
  if (authMethod === "external-idp") {
    const idpClientId = parts[1] ?? "";
    const tokenEndpoint = parts[2] ?? "";
    if (!tokenEndpoint) throw new Error("External IdP token refresh: missing token endpoint");
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "pi-cli",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: idpClientId,
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!response.ok) throw new Error(`External IdP token refresh failed: ${response.status}`);
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) throw new Error("External IdP token refresh: missing access_token");
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    return {
      refresh: `${data.refresh_token || refreshToken}|${idpClientId}|${tokenEndpoint}|external-idp`,
      access: data.access_token,
      expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
      clientId: idpClientId,
      clientSecret: "",
      region,
      authMethod: "external-idp" as KiroAuthMethod,
      profileArn: (credentials as KiroCredentials).profileArn,
      credentialSource: (credentials as KiroCredentials).credentialSource ?? "pi",
    };
  }

  // IDC auth method — SSO OIDC refresh
  const clientId = parts[1] ?? "";
  const clientSecret = parts[2] ?? "";
  const ssoEndpoint = `https://oidc.${region}.amazonaws.com`;
  const response = await fetch(`${ssoEndpoint}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...kiroUserAgent("ssooidc", "E"),
    },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const data = (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
  return {
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|idc`,
    access: data.accessToken,
    expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
    clientId: clientId,
    clientSecret: clientSecret,
    region,
    authMethod: "idc" as KiroAuthMethod,
    profileArn: (credentials as KiroCredentials).profileArn,
    startUrl: (credentials as KiroCredentials).startUrl,
    isEnterprise: (credentials as KiroCredentials).isEnterprise,
    credentialSource: (credentials as KiroCredentials).credentialSource ?? "pi",
  };
}
