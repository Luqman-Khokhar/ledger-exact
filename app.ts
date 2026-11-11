import type { Answer, Result, Sources, Storage } from './app.contract.d.ts';

const FILE = 'app:/data/ledger.json';
export const grants = [`fs.read ${FILE}`, `fs.write ${FILE}`].join('\n');

type Reply = Result<'addTxn'>;
type StoredTxn = { id: string; amount: number; categoryId: string; paidBy: string; note: string; day: string; at: number };
type StoredCat = { id: string; name: string; limit: number };
type StoredMember = { id: string; name: string };
type StoredSettlement = { id: string; from: string; to: string; amount: number; day: string; at: number };
type Book = { members: StoredMember[]; categories: StoredCat[]; txns: StoredTxn[]; settlements: StoredSettlement[] };

// A first launch starts with one person and four categories (limits in cents), so an expense can be added at once.
const fresh = (): Book => ({
  members: [{ id: '1', name: 'You' }],
  categories: [
    { id: '1', name: 'Groceries', limit: 45000 },
    { id: '2', name: 'Eating Out', limit: 20000 },
    { id: '3', name: 'Transport', limit: 15000 },
    { id: '4', name: 'Bills', limit: 60000 },
  ],
  txns: [],
  settlements: [],
});

let book: Book | null = null; // memory; the file is what survives a launch

async function load(storage: Storage): Promise<Book> {
  if (!book) book = await storage.fs.readFile(FILE).then(
    (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as Book,
    (e) => { if (e.code === 'ENOENT') return fresh(); throw e; }); // no file yet; 'bake' (the build) passes through
  return book;
}
async function save(storage: Storage, next: Book): Promise<Reply> {
  book = next;
  await storage.fs.atomicWriteFile(FILE, new TextEncoder().encode(JSON.stringify(next)));
  return { ok: true, error: '' };
}
const refuse = (error: string): Reply => ({ ok: false, error });
const nextId = (rows: { id: string }[]) => String(Math.max(0, ...rows.map((r) => Number(r.id))) + 1);
const sum = (rows: { amount: number }[]) => rows.reduce((total, r) => total + r.amount, 0);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// A month key ("2026-10") from the location: none, a malformed one or one past this month is this month.
// `prev` and `next` are its neighbours' keys; `next` is "" when it is this month (the bare location).
const keyOf = (y: number, m: number) => {
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
function monthOf(today: string, asked: string) {
  const thisKey = today.slice(0, 7);
  const key = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) && asked < thisKey ? asked : thisKey;
  const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)) - 1;
  const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m, 1)));
  const after = keyOf(y, m + 1);
  return { key, label, prev: keyOf(y, m - 1), next: key === thisKey || after === thisKey ? '' : after, current: key === thisKey };
}

// A category's colour is a palette token (app.tamber's cat.c1 … cat.c8), by its place in the list.
const hueAt = (i: number) => `cat.c${(i % 8) + 1}`;
const hueOf = (b: Book, id: string) => {
  const i = b.categories.findIndex((c) => c.id === id);
  return i < 0 ? 'cat.c8' : hueAt(i);
};

function rowsOf(b: Book, txns: StoredTxn[]) {
  const catName = (id: string) => b.categories.find((c) => c.id === id)?.name ?? 'Uncategorized';
  const memberName = (id: string) => b.members.find((m) => m.id === id)?.name ?? 'Someone';
  return [...txns].sort((x, y) => y.at - x.at || Number(y.id) - Number(x.id))
    .map((t) => ({ ...t, categoryName: catName(t.categoryId), payerName: memberName(t.paidBy), hue: hueOf(b, t.categoryId) }));
}

// Each expense splits equally between everyone; the odd cents go to the first people, so shares add up to the amount.
function balances(b: Book) {
  const n = b.members.length;
  const owed = new Map(b.members.map((m) => [m.id, 0]));
  const paid = new Map(b.members.map((m) => [m.id, 0]));
  for (const t of b.txns) {
    if (n === 0) break;
    const base = Math.floor(t.amount / n), extra = t.amount - base * n;
    b.members.forEach((m, i) => owed.set(m.id, (owed.get(m.id) ?? 0) + base + (i < extra ? 1 : 0)));
    paid.set(t.paidBy, (paid.get(t.paidBy) ?? 0) + t.amount);
  }
  const balance = new Map(b.members.map((m) => [m.id, (paid.get(m.id) ?? 0) - (owed.get(m.id) ?? 0)]));
  for (const s of b.settlements) {
    balance.set(s.from, (balance.get(s.from) ?? 0) + s.amount);
    balance.set(s.to, (balance.get(s.to) ?? 0) - s.amount);
  }
  return { paid, balance };
}

// The fewest payments, greedily: the one who owes most pays the one owed most, until everyone is even.
function transfers(b: Book, balance: Map<string, number>) {
  const name = (id: string) => b.members.find((m) => m.id === id)?.name ?? 'Someone';
  const debtors = b.members.map((m) => ({ id: m.id, left: -(balance.get(m.id) ?? 0) })).filter((d) => d.left > 0);
  const creditors = b.members.map((m) => ({ id: m.id, left: balance.get(m.id) ?? 0 })).filter((c) => c.left > 0);
  const out: Result<'loadPeople'>['transfers'] = [];
  while (debtors.length && creditors.length) {
    debtors.sort((x, y) => y.left - x.left);
    creditors.sort((x, y) => y.left - x.left);
    const d = debtors[0], c = creditors[0], amount = Math.min(d.left, c.left);
    out.push({ id: `${d.id}-${c.id}`, from: d.id, fromName: name(d.id), to: c.id, toName: name(c.id), amount });
    d.left -= amount;
    c.left -= amount;
    if (d.left === 0) debtors.shift();
    if (c.left === 0) creditors.shift();
  }
  return out;
}

