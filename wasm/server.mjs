import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const port = Number(process.env.PORT || 8787);
const noCache = process.argv.includes('--no-cache') || process.env.NO_CACHE === '1';

// With --no-cache, an old worker is replaced by one that unregisters itself.
const UNREGISTER_SW = [
    "self.addEventListener('install', () => self.skipWaiting());",
    "self.addEventListener('activate', () => self.registration.unregister());",
    '',
].join('\n');

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent((request.url || '/').split('?')[0]);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(root, relative);

    if (file !== path.join(root, 'index.html') && !file.startsWith(root + path.sep)) {
        response.writeHead(403, { 'Content-Type': 'text/plain' });
        response.end('Forbidden');
        return;
    }

    fs.readFile(file, (error, data) => {
        if (error) {
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.end('Not found');
            return;
        }
        if (noCache && relative === 'sw.js') {
            response.writeHead(200, {
                'Content-Type': 'text/javascript; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            response.end(UNREGISTER_SW);
            return;
        }

        let output = data;
        if (noCache && relative === 'index.html') {
            const html = data.toString('utf8').replace('<head>', '<head>\n    <script>window.REPLAYER_NO_CACHE = true;</script>');
            output = Buffer.from(html, 'utf8');
        }

        response.writeHead(200, {
            'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        response.end(output);
    });
});

server.listen(port, '127.0.0.1', () => {
    console.log(`rePlayer wasm: http://127.0.0.1:${port}/${noCache ? ' (cache off)' : ''}`);
});
