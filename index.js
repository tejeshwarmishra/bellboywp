const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const QRCode = require('qrcode');
const express = require('express');
const db = require('./db');

let latestQR = null;

const RESIDENT_KEY = process.env.RESIDENT_ACCESS_KEY || 'RES123';
const ADMIN_KEY = process.env.ADMIN_ACCESS_KEY || 'ADM999';
const DUES_AMOUNT = '₹3,000';
const DUES_DEADLINE = '5th of this month';

function extractText(msg) {
  return (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    null
  );
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
  });

  global.sock = sock;
  global.creds = state.creds;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) latestQR = qr;
    if (connection === 'open') latestQR = null;
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) startBot();
    }
  });

  sock.ev.on('group-participants.update', async (event) => {
    if (event.action !== 'promote') return;
    const botNumber = sock.user.id.split(':')[0];
    const botPromoted = event.participants.some((p) => p.startsWith(botNumber));
    if (!botPromoted) return;

    const groupJid = event.id;
    try {
      db.setGroupJid(groupJid);
      await sock.groupSettingUpdate(groupJid, 'announcement');
      await sock.groupSettingUpdate(groupJid, 'locked');
      await sock.sendMessage(groupJid, {
        text: "BellBoy is now active as group admin 🤖\n\nThis group is now admin-only for messaging and group info edits. I'll route resident complaints, dues reminders, and society announcements here automatically.",
      });
      console.log('Group linked and locked:', groupJid);
    } catch (err) {
      console.error('group takeover failed:', err);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    if (isGroup) return;

    const sender = msg.key.senderPn || msg.key.remoteJidAlt || from;
    const text = extractText(msg);
    if (!text) return;

    try {
      await handleDM(sock, from, sender, text.trim());
    } catch (err) {
      console.error('handler error:', err);
    }
  });
}

async function handleDM(sock, chatJid, identityJid, text) {
  const clean = text.toLowerCase();
  const role = db.getUserRole(identityJid);

  if (!role) {
    if (text === RESIDENT_KEY) {
      db.setUserRole(identityJid, 'resident');
      db.setUserState(identityJid, 'menu');
      await sendResidentMenu(sock, chatJid);
      return;
    }
    if (text === ADMIN_KEY) {
      db.setUserRole(identityJid, 'admin');
      db.setUserState(identityJid, 'menu');
      await sendAdminMenu(sock, chatJid);
      return;
    }
    await sock.sendMessage(chatJid, { text: '🔒 Access restricted.\nPlease enter your access key to continue.' });
    return;
  }

  if (['hi', 'hello', 'hey', 'menu'].includes(clean)) {
    db.setUserState(identityJid, 'menu');
    if (role === 'resident') await sendResidentMenu(sock, chatJid);
    else await sendAdminMenu(sock, chatJid);
    return;
  }

  if (role === 'resident') return handleResident(sock, chatJid, identityJid, clean, text);
  return handleAdmin(sock, chatJid, identityJid, clean, text);
}

async function sendResidentMenu(sock, chatJid) {
  await sock.sendMessage(chatJid, {
    text: 'Resident Portal 🏠\n1. Check maintenance dues\n2. Register a complaint\n3. Facility & venue directory\n\nReply with a number.',
  });
}

async function sendAdminMenu(sock, chatJid) {
  await sock.sendMessage(chatJid, {
    text: 'Admin Portal 🛠️\n1. Broadcast dues reminder\n2. Send society announcement\n3. Publish event/venue update\n\nReply with a number.',
  });
}

