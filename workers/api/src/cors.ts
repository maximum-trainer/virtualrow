const ALLOW_METHODS = 'GET, PUT, POST, OPTIONS';
const ALLOW_HEADERS = 'Authorization, Content-Type';

export function allowedOrigin(request: Request, allowList: string | undefined): string | null {
  const origin = request.headers.get('Origin');
  if (!origin || !allowList) return null;
  return allowList.split(',').map((o) => o.trim()).includes(origin) ? origin : null;
}

export function preflight(origin: string | null): Response {
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': ALLOW_METHODS,
      'Access-Control-Allow-Headers': ALLOW_HEADERS,
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  });
}

export function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}
