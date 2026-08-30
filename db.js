const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(FILE)) {
    return { users: {}, societies: {}, pendingSocieties: {}, groupAdminStates: {} };
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

module.exports = {
  getUser(jid) {
    return load().users[jid];
  },
  setUserState(jid, state) {
    const d = load();
    d.users[jid] = d.users[jid] || {};
    d.users[jid].state = state;
    save(d);
  },
  getUserState(jid) {
    return load().users[jid]?.state;
  },
  linkUserToSociety(jid, groupJid) {
    const d = load();
    d.users[jid] = d.users[jid] || {};
    d.users[jid].societyGroupJid = groupJid;
    save(d);
  },
  getSocietyByCode(code) {
    return Object.values(load().societies).find(s => s.code === code.toUpperCase());
  },
  getSocietyByGroupJid(groupJid) {
    return load().societies[groupJid];
  },
  registerPendingSociety(groupJid, inviter) {
    const d = load();
    d.pendingSocieties[groupJid] = { inviter };
    save(d);
  },
  getPendingSociety(groupJid) {
    return load().pendingSocieties[groupJid];
  },
  finalizeSociety(groupJid, name) {
    const d = load();
    const code = genCode();
    d.societies[groupJid] = { name, groupJid, code };
    delete d.pendingSocieties[groupJid];
    save(d);
    return code;
  },
  getGroupAdminState(groupJid, adminJid) {
    return load().groupAdminStates[`${groupJid}:${adminJid}`];
  },
  setGroupAdminState(groupJid, adminJid, state) {
    const d = load();
    d.groupAdminStates[`${groupJid}:${adminJid}`] = state;
    save(d);
  },
  clearGroupAdminState(groupJid, adminJid) {
    const d = load();
    delete d.groupAdminStates[`${groupJid}:${adminJid}`];
    save(d);
  },
};
