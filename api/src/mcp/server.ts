// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { Server } from "npm:@modelcontextprotocol/sdk@1.13.1/server/index.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@1.13.1/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "npm:@modelcontextprotocol/sdk@1.13.1/types.js";
import { AppError } from "../domain/errors.ts";
import { deps } from "../http/deps.ts";
import { CdpWorkUnitRequest } from "../services/cdp_driver_service.ts";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

const server = new Server(
  {
    name: "capillary-review-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "github_connect",
      description: "Authenticate GitHub identity for review operations.",
      inputSchema: {
        type: "object",
        properties: {
          oauthState: { type: "string", default: "valid" },
          token: { type: "string" },
        },
      },
    },
    {
      name: "github_list_repositories",
      description: "List repositories available to the authenticated identity.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "github_list_pull_requests",
      description: "List pull requests for a repository, filtered by open or closed state.",
      inputSchema: {
        type: "object",
        properties: {
          repositoryId: { type: "string" },
          state: { type: "string", enum: ["open", "closed"], default: "open" },
        },
        required: ["repositoryId"],
      },
    },
    {
      name: "github_get_pull_request_diff",
      description: "Fetch file-level diff metadata for a pull request.",
      inputSchema: {
        type: "object",
        properties: {
          repositoryId: { type: "string" },
          pullRequestId: { type: "string" },
        },
        required: ["repositoryId", "pullRequestId"],
      },
    },
    {
      name: "review_begin_run",
      description: "Start a full Capillary review run for a pull request.",
      inputSchema: {
        type: "object",
        properties: {
          pullRequestId: { type: "string" },
          repositoryId: { type: "string" },
        },
        required: ["pullRequestId"],
      },
    },
    {
      name: "review_get_run",
      description: "Get review run status and aggregate counts.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "review_get_events",
      description: "Get review progression events for a run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "artifact_markdown",
      description: "Export final markdown review artifact for a run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "artifact_graph",
      description: "Export JSON graph artifact for a run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "cdp_create_session",
      description: "Create a browser session through the low-level CDP driver.",
      inputSchema: {
        type: "object",
        properties: {
          startUrl: { type: "string", default: "about:blank" },
        },
      },
    },
    {
      name: "cdp_list_sessions",
      description: "List active CDP browser sessions.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "cdp_execute_work_unit",
      description: "Execute a structured work unit of browser steps in a CDP session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          request: {
            type: "object",
            properties: {
              name: { type: "string" },
              stopOnFailure: { type: "boolean" },
              steps: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    action: { type: "string" },
                  },
                  required: ["action"],
                },
              },
            },
            required: ["steps"],
          },
        },
        required: ["sessionId", "request"],
      },
    },
    {
      name: "cdp_close_session",
      description: "Close an active CDP browser session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments || {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "github_connect":
        return jsonResult(await deps.githubService.connectGithub(
          asString(args.oauthState, "valid"),
          optionalString(args.token),
        ));
      case "github_list_repositories":
        return jsonResult(await deps.githubService.listRepositories());
      case "github_list_pull_requests":
        return jsonResult(await deps.githubService.listPullRequests(
          requiredString(args.repositoryId, "repositoryId"),
          asState(args.state),
        ));
      case "github_get_pull_request_diff":
        return jsonResult(await deps.githubService.getPullRequestDiff(
          requiredString(args.repositoryId, "repositoryId"),
          requiredString(args.pullRequestId, "pullRequestId"),
        ));
      case "review_begin_run":
        return jsonResult(await deps.reviewService.beginReview(
          requiredString(args.pullRequestId, "pullRequestId"),
          optionalString(args.repositoryId),
        ));
      case "review_get_run":
        return jsonResult(deps.reviewService.getReviewRun(requiredString(args.runId, "runId")));
      case "review_get_events":
        return jsonResult(deps.reviewService.streamReviewEvents(requiredString(args.runId, "runId")));
      case "artifact_markdown":
        return textResult(deps.artifactService.exportMarkdownReview(requiredString(args.runId, "runId")));
      case "artifact_graph":
        return jsonResult(deps.artifactService.exportGraphJson(requiredString(args.runId, "runId")));
      case "cdp_create_session":
        return jsonResult(await deps.cdpDriverService.createSession(asString(args.startUrl, "about:blank")));
      case "cdp_list_sessions":
        return jsonResult(deps.cdpDriverService.listSessions());
      case "cdp_execute_work_unit":
        return jsonResult(await deps.cdpDriverService.executeWorkUnit(
          requiredString(args.sessionId, "sessionId"),
          normalizeWorkUnit(args.request),
        ));
      case "cdp_close_session":
        return jsonResult({
          closed: await deps.cdpDriverService.closeSession(requiredString(args.sessionId, "sessionId")),
        });
      default:
        throw new AppError(`unsupported_tool: ${name}`, 400, "unsupported_tool");
    }
  } catch (error) {
    if (error instanceof AppError) {
      return textResult(`[${error.code}] ${error.message}`);
    }

    const message = error instanceof Error ? error.message : "unknown_error";
    return textResult(`[internal_error] ${message}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(`invalid_${name}`, 400, `invalid_${name}`);
  }

  return value;
}

function asState(value: unknown): "open" | "closed" {
  return value === "closed" ? "closed" : "open";
}

function normalizeWorkUnit(value: unknown): CdpWorkUnitRequest {
  if (!value || typeof value !== "object") {
    throw new AppError("invalid_request", 400, "invalid_request");
  }

  const payload = value as Record<string, unknown>;
  const steps = payload.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new AppError("work_unit_steps_required", 400, "work_unit_steps_required");
  }

  return payload as unknown as CdpWorkUnitRequest;
}

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function textResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
  };
}
