import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute } from '@mastra/core/server';
import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';
import { convertCustomRoutesToOpenAPIPaths, generateOpenAPIDocument, hoistSchemaDefsIntoComponents } from './openapi-utils';
import type { ServerRoute } from './routes';
import { createRoute } from './routes/route-builder';

describe('generateOpenAPIDocument', () => {
  it('does not pollute Object.prototype when a route path is "__proto__"', () => {
    const pollutingRoute = {
      method: 'GET',
      path: '__proto__',
      openapi: {
        summary: 's',
        description: 'd',
        tags: ['t'],
        requestParams: {},
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: z.object({ polluted: z.boolean() }),
              },
            },
          },
        },
      },
      handler: () => new Response('ok'),
    } as unknown as ServerRoute;

    generateOpenAPIDocument([pollutingRoute], { title: 't', version: '1' });

    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).get).toBeUndefined();
  });
});

describe('convertCustomRoutesToOpenAPIPaths', () => {
  it('does not classify Hono routes by an incidental responseType property', () => {
    const route = Object.assign(
      registerApiRoute('/legacy', {
        method: 'GET',
        handler: async c => c.json({ ok: true }),
        openapi: { summary: 'Legacy route' },
      }),
      { responseType: 'json' },
    ) as unknown as ApiRoute;

    const paths = convertCustomRoutesToOpenAPIPaths([route]);

    expect(paths['/legacy'].get.summary).toBe('Legacy route');
  });

  it('converts schema metadata from createRoute routes', () => {
    const route = createRoute({
      method: 'POST',
      path: '/widgets/:widgetId',
      responseType: 'json',
      deprecated: true,
      pathParamSchema: z.object({ widgetId: z.string() }),
      bodySchema: z.object({ name: z.string() }),
      responseSchema: z.object({ id: z.string() }),
      handler: async () => ({ id: 'widget-1' }),
    });

    expect(route._mastraSchemaRoute).toBe(true);
    const paths = convertCustomRoutesToOpenAPIPaths([route satisfies ApiRoute]);

    expect(paths['/widgets/{widgetId}'].post.deprecated).toBe(true);
    expect(paths['/widgets/{widgetId}'].post.parameters).toEqual([
      expect.objectContaining({ name: 'widgetId', in: 'path', required: true }),
    ]);
    expect(paths['/widgets/{widgetId}'].post.requestBody.content['application/json'].schema).toMatchObject({
      type: 'object',
      required: ['name'],
    });
    expect(paths['/widgets/{widgetId}'].post.responses['200'].content['application/json'].schema).toMatchObject({
      type: 'object',
      required: ['id'],
    });
  });
});

describe('hoistSchemaDefsIntoComponents', () => {
  const collectRefs = (node: any, refs: string[] = []): string[] => {
    if (!node || typeof node !== 'object') return refs;
    if (Array.isArray(node)) {
      node.forEach(child => collectRefs(child, refs));
      return refs;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        refs.push(value);
      } else {
        collectRefs(value, refs);
      }
    }
    return refs;
  };

  const hasNestedDefs = (node: any): boolean => {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(hasNestedDefs);
    return Object.entries(node).some(([key, value]) => key === '$defs' || key === 'definitions' || hasNestedDefs(value));
  };

  it('hoists nested definitions into components.schemas and rewrites refs', () => {
    const invoice = z.object({ total: z.number() }).meta({ id: 'Invoice' });
    const route = createRoute({
      method: 'POST',
      path: '/invoices',
      responseType: 'json',
      bodySchema: invoice,
      handler: async () => ({}),
    });

    const doc = generateOpenAPIDocument([route], { title: 't', version: '1' });

    const refs = collectRefs(doc);
    expect(refs).toContain('#/components/schemas/Invoice');
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
    }
    expect(doc.components.schemas.Invoice).toMatchObject({ type: 'object' });
    expect(hasNestedDefs(doc.paths)).toBe(false);
  });

  it('keeps same-named defs from different routes distinct', () => {
    const shapeA = z.object({ nameA: z.string() }).meta({ id: 'Shared' });
    const shapeB = z.object({ nameB: z.string() }).meta({ id: 'Shared' });
    const routeA = createRoute({
      method: 'POST',
      path: '/a',
      responseType: 'json',
      bodySchema: shapeA,
      handler: async () => ({}),
    });
    const routeB = createRoute({
      method: 'POST',
      path: '/b',
      responseType: 'json',
      bodySchema: shapeB,
      handler: async () => ({}),
    });

    const doc = generateOpenAPIDocument([routeA, routeB], { title: 't', version: '1' });

    expect(Object.keys(doc.components.schemas)).toEqual(['Shared', 'Shared_2']);
    const refA = doc.paths['/a'].post.requestBody.content['application/json'].schema.$ref;
    const refB = doc.paths['/b'].post.requestBody.content['application/json'].schema.$ref;
    expect(refA).toBe('#/components/schemas/Shared');
    expect(refB).toBe('#/components/schemas/Shared_2');
    expect(doc.components.schemas.Shared).toMatchObject({ properties: { nameA: { type: 'string' } } });
    expect(doc.components.schemas.Shared_2).toMatchObject({ properties: { nameB: { type: 'string' } } });
    expect(hasNestedDefs(doc.paths)).toBe(false);
  });

  it('hoists $defs from custom routes merged after the built-in document', () => {
    const invoice = z.object({ total: z.number() }).meta({ id: 'Invoice' });
    const customRoute = registerApiRoute('/invoices', {
      method: 'POST',
      handler: async c => c.json({ ok: true }),
      openapi: {
        summary: 'Create invoice',
        requestBody: { content: { 'application/json': { schema: invoice as any } } },
        responses: { 200: { description: 'ok' } },
      },
    });

    const doc = generateOpenAPIDocument([], { title: 't', version: '1' });
    doc.paths = { ...doc.paths, ...convertCustomRoutesToOpenAPIPaths([customRoute]) };
    hoistSchemaDefsIntoComponents(doc);

    const refs = collectRefs(doc);
    expect(refs).toContain('#/components/schemas/Invoice');
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
    }
    expect(doc.components.schemas.Invoice).toBeDefined();
    expect(hasNestedDefs(doc.paths)).toBe(false);
  });

  it('leaves documents without defs untouched', () => {
    const route = createRoute({
      method: 'POST',
      path: '/plain',
      responseType: 'json',
      bodySchema: z.object({ name: z.string() }),
      handler: async () => ({}),
    });

    const doc = generateOpenAPIDocument([route], { title: 't', version: '1' });

    expect(doc.components).toBeUndefined();
  });
});
