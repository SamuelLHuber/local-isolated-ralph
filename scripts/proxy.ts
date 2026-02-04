#!/usr/bin/env bun
/**
 * Moonshot AI Proxy for Codex CLI
 * Fixes ROLE_UNSPECIFIED error by converting 'developer' role to 'system'
 * 
 * Usage:
 *   bun run proxy.ts
 *   
 * Then in ~/.codex/config.toml:
 *   base_url = "http://localhost:3000"
 */

const PORT = 33000;
const MOONSHOT_BASE_URL = "https://api.moonshot.ai";

// Simple HTTP proxy with role translation
const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    
    // Only proxy /v1 paths
    if (!url.pathname.startsWith('/v1')) {
      return new Response('Not found', { status: 404 });
    }

    // Construct target URL
    const targetUrl = `${MOONSHOT_BASE_URL}${url.pathname}${url.search}`;
    
    // Clone headers
    const headers = new Headers(request.headers);
    headers.delete('host');
    
    let body: string | null = null;
    
    // Handle request body for POST/PUT
    if (request.method === 'POST' || request.method === 'PUT') {
      const contentType = request.headers.get('content-type') || '';
      
      if (contentType.includes('application/json')) {
        try {
          const json = await request.json();
          
          // Translate developer role to system in messages
          if (json.messages && Array.isArray(json.messages)) {
            json.messages = json.messages.map((msg: any) => ({
              ...msg,
              role: msg.role === 'developer' ? 'system' : msg.role
            }));
          }
          
          body = JSON.stringify(json);
          headers.set('content-length', String(Buffer.byteLength(body)));
        } catch (e) {
          // If JSON parsing fails, pass through raw body
          body = await request.text();
        }
      } else {
        body = await request.text();
      }
    }

    // Forward request to Moonshot
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
    });

    // Return response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
});

console.log(`🚀 Moonshot AI Proxy running on http://localhost:${PORT}`);
console.log(`📡 Forwarding to ${MOONSHOT_BASE_URL}`);
console.log(`🔧 Translating 'developer' role → 'system'`);
console.log('');
console.log('Add to ~/.codex/config.toml:');
console.log(`  base_url = "http://localhost:${PORT}/v1"`);
