#!/usr/bin/env node

import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";

const options = parseArgs({
  options: {
    label: { type: "string" },
    port: { type: "string" },
    root: { type: "string" },
  },
  strict: true,
}).values;

const label = String(options.label ?? "")
  .trim()
  .toLowerCase();
if (!/^(?:primary|backup)$/.test(label)) {
  throw new Error("--label must be primary or backup");
}
const port = Number.parseInt(String(options.port ?? ""), 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("--port must be an integer from 1 to 65535");
}
const configuredRoot = path.resolve(String(options.root ?? ""));
if (!existsSync(configuredRoot)) {
  throw new Error("--root must reference an existing HLS directory");
}
const root = realpathSync(configuredRoot);

function setDeliveryHeaders(response, extension) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, X-Hyperbet-E2E-HLS-Origin",
  );
  response.setHeader("Timing-Allow-Origin", "*");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Hyperbet-E2E-HLS-Origin", label);
  if (extension === ".m3u8") {
    response.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Expires", "0");
    response.setHeader("Surrogate-Control", "no-store");
  } else {
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
}

function contentTypeFor(extension) {
  if (extension === ".m3u8") return "application/vnd.apple.mpegurl";
  if (extension === ".ts") return "video/mp2t";
  if (extension === ".m4s") return "video/iso.segment";
  if (extension === ".mp4") return "video/mp4";
  return null;
}

function pipeFile(response, filePath, range) {
  const stream = createReadStream(filePath, range);
  stream.on("error", (error) => {
    console.error(
      JSON.stringify({
        event: "e2e-hls-origin-read-error",
        label,
        message: error instanceof Error ? error.message : String(error),
        path: filePath,
      }),
    );
    response.destroy(error);
  });
  stream.pipe(response);
}

function parseByteRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start ||
    end >= size
  ) {
    return null;
  }
  return { start, end };
}

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    setDeliveryHeaders(response, "");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Range");
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.setHeader("Allow", "GET, HEAD, OPTIONS");
    response.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    );
  } catch {
    response.statusCode = 400;
    response.end("Malformed request path");
    return;
  }
  const prefix = `/live/${label}/`;
  if (!pathname.startsWith(prefix)) {
    response.statusCode = 404;
    response.end("Unknown HLS source");
    return;
  }

  const relativePath = pathname.slice("/live/".length);
  const candidate = path.resolve(root, relativePath);
  if (!candidate.startsWith(`${root}${path.sep}`) || !existsSync(candidate)) {
    response.statusCode = 503;
    response.end("HLS stream unavailable");
    return;
  }
  const extension = path.extname(candidate).toLowerCase();
  const contentType = contentTypeFor(extension);
  if (!contentType) {
    response.statusCode = 415;
    response.end("Unsupported HLS resource");
    return;
  }

  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    response.statusCode = 503;
    response.end("HLS stream unavailable");
    return;
  }
  if (!stat.isFile()) {
    response.statusCode = 404;
    response.end("HLS resource not found");
    return;
  }
  setDeliveryHeaders(response, extension);
  response.setHeader("Content-Type", contentType);
  const rangeHeader = request.headers.range;
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, stat.size);
    if (!range) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${stat.size}`);
      response.end();
      return;
    }
    const { start, end } = range;
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    response.setHeader("Content-Length", String(end - start + 1));
    if (request.method === "HEAD") {
      response.end();
    } else {
      pipeFile(response, candidate, { start, end });
    }
    return;
  }

  response.statusCode = 200;
  response.setHeader("Content-Length", String(stat.size));
  if (request.method === "HEAD") {
    response.end();
  } else {
    pipeFile(response, candidate);
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
  server.closeAllConnections?.();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(port, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      event: "e2e-hls-origin-ready",
      label,
      port,
      root,
    }),
  );
});
