const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const db = require('./db');

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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });
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
app.listen(process.env.PORT || 3000);

startBot();
