#!/usr/bin/env node
'use strict';
/**
 * CoEdit-DS command line client.
 *
 *   node src/client/cli/index.js --user alice --pass password123 --create "My doc"
 *   node src/client/cli/index.js --user bob   --pass password123 --doc doc-abc123
 *   node src/client/cli/index.js --user alice --pass password123 --doc doc-abc123 \
 *        --script "insert 0 Hello; wait 500; insert 5 ' world'; print"
 *
 * Interactive commands (one per line):
 *   insert <pos> <text>     delete <pos> <count>     print
 *   share <user> <role>     status      sync      kill      quit
 */
const readline = require('readline');
const { CoEditClient } = require('../engine');
const { createLogger } = require('../../common/util/log');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) a[k.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.user || !args.pass) {
    console.error('usage: --user <name> --pass <password> [--create <title> | --doc <docId>] [--replica collab-2] [--script "..."]');
    process.exit(1);
  }
  const log = createLogger(`cli/${args.user}`);
  const client = new CoEditClient({
    username: args.user, password: args.pass, logger: log,
    preferReplica: args.replica || null,
  });

  await client.register();
  await client.login();
  log.info('logged_in', { user: args.user, userId: client.userId });

  let docId = args.doc;
  if (args.create) {
    docId = await client.createDoc(String(args.create));
    log.info('doc_created', { docId, title: args.create });
    console.log('\n  DOC ID: ' + docId + '\n');
  }
  if (!docId) {
    const docs = await client.listDocs();
    if (!docs.length) { console.error('no documents; use --create "title"'); process.exit(1); }
    console.log('your documents:');
    for (const d of docs) console.log(`  ${d.id}  ${d.role.padEnd(6)}  ${d.title}`);
    process.exit(0);
  }

  client.on('change', (t) => { if (!args.quiet) render(t); });
  client.on('presence', (p) => { if (!args.quiet) console.log('  [presence] ' + p.map((u) => `${u.username}@${u.pos}`).join(', ')); });
  client.on('failover', (f) => console.log(`  [FAILOVER] ${f.from} -> ${f.to}`));

  await client.open(docId);
  console.log(`\nconnected to ${client.replicaId} as ${client.clientId} (role ${client.role})`);
  render(client.text());

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function exec(line) {
    const s = line.trim();
    if (!s) return true;
    const [cmd, ...rest] = s.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case 'insert': {
        const pos = parseInt(rest[0], 10) || 0;
        let text = rest.slice(1).join(' ');
        if (/^'.*'$/.test(text) || /^".*"$/.test(text)) text = text.slice(1, -1);
        client.insert(pos, text);
        break;
      }
      case 'delete': client.delete(parseInt(rest[0], 10) || 0, parseInt(rest[1], 10) || 1); break;
      case 'print': render(client.text()); break;
      case 'share': await client.share(docId, rest[0], rest[1] || 'editor').then(() => console.log('  shared')); break;
      case 'sync': client.requestSync(); break;
      case 'kill': console.log('  dropping socket'); client.killSocket(); break;
      case 'wait': await sleep(parseInt(rest[0], 10) || 500); break;
      case 'status': console.log('  ' + JSON.stringify({ replica: client.replicaId, clientId: client.clientId, connected: client.connected, ...client.stats, pending: client.doc.pendingCount(), chars: client.doc.length })); break;
      case 'quit': case 'exit': return false;
      default: console.log('  commands: insert <pos> <text> | delete <pos> <n> | print | share <u> <role> | sync | kill | wait <ms> | status | quit');
    }
    return true;
  }

  if (args.script) {
    for (const part of String(args.script).split(';')) await exec(part);
    await sleep(parseInt(args.linger, 10) || 1200);
    console.log('\nFINAL: ' + JSON.stringify(client.text()));
    client.close();
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const cont = await exec(line).catch((e) => { console.error('  error: ' + e.message); return true; });
    if (!cont) { client.close(); rl.close(); process.exit(0); }
    rl.prompt();
  });
  rl.on('close', () => { client.close(); process.exit(0); });
}

function render(text) {
  console.log('\n  ┌' + '─'.repeat(68) + '┐');
  for (const line of (text || '(empty)').split('\n')) {
    for (let i = 0; i < Math.max(1, Math.ceil(line.length / 66)); i++) {
      console.log('  │ ' + line.substr(i * 66, 66).padEnd(66) + ' │');
    }
  }
  console.log('  └' + '─'.repeat(68) + '┘');
}

main().catch((e) => { console.error('fatal: ' + e.message); process.exit(1); });
