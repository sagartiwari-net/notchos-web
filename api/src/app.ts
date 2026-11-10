// Builds the Fastify application: logging, error handling, and the route groups.
//
// Route groups are Fastify plugins registered under a prefix:
//   /v1/*      routes/v1.ts      the Mac app
//   /api/*     routes/public.ts  the public site (trial leads)
//   /admin/*   routes/admin.ts   the admin panel (W2), session cookie + TOTP login
// Each receives the shared AppContext.

import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import type { AppContext } from './context.ts';
import { sendError } from './http/respond.ts';
import { toIso } from './lib/time.ts';
import { adminRoutes } from './routes/admin.ts';
import { publicRoutes } from './routes/public.ts';
import { v1Routes } from './routes/v1.ts';

export interface BuildAppOptions {
  /** false turns logging off (tests). Default: on, at config.logLevel. */
  logging?: boolean;
  /** Where log lines go instead of stdout (tests capture them here). */
  logStream?: { write(line: string): void };
  /** Overrides config.logLevel. */
  logLevel?: string;
}

/** Body size for routes that do not set their own limit. */
const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024;

// Second line of defence: the code never logs these fields, and if a future change does,
// the value is replaced before the line is written.
const REDACTED_LOG_PATHS = [
  'key',
  'token',
  'password',
  'secret',
  'body',
  'headers',
  '*.key',
  '*.token',
  '*.password',
  '*.secret',
  '*.body',
  '*.headers',
  '*.keyEncSecret',
  '*.*.password',
];

function pathOf(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

export function buildApp(ctx: AppContext, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger:
      options.logging === false
        ? false
        : {
            level: options.logLevel ?? ctx.config.logLevel,
            ...(options.logStream ? { stream: options.logStream } : {}),
            redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' },
            serializers: {
              // Method, path and client address only: no query string, no headers, no body.
              req(request: { method: string; url: string; ip: string }) {
                return { method: request.method, path: pathOf(request.url), remoteAddress: request.ip };
              },
            },
          },
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    // Behind the reverse proxy the client address is taken from X-Forwarded-For, and only
    // when the direct peer is this machine.
    trustProxy: ctx.config.trustProxy ? 'loopback' : false,
    // Request ids are generated here, never taken from a header.
    requestIdHeader: false,
    requestTimeout: 15_000,
    ajv: {
      customOptions: {
        // Strict input: "12" is not 12 and "true" is not true.
        coerceTypes: false,
        // Fields the schema does not name are dropped, so a newer app can send more.
        removeAdditional: true,
        useDefaults: true,
        allErrors: false,
      },
    },
    // Bytes that are not a valid HTTP request never reach a route. Answer them in the same
    // JSON shape as everything else, and log the parser's error code only: the error
    // object itself carries the raw bytes that were received.
    clientErrorHandler(error, socket) {
      if (error.code === 'ECONNRESET' || socket.destroyed) return;
      const status =
        error.code === 'ERR_HTTP_REQUEST_TIMEOUT'
          ? '408 Request Timeout'
          : error.code === 'HPE_HEADER_OVERFLOW'
            ? '431 Request Header Fields Too Large'
            : '400 Bad Request';
      app.log.info({ outcome: 'bad_request', code: error.code }, 'malformed request');
      if (socket.writable) {
        const body = JSON.stringify({
          error: 'bad_request',
          message: 'This is not a valid HTTP request.',
          server_time: toIso(ctx.clock.now()),
        });
        socket.write(
          `HTTP/1.1 ${status}\r\n` +
            'Content-Type: application/json; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            'Cache-Control: no-store\r\n' +
            'Connection: close\r\n\r\n' +
            body,
        );
      }
      socket.destroy();
    },
  });

  // JSON is the only request format. Fastify also accepts text/plain out of the box.
  app.removeContentTypeParser('text/plain');

  app.addHook('onSend', async (_request, reply) => {
    // Answers carry tokens: never cache them, never let a browser guess their type.
    void reply.header('cache-control', 'no-store');
    void reply.header('x-content-type-options', 'nosniff');
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, ctx.clock, 'not_found'));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (error.validation !== undefined) {
      // Schema messages describe the rule that failed ("body/device_id must be string"),
      // never the value that was sent.
      request.log.info({ outcome: 'bad_request' }, 'request rejected');
      return sendError(reply, ctx.clock, 'bad_request', {}, error.message);
    }
    if (status >= 400 && status < 500) {
      // Malformed JSON, wrong content type, body too large ... Only the error code is
      // logged: the message of a parse error could quote the body.
      request.log.info({ outcome: 'bad_request', code: error.code, status }, 'request rejected');
      if (status === 413) return sendError(reply, ctx.clock, 'payload_too_large');
      if (status === 415) return sendError(reply, ctx.clock, 'unsupported_media_type');
      if (status === 404) return sendError(reply, ctx.clock, 'not_found');
      return sendError(reply, ctx.clock, 'bad_request');
    }

    request.log.error({ err: error }, 'request failed');
    return sendError(reply, ctx.clock, 'server_error');
  });

  void app.register(v1Routes, { prefix: '/v1', ctx });
  void app.register(publicRoutes, { prefix: '/api', ctx });
  void app.register(adminRoutes, { prefix: '/admin', ctx });

  return app;
}
