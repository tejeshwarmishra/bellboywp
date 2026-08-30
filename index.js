const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const QRCode = require('qrcode');
const express = require('express');
const db = require('./db');

let latestQR = null;

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
    if (event.action !== 'add') return;
    const botNumber = sock.user.id.split(':')[0];
    const botAdded = event.participants.some((p) => p.startsWith(botNumber));
    if (!botAdded) return;

    const groupJid = event.id;
    const inviter = event.author;
    db.registerPendingSociety(groupJid, inviter);

    await sock.sendMessage(groupJid, {
      text: `Hi! I'm the Bellboy bot 👋\n\n${inviter ? '@' + inviter.split('@')[0] + ' ' : ''}please reply here with your society's name to finish setup.`,
      mentions: inviter ? [inviter] : [],
    });
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? msg.key.participant : from;
    const text = extractText(msg);
    if (!text) return;

    try {
      if (isGroup) {
        await handleGroupMessage(sock, from, sender, text);
      } else {
        await handlePrivateMessage(sock, from, text);
      }
    } catch (err) {
      console.error('handler error:', err);
    }
  });
}

async function handlePrivateMessage(sock, from, text) {
  const clean = text.trim().toLowerCase();

  if (['hi', 'hello', 'hey', 'menu'].includes(clean)) {
    const user = db.getUser(from);
    if (!user?.societyGroupJid) {
      db.setUserState(from, 'awaiting_code');
      await sock.sendMessage(from, { text: 'Welcome to Bellboy 👋\nPlease enter your society code to get started.' });
    } else {
      db.setUserState(from, 'menu');
      await sock.sendMessage(from, { text: 'What would you like to do?\n1. Check maintenance dues\n2. Register a complaint\n\nReply with 1 or 2.' });
    }
    return;
  }

  const state = db.getUserState(from);

  if (state === 'awaiting_code') {
    const society = db.getSocietyByCode(text.trim());
    if (!society) {
      await sock.sendMessage(from, { text: 'Code not recognized. Please check with your society admin and try again.' });
      return;
    }
    db.linkUserToSociety(from, society.groupJid);
    db.setUserState(from, 'menu');
    await sock.sendMessage(from, {
      text: `Linked to ${society.name} ✅\n\nWhat would you like to do?\n1. Check maintenance dues\n2. Register a complaint\n\nReply with 1 or 2.`,
    });
    return;
  }

  if (state === 'menu') {
    if (clean === '1') {
      await sock.sendMessage(from, { text: 'Maintenance status: no dues pending. (placeholder — connect to billing system)' });
    } else if (clean === '2') {
      db.setUserState(from, 'awaiting_complaint');
      await sock.sendMessage(from, { text: 'Please describe your complaint in one message.' });
    } else {
      await sock.sendMessage(from, { text: 'Please reply with 1 or 2.' });
    }
    return;
  }

  if (state === 'awaiting_complaint') {
    const user = db.getUser(from);
    const society = db.getSocietyByGroupJid(user.societyGroupJid);
    await sock.sendMessage(society.groupJid, { text: `📢 New complaint\nFrom: ${from.split('@')[0]}\n\n${text}` });
    await sock.sendMessage(from, { text: 'Complaint forwarded to your society ✅' });
    db.setUserState(from, 'menu');
    return;
  }

  await sock.sendMessage(from, { text: "Say 'hi' to get started." });
}

