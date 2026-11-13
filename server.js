// Сервер AutoMarket: отдаёт страницу дашборда и API. Без фреймворков, данные — в папке data/.
// Запуск: node server.js   (тестовые данные вместо API: node server.js --test)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./lib/env');
const { Sync } = require('./lib/sync');
const { buildDashboard } = require('./lib/calc');
const { today } = require('./lib/dates');
const { createPrivateAccess } = require('./lib/private-access');
const { scheduleMoscowSync } = require('./lib/sync-schedule');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));

const { Team, KINDS } = require('./lib/team');
const { AI, AiError } = require('./lib/ai');
const { Documents } = require('./lib/documents');
const { MailSource } = require('./lib/docsources/mail');
const { TelegramSource } = require('./lib/docsources/telegram');
const { DiadocSource } = require('./lib/docsources/diadoc');
const { DecisionCenter } = require('./lib/decisions');
const { buildEconomics } = require('./lib/economics');
const { parseReport } = require('./lib/pnlimport');
const { parseCosts } = require('./lib/costimport');
const { supplyWorkbook } = require('./lib/supplyexport');
const { buildSnapshot } = require('./lib/snapshot');
const { parseUnitReport, UnitReports } = require('./lib/unitreport');

const TEST_MODE = process.argv.includes('--test') || process.env.TEST_DATA === '1';
const PORT = Number(process.env.PORT) || 3000;
const CLOUD = process.env.AUTOMARKET_CLOUD === '1' || Boolean(process.env.RAILWAY_ENVIRONMENT_ID);
const HOST = process.env.HOST || (CLOUD ? '0.0.0.0' : '127.0.0.1');
const STATIC = path.join(ROOT, 'brandos');
const SETTINGS_FILE = path.join(ROOT, 'settings.json');
const DATA = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data');
const privateAccess = createPrivateAccess(process.env, CLOUD);
if (CLOUD && !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  throw new Error('Attach a Railway volume before deploying AutoMarket.');
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch (e) { console.error('[settings] не удалось прочитать settings.json:', e.message); return {}; }
}

const sync = new Sync(DATA);
// В тестовом режиме — отдельный файл с примерными задачами и документами, чтобы не смешивать с настоящими.
const team = TEST_MODE
  ? new Team(path.join(DATA, 'team-test.json'), require('./test/fixtures').testTeam(today()))
  : new Team(path.join(DATA, 'team.json'));
const ai = new AI();
// Отчёты Ozon «Юнит-экономика» за месяцы, которых нет в API (история до подключения)
const unitReports = new UnitReports(path.join(DATA, TEST_MODE ? 'unit-reports-test.json' : 'unit-reports.json'));
const docs = new Documents({ team, ai, dir: path.join(DATA, TEST_MODE ? 'files-test' : 'files'), settings: readSettings });
const mail = new MailSource({ env: process.env, team, docs });
const telegram = new TelegramSource({ env: process.env, docs });
const diadoc = new DiadocSource({ env: process.env, team, docs });

const DOC_SOURCES = [
  { id: 'mail', name: 'Почта (IMAP)', src: mail, hint: 'Яндекс ID / Google / Mail.ru → Безопасность → Пароли приложений. Плюс адрес IMAP-сервера и сама почта.' },
  { id: 'telegram', name: 'Telegram-бот', src: telegram, hint: 'Напишите @BotFather → /newbot, скопируйте токен. Потом напишите боту — он пришлёт номер чата для TELEGRAM_ALLOWED_CHAT_IDS.' },
  { id: 'diadoc', name: 'Диадок (ЭДО)', src: diadoc, hint: 'developer.kontur.ru → ключ разработчика. Логин и пароль — от учётной записи Диадока.' },
  { id: 'claude', name: 'Claude API', src: ai, keys: ['ANTHROPIC_API_KEY'], hint: 'console.anthropic.com → API Keys → Create Key. Оплата по объёму, пополните баланс.' }
];

function integrations() {
  return [
    ...sync.status(),
    ...DOC_SOURCES.map(s => ({ id: s.id, name: s.name, keys: s.keys || s.src.keys, hint: s.hint, ...s.src.status, stale: false }))
  ];
}

const BLOCKS = ['kpi', 'plan', 'cash', 'channels', 'drr', 'payments', 'sales', 'stock', 'skus', 'campaigns', 'insights'];

// Тестовый магазин строится один раз в день — он большой (тысячи операций).
let testCache = null;
function testRaw() {
  if (testCache?.day !== today()) testCache = { day: today(), raw: require('./test/fixtures').testRaw(today()) };
  return testCache.raw;
}