const sources: Sources = {
  // The view has no reduce or sort, and the data module no clock: today ("2026-11-12") is an argument.
  loadMonth: async ([today, asked], _store, storage) => {
    const b = await load(storage);
    const { key, label, prev, next, current } = monthOf(today, asked);
    const txns = rowsOf(b, b.txns.filter((t) => t.day.startsWith(key)));
    const days: Result<'loadMonth'>['days'] = [];
    for (const t of txns) {
      const d = days.find((x) => x.day === t.day);
      if (d) d.total += t.amount;
      else days.push({ day: t.day, at: t.at, total: t.amount });
    }
    // The six months up to this one, oldest first, each a fraction of the tallest (for the bars).
    const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)) - 1;
    const short = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
    const months = [5, 4, 3, 2, 1, 0].map((back) => {
      const k = keyOf(y, m - back);
      return { key: k, label: short.format(new Date(Date.UTC(y, m - back, 1))), total: sum(b.txns.filter((t) => t.day.startsWith(k))), current: back === 0 };
    });
    const peak = Math.max(1, ...months.map((x) => x.total));
    const trend = months.map((x) => ({ ...x, fraction: x.total / peak }));
    return {
      key, label, prev, next, current, trend,
      spent: sum(txns),
      budget: b.categories.reduce((total, c) => total + c.limit, 0),
      days, txns,
      categories: b.categories.map((c, i) => ({ ...c, hue: hueAt(i), spent: sum(txns.filter((t) => t.categoryId === c.id)) })),
    };
  },
  loadTxns: async (_args, _store, storage) => {
    const b = await load(storage);
    return rowsOf(b, b.txns);
  },
  loadPeople: async (_args, _store, storage) => {
    const b = await load(storage);
    const { paid, balance } = balances(b);
    return {
      members: b.members.map((m) => ({ ...m, paid: paid.get(m.id) ?? 0, balance: balance.get(m.id) ?? 0 })),
      transfers: transfers(b, balance),
    };
  },
  addTxn: async ([amount, categoryId, paidBy, note, day, at], _store, storage) => {
    const b = await load(storage);
    if (!Number.isInteger(amount) || amount <= 0) return refuse('Enter an amount more than zero.');
    if (!b.categories.some((c) => c.id === categoryId)) return refuse('Pick a category.');
    if (!b.members.some((m) => m.id === paidBy)) return refuse('Pick who paid.');
    return save(storage, { ...b, txns: [...b.txns, { id: nextId(b.txns), amount, categoryId, paidBy, note: note.trim(), day, at }] });
  },
  updateTxn: async ([id, amount, categoryId, paidBy, note], _store, storage) => {
    const b = await load(storage);
    if (!b.txns.some((t) => t.id === id)) return refuse('This expense was deleted.');
    if (!Number.isInteger(amount) || amount <= 0) return refuse('Enter an amount more than zero.');
    if (!b.categories.some((c) => c.id === categoryId)) return refuse('Pick a category.');
    if (!b.members.some((m) => m.id === paidBy)) return refuse('Pick who paid.');
    return save(storage, { ...b, txns: b.txns.map((t) => t.id === id ? { ...t, amount, categoryId, paidBy, note: note.trim() } : t) });
  },
  removeTxn: async ([id], _store, storage) => {
    const b = await load(storage);
    return save(storage, { ...b, txns: b.txns.filter((t) => t.id !== id) });
  },
  addCategory: async ([name, limit], _store, storage) => {
    const b = await load(storage);
    const clean = name.trim();
    if (clean === '') return refuse('Enter a name.');
    const dup = b.categories.find((c) => same(c.name, clean));
    if (dup) return refuse(`There’s already a category called ${dup.name}.`);
    if (!Number.isInteger(limit) || limit <= 0) return refuse('Enter a monthly limit more than zero.');
    return save(storage, { ...b, categories: [...b.categories, { id: nextId(b.categories), name: clean, limit }] });
  },
  updateCategory: async ([id, name, limit], _store, storage) => {
    const b = await load(storage);
    const clean = name.trim();
    if (!b.categories.some((c) => c.id === id)) return refuse('This category was deleted.');
    if (clean === '') return refuse('Enter a name.');
    const dup = b.categories.find((c) => c.id !== id && same(c.name, clean));
    if (dup) return refuse(`There’s already a category called ${dup.name}.`);
    if (!Number.isInteger(limit) || limit <= 0) return refuse('Enter a monthly limit more than zero.');
    return save(storage, { ...b, categories: b.categories.map((c) => c.id === id ? { ...c, name: clean, limit } : c) });
  },
  addMember: async ([name], _store, storage) => {
    const b = await load(storage);
    const clean = name.trim();
    if (clean === '') return refuse('Enter a name.');
    const dup = b.members.find((m) => same(m.name, clean));
    if (dup) return refuse(`${dup.name} is already in the household.`);
    return save(storage, { ...b, members: [...b.members, { id: nextId(b.members), name: clean }] });
  },
  addSettlement: async ([from, to, amount, day, at], _store, storage) => {
    const b = await load(storage);
    if (from === to || !b.members.some((m) => m.id === from) || !b.members.some((m) => m.id === to)) return refuse('Pick two people.');
    if (!Number.isInteger(amount) || amount <= 0) return refuse('Enter an amount more than zero.');
    return save(storage, { ...b, settlements: [...b.settlements, { id: nextId(b.settlements), from, to, amount, day, at }] });
  },
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