async function handleGroupMessage(sock, groupJid, sender, text) {
  const existingSociety = db.getSocietyByGroupJid(groupJid);

  if (!existingSociety && text.trim().toLowerCase().startsWith('/setup ')) {
    const metadata = await sock.groupMetadata(groupJid);
    const participant = metadata.participants.find((p) => p.id === sender);
    const isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
    if (!isAdmin) {
      await sock.sendMessage(groupJid, { text: 'Only a group admin can run /setup.' });
      return;
    }
    const name = text.trim().slice(7).trim();
    const code = db.finalizeSociety(groupJid, name);
    await sock.groupSettingUpdate(groupJid, 'announcement');
    await sock.sendMessage(groupJid, {
      text: `Society "${name}" registered ✅\nGroup is now admin-only.\nShare this code with residents to register: ${code}`,
    });
    return;
  }

  const pending = db.getPendingSociety(groupJid);
  if (pending) {
    if (sender !== pending.inviter) return;
    const code = db.finalizeSociety(groupJid, text.trim());
    await sock.groupSettingUpdate(groupJid, 'announcement');
    await sock.sendMessage(groupJid, {
      text: `Society "${text.trim()}" registered ✅\nGroup is now admin-only.\nShare this code with residents to register: ${code}`,
    });
    return;
  }

  const society = db.getSocietyByGroupJid(groupJid);
  if (!society) return;

  const metadata = await sock.groupMetadata(groupJid);
  const participant = metadata.participants.find((p) => p.id === sender);
  const isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
  if (!isAdmin) return;

  const state = db.getGroupAdminState(groupJid, sender);

  if (!state) {
    db.setGroupAdminState(groupJid, sender, 'confirm_announcement');
    await sock.sendMessage(groupJid, {
      text: `Hi @${sender.split('@')[0]}, do you want to send an announcement to the group? (yes/no)`,
      mentions: [sender],
    });
    return;
  }

  if (state === 'confirm_announcement') {
    if (text.trim().toLowerCase() === 'yes') {
      db.setGroupAdminState(groupJid, sender, 'awaiting_text');
      await sock.sendMessage(groupJid, { text: 'Send the announcement text now.' });
    } else {
      db.clearGroupAdminState(groupJid, sender);
    }
    return;
  }

  if (state === 'awaiting_text') {
    const members = metadata.participants.map((p) => p.id).filter((id) => id !== sender);
    for (const member of members) {
      await sock.sendMessage(member, { text: `📢 Announcement from ${society.name}:\n\n${text}` });
    }
    db.clearGroupAdminState(groupJid, sender);
    await sock.sendMessage(groupJid, { text: 'Announcement sent to all members ✅' });
    return;
  }
}

const app = express();
app.get('/', (req, res) => res.send('Bellboy bot running'));
app.get('/qr', async (req, res) => {
  if (!latestQR) return res.send('No QR pending — either already logged in, or waiting on connection. Refresh in a few seconds.');
  const dataUrl = await QRCode.toDataURL(latestQR);
  res.send(`<html><body style="text-align:center"><img src="${dataUrl}"/><script>setTimeout(()=>location.reload(),5000)</script></body></html>`);
});
app.get('/pair', async (req, res) => {
  const number = req.query.number; // e.g. 919876543210, no + or spaces
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
app.get('/groups', async (req, res) => {
  if (!global.sock) return res.send('Bot not started yet.');
  try {
    const groups = await global.sock.groupFetchAllParticipating();
    const list = Object.values(groups).map((g) => `${g.id}  —  ${g.subject}`);
    res.send('<pre>' + list.join('\n') + '</pre>');
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});
app.get('/seed', (req, res) => {
  const { groupJid, name, resident } = req.query;
  if (!groupJid || !name || !resident) {
    return res.send('Usage: /seed?groupJid=XXXX@g.us&name=TestSociety&resident=919821343638');
  }
  const code = db.finalizeSociety(groupJid, name);
  const residentJid = resident.includes('@') ? resident : `${resident}@s.whatsapp.net`;
  db.linkUserToSociety(residentJid, groupJid);
  db.setUserState(residentJid, 'menu');
  res.send(`Seeded "${name}" (code: ${code}) for group ${groupJid}, linked resident ${residentJid}. This did NOT change the group's admin-only setting.`);
});
app.listen(process.env.PORT || 3000);

function autoSeed() {
  const { SEED_GROUP_JID, SEED_SOCIETY_NAME, SEED_RESIDENT } = process.env;
  if (!SEED_GROUP_JID || !SEED_SOCIETY_NAME || !SEED_RESIDENT) return;
  if (db.getSocietyByGroupJid(SEED_GROUP_JID)) return;
  const code = db.finalizeSociety(SEED_GROUP_JID, SEED_SOCIETY_NAME);
  const residentJid = SEED_RESIDENT.includes('@') ? SEED_RESIDENT : `${SEED_RESIDENT}@s.whatsapp.net`;
  db.linkUserToSociety(residentJid, SEED_GROUP_JID);
  db.setUserState(residentJid, 'menu');
  console.log(`Auto-seeded ${SEED_SOCIETY_NAME} (${code}) for ${SEED_GROUP_JID}`);
}

autoSeed();
startBot();