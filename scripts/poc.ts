// Day-1 proof of concept (README §4): link a number via QR and expose POST /send.
// Uses file-based auth in ./auth — NOT for production (see packages/provider for the Postgres store).
import { createServer } from 'node:http';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { toJid } from '@wa/shared';

const PORT = Number(process.env.POC_PORT ?? 3001);
let sock: ReturnType<typeof makeWASocket> | undefined;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'warn' }) });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'open') console.log('CONNECTED as', sock?.user?.id);
    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      console.log('CLOSED', code);
      if (code !== DisconnectReason.loggedOut) void start();
    }
  });
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    const m = messages[0];
    if (m && !m.key.fromMe) console.log('IN', m.key.remoteJid, m.message?.conversation ?? m.message?.extendedTextMessage?.text);
  });
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/send') return res.writeHead(404).end();
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { to, text } = JSON.parse(raw) as { to: string; text: string };
    if (!sock) throw new Error('socket not ready');
    const result = await sock.sendMessage(toJid(to), { text });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: result?.key.id }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
  }
}).listen(PORT, () => console.log(`POC listening on http://localhost:${PORT}`));

void start();
