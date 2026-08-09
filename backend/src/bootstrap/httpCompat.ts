import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Hono } from 'hono';

const toHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
};

const toRequest = async (request: IncomingMessage): Promise<Request> => {
  const protocol = request.headers['x-forwarded-proto'] ?? 'http';
  const host = request.headers.host ?? 'localhost';
  const url = `${Array.isArray(protocol) ? protocol[0] : protocol}://${host}${request.url ?? '/'}`;
  const method = request.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : request;

  return new Request(url, {
    method,
    headers: toHeaders(request),
    body,
    // Node's IncomingMessage is a streaming body, which fetch requires to be
    // explicitly marked as half-duplex.
    duplex: body ? 'half' : undefined,
  } as RequestInit);
};

const writeResponse = async (response: Response, target: ServerResponse): Promise<void> => {
  target.statusCode = response.status;
  response.headers.forEach((value, key) => target.setHeader(key, value));
  target.end(Buffer.from(await response.arrayBuffer()));
};

/**
 * Node-shaped adapter used only by the existing supertest suite. Production
 * traffic is served by BunRuntimeServer, so @hono/node-server is not part of
 * the runtime path anymore.
 */
export const createHttpCompatibilityServer = (app: Hono): Server =>
  createServer(async (request, response) => {
    try {
      await writeResponse(await app.fetch(await toRequest(request)), response);
    } catch (error) {
      console.error('HTTP compatibility adapter failed:', error);
      if (!response.headersSent) response.statusCode = 500;
      response.end('Internal Server Error');
    }
  });
