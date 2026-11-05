// Daily review of what the bot handled: reads `journalctl -o json` on stdin
// and prints a report. Run it through `mise run review` (see README).
//
// It reads the `[msg]` and `[error]` lines the bot writes (src/trace.js), plus
// the service's own start and failure lines. Anything else is ignored, so
// older logs without `[msg]` lines produce an empty report, not an error.

import { createInterface } from 'node:readline';

const SLOWEST = 5;
const EXAMPLES = 3;

const messages = [];
const errors = [];
let starts = 0;
let crashes = 0;
let first = null;
let last = null;

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  const text = typeof entry.MESSAGE === 'string' ? entry.MESSAGE : '';
  const at = new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000);
  first ??= at;
  last = at;

  if (text.startsWith('[msg] ')) {
    const record = parseJson(text.slice(6));
    if (record) messages.push({ at, ...record });
  } else if (text.startsWith('[error] ')) {
    const record = parseJson(text.slice(8));
    if (record) errors.push({ at, ...record });
  } else if (text.startsWith('logged in as ')) {
    starts += 1;
  } else if (/Failed with result/.test(text)) {
    // systemd also writes 'Main process exited' for the same event: count one.
    crashes += 1;
  }
}

process.stdout.write(report());

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function report() {
  const out = [];
  const range = first ? `${stamp(first)} to ${stamp(last)}` : 'no log lines';
  out.push(`# cleanlink review, ${range}`, '');

  const urls = messages.flatMap((m) => m.urls.map((u) => ({ ...u, message: m })));
  out.push(`Messages: ${messages.length}, URLs: ${urls.length}, service starts: ${starts}, service failures: ${crashes}`, '');

  out.push('## How messages ended');
  out.push(table(['reply', 'count'], countBy(messages, (m) => m.reply)));

  out.push('## Per site');
  const rows = [...groupBy(urls, siteOf)].map(([site, list]) => [
    site,
    list.length,
    list.filter((u) => u.clean && !['unchanged', 'error'].includes(u.clean)).length,
    list.filter((u) => u.card && !u.card.includes(':')).length,
    countBy(list.filter((u) => u.media), (u) => u.media.replace(/:\d+$/, '')).map(([k, n]) => `${k} ${n}`).join(', ') || '-',
  ]).sort((a, b) => b[1] - a[1]);
  out.push(table(['site', 'urls', 'cleaned', 'carded', 'media'], rows));

  out.push('## Problems');
  const problems = urls.flatMap((u) => problemsOf(u).map((kind) => ({ kind, u })));
  const refused = messages.filter((m) => ['refused', 'error'].includes(m.reply));
  if (problems.length === 0 && refused.length === 0) out.push('None.', '');
  for (const [kind, list] of groupBy(problems, (p) => p.kind)) {
    out.push(`### ${kind} (${list.length})`);
    for (const { u } of list.slice(0, EXAMPLES)) {
      out.push(`- ${stamp(u.message.at)} ${u.message.where} - ${u.in}`);
      for (const n of u.notes ?? []) out.push(`  - ${n}`);
    }
    if (list.length > EXAMPLES) out.push(`- ... ${list.length - EXAMPLES} more`);
    out.push('');
  }
  for (const m of refused) {
    out.push(`- reply ${m.reply}: ${stamp(m.at)} ${m.where}, message ${m.id}`);
    for (const n of m.notes ?? []) out.push(`  - ${n}`);
  }
  if (refused.length > 0) out.push('');

  out.push('## Errors');
  if (errors.length === 0) out.push('None.', '');
  for (const [key, list] of groupBy(errors, (e) => `${e.kind}: ${e.message}`)) {
    out.push(`- ${list.length}x ${key}`);
    const example = list[0];
    if (example.id) out.push(`  - message ${example.id}`);
    for (const frame of example.stack ?? []) out.push(`  - ${frame}`);
  }
  if (errors.length > 0) out.push('');

  out.push('## Slowest messages');
  const slow = [...messages].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST);
  out.push(table(['ms', 'when', 'urls'], slow.map((m) => [m.ms, stamp(m.at), m.urls.map((u) => u.in).join(' ')])));

  return `${out.join('\n')}\n`;
}

/** Everything about one URL that a reviewer should look at. */
function problemsOf(u) {
  const kinds = [];
  if (u.resolve) kinds.push(`resolve ${u.resolve}`);
  if (u.redirect === 'none') kinds.push('share link did not redirect');
  if (u.clean === 'error') kinds.push('clean error');
  if (u.card?.includes(':')) kinds.push(`card ${u.card.replace(':', ' ')}`);
  if (u.media === 'follow_up') kinds.push('video too large, sent as follow-up');
  if (u.media === 'unfurl') kinds.push('no card of ours, link handed to a mirror');
  return kinds;
}

/** The card site when there is one, otherwise the host, without www. */
function siteOf(u) {
  if (u.card) return u.card.split(':')[0];
  try {
    return new URL(u.in).hostname.replace(/^www\./, '');
  } catch {
    return u.in.split('/')[0];
  }
}

function groupBy(list, key) {
  const groups = new Map();
  for (const item of list) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

function countBy(list, key) {
  return [...groupBy(list, key)].map(([k, items]) => [k, items.length]).sort((a, b) => b[1] - a[1]);
}

function table(head, rows) {
  if (rows.length === 0) return 'None.\n';
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return `${[line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n')}\n`;
}

function stamp(date) {
  // Local time of the machine running the review, minutes are enough.
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
