// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// github_app.ts — per-instance GitHub App support (issue #46 Pillar B).
//
// Not a central app owned by the project: each deployment mints ITS OWN app
// via GitHub's manifest flow — capillary serves the manifest, the org admin
// clicks once, GitHub creates the app and hands the credentials back to this
// instance through the conversion callback. Data-stays-home holds; nothing
// routes through the maintainers.
//
// The app supplies the honest service identity: installation tokens (1-hour,
// minted from a rotatable private key) act as `capillary[bot]` for genuinely
// automated surfaces — check runs in the merge box, PR-opened webhooks.
// Member posting stays on member tokens; the app never launders a human.
//
// Credential storage: the app id/key are INSTANCE INFRASTRUCTURE (the analog
// of the env PAT), not user secrets. Env wins when set
// (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY); otherwise manifest-flow
// credentials persist in the durable store — a documented deliberate trade,
// like channel webhook URLs, so the app survives restarts. Member tokens
// remain memory-only, unchanged.

export interface GithubAppCredentials {
  appId: string;
  slug?: string;
  /** PEM private key (PKCS#1 as GitHub issues it, or PKCS#8). */
  privateKeyPem: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  htmlUrl?: string;
}

/** Narrow persistence surface (implemented by DurableReviewStore). */
export interface GithubAppPersistence {
  saveGithubApp(credentials: GithubAppCredentials): Promise<void>;
  getGithubApp(): Promise<GithubAppCredentials | null>;
}

/**
 * Can GitHub's servers reach this URL? Manifest creation VALIDATES the hook
 * URL and rejects localhost/private hosts outright ("Hook url is not
 * supported because it isn't reachable over the public Internet"). Redirect
 * URLs are exempt — the developer's own browser follows those.
 */