function dashboard() {
  const settings = readSettings();
  const raw = TEST_MODE ? testRaw() : sync.raw();
  const data = buildDashboard(raw, settings);
  const econ = buildEconomics({ raw, purchases: team.list('purchases'), fileCosts: team.list('costs'), pnlLines: team.list('pnl'), settings, pricing: team.data.meta.pricing, reportFin: unitReports.fin(), today: today() });
  econ.unitReports = unitReports.list();
  // График платежей берётся из settings.json — без подключённых источников это ещё не «живые данные».
  const live = Object.keys(data).some(k => k !== 'payments');
  return {
    mode: TEST_MODE ? 'test' : live ? 'live' : 'demo',
    lastSync: TEST_MODE ? new Date().toISOString() : sync.state.lastSync,
    syncing: !TEST_MODE && !!sync.running,
    data, econ, integrations: integrations(), owner: settings.owner, team: settings.team,
    tax: { mode: settings.taxMode || 'usn_income', rate: Number(settings.taxRate ?? 6), vat: Number(settings.vatRate ?? 0) },
    store: {
      tasks: team.list('tasks'), docs: team.list('docs').map(publicDoc), decisions: team.list('decisions'),
      purchases: team.list('purchases'), pnl: team.list('pnl'), costs: team.list('costs')
    },
    costsMeta: team.data.meta.costs || null,
    decisionsMeta: decisions.meta(),
    ai: ai.enabled
  };
}

const decisions = new DecisionCenter({ team, ai, dashboard, settings: readSettings });

const publicDoc = d => { const { hash, file, ...rest } = d; return { ...rest, hasFile: !!file }; };

