import type { Express, Request, Response, RequestHandler } from 'express';
import { toWebRequest } from '@modelcontextprotocol/node';
import type { HostedAuth } from './hosted-auth.js';

/**
 * Mount the external OAuth provider before JSON body parsing and MCP bearer-token
 * middleware. Better Auth owns the OAuth routes; Express owns the MCP route.
 */
export function mountHostedAuth(app: Express, auth: HostedAuth): void {
  const handler = async (req: Request, res: Response): Promise<void> => {
    try {
      const request = await toWebRequest(req);
      const reply = await auth.handler(request);
      res.status(reply.status);
      for (const [name, value] of reply.headers) {
        if (name.toLowerCase() !== 'set-cookie') res.setHeader(name, value);
      }
      const cookies = reply.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader('set-cookie', cookies);
      res.end(Buffer.from(await reply.arrayBuffer()));
    } catch {
      // Never reflect auth-provider internals, credentials or untrusted error text.
      if (!res.headersSent) res.status(500).json({ error: 'Authentication request failed' });
      else res.end();
    }
  };

  // Explicit synchronous Express middleware hands rejected promises to the
  // error pipeline, including providers whose errors occur before a response.
  const route: RequestHandler = (req, res, next) => {
    void handler(req, res).catch(next);
  };
  app.all('/api/auth/*authPath', route);
  // RFC 8414 inserts well-known metadata before the issuer's /api/auth path.
  app.get('/.well-known/oauth-authorization-server/api/auth', route);
  app.all('/.well-known/oauth-protected-resource', route);
  app.all('/.well-known/oauth-protected-resource/mcp', route);
}
