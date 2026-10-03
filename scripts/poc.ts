/**
 * README §4 prototype: links a number by QR (printed in the terminal) and exposes POST /send.
 * File-based auth in ./auth — for experiments only; the platform uses Postgres auth state.
 *
 *   pnpm poc
 *   curl -X POST localhost:3001/send -H 'content-type: application/json' -d '{"to":"+2010XXXXXXXX","text":"hello"}'
 */
import type { Boom } from '@hapi/boom';
import makeWASocket, { DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys';
import Fastify from 'fastify';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

let sock: WASocket;
const logger = pino({ level: 'warn' });

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestWaWebVersion();
  sock = makeWASocket({ auth: state, version, logger, markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'open') console.log('connected as', sock.user?.id);
    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      console.log('closed', code);
      if (code !== DisconnectReason.loggedOut) void start();
    }
  });
  sock.ev.on('messages.upsert', ({ messages }) => {
    const m = messages[0];
    if (m && !m.key.fromMe) console.log('IN', m.key.remoteJid, m.message?.conversation ?? m.message?.extendedTextMessage?.text);
  });
}

const app = Fastify();
app.post('/send', async (req) => {
  const { to, text } = req.body as { to: string; text: string };
  const jid = `${to.replace(/\D/g, '')}@s.whatsapp.net`;
  const msg = await sock.sendMessage(jid, { text });
  return { id: msg?.key.id };
});

await start();
await app.listen({ port: 3001 });
console.log('POC listening on :3001 — scan the QR above with WhatsApp → Linked devices');
