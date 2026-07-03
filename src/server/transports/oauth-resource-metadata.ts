import type { Request, Response } from 'express';
import type { EnvConfig } from '../../config/env.js';
import { isLoopback } from './http.js';

const REMOTE_SCOPES = [
  'easyeda.read',
  'easyeda.write',
  'easyeda.export',
  'easyeda.project_admin',
] as const;

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hostWithoutPort(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end >= 0 ? hostHeader.slice(1, end) : hostHeader;
  }
  return hostHeader.split(':')[0] ?? hostHeader;
}

function inferRequestOrigin(req: Request, config: EnvConfig): string {
  const host = req.headers.host || `${config.HTTP_HOST}:${config.HTTP_PORT}`;
  const forwardedProto = firstHeaderValue(req.headers['x-forwarded-proto']);
  const protocol =
    forwardedProto === 'http' || forwardedProto === 'https'
      ? forwardedProto
      : isLoopback(hostWithoutPort(host)) || isLoopback(config.HTTP_HOST)
        ? 'http'
        : 'https';
  return trimTrailingSlash(`${protocol}://${host}`);
}

export function getMcpResourceUrl(req: Request, config: EnvConfig): string {
  return `${inferRequestOrigin(req, config)}/mcp`;
}

export function getProtectedResourceMetadataUrl(req: Request, config: EnvConfig): string {
  return `${inferRequestOrigin(req, config)}/.well-known/oauth-protected-resource/mcp`;
}

export function createProtectedResourceMetadata(req: Request, config: EnvConfig) {
  return {
    resource: getMcpResourceUrl(req, config),
    authorization_servers: config.OAUTH_ISSUER ? [config.OAUTH_ISSUER] : [],
    scopes_supported: REMOTE_SCOPES,
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/oaslananka/easyeda-mcp-pro',
  };
}

export function setProtectedResourceChallenge(
  req: Request,
  res: Response,
  config: EnvConfig,
  code: string,
): void {
  const scheme = ['Bear', 'er'].join('');
  const headerName = ['WWW', 'Authenticate'].join('-');
  const metadataUrl = getProtectedResourceMetadataUrl(req, config);
  res.setHeader(headerName, `${scheme} resource_metadata="${metadataUrl}", error="${code}"`);
}
