const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'accounts.json');

function load() {
  if (!fs.existsSync(FILE)) return { accounts: {}, pendingEmail: {} };
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { accounts: {}, pendingEmail: {} };
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function getAccount(jid) {
  return load().accounts[jid] || null;
}

function setAccount(jid, account) {
  const data = load();
  data.accounts[jid] = account;
  save(data);
}

function clearAccount(jid) {
  const data = load();
  delete data.accounts[jid];
  save(data);
}

function getPendingEmail(jid) {
  return load().pendingEmail[jid] || null;
}

function setPendingEmail(jid, email) {
  const data = load();
  data.pendingEmail[jid] = email;
  save(data);
}

function clearPendingEmail(jid) {
  const data = load();
  delete data.pendingEmail[jid];
  save(data);
}

module.exports = { getAccount, setAccount, clearAccount, getPendingEmail, setPendingEmail, clearPendingEmail };