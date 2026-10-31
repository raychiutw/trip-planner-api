import { OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from './env';
import { checkHealth, healthRoute } from './health';

export const app = new OpenAPIHono<{ Bindings: Env }>();

app.openapi(healthRoute, async (c) => {
  const { code, body } = await checkHealth(c.env);
  return c.json(body, code);
});

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Tripline API', version: '0.1.0' },
});
