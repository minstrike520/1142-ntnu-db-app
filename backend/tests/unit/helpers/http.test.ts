import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { request } from '../../helpers/http';

describe('Hono HTTP test helper', () => {
  it('sends JSON through the app.request testing path', async () => {
    const app = new Hono();
    app.post('/echo', async (c) => c.json(await c.req.json(), 201));

    const response = await request(app)
      .post<{ hello: string }>('/echo')
      .set('X-Test', 'present')
      .send({ hello: 'world' });

    expect(response.status).toBe(201);
    expect(response.body.hello).toBe('world');
  });

  it('sends multipart uploads with the field name and filename intact', async () => {
    const app = new Hono();
    app.post('/upload', async (c) => {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) throw new Error('expected an uploaded file');
      return c.json({ filename: file.name, type: file.type, contents: await file.text() });
    });

    const response = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('hello upload'), 'greeting.txt');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ filename: 'greeting.txt', type: expect.any(String), contents: 'hello upload' });
  });

  it('preserves request cookies and representative response headers', async () => {
    const app = new Hono();
    app.get('/headers', (c) => {
      return new Response(JSON.stringify({ cookie: c.req.header('cookie'), requestId: c.req.header('x-request-id') }), {
        headers: [
          ['Content-Type', 'application/json'],
          ['X-Response-Id', 'response-123'],
        ],
      });
    });

    const response = await request(app)
      .get('/headers')
      .set('Cookie', 'session=abc; theme=dark')
      .set('X-Request-Id', 'request-123');

    expect(response.body).toEqual({ cookie: 'session=abc; theme=dark', requestId: 'request-123' });
    expect(response.headers['x-response-id']).toBe('response-123');
  });

  it('keeps multiple response Set-Cookie values as an array', async () => {
    const app = new Hono();
    app.get('/cookies', () => {
      return new Response('{}', {
        headers: [
          ['Content-Type', 'application/json'],
          ['Set-Cookie', 'access=one; Path=/'],
          ['Set-Cookie', 'refresh=two; Path=/; HttpOnly'],
        ],
      });
    });

    const response = await request(app).get('/cookies');

    expect(response.headers['set-cookie']).toEqual(['access=one; Path=/', 'refresh=two; Path=/; HttpOnly']);
  });
});
