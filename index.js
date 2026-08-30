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
    const botNumber = sock.user.id.split(':')[0];
    const groupJid = event.id;

    if (event.action === 'promote') {
      const botPromoted = event.participants.some((p) => p.startsWith(botNumber));
      if (botPromoted) {
        try {
          await sock.groupSettingUpdate(groupJid, 'announcement');
          await sock.sendMessage(groupJid, { text: 'I was made admin — this group is now locked to admin-only messaging.' });
        } catch (err) {
          console.error('lock group failed:', err);
        }
      }
      return;
    }

    if (event.action !== 'add') return;
    const botAdded = event.participants.some((p) => p.startsWith(botNumber));
    if (!botAdded) return;

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
    const sender = isGroup ? (msg.key.participantPn || msg.key.participant) : (msg.key.senderPn || msg.key.remoteJidAlt || from);
    const text = extractText(msg);
    console.log('INCOMING', JSON.stringify({ from, isGroup, sender, key: msg.key, text }));
    if (!text) return;

    try {
      if (isGroup) {
        await handleGroupMessage(sock, from, sender, text);
      } else {
        await handlePrivateMessage(sock, from, sender, text);
      }
    } catch (err) {
      console.error('handler error:', err);
    }
  });
}

async function handlePrivateMessage(sock, chatJid, identityJid, text) {
  const clean = text.trim().toLowerCase();

  if (['hi', 'hello', 'hey', 'menu'].includes(clean)) {
    const user = db.getUser(identityJid);
    if (!user?.societyGroupJid) {
      db.setUserState(identityJid, 'awaiting_code');
      await sock.sendMessage(chatJid, { text: 'Welcome to Bellboy 👋\nPlease enter your society code to get started.' });
    } else {
      db.setUserState(identityJid, 'menu');
      await sock.sendMessage(chatJid, { text: 'What would you like to do?\n1. Check maintenance dues\n2. Register a complaint\n\nReply with 1 or 2.' });
    }
    return;
  }

  const state = db.getUserState(identityJid);

  if (state === 'awaiting_code') {
    const society = db.getSocietyByCode(text.trim());
    if (!society) {
      await sock.sendMessage(chatJid, { text: 'Code not recognized. Please check with your society admin and try again.' });
      return;
    }
    db.linkUserToSociety(identityJid, society.groupJid);
    db.setUserState(identityJid, 'menu');
    await sock.sendMessage(chatJid, {
      text: `Linked to ${society.name} ✅\n\nWhat would you like to do?\n1. Check maintenance dues\n2. Register a complaint\n\nReply with 1 or 2.`,
    });
    return;
  }

  if (state === 'menu') {
    if (clean === '1') {
      await sock.sendMessage(chatJid, { text: 'Maintenance status: no dues pending. (placeholder — connect to billing system)' });
    } else if (clean === '2') {
      db.setUserState(identityJid, 'awaiting_complaint');
      await sock.sendMessage(chatJid, { text: 'Please describe your complaint in one message.' });
    } else {
      await sock.sendMessage(chatJid, { text: 'Please reply with 1 or 2.' });
    }
    return;
  }

  if (state === 'awaiting_complaint') {
    const user = db.getUser(identityJid);
    const society = db.getSocietyByGroupJid(user.societyGroupJid);
    await sock.sendMessage(society.groupJid, { text: `📢 New complaint\nFrom: ${identityJid.split('@')[0]}\n\n${text}` });
    await sock.sendMessage(chatJid, { text: 'Complaint forwarded to your society ✅' });
    db.setUserState(identityJid, 'menu');
    return;
  }

  await sock.sendMessage(chatJid, { text: "Say 'hi' to get started." });
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
    const members = metadata.participants.map((p) => p.id).filter((id) => id !== sender && !id.startsWith(sock.user.id.split(':')[0]));
    let sentCount = 0;
    for (const member of members) {
      try {
        await sock.sendMessage(member, { text: `📢 Announcement from ${society.name}:\n\n${text}` });
        sentCount++;
      } catch (err) {
        console.error('announcement send failed for', member, err.message);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    db.clearGroupAdminState(groupJid, sender);
    await sock.sendMessage(groupJid, { text: `Announcement sent to ${sentCount}/${members.length} members ✅` });
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
app.get('/debug', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, 'data.json');
  if (!fs.existsSync(file)) return res.send('No data.json yet.');
  res.type('json').send(fs.readFileSync(file, 'utf8'));
});
app.listen(process.env.PORT || 3000);

function autoSeed() {
  const { SEED_GROUP_JID, SEED_SOCIETY_NAME, SEED_RESIDENT } = process.env;
  if (!SEED_GROUP_JID || !SEED_SOCIETY_NAME || !SEED_RESIDENT) return;
  if (!db.getSocietyByGroupJid(SEED_GROUP_JID)) {
    const code = db.finalizeSociety(SEED_GROUP_JID, SEED_SOCIETY_NAME);
    console.log(`Auto-seeded ${SEED_SOCIETY_NAME} (${code}) for ${SEED_GROUP_JID}`);
  }
  const residents = SEED_RESIDENT.split(',').map((r) => r.trim()).filter(Boolean);
  for (const resident of residents) {
    const residentJid = resident.includes('@') ? resident : `${resident}@s.whatsapp.net`;
    db.linkUserToSociety(residentJid, SEED_GROUP_JID);
    db.setUserState(residentJid, 'menu');
    console.log(`Linked resident ${residentJid}`);
  }
}

autoSeed();
startBot();