// Что видит ИИ-ассистент: сводка дашборда, экономика, задачи, документы и пометка, какие блоки — демо.
function chatContext() {
  const dash = dashboard();
  const d = dash.data;
  const pickDoc = x => ({ name: x.name, source: x.source, date: x.date, status: x.status, counterparty: x.who, amount: x.amount, kind: x.ai?.kind, due: x.ai?.due, needsSignature: x.ai?.needsSignature, needsPayment: x.ai?.needsPayment, summary: x.ai?.summary });
  return {
    today: today(),
    mode: dash.mode === 'test' ? 'тестовые данные (придуманный магазин для проверки расчётов)' : dash.mode === 'live' ? 'живые данные' : 'источники не подключены',
    demoBlocks: [...BLOCKS.filter(k => !(k in d)), 'дебиторка', 'поставки', 'внешний трафик'],
    connected: dash.integrations.filter(i => i.status === 'ok').map(i => i.name),
    dashboard: { ...d, skus: d.skus?.slice(0, 40) },
    tasks: team.list('tasks').filter(t => t.status !== 'done').slice(0, 80).map(t => ({ title: t.title, status: t.status, priority: t.pr, due: t.due, who: t.who, createdByAI: !!t.ai })),
    documents: team.list('docs').slice(0, 60).map(pickDoc),
    economics: dash.econ.pnl ? {
      pnlThisMonth: dash.econ.pnl[today().slice(0, 7)],
      pnlByMonth: Object.fromEntries(Object.entries(dash.econ.pnl).map(([m, p]) => [m, { revenue: p.revenue, net: p.net, margin: p.margin }])),
      unitThisMonth: (dash.econ.unit?.[today().slice(0, 7)] || []).slice(0, 40),
      stock: dash.econ.stock && { summary: dash.econ.stock.summary, rows: dash.econ.stock.rows.slice(0, 40) },
      prices: (dash.econ.pricing || []).slice(0, 40).map(p => ({ offer: p.offer, name: p.name, currentPrice: p.input.currentPrice, minPrice: p.min, recommendedPrice: p.rec, cost: p.input.cost, belowMin: p.belowMin })),
      purchasesByOffer: dash.econ.costs
    } : undefined,
    decisions: team.list('decisions').slice(0, 40).map(x => ({ title: x.title, area: x.area, status: x.status, situation: x.situation, why: x.why, steps: x.steps, effect: x.effect, due: x.due, confidence: x.conf, rejectReason: x.reason }))
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readBody = async req => { const b = await readRaw(req, 5e6); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

function serveStatic(req, res) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(STATIC, rel === '/' ? 'index.html' : rel));
  if (!file.startsWith(STATIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

// Файл документа: PDF и картинки открываются в браузере, остальное скачивается. Скрипты из файлов не исполняются.
function serveDocFile(res, id) {
  const doc = team.get('docs', id);
  if (!doc?.file || !fs.existsSync(docs.filePath(doc))) return send(res, 404, { error: 'Файла нет' });
  const inline = doc.mime === 'application/pdf' || /^image\/(jpeg|png|gif|webp)$/.test(doc.mime);
  send(res, 200, fs.readFileSync(docs.filePath(doc)), inline ? doc.mime : 'application/octet-stream', {
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
    'Content-Security-Policy': 'sandbox'
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;
  try {
    if (privateAccess) {
      if (p === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true });
      if (!privateAccess(req)) {
        return send(res, 401, 'Войдите в AutoMarket.', 'text/plain; charset=utf-8', {
          'WWW-Authenticate': 'Basic realm="AutoMarket", charset="UTF-8"'
        });
      }
      if (!['GET', 'HEAD'].includes(req.method) && ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
        return send(res, 403, { error: 'Запрос с другого сайта отклонён.' });
      }
    }
    if (p === '/api/dashboard' && req.method === 'GET') return send(res, 200, dashboard());
    if (p === '/api/sync' && req.method === 'POST') {
      if (!TEST_MODE) {
        if (!sync.hasConfiguredSources()) return send(res, 409, { error: 'Подключите источник данных.' });
        runSync();
        mail.poll();
        diadoc.poll();
      }
      return send(res, 202, { started: true });
    }
    if (p === '/api/integrations' && req.method === 'GET') return send(res, 200, integrations());

    // Задачи, сделки и документы команды: изменения пачкой (новые/изменённые + удалённые).
    if ((m = p.match(/^\/api\/team\/(\w+)\/sync$/)) && req.method === 'POST') {
      if (!KINDS.includes(m[1])) return send(res, 404, { error: 'Нет такого списка' });
      const body = await readBody(req);
      const upsert = (Array.isArray(body.upsert) ? body.upsert : []).map(x => {
        if (m[1] !== 'docs') return x;
        const cur = team.get('docs', x.id); // у документа с дашборда меняется только статус
        return cur ? { id: x.id, status: x.status } : null;
      }).filter(Boolean);
      const remove = Array.isArray(body.remove) ? body.remove.map(String) : [];
      if (m[1] === 'docs') for (const id of remove) { const d = team.get('docs', id); if (d?.file) fs.rm(docs.filePath(d), () => {}); }
      const list = team.apply(m[1], { upsert, remove });
      return send(res, 200, m[1] === 'docs' ? list.map(publicDoc) : list);
    }

    if (p === '/api/docs/upload' && req.method === 'POST') {
      const buffer = await readRaw(req, 20 * 1024 * 1024);
      const filename = decodeURIComponent(String(req.headers['x-filename'] || 'Документ'));
      const r = docs.ingest({ source: 'Вручную', filename, mime: String(req.headers['content-type'] || '').split(';')[0], buffer });
      return send(res, 200, { doc: publicDoc(r.doc), duplicate: r.duplicate, ai: ai.enabled });
    }
    if ((m = p.match(/^\/api\/docs\/(\w+)\/file$/)) && req.method === 'GET') return serveDocFile(res, m[1]);
    if ((m = p.match(/^\/api\/docs\/(\w+)\/analyze$/)) && req.method === 'POST') {
      if (!ai.enabled) return send(res, 409, { error: 'ИИ не подключён: впишите ANTHROPIC_API_KEY в .env' });
      if (!team.get('docs', m[1])) return send(res, 404, { error: 'Документ не найден' });
      const d = await docs.reanalyze(m[1]);
      return send(res, 200, publicDoc(d));
    }

    // Параметры расчёта цены (целевая маржа, ДРР, эквайринг, схема, значения по умолчанию).
    // Снимок дашборда одним файлом index.html (открывается без сервера)
    if (p === '/api/snapshot' && req.method === 'GET') {
      const html = buildSnapshot(dashboard(), STATIC);
      return send(res, 200, html, 'text/html; charset=utf-8', { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('index.html')}` });
    }

    // Сборочный лист → Excel для загрузки в поставку Ozon. Тело: { file, clusters: [{ name, items: [{ offer, qty }] }] }
    if (p === '/api/supply/export' && req.method === 'POST') {
      const body = await readBody(req);
      const buf = await supplyWorkbook(Array.isArray(body.clusters) ? body.clusters.slice(0, 100) : []);
      if (!buf) return send(res, 422, { error: 'Нет товаров для поставки' });
      const file = String(body.file || 'Поставка.xlsx').replace(/[\\/:*?"<>|]/g, ' ').slice(0, 120);
      return send(res, 200, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', {
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file)}`
      });
    }

    if (p === '/api/pricing/params' && req.method === 'POST') {
      const body = await readBody(req);
      const allowed = ['targetMarginPct', 'drrPct', 'acquiringPct', 'extraPct', 'packDefault', 'ozonPack', 'commissionPct', 'logistics', 'returnCost', 'returnRatePct', 'vatPct'];
      const P = { ...(team.data.meta.pricing || {}) };
      for (const k of allowed) if (body[k] !== undefined && Number.isFinite(Number(body[k])) && Number(body[k]) >= 0) P[k] = Number(body[k]);
      if (body.scheme === 'FBO' || body.scheme === 'FBS') P.scheme = body.scheme;
      if (body.logisticsMode === 'tariff' || body.logisticsMode === 'fact') P.logisticsMode = body.logisticsMode;
      // Упаковка по типам товаров: { «Рычаг стеклоочистителя»: 15, … } — пустое значение удаляет цену
      if (body.packaging && typeof body.packaging === 'object') {
        const pk = { ...(P.packaging || {}) };
        for (const [k, v] of Object.entries(body.packaging)) {
          const key = String(k).slice(0, 200);
          if (v === null || v === '') delete pk[key];
          else if (Number.isFinite(Number(v)) && Number(v) >= 0) pk[key] = Number(v);
        }
        P.packaging = pk;
      }
      team.data.meta.pricing = P;
      team.save();
      return send(res, 200, P);
    }

    // Файл себестоимости (Excel/CSV: Артикул, Наименование, Себестоимость) — дополняет уже введённую:
    // цены из файла обновляют совпавшие артикулы, остальные артикулы остаются как были.
    // Выгрузка Ozon «Юнит-экономика» за месяц (xlsx) — история для месяцев, которых нет в API
    if (p === '/api/unitreports/import' && req.method === 'POST') {
      const buffer = await readRaw(req, 20 * 1024 * 1024);
      const filename = decodeURIComponent(String(req.headers['x-filename'] || 'Юнит-экономика.xlsx')).slice(0, 200);
      try {
        const rep = await parseUnitReport(buffer);
        if (!rep.rows.length) return send(res, 422, { error: 'В отчёте нет строк с артикулами' });
        const r = unitReports.add(rep, filename);
        const apiHas = !!sync.raw().ozon?.fin?.[rep.month];
        return send(res, 200, { month: rep.month, from: r.from, to: r.to, rows: r.rows, full: r.full, usedFor: apiHas ? 'api' : 'report' });
      } catch (e) { return send(res, 422, { error: e.message }); }
    }
    if ((m = p.match(/^\/api\/unitreports\/(\d{4}-\d{2})$/)) && req.method === 'DELETE') {
      unitReports.remove(m[1]);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/costs' && req.method === 'POST') {
      const { offer, unitCost } = await readBody(req);
      if (typeof offer !== 'string' || !offer.trim() || offer.length > 250 ||
          typeof unitCost !== 'number' || !Number.isFinite(unitCost) || unitCost < 0.01 || unitCost > 1e9) {
        return send(res, 400, { error: 'Укажите артикул и положительную себестоимость за штуку.' });
      }
      const id = offer.trim();
      team.apply('costs', { upsert: [{ id, offer: id, unitCost: Math.round(unitCost * 100) / 100, source: 'вручную' }] });
      return send(res, 200, { saved: true });
    }

    if (p === '/api/costs/import' && req.method === 'POST') {
      const buffer = await readRaw(req, 20 * 1024 * 1024);
      const filename = decodeURIComponent(String(req.headers['x-filename'] || 'себестоимость.xlsx'));
      try {
        const { items, skipped, since } = await parseCosts({ buffer, filename });
        if (!items.length) return send(res, 422, { error: 'В файле не нашлось строк с артикулом и себестоимостью' });
        const label = 'файл ' + filename.slice(0, 60) + (since ? ` (с ${since})` : '');
        const inFile = new Set(items.map(x => x.offer));
        const kept = team.list('costs').filter(c => !inFile.has(c.offer));
        team.data.costs = [...items.map(x => ({ id: x.offer, ...x, source: label })), ...kept];
        const ozonOffers = new Set([...(sync.raw().ozon?.stockTypes || []).map(s => s.offer), ...(sync.raw().ozon?.prices || []).map(s => s.offer)]);
        const matched = items.filter(x => ozonOffers.has(x.offer)).length;
        const covered = new Set(team.data.costs.map(c => c.offer));
        team.data.meta.costs = {
          file: filename, since, at: new Date().toISOString(), count: items.length, skipped, matched, ozonTotal: ozonOffers.size,
          total: team.data.costs.length, missing: [...ozonOffers].filter(o => !covered.has(o)).length
        };
        team.save();
        return send(res, 200, team.data.meta.costs);
      } catch (e) {
        return send(res, 422, { error: e.message });
      }
    }

    // Свой отчёт о прибылях и убытках: статьи добавляются к выбранному месяцу.
    if (p === '/api/pnl/import' && req.method === 'POST') {
      const month = url.searchParams.get('month');
      if (!/^\d{4}-\d{2}$/.test(month || '')) return send(res, 400, { error: 'Не выбран месяц' });
      const buffer = await readRaw(req, 20 * 1024 * 1024);
      const filename = decodeURIComponent(String(req.headers['x-filename'] || 'отчёт'));
      try {
        const lines = await parseReport({ buffer, filename, mime: String(req.headers['content-type'] || '').split(';')[0], ai, month });
        if (!lines.length) return send(res, 422, { error: 'В файле не нашлось строк «статья — сумма»' });
        const items = lines.map(l => ({ id: Team.id(), month, title: l.title, amount: l.amount, type: l.type, source: 'файл: ' + filename.slice(0, 80) }));
        team.apply('pnl', { upsert: items });
        return send(res, 200, { added: items.length });
      } catch (e) {
        return send(res, 422, { error: e.message });
      }
    }

    if (p === '/api/decisions/recalc' && req.method === 'POST') {
      decisions.run().catch(e => console.error('[decisions]', e));
      return send(res, 202, { started: true });
    }

    if (p === '/api/chat' && req.method === 'POST') {
      if (!ai.enabled) return send(res, 409, { error: 'ИИ не подключён: впишите ANTHROPIC_API_KEY в .env' });
      const body = await readBody(req);
      try {
        const text = await ai.chat({ history: Array.isArray(body.messages) ? body.messages : [], context: chatContext() });
        return send(res, 200, { text });
      } catch (e) {
        return send(res, e instanceof AiError ? 502 : 500, { error: e.message });
      }
    }

    if (p.startsWith('/api/')) return send(res, 404, { error: 'Нет такого метода' });
    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 405, { error: 'Метод не поддерживается' });
  } catch (e) {
    if (e.code === 413) return send(res, 413, { error: 'Файл больше 20 МБ' });
    if (e instanceof SyntaxError) return send(res, 400, { error: 'Неверный запрос' });
    console.error('[server]', e);
    send(res, 500, { error: e.message && /файл/i.test(e.message) ? e.message : 'Внутренняя ошибка сервера' });
  }
});

function runSync() {
  return sync.run().catch(error => console.error('[sync] Не удалось сохранить данные:', error.code || error.name));
}

server.listen(PORT, HOST, () => {
  console.log(`AutoMarket: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}` + (TEST_MODE ? '  (тестовые данные)' : ''));
  const S = readSettings();
  ai.check();
  console.log(`Центр решений: каждый день после ${decisions.meta().hour}:00 и по кнопке «Пересчитать сейчас».`);
  if (TEST_MODE) { decisions.start(); return; }
  // Первый расчёт решений — когда подтянутся данные источников.
  setTimeout(() => decisions.start(), 90000);
  const minutes = Math.max(5, Number(S.syncMinutes) || 30);
  const active = sync.status().filter(s => s.status !== 'off').map(s => s.name);
  const docSrc = DOC_SOURCES.filter(s => s.src.enabled).map(s => s.name);
  const schedule = CLOUD ? 'в 08:00 и 19:00 по Москве' : `каждые ${minutes} мин.`;
  console.log(active.length ? `Источники: ${active.join(', ')}. Синхронизация ${schedule}` : 'Ключи источников не заданы.');
  if (docSrc.length) console.log(`Документы и ИИ: ${docSrc.join(', ')}.`);
  if (active.length) {
    if (CLOUD) {
      if (!sync.state.lastSync) runSync();
      scheduleMoscowSync(runSync);
    } else {
      runSync();
      setInterval(runSync, minutes * 60000);
    }
  }
  mail.start(Number(S.mailMinutes) || 10);
  telegram.start();
  diadoc.start(Number(S.diadocMinutes) || 30);
});
