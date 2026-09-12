/* eslint-disable no-console */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');

const routesPath = resolve(repoRoot, 'tests/security/zap/routes.json');
const outputPath = resolve(repoRoot, 'tests/security/zap/openapi.json');

const routesData = JSON.parse(readFileSync(routesPath, 'utf8'));
const routes = Array.isArray(routesData) ? routesData : routesData.routes;

export const openapiServers = [
  { url: 'http://127.0.0.1:3000', description: 'Web service (Next.js)' },
  { url: 'http://127.0.0.1:3001', description: 'API service (NestJS)' },
  { url: 'http://127.0.0.1:3002', description: 'Agent service (FastAPI)' },
  { url: 'http://127.0.0.1:3301', description: 'API service (Security Compose)' },
  { url: 'http://127.0.0.1:3302', description: 'Agent service (Security Compose)' },
  { url: 'http://127.0.0.1:3400', description: 'Web service (Security Compose)' },
];

export const openapiSecuritySchemes = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'User JWT bearer authentication',
  },
  agentApiKey: {
    type: 'apiKey',
    in: 'header',
    name: 'AGENT_SERVICE_API_KEY',
    description: 'Agent service shared API key header',
  },
  claimToken: {
    type: 'apiKey',
    in: 'header',
    name: 'CLAIM_TOKEN',
    description: 'Agent attested user claim token header',
  },
  adminBearer: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Admin bearer authentication',
  },
};

export function getMockExample(schema, routeId) {
  if (!schema || !schema.properties) {
    if (routeId?.includes('webhook')) {
      return { id: 'evt_mock_123', type: 'mock.event', livemode: false };
    }
    return {};
  }
  const example = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (key === 'email') example[key] = 'security-a@example.invalid';
    else if (key === 'password') example[key] = 'SecurityPass123!';
    else if (key === 'origin') example[key] = 'SFO';
    else if (key === 'destination') example[key] = 'JFK';
    else if (key === 'departureDate') example[key] = '2026-10-15';
    else if (key === 'passengers') example[key] = prop.type === 'integer' ? 1 : [{ id: 'pax_1', givenName: 'Alice', familyName: 'Smith' }];
    else if (key === 'flightOfferId' || key === 'flight_offer_id') example[key] = 'off_mock_123';
    else if (key === 'handoffToken') example[key] = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.synthetic_handoff_token';
    else if (key === 'intentId') example[key] = 'bi_mock_123';
    else if (key === 'paymentIntentId') example[key] = 'pi_mock_123';
    else if (key === 'givenName') example[key] = 'Jane';
    else if (key === 'familyName') example[key] = 'Doe';
    else if (key === 'passportNumber') example[key] = 'A12345678';
    else if (key === 'resolution') example[key] = 'approved';
    else if (key === 'reason') example[key] = 'Flight cancelled by airline';
    else if (key === 'message') example[key] = 'Find flights from SFO to JFK on October 15';
    else if (key === 'thread_id') example[key] = 'thread_mock_security';
    else if (key === 'baggage') example[key] = [{ type: 'checked', quantity: 1 }];
    else if (key === 'seats') example[key] = [{ seatNumber: '12A' }];
    else if (prop.type === 'string') example[key] = `mock_${key}`;
    else if (prop.type === 'integer' || prop.type === 'number') example[key] = 1;
    else if (prop.type === 'boolean') example[key] = true;
    else if (prop.type === 'array') example[key] = [];
    else example[key] = {};
  }
  return example;
}

export function convertPathToOpenApi(routePath) {
  return routePath.replace(/:([a-zA-Z0-9_]+)/g, (_, p1) => `{${p1}}`);
}

export function buildOpenApiSpec(routeList = routes) {
  const openapiPaths = {};

  for (const r of routeList) {
    const openApiPath = convertPathToOpenApi(r.path);
    if (!openapiPaths[openApiPath]) {
      openapiPaths[openApiPath] = {};
    }

    const method = r.method.toLowerCase();

    // Build parameters
    const params = [];
    if (r.params?.path) {
      for (const p of r.params.path) {
        params.push({
          name: p,
          in: 'path',
          required: true,
          schema: { type: 'string' },
          description: `Path parameter ${p}`,
        });
      }
    }
    if (r.params?.query) {
      for (const q of r.params.query) {
        params.push({
          name: q,
          in: 'query',
          required: false,
          schema: {
            type: q === 'limit' || q === 'page' || q === 'passengers' ? 'integer' : 'string',
          },
          description: `Query parameter ${q}`,
        });
      }
    }

    // Security
    let security = [];
    if (r.authRequirement === 'none') {
      security = [];
    } else if (r.authRequirement === 'bearer_user') {
      if (r.additionalAuth === 'agent_key_claim') {
        security = [{ bearerAuth: [] }, { agentApiKey: [], claimToken: [] }];
      } else {
        security = [{ bearerAuth: [] }];
      }
    } else if (r.authRequirement === 'agent_key_claim') {
      security = [{ agentApiKey: [], claimToken: [] }];
    } else if (r.authRequirement === 'admin_bearer') {
      security = [{ adminBearer: [] }];
    }

    // Request Body
    let requestBody = undefined;
    if (r.requestBody) {
      requestBody = {
        required: true,
        description: r.description,
        content: {
          'application/json': {
            schema: r.requestBody,
            example: getMockExample(r.requestBody, r.id),
          },
        },
      };
    }

    if (openapiPaths[openApiPath][method]) {
      // Merge route into existing operation
      const existing = openapiPaths[openApiPath][method];
      existing['x-route-ids'] = existing['x-route-ids'] || [existing.operationId];
      existing['x-route-ids'].push(r.id);
      for (const p of params) {
        if (!existing.parameters.some((ep) => ep.name === p.name && ep.in === p.in)) {
          existing.parameters.push(p);
        }
      }
    } else {
      openapiPaths[openApiPath][method] = {
        operationId: r.id,
        summary: r.description,
        description: r.description,
        tags: [r.service],
        parameters: params,
        requestBody,
        security,
        responses: {
          '200': { description: 'Successful operation' },
          '400': { description: 'Bad request / schema validation failure' },
          '401': { description: 'Unauthorized / authentication required' },
          '403': { description: 'Forbidden / insufficient permissions' },
        },
        'x-sensitivity': r.sensitivity,
        'x-target-port': r.targetPort,
        'x-route-id': r.id,
      };
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Booking Systems Route Catalog',
      description: 'OpenAPI 3.0.3 specification converted from routes.json for OWASP ZAP scanning',
      version: '1.0.0',
    },
    servers: openapiServers,
    paths: openapiPaths,
    components: {
      securitySchemes: openapiSecuritySchemes,
    },
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isMain) {
  const spec = buildOpenApiSpec();
  writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf8');
  console.log(`Generated OpenAPI spec at ${outputPath} with ${Object.keys(spec.paths).length} paths`);
}
