const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(FILE)) {
    return { users: {}, groupJid: null, ticketSeq: 0 };
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}
function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

module.exports = {
  getUser(jid) {
    return load().users[jid];
  },
  setUserRole(jid, role) {
    const d = load();
    d.users[jid] = d.users[jid] || {};
    d.users[jid].role = role;
    save(d);
  },
  getUserRole(jid) {
    return load().users[jid]?.role;
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
  setGroupJid(jid) {
    const d = load();
    d.groupJid = jid;
    save(d);
  },
  getGroupJid() {
    return load().groupJid;
  },
  nextTicketId() {
    const d = load();
    d.ticketSeq = (d.ticketSeq || 0) + 1;
    save(d);
    return `TCK-${String(d.ticketSeq).padStart(4, '0')}`;
  },
};