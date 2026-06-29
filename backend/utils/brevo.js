const net = require('net');
const tls = require('tls');

function configError(message) {
  const error = new Error(message);
  error.publicMessage = message;
  return error;
}

function getFrom() {
  const email = process.env.BREVO_FROM_EMAIL || process.env.MAIL_FROM_EMAIL;
  if (!email) throw configError('Configuration Brevo manquante: BREVO_FROM_EMAIL');

  return {
    email,
    name: process.env.BREVO_FROM_NAME || process.env.MAIL_FROM_NAME || 'SalesForge',
  };
}

function encodeHeader(value = '') {
  return String(value).replace(/[\r\n]/g, ' ').trim();
}

async function sendWithBrevoApi({ to, subject, htmlContent, textContent }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return false;

  const from = getFrom();
  const response = await fetch(process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: from,
      to: [{ email: to }],
      subject,
      htmlContent,
      textContent,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Brevo API: ${response.status} ${detail}`);
  }

  return true;
}

function isCompleteSmtpResponse(text) {
  const lines = text.split('\r\n').filter(Boolean);
  return lines.length > 0 && /^\d{3} /.test(lines[lines.length - 1]);
}

function createSmtpReader(socket) {
  let buffer = '';
  let pending = null;

  function flush() {
    if (!pending || !isCompleteSmtpResponse(buffer)) return;
    const response = buffer;
    buffer = '';
    const current = pending;
    pending = null;
    current.resolve(response);
  }

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    flush();
  });

  socket.on('error', (error) => {
    if (pending) {
      pending.reject(error);
      pending = null;
    }
  });

  return () => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    flush();
  });
}

function smtpCode(response) {
  return Number(response.slice(0, 3));
}

async function expectSmtp(socket, read, expectedCodes) {
  const response = await read();
  const code = smtpCode(response);
  if (!expectedCodes.includes(code)) {
    throw new Error(`Brevo SMTP: ${response.trim()}`);
  }
  return response;
}

async function writeSmtp(socket, read, command, expectedCodes) {
  socket.write(`${command}\r\n`);
  return expectSmtp(socket, read, expectedCodes);
}

function connectSocket(host, port, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));

    socket.once('error', reject);
  });
}

function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');

    const secureSocket = tls.connect({ socket, servername: host }, () => resolve(secureSocket));
    secureSocket.once('error', reject);
  });
}

function buildMessage({ from, to, subject, htmlContent }) {
  const body = String(htmlContent || '').replace(/^\./gm, '..');
  return [
    `From: ${encodeHeader(from.name)} <${from.email}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    body,
  ].join('\r\n');
}

async function sendWithBrevoSmtp({ to, subject, htmlContent }) {
  const password = process.env.BREVO_SMTP_KEY;
  if (!password) return false;

  const from = getFrom();
  const username = process.env.BREVO_SMTP_LOGIN || process.env.BREVO_SMTP_USER || from.email;
  const host = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
  const port = Number(process.env.BREVO_SMTP_PORT || 587);
  const secure = process.env.BREVO_SMTP_SECURE === 'true' || port === 465;
  const message = buildMessage({ from, to, subject, htmlContent });

  let socket = await connectSocket(host, port, secure);
  let read = createSmtpReader(socket);
  await expectSmtp(socket, read, [220]);
  await writeSmtp(socket, read, `EHLO ${process.env.BREVO_SMTP_HELO || 'salesforge.local'}`, [250]);

  if (!secure) {
    await writeSmtp(socket, read, 'STARTTLS', [220]);
    socket = await upgradeToTls(socket, host);
    read = createSmtpReader(socket);
    await writeSmtp(socket, read, `EHLO ${process.env.BREVO_SMTP_HELO || 'salesforge.local'}`, [250]);
  }

  await writeSmtp(socket, read, 'AUTH LOGIN', [334]);
  await writeSmtp(socket, read, Buffer.from(username).toString('base64'), [334]);
  await writeSmtp(socket, read, Buffer.from(password).toString('base64'), [235]);
  await writeSmtp(socket, read, `MAIL FROM:<${from.email}>`, [250]);
  await writeSmtp(socket, read, `RCPT TO:<${to}>`, [250, 251]);
  await writeSmtp(socket, read, 'DATA', [354]);
  socket.write(`${message}\r\n.\r\n`);
  await expectSmtp(socket, read, [250]);
  socket.write('QUIT\r\n');
  socket.end();

  return true;
}

async function sendEmail(payload) {
  if (await sendWithBrevoApi(payload)) return;
  if (await sendWithBrevoSmtp(payload)) return;
  throw configError('Configuration Brevo manquante: BREVO_API_KEY ou BREVO_SMTP_KEY');
}

async function sendPasswordResetEmail({ to, resetUrl }) {
  await sendEmail({
    to,
    subject: 'Reinitialisation de votre mot de passe SalesForge',
    textContent: `Cliquez sur ce lien pour reinitialiser votre mot de passe: ${resetUrl}`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
        <h2>Reinitialisation du mot de passe</h2>
        <p>Vous avez demande a reinitialiser votre mot de passe SalesForge.</p>
        <p>
          <a href="${resetUrl}" style="display:inline-block;background:#1340E0;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">
            Choisir un nouveau mot de passe
          </a>
        </p>
        <p>Si vous n'etes pas a l'origine de cette demande, vous pouvez ignorer cet email.</p>
      </div>
    `,
  });
}

module.exports = {
  sendEmail,
  sendPasswordResetEmail,
};
