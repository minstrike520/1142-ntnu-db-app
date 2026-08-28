import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { request } from '../../helpers/http';

describe('Hono HTTP test helper', () => {
  it('sends JSON through the app.request testing path', async () => {
    const app = new Hono();
    app.post('/echo', async (c) => c.json(await c.req.json(), 201));

    const response = await request(app)
      .post('/echo')
      .set('X-Test', 'present')
      .send({ hello: 'world' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ hello: 'world' });
  });
});
