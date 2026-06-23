import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';

function extractPageTitle(htmlText) {
  const match = String(htmlText || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return match[1]
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    let settled = false;
    let request;

    function finishHtml(html) {
      if (settled) return;
      settled = true;
      resolve(html);
      request?.destroy();
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    request = client.get(
      url,
      {
        headers: {
          'user-agent': 'Mozilla/5.0 Rubrics-QC-Workbench',
          accept: 'text/html,application/xhtml+xml',
        },
        timeout: 12000,
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          const redirectedUrl = new URL(response.headers.location, url).toString();
          fetchHtml(redirectedUrl).then(resolve, reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        response.setEncoding('utf8');
        let html = '';
        response.on('data', (chunk) => {
          html += chunk;
          if (/<\/title>/i.test(html)) finishHtml(html);
          if (html.length > 512 * 1024) finishHtml(html);
        });
        response.on('end', () => finishHtml(html));
      },
    );

    request.on('timeout', () => fail(new Error('timeout')));
    request.on('error', fail);
  });
}

function pageTitleMiddleware() {
  return {
    name: 'page-title-middleware',
    configureServer(server) {
      server.middlewares.use('/api/page-title', async (request, response) => {
        try {
          const requestUrl = new URL(request.url || '', 'http://localhost');
          const targetUrl = requestUrl.searchParams.get('url');
          if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
            response.statusCode = 400;
            response.end(JSON.stringify({ title: '', error: 'invalid url' }));
            return;
          }

          const html = await fetchHtml(targetUrl);
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ title: extractPageTitle(html) }));
        } catch (error) {
          response.statusCode = 502;
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ title: '', error: error.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pageTitleMiddleware()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        label: resolve(__dirname, 'label/index.html'),
      },
    },
  },
});
