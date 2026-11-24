import { createServer } from 'node:http';
import { createVerify, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const marker = 'webmark-bookmark-index-v1';
const recordId = /^[a-zA-Z0-9-]{8,80}$/;
const certUrl = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const error = (httpStatus, message) => Object.assign(new Error(message), { httpStatus });

export function googleVerifier(project) {
    let certs, expires = 0;
    return async token => {
        const parts = token.split('.');
        if (parts.length !== 3) throw error(401, 'Sign in again.');
        let header, claims;
        try {
            [header, claims] = parts.slice(0, 2).map(part => JSON.parse(Buffer.from(part, 'base64url')));
        } catch { throw error(401, 'Sign in again.'); }
        const now = Date.now() / 1000;
        if (header?.alg !== 'RS256' || typeof header.kid !== 'string' ||
            claims?.aud !== project || claims.iss !== 'https://securetoken.google.com/' + project ||
            typeof claims.sub !== 'string' || !/^[\w-]{1,128}$/.test(claims.sub) ||
            !Number.isFinite(claims.exp) || claims.exp <= now ||
            !Number.isFinite(claims.iat) || claims.iat > now ||
            !Number.isFinite(claims.auth_time) || claims.auth_time > now ||
            claims.firebase?.sign_in_provider !== 'google.com') throw error(401, 'Sign in again.');
        if (Date.now() >= expires) {
            const response = await fetch(certUrl, { signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw error(503, 'Google sign-in verification is temporarily unavailable.');
            certs = await response.json();
            const maxAge = /\bmax-age=(\d+)/.exec(response.headers.get('cache-control') || '');
            expires = Date.now() + (Number(maxAge?.[1]) || 60) * 1000;
        }
        if (!Object.hasOwn(certs, header.kid) ||
            !createVerify('RSA-SHA256').update(parts.slice(0, 2).join('.')).verify(certs[header.kid], Buffer.from(parts[2], 'base64url'))) {
            throw error(401, 'Sign in again.');
        }
        return claims.sub;
    };
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 27_000_000) throw error(413, 'Bookmark batch is too large.');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks)); }
    catch { throw error(400, 'Invalid JSON.'); }
}

export function bookmarkServer({ project, filename, verify = googleVerifier(project) }) {
    const db = new DatabaseSync(filename);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (uid TEXT, id TEXT, value TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(uid,id))');
    const get = db.prepare('SELECT * FROM records WHERE uid = ? AND id = ?');
    const list = db.prepare('SELECT * FROM records WHERE uid = ? AND id > ? ORDER BY id LIMIT 21');
    const put = db.prepare('INSERT OR REPLACE INTO records (uid,id,value,version) VALUES (?,?,?,?)');
    const prefix = 'projects/' + project + '/databases/(default)/documents/users/';
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        try {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname === '/health' && req.method === 'GET') return send(200, { ok: true });
            const token = /^Bearer ([\w.-]{1,8192})$/.exec(req.headers.authorization || '')?.[1];
            if (!token) throw error(401, 'Sign in again.');
            const uid = await verify(token);
            const names = prefix + uid + '/records/';
            const path = '/v1/users/' + encodeURIComponent(uid) + '/records';
            const doc = row => ({ name: names + row.id, updateTime: row.version, fields: { value: { stringValue: row.value } } });
            const idFromName = name => {
                if (typeof name !== 'string' || !name.startsWith(names) || !recordId.test(name.slice(names.length))) throw error(403, 'Invalid bookmark account or record.');
                return name.slice(names.length);
            };
            if (req.method === 'GET' && url.pathname === path) {
                const after = url.searchParams.get('pageToken') || '';
                if (after && !recordId.test(after)) throw error(400, 'Invalid page.');
                const rows = list.all(uid, after);
                return send(200, { documents: rows.slice(0, 20).map(doc), nextPageToken: rows.length > 20 ? rows[19].id : undefined });
            }
            if (req.method === 'GET' && url.pathname.startsWith(path + '/')) {
                const row = get.get(uid, idFromName(names + url.pathname.slice(path.length + 1)));
                if (!row) throw error(404, 'Bookmark record not found.');
                return send(200, doc(row));
            }
            if (req.method === 'POST' && url.pathname === '/v1:batchGet') {
                const { documents } = await readBody(req);
                if (!Array.isArray(documents) || documents.length > 50) throw error(400, 'Invalid bookmark list.');
                return send(200, documents.map(name => {
                    const row = get.get(uid, idFromName(name));
                    return row ? { found: doc(row) } : { missing: name };
                }));
            }
            if (req.method === 'POST' && url.pathname === '/v1:commit') {
                const { writes } = await readBody(req);
                if (!Array.isArray(writes) || writes.length < 1 || writes.length > 26) throw error(400, 'Invalid bookmark batch.');
                const batch = writes.map(write => {
                    const id = idFromName(write?.update?.name);
                    const value = write?.update?.fields?.value?.stringValue;
                    if (typeof value !== 'string' || !/^wm1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(value) || value.length > 1_000_000) throw error(400, 'Expected an encrypted bookmark record.');
                    return { id, value, condition: write.currentDocument };
                });
                if (batch.at(-1).id !== marker || new Set(batch.map(row=>row.id)).size !== batch.length) throw error(400, 'Expected one change marker.');
                db.exec('BEGIN IMMEDIATE');
                try {
                    const writeResults = batch.map(({ id, value, condition }) => {
                        const current = get.get(uid,id);
                        if (current ? current.version !== condition?.updateTime : condition?.exists !== false) throw error(409, 'FAILED_PRECONDITION');
                        const updateTime = randomUUID();
                        put.run(uid,id,value,updateTime);
                        return { updateTime };
                    });
                    db.exec('COMMIT');
                    return send(200, { writeResults });
                } catch (err) { db.exec('ROLLBACK'); throw err; }
            }
            throw error(404, 'Sync endpoint not found.');
        } catch (err) {
            send(err.httpStatus || 500, { error: { message: err.httpStatus ? err.message : 'Bookmark sync service is temporarily unavailable.' } });
        }
    });
    server.on('close', () => db.close());
    return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const project = process.env.WEBMARK_FIREBASE_PROJECT;
    if (!/^[a-z0-9-]{4,64}$/.test(project || '')) throw Error('Set WEBMARK_FIREBASE_PROJECT to your existing Firebase Authentication project ID.');
    bookmarkServer({ project, filename: process.env.WEBMARK_SYNC_DB || 'webmark.sqlite' })
        .listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1');
}
