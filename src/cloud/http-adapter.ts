import type { Express, Request, Response } from 'express';
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

  app.all('/api/auth/*authPath', handler);
  app.all('/.well-known/oauth-protected-resource', handler);
  app.all('/.well-known/oauth-protected-resource/mcp', handler);
}