export function isPubliclyReachableUrl(base: string): boolean {
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return false;
    }
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" || host === "127.0.0.1" || host === "::1" ||
      host === "[::1]" || host.endsWith(".local") || host.endsWith(".internal") ||
      host === "host.docker.internal"
    ) {
      return false;
    }
    if (
      /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      // Link-local + cloud metadata (169.254.0.0/16, incl. 169.254.169.254).
      /^169\.254\./.test(host) || host === "0.0.0.0" || host === "metadata.google.internal"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The manifest GitHub consumes to create the per-instance app. On a
 * localhost/private CAPILLARY_PUBLIC_URL the app is minted WITHOUT webhooks —
 * checks, installation tokens and member flows all work; only PR-opened
 * auto-review needs hooks, and that needs a public URL regardless. Deploy
 * publicly later and add the webhook URL in the app's GitHub settings.
 */
export function buildAppManifest(
  publicUrl: string,
  instanceName?: string,
): Record<string, unknown> {
  const base = publicUrl.trim().replace(/\/+$/, "");
  const webhookCapable = isPubliclyReachableUrl(base);
  return {
    name: (instanceName ?? `capillary-${new URL(base).hostname}`).slice(0, 34),
    url: "https://github.com/Solesius/capillary-cr",
    redirect_url: `${base}/api/github/app/callback`,
    ...(webhookCapable
      ? {
        hook_attributes: { url: `${base}/api/github/webhook`, active: true },
        default_events: ["pull_request"],
      }
      : {}),
    public: false,
    default_permissions: {
      contents: "read",
      metadata: "read",
      pull_requests: "write",
      checks: "write",
      issues: "write",
    },
  };
}

// --- key handling -------------------------------------------------------------

/** Wrap a PKCS#1 RSAPrivateKey in the PKCS#8 envelope WebCrypto requires. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // PKCS#8 = SEQUENCE { version 0, AlgorithmIdentifier rsaEncryption, OCTET STRING pkcs1 }
  const algorithm = new Uint8Array([
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const octet = derWrap(0x04, pkcs1);
  const body = new Uint8Array(version.length + algorithm.length + octet.length);
  body.set(version, 0);
  body.set(algorithm, version.length);
  body.set(octet, version.length + algorithm.length);
  return derWrap(0x30, body);
}

function derWrap(tag: number, body: Uint8Array): Uint8Array {
  let header: number[];
  if (body.length < 0x80) {
    header = [tag, body.length];
  } else if (body.length < 0x100) {
    header = [tag, 0x81, body.length];
  } else if (body.length < 0x10000) {
    header = [tag, 0x82, body.length >> 8, body.length & 0xff];
  } else {
    header = [tag, 0x83, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff];
  }
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

function pemToDer(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const pkcs1 = pem.includes("RSA PRIVATE KEY");
  const stripped = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(stripped), (c) => c.charCodeAt(0));
  return { der: raw, pkcs1 };
}

/** Import a GitHub App private key (PKCS#1 or PKCS#8 PEM) for RS256 signing. */
export async function importAppKey(pem: string): Promise<CryptoKey> {
  const { der, pkcs1 } = pemToDer(pem);
  const pkcs8 = pkcs1 ? pkcs1ToPkcs8(der) : der;
  return await crypto.subtle.importKey(
    "pkcs8",
    pkcs8.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function b64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** RS256 app JWT: 10-minute lifetime, 60s clock-skew backdate, iss = app id. */
export async function buildAppJwt(
  appId: string,
  key: CryptoKey,
  nowSeconds?: number,
): Promise<string> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const header = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(
    encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      encoder.encode(`${header}.${payload}`),
    ),
  );
  return `${header}.${payload}.${b64url(signature)}`;
}

// --- service --------------------------------------------------------------------

export class GithubAppService {
  #credentials: GithubAppCredentials | null = null;
  #persistence: GithubAppPersistence | null;
  #fetch: typeof fetch;
  #key: CryptoKey | null = null;
  #installationToken: { token: string; expiresAtMs: number } | null = null;

  constructor(
    persistence: GithubAppPersistence | null,
    options: { fetchFn?: typeof fetch } = {},
  ) {
    this.#persistence = persistence;
    this.#fetch = options.fetchFn ?? fetch;
  }

  /** Load credentials: env wins (operator explicit), else the durable store. */
  async init(
    env: { appId?: string; privateKeyPem?: string; webhookSecret?: string } = {},
  ): Promise<void> {
    if (env.appId?.trim() && env.privateKeyPem?.trim()) {
      this.#credentials = {
        appId: env.appId.trim(),
        privateKeyPem: env.privateKeyPem,
        webhookSecret: env.webhookSecret?.trim() || undefined,
      };
      return;
    }
    if (this.#persistence) {
      this.#credentials = await this.#persistence.getGithubApp();
    }
  }

  configured(): boolean {
    return this.#credentials !== null;
  }

  /** UI-safe status: never exposes key material. */
  status(): { configured: boolean; appId?: string; slug?: string; htmlUrl?: string } {
    if (!this.#credentials) {
      return { configured: false };
    }
    return {
      configured: true,
      appId: this.#credentials.appId,
      slug: this.#credentials.slug,
      htmlUrl: this.#credentials.htmlUrl,
    };
  }

  /** Complete the manifest flow: exchange the one-time code for credentials. */
  async completeManifest(code: string): Promise<{ slug?: string; htmlUrl?: string }> {
    const response = await this.#fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      { method: "POST", headers: { accept: "application/vnd.github+json" } },
    );
    if (!response.ok) {
      throw new Error(`app_manifest_conversion_failed_${response.status}`);
    }
    const dto = await response.json() as {
      id: number;
      slug?: string;
      pem: string;
      client_id?: string;
      client_secret?: string;
      webhook_secret?: string;
      html_url?: string;
    };
    this.#credentials = {
      appId: String(dto.id),
      slug: dto.slug,
      privateKeyPem: dto.pem,
      clientId: dto.client_id,
      clientSecret: dto.client_secret,
      webhookSecret: dto.webhook_secret,
      htmlUrl: dto.html_url,
    };
    this.#key = null;
    this.#installationToken = null;
    if (this.#persistence) {
      await this.#persistence.saveGithubApp(this.#credentials);
    }
    return { slug: dto.slug, htmlUrl: dto.html_url };
  }

  /** Short-lived installation token (first installation), cached to expiry. */
  async installationToken(): Promise<string> {
    if (!this.#credentials) {
      throw new Error("github_app_not_configured");
    }
    if (this.#installationToken && Date.now() < this.#installationToken.expiresAtMs - 60_000) {
      return this.#installationToken.token;
    }
    if (!this.#key) {
      this.#key = await importAppKey(this.#credentials.privateKeyPem);
    }
    const jwt = await buildAppJwt(this.#credentials.appId, this.#key);
    const headers = {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    const installations = await this.#fetch("https://api.github.com/app/installations", {
      headers,
    });
    if (!installations.ok) {
      throw new Error(`github_app_installations_failed_${installations.status}`);
    }
    const list = await installations.json() as { id: number }[];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("github_app_not_installed");
    }
    const minted = await this.#fetch(
      `https://api.github.com/app/installations/${list[0].id}/access_tokens`,
      { method: "POST", headers },
    );
    if (!minted.ok) {
      throw new Error(`github_app_token_failed_${minted.status}`);
    }
    const dto = await minted.json() as { token: string; expires_at: string };
    this.#installationToken = {
      token: dto.token,
      expiresAtMs: Date.parse(dto.expires_at) || Date.now() + 55 * 60_000,
    };
    return dto.token;
  }

  /** Verify X-Hub-Signature-256 on an inbound webhook body. */
  async verifyWebhookSignature(body: Uint8Array, signatureHeader: string | null): Promise<boolean> {
    const secret = this.#credentials?.webhookSecret;
    if (!secret || !signatureHeader?.startsWith("sha256=")) {
      return false;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, body.buffer as ArrayBuffer),
    );
    const expected = `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    // Constant-time-ish comparison over equal-length hex strings.
    if (expected.length !== signatureHeader.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
    }
    return diff === 0;
  }
}
