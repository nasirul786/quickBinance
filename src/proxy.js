import nodeFetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from './config.js';

function buildAgent() {
  const p = config.proxy;
  if (!p) return undefined;

  const auth = p.username
    ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@`
    : '';

  if (p.type === 'http') return new HttpsProxyAgent(`http://${auth}${p.host}:${p.port}`);
  // socks5h = DNS is resolved by the proxy too
  return new SocksProxyAgent(`socks5h://${auth}${p.host}:${p.port}`);
}

/** Proxy agent for Binance requests, or undefined when the proxy is off. */
export const agent = buildAgent();

/** fetch() for Binance requests; goes through the proxy when enabled. */
export function proxiedFetch(url, options = {}) {
  return nodeFetch(url, { ...options, agent });
}

export function describeProxy() {
  const p = config.proxy;
  return p ? `${p.type}://${p.host}:${p.port}` : 'off';
}
