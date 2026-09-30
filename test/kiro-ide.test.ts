import { describe, expect, it } from "vitest";
import { parseKiroIdeCredentials } from "../src/kiro-ide.js";

describe("Kiro IDE credential bootstrap", () => {
  it("maps KAM/Kiro IDE social credentials to desktop refresh", () => {
    const creds = parseKiroIdeCredentials(
      {
        accessToken: "social-access",
        refreshToken: "social-refresh",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        authMethod: "social",
        provider: "Google",
        profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/social",
      },
      undefined,
      false,
    );

    expect(creds).toMatchObject({
      access: "social-access",
      refresh: "social-refresh|desktop",
      authMethod: "desktop",
      region: "us-east-1",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/social",
      clientId: "",
      clientSecret: "",
    });
  });

  it("maps KAM/Kiro IDE IdC credentials to AWS OIDC refresh", () => {
    const creds = parseKiroIdeCredentials(
      {
        accessToken: "idc-access",
        refreshToken: "idc-refresh",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        authMethod: "IdC",
        provider: "BuilderId",
        region: "eu-west-1",
        clientIdHash: "abc123",
        profileArn: "arn:aws:codewhisperer:eu-central-1:123:profile/idc",
      },
      {
        clientId: "client-id",
        clientSecret: "client-secret",
      },
      false,
    );

    expect(creds).toMatchObject({
      access: "idc-access",
      refresh: "idc-refresh|client-id|client-secret|idc",
      authMethod: "idc",
      region: "eu-west-1",
      clientId: "client-id",
      clientSecret: "client-secret",
      profileArn: "arn:aws:codewhisperer:eu-central-1:123:profile/idc",
    });
  });

  it("recognizes legacy social cache files without authMethod by absence of clientIdHash", () => {
    const creds = parseKiroIdeCredentials(
      {
        accessToken: "legacy-access",
        refreshToken: "legacy-refresh",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        provider: "Github",
      },
      undefined,
      false,
    );

    expect(creds?.authMethod).toBe("desktop");
    expect(creds?.refresh).toBe("legacy-refresh|desktop");
  });

  it("can import an expired IDE credential for one-time refresh but not as a live token", () => {
    const token = {
      accessToken: "expired-access",
      refreshToken: "expired-refresh",
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
      authMethod: "social",
      provider: "Google",
    };

    expect(parseKiroIdeCredentials(token, undefined, false)).toBeUndefined();
    expect(parseKiroIdeCredentials(token, undefined, true)?.refresh).toBe("expired-refresh|desktop");
  });
});
