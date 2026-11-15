import { describe, expect, it } from 'vitest';
import { isPlainHttpHost, secureCookies } from '../src/auth.js';

describe('session cookies on plain HTTP', () => {
  it('treats loopback and Tailscale CGNAT as plain-HTTP hosts', () => {
    expect(isPlainHttpHost('localhost')).toBe(true);
    expect(isPlainHttpHost('127.0.0.1:8787')).toBe(true);
    expect(isPlainHttpHost('[::1]:8787')).toBe(true);
    expect(isPlainHttpHost('100.64.0.1')).toBe(true);
    expect(isPlainHttpHost('100.127.255.4:8787')).toBe(true);
    expect(isPlainHttpHost('100.63.0.1')).toBe(false);
    expect(isPlainHttpHost('100.128.0.1')).toBe(false);
    expect(isPlainHttpHost('192.168.1.20')).toBe(false);
  });

  it('leaves Secure off for a Tailscale host in production unless the operator forces it', () => {
    const previousNode = process.env.NODE_ENV;
    const previousForce = process.env.FORCE_INSECURE_COOKIE;
    const previousHost = process.env.HOST;
    process.env.NODE_ENV = 'production';
    delete process.env.FORCE_INSECURE_COOKIE;
    process.env.HOST = '0.0.0.0';
    try {
      expect(secureCookies({ req: { header: () => '100.89.1.4:8787' } } as never)).toBe(false);
      expect(secureCookies({ req: { header: () => 'desk.example.com' } } as never)).toBe(true);
      process.env.FORCE_INSECURE_COOKIE = '1';
      expect(secureCookies({ req: { header: () => 'desk.example.com' } } as never)).toBe(false);
    } finally {
      process.env.NODE_ENV = previousNode;
      if (previousForce === undefined) delete process.env.FORCE_INSECURE_COOKIE;
      else process.env.FORCE_INSECURE_COOKIE = previousForce;
      if (previousHost === undefined) delete process.env.HOST;
      else process.env.HOST = previousHost;
    }
  });
});
