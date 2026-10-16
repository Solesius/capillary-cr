// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { fileURLToPath } from "node:url";
import { createApp } from "./http/app.ts";

const port = Number(process.env["PORT"] || 8080);

const app = createApp({
  allowedOrigins: (process.env["CORS_ORIGIN"] || "http://localhost:4200")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  requireGithubLogin: readBooleanEnv("CAPILLARY_REQUIRE_GITHUB_LOGIN", false),
  webDistRoot: readBooleanEnv("CAPILLARY_SERVE_WEB", false)
    ? process.env["CAPILLARY_WEB_DIST"]?.trim() ||
      fileURLToPath(new URL("../../web/dist/capillary-web/browser", import.meta.url))
    : null,
});

const server = app.listen(port, () => {
  console.log(`Capillary API listening on :${port}`);
});
// Review and RetV runs stream over SSE for minutes; don't let Node's request
// timeout cut them. Headers must still arrive promptly.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const normalized = process.env[name]?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