async function handleResident(sock, chatJid, identityJid, clean, text) {
  const state = db.getUserState(identityJid);

  if (state === 'menu') {
    if (clean === '1') {
      await sock.sendMessage(chatJid, { text: `Maintenance Dues 💰\nPending: ${DUES_AMOUNT}\nDeadline: ${DUES_DEADLINE}` });
    } else if (clean === '2') {
      db.setUserState(identityJid, 'awaiting_complaint');
      await sock.sendMessage(chatJid, { text: 'Please describe your complaint in one message.' });
    } else if (clean === '3') {
      await sock.sendMessage(chatJid, {
        text: 'Facility Directory 🏢\nClubhouse: 9AM–9PM, book via office\nGym: 6AM–10PM\nSwimming pool: 6AM–8PM (seasonal)\nParking: assigned slots only',
      });
    } else {
      await sock.sendMessage(chatJid, { text: 'Please reply with 1, 2, or 3.' });
    }
    return;
  }

  if (state === 'awaiting_complaint') {
    const groupJid = db.getGroupJid();
    const ticket = db.nextTicketId();
    if (groupJid) {
      await sock.sendMessage(groupJid, {
        text: `📢 New Complaint [${ticket}]\nFrom: ${identityJid.split('@')[0]}\n\n${text}`,
      });
    }
    await sock.sendMessage(chatJid, {
      text: `Complaint logged ✅\nTicket ID: ${ticket}${groupJid ? '' : '\n(No group linked yet — visible to admin here only.)'}`,
    });
    db.setUserState(identityJid, 'menu');
    return;
  }

  await sendResidentMenu(sock, chatJid);
}

async function handleAdmin(sock, chatJid, identityJid, clean, text) {
  const state = db.getUserState(identityJid);
  const groupJid = db.getGroupJid();

  if (state === 'menu') {
    if (clean === '1') {
      if (!groupJid) return sock.sendMessage(chatJid, { text: 'No group linked yet. Add and promote the bot to admin in the society group first.' });
      await sock.sendMessage(groupJid, { text: `🔔 Dues Reminder\nMaintenance of ${DUES_AMOUNT} per flat is due by ${DUES_DEADLINE}. Please clear pending dues.` });
      await sock.sendMessage(chatJid, { text: 'Dues reminder broadcast to group ✅' });
    } else if (clean === '2') {
      db.setUserState(identityJid, 'awaiting_announcement');
      await sock.sendMessage(chatJid, { text: 'Send the announcement text now.' });
    } else if (clean === '3') {
      db.setUserState(identityJid, 'awaiting_event');
      await sock.sendMessage(chatJid, { text: 'Send the event/venue update text now.' });
    } else {
      await sock.sendMessage(chatJid, { text: 'Please reply with 1, 2, or 3.' });
    }
    return;
  }

  if (state === 'awaiting_announcement' || state === 'awaiting_event') {
    if (!groupJid) {
      await sock.sendMessage(chatJid, { text: 'No group linked yet. Add and promote the bot to admin in the society group first.' });
      db.setUserState(identityJid, 'menu');
      return;
    }
    const label = state === 'awaiting_announcement' ? '📣 Society Announcement' : '🎉 Event & Venue Update';
    await sock.sendMessage(groupJid, { text: `${label}\n\n${text}` });
    await sock.sendMessage(chatJid, { text: 'Sent to group ✅' });
    db.setUserState(identityJid, 'menu');
    return;
  }

  await sendAdminMenu(sock, chatJid);
}

const app = express();
app.get('/', (req, res) => res.send('BellBoy bot running'));

app.get('/qr', async (req, res) => {
  if (!latestQR) return res.send('No QR pending — either already logged in, or waiting on connection. Refresh in a few seconds.');
  const dataUrl = await QRCode.toDataURL(latestQR);
  res.send(`<html><body style="text-align:center"><img src="${dataUrl}"/><script>setTimeout(()=>location.reload(),5000)</script></body></html>`);
});

app.get('/pair', async (req, res) => {
  const number = req.query.number;
  if (!number) return res.send('Add your WhatsApp number: /pair?number=91XXXXXXXXXX');
  if (!global.sock) return res.send('Bot not started yet, try again shortly.');
  if (global.creds?.registered) return res.send('Already logged in.');
  try {
    const code = await global.sock.requestPairingCode(number);
    res.send(`Pairing code: ${code}\n\nOn your phone: WhatsApp > Linked Devices > Link a Device > Link with phone number instead > enter this code.`);
  } catch (err) {
    res.send('Error requesting pairing code: ' + err.message);
  }
});

app.get('/debug', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, 'data.json');
  if (!fs.existsSync(file)) return res.send('No data.json yet.');
  res.type('json').send(fs.readFileSync(file, 'utf8'));
});

app.listen(process.env.PORT || 3000);
startBot();