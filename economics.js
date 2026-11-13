// Экономика магазина на Ozon: карточки Главной, юнит-экономика, отчёт о прибылях и убытках, склад, цена товара.
// Чистая функция: данные Ozon + закупки + статьи ОПиУ + настройки → блоки для страницы.
const D = require('./dates');
const { calcPrice } = require('../brandos/pricing');

const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);
const round = (n, k = 0) => { const m = 10 ** k; return Math.round(n * m) / m; };
const pct = (a, b) => (b > 0 ? round(a / b * 100, 1) : null);

// returnRatePct — для новых товаров без продаж; у остальных берётся фактический процент возвратов.
// logisticsMode: tariff — средний тариф Ozon по товару (между минимальным и максимальным), fact — фактическая из отчётов.
// vatPct по умолчанию — ставка НДС из settings.json (vatRate). packaging — упаковка в ₽ по типу товара.
const PRICING_DEFAULTS = {
  targetMarginPct: 20, drrPct: 0, acquiringPct: 1, extraPct: 5, scheme: 'FBO', logisticsMode: 'tariff',
  commissionPct: 20, logistics: 120, returnCost: 60, returnRatePct: 35, vatPct: 0, packaging: {},
  packDefault: 5,   // своя упаковка, ₽ за штуку — для типов товаров, где не задана отдельно
  ozonPack: 15      // переупаковка товара Ozon, ₽ за штуку
};

// Средний тариф логистики Ozon по товару: прямой поток (среднее мин./макс.) + доставка до покупателя (+ первая миля для FBS).
function tariffLogistics(cm, fbo) {
  const avg = (a, b) => (a > 0 && b > 0 ? (a + b) / 2 : a || b || 0);
  if (fbo) return avg(cm.fboDirectMin || 0, cm.fboDirect || 0) + (cm.fboDelivery || 0);
  return avg(cm.fbsDirectMin || 0, cm.fbsDirect || 0) + avg(cm.fbsFirstMileMin || 0, cm.fbsFirstMile || 0) + (cm.fbsDelivery || 0);
}

// Колонки юнит-экономики в том же порядке и с теми же названиями, что в отчёте Ozon.
// Каждый тип начисления Ozon относится к одной колонке; что не подошло — в «Прочее».
const UNIT_COLS = [
  ['acquiring', /^Acquiring/],
  ['returnProcessing', /ReturnAcceptance|ClientReturn|PartialReturn|PreparingToReturn|SellerReturns|ReturnStorage/],
  ['returnLogistics', /ReturnFlow|Backward/],
  ['lastMile', /LastMile|DeliveryToHandoverPlace|ClickAndCollect/],
  // Переупаковка Ozon: «Обеспечение материалами для упаковки товара» + «Упаковка товаров партнёрами»
  ['packing', /^(PackageCost|PackingFee)$/],
  ['processing', /Drop-?Off|Pick-?Up|Shipment|PackageUnitProcessing|QuantProcessing|CrossDock|Fulfillment|Packing|Sealing|CourierPickUp/],
  ['logistics', /Logistic|Delivery/],
  ['placement', /Placement|Replenishment|StockInsurance/],
  ['disposal', /Disposal/],
  ['ovh', /VolumeWeight|Oversized/],
  ['errors', /DefectRate|DefectFine|ClaimCommission/],
  ['click', /PayPerClick/],
  ['orderPay', /^Promotion$|PremiumCashbackPromotion|LeadGeneration|ExternalPromotion/],
  ['stars', /StarsMembership/],
  ['brand', /^Brand(Commission|Promotion|Shelf)/],
  ['reviews', /Review/]
];
const unitCol = name => (UNIT_COLS.find(([, re]) => re.test(String(name))) || ['other'])[0];

// Сложить агрегаты нескольких месяцев (для периода «все месяцы»).
function mergeFin(list) {
  const skus = {};
  for (const m of list) for (const s of Object.values(m?.skus || {})) {
    const t = skus[s.offer] = skus[s.offer] || { offer: s.offer, name: s.name, rev: { buyer: 0, bonus: 0, partner: 0 }, svc: {} };
    for (const k of ['buyQty', 'buyRev', 'retQty', 'retRev', 'commission', 'logistics', 'returnLogistics', 'acquiring', 'other', 'payout', 'fbo', 'fbs', 'mbQty']) t[k] = (t[k] || 0) + (s[k] || 0);
    for (const k of ['buyer', 'bonus', 'partner']) t.rev[k] += s.rev?.[k] || 0;
    for (const [k, v] of Object.entries(s.svc || {})) t.svc[k] = (t.svc[k] || 0) + v;
  }
  return { skus };
}

// Себестоимость единицы: из загруженного файла себестоимости (главный источник), а для товаров,
// которых в файле нет, — по закупкам: средняя взвешенная, доп. расходы (доставка, упаковка) делятся на штуки.
function unitCosts(purchases, fileCosts = []) {
  const fromPurchases = purchaseCosts(purchases);
  const out = Object.fromEntries(Object.entries(fromPurchases).filter(([, c]) => Number.isFinite(c.unitCost) && c.unitCost > 0));
  for (const c of fileCosts || []) {
    if (!c.offer || !(c.unitCost > 0)) continue;
    const p = fromPurchases[c.offer];
    out[c.offer] = {
      offer: c.offer, name: c.name || p?.name || '', unitCost: c.unitCost, source: 'file', sourceLabel: c.source || 'файл',
      qty: p?.qty || 0, total: p?.total || 0, suppliers: p?.suppliers || [], last: p?.last || null, inTransit: p?.inTransit || 0
    };
  }
  return out;
}

function purchaseCosts(purchases) {
  const by = {};
  for (const p of purchases || []) {
    const offer = String(p.offer || '').trim();
    const qty = Number(p.qty) || 0;
    if (!offer || qty <= 0) continue;
    const b = by[offer] = by[offer] || { offer, name: p.name || '', qty: 0, total: 0, suppliers: new Set(), last: null, inTransit: 0 };
    b.qty += qty;
    b.total += qty * (Number(p.price) || 0) + (Number(p.extra) || 0);
    if (p.supplier) b.suppliers.add(p.supplier);
    if (!b.last || (p.date || '') >= (b.last.date || '')) b.last = { date: p.date, price: Number(p.price) || 0, supplier: p.supplier || '' };
    if (p.status !== 'Получено') b.inTransit += qty;
    if (!b.name && p.name) b.name = p.name;
  }
  return Object.fromEntries(Object.values(by).map(b => [b.offer, {
    offer: b.offer, name: b.name, qty: b.qty, unitCost: b.qty ? b.total / b.qty : 0, total: b.total, source: 'purchases',
    suppliers: [...b.suppliers], last: b.last, inTransit: b.inTransit
  }]));
}

function ordersIn(postings, from, to) {
  const list = (postings || []).filter(p => D.inRange(p.date, from, to));
  const live = list.filter(p => p.status !== 'cancelled');
  const agg = ps => ({ qty: sum(ps, p => sum(p.items, i => i.qty)), sum: sum(ps, p => sum(p.items, i => i.qty * i.price)) });
  return { all: agg(live), fbo: agg(live.filter(p => p.scheme === 'FBO')), fbs: agg(live.filter(p => p.scheme === 'FBS')), cancelled: agg(list.filter(p => p.status === 'cancelled')), list: live };
}

function taxOf(S, netRevenue, profitBeforeTax) {
  const rate = Number(S.taxRate ?? 6) / 100;
  if (S.taxMode === 'none') return 0;
  if (S.taxMode === 'usn_profit') return Math.max(0, profitBeforeTax) * rate;
  return Math.max(0, netRevenue) * rate; // УСН «доходы»
}

const vatOf = (S, gross) => { const v = Number(S.vatRate || 0); return v > 0 ? Math.max(0, gross) * v / (100 + v) : 0; };

function pnlMonth({ month, fin, perfSpend, lines, costs, S, today }) {
  const T = fin?.totals || {};
  const g = k => T[k] || 0;
  const netMp = g('sales') + g('returns');
  const financeAds = g('ads');
  const ads = financeAds !== 0 ? financeAds : -perfSpend; // реклама из отчёта Ozon, иначе — расход Performance
  const payout = g('payout') + (financeAds === 0 ? -perfSpend : 0);
  // Себестоимость проданного: по закупкам, а где закупок нет — процентом из настроек.
  let cost = 0;
  const missingCosts = [];
  for (const s of Object.values(fin?.skus || {})) {
    const units = s.buyQty - s.retQty;
    if (costs[s.offer]) cost += units * costs[s.offer].unitCost;
    else if (s.buyQty || s.retQty || s.buyRev || s.retRev) missingCosts.push(s.offer);
  }
  const own = (lines || []).filter(l => l.month === month);
  const income = sum(own.filter(l => l.type === 'income'), l => Number(l.amount) || 0);
  const expenseLines = own.filter(l => l.type !== 'income');
  let expenses = sum(expenseLines, l => Number(l.amount) || 0);
  let fixedFromSettings = 0;
  if (!expenseLines.length && S.fixedCosts) {
    const isCurrent = month === today.slice(0, 7);
    fixedFromSettings = S.fixedCosts * (isCurrent ? D.dayOfMonth(today) / D.daysInMonth(today) : 1);
    expenses = fixedFromSettings;
  }
  const revenue = netMp;
  // НДС уже внутри выручки (при 5% — это 5/105), УСН считается с выручки без НДС.
  // Компенсации Ozon за утерянный / повреждённый товар — возмещение ущерба, а не продажа: в доходах УСН есть, НДС с них нет.
  // Декомпенсация (Ozon забрал компенсацию) уменьшает доход месяца, когда её списали. В прибыли они уже внутри «к выплате».
  const compensation = g('compensation');
  const vat = vatOf(S, revenue + income);
  const before = payout + income - cost - expenses - vat;
  const incomplete = missingCosts.length > 0;
  const tax = incomplete && S.taxMode === 'usn_profit' ? null : taxOf(S, revenue + income - vat + compensation, before);
  const net = incomplete ? null : before - tax;
  const r = v => v === null ? null : round(v);
  return {
    month,
    sales: r(g('sales')), returns: r(g('returns')), netMp: r(netMp),
    mbSales: r(g('mbSales')), mbQty: g('mbQty'),
    commission: r(g('commission')), logistics: r(g('logistics')), returnLogistics: r(g('returnLogistics')),
    acquiring: r(g('acquiring')), storage: r(g('storage')), ads: r(ads), adsSource: financeAds !== 0 ? 'ozon' : perfSpend ? 'performance' : null,
    services: r(g('services') + g('other')), compensation: r(compensation), payout: r(payout),
    cost: incomplete ? null : r(cost), missingCosts,
    income: r(income), expenses: r(expenses), fixedFromSettings: r(fixedFromSettings), lines: own,
    tax: r(tax), taxMode: S.taxMode || 'usn_income', taxRate: Number(S.taxRate ?? 6),
    vat: r(vat), vatRate: Number(S.vatRate || 0),
    revenue: r(revenue), net: r(net), margin: net === null ? null : pct(net, revenue + income)
  };
}

// Статусы Ozon, при которых отправление уже передано в доставку.
const PASSED = new Set(['delivering', 'driver_pickup', 'delivered', 'sent_by_seller', 'arbitration', 'client_arbitration']);

function unitRows({ from, to, fin, postings, stocks, prices, skuMap, costs, S, adsTotal }) {
  const all = (postings || []).filter(p => D.inRange(p.date, from, to));
  const orders = all.filter(p => p.status !== 'cancelled');
  const firstPosting = (postings || []).reduce((m, p) => (!m || p.date < m ? p.date : m), '');
  const passedKnown = !!firstPosting && firstPosting <= from;
  const priceOf = Object.fromEntries((prices || []).map(p => [p.offer, p.price]));
  const skuOf = {};
  for (const [sku, offer] of Object.entries(skuMap || {})) if (!skuOf[offer]) skuOf[offer] = sku;
  const byOffer = {};
  const row = (offer, name) => byOffer[offer] = byOffer[offer] || {
    offer, name: name || offer, ordQty: 0, ordSum: 0, passed: 0, buyQty: 0, buyRev: 0, retQty: 0, retRev: 0,
    commission: 0, logistics: 0, acquiring: 0, other: 0, payout: 0, fbo: 0, fbs: 0, soldFbo: 0, soldFbs: 0,
    rev: { buyer: 0, bonus: 0, partner: 0 }, cols: {}
  };
  for (const p of orders) for (const i of p.items) {
    const r = row(i.offer, i.name);
    r.ordQty += i.qty; r.ordSum += i.qty * i.price;
    if (PASSED.has(p.status)) r.passed += i.qty;
  }
  for (const s of Object.values(fin?.skus || {})) {
    const r = row(s.offer, s.name);
    r.buyQty += s.buyQty; r.buyRev += s.buyRev; r.retQty += s.retQty; r.retRev += s.retRev;
    r.commission += s.commission; r.logistics += s.logistics + s.returnLogistics; r.acquiring += s.acquiring;
    r.other += s.other; r.payout += s.payout; r.soldFbo += s.fbo || 0; r.soldFbs += s.fbs || 0;
    if (s.rev) for (const k of ['buyer', 'bonus', 'partner']) r.rev[k] += s.rev[k] || 0;
    else r.rev.buyer += s.buyRev - s.retRev;
    const svc = s.svc && Object.keys(s.svc).length ? s.svc : { Logistic: s.logistics, ReturnFlowLogistic: s.returnLogistics, Acquiring: s.acquiring, Other: s.other };
    for (const [k, v] of Object.entries(svc)) { const c = unitCol(k); r.cols[c] = (r.cols[c] || 0) + (v || 0); }
  }
  for (const st of stocks || []) { const r = row(st.offer, st.name); r.fbo += st.fbo; r.fbs += st.fbs; }
  const netAll = sum(Object.values(byOffer), r => r.buyRev - r.retRev);
  return Object.values(byOffer).map(r => {
    const net = r.buyRev - r.retRev;
    const units = r.buyQty - r.retQty;
    const c = costs[r.offer];
    const cost = c ? units * c.unitCost : (r.buyQty || r.retQty || r.buyRev || r.retRev) ? null : 0;
    const ads = netAll > 0 && net > 0 ? Math.abs(adsTotal) * net / netAll : 0; // реклама делится по доле выручки
    const vat = vatOf(S, net);
    const tax = S.taxMode === 'usn_profit' || S.taxMode === 'none' ? 0 : Math.max(0, net - vat) * Number(S.taxRate ?? 6) / 100;
    const profit = cost === null ? null : r.payout - cost - ads - vat - tax;
    const scheme = [r.soldFbo || (!r.soldFbs && r.fbo) ? 'FBO' : '', r.soldFbs || (!r.soldFbo && r.fbs) ? 'FBS' : ''].filter(Boolean).join(', ');
    return {
      offer: r.offer, name: r.name, sku: skuOf[r.offer] || null, scheme: scheme || '—',
      price: priceOf[r.offer] || null, unitCost: c ? round(c.unitCost, 2) : null,
      ordQty: r.ordQty, ordSum: round(r.ordSum), passed: passedKnown ? r.passed : null,
      buyQty: r.buyQty, buyRev: round(r.buyRev), retQty: r.retQty, retRev: round(r.retRev),
      retPct: pct(r.retQty, r.buyQty + r.retQty), commission: round(r.commission), logistics: round(r.logistics),
      acquiring: round(r.acquiring), ads: round(ads), vat: round(vat), tax: round(tax), cost: cost === null ? null : round(cost), costKnown: !!c,
      rev: { buyer: round(r.rev.buyer, 2), bonus: round(r.rev.bonus, 2), partner: round(r.rev.partner, 2) },
      cols: Object.fromEntries(Object.entries(r.cols).map(([k, v]) => [k, round(v, 2)])),
      share: pct(net, netAll),
      payout: round(r.payout), profit: profit === null ? null : round(profit), margin: profit === null ? null : pct(profit, net), perUnit: units > 0 && profit !== null ? round(profit / units) : null,
      fbo: r.fbo, fbs: r.fbs
    };
  }).sort((a, b) => b.buyRev - a.buyRev || b.ordSum - a.ordSum);
}

function stockRows({ postings, stocks, costs, S, today }) {
  const from = D.addDays(today, -27), from30 = D.addDays(today, -29);
  const sold = {}, ord30 = {};
  for (const p of (postings || []).filter(x => x.status !== 'cancelled' && D.inRange(x.date, from30, today))) {
    for (const i of p.items) {
      ord30[i.offer] = (ord30[i.offer] || 0) + i.qty;
      if (p.date >= from) sold[i.offer] = (sold[i.offer] || 0) + i.qty;
    }
  }
  const lead = Number(S.leadTimeDays ?? 14), target = Number(S.stockTargetDays ?? 45);
  const offers = new Set([...(stocks || []).map(s => s.offer), ...Object.keys(sold), ...Object.keys(costs)]);
  const names = Object.fromEntries((stocks || []).map(s => [s.offer, s.name]));
  for (const p of postings || []) for (const i of p.items) names[i.offer] = names[i.offer] || i.name;
  const rows = [...offers].map(offer => {
    const st = (stocks || []).find(s => s.offer === offer) || { fbo: 0, fbs: 0 };
    const c = costs[offer];
    const total = st.fbo + st.fbs;
    const daily = (sold[offer] || 0) / 28;
    const days = daily > 0 ? Math.floor(total / daily) : null;
    const inTransit = c?.inTransit || 0;
    const reorder = daily > 0 ? Math.max(0, Math.ceil((daily * target - total - inTransit) / 10) * 10) : 0;
    const status = total === 0 && daily > 0 ? 'Нет в наличии' : days === null ? (total ? 'Нет продаж' : '—') : days < lead ? 'Срочно дозаказать' : days < lead + 14 ? 'Скоро закончится' : days > 90 ? 'Залежался' : 'В норме';
    return {
      offer, name: names[offer] || c?.name || offer, fbo: st.fbo, fbs: st.fbs, total, inTransit,
      sold28: sold[offer] || 0, ord30: ord30[offer] || 0, daily: round(daily, 1), days, until: days !== null ? D.addDays(today, days) : null,
      reorder, status, value: c ? round(total * c.unitCost) : null
    };
  }).filter(r => r.total || r.sold28 || r.inTransit).sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));
  const totalDaily = sum(rows, r => r.daily);
  const totalStock = sum(rows, r => r.total);
  return {
    rows,
    summary: {
      fbo: sum(rows, r => r.fbo), fbs: sum(rows, r => r.fbs), inTransit: sum(rows, r => r.inTransit),
      value: round(sum(rows, r => r.value || 0)), valueKnown: rows.every(r => r.value !== null),
      turnover: totalDaily > 0 ? Math.round(totalStock / totalDaily) : null,
      urgent: rows.filter(r => r.status === 'Срочно дозаказать' || r.status === 'Нет в наличии').length,
      stale: rows.filter(r => r.status === 'Залежался').length
    }
  };
}

function pricingRows({ finList, prices, unit, costs, categories = {}, P, S }) {
  const byOffer = Object.fromEntries((unit || []).map(u => [u.offer, u]));
  // Фактические логистика и возвраты — по всем загруженным месяцам отчёта Ozon.
  // Логистика — средняя на одну отправленную штуку (выкупленную или вернувшуюся), обратная — на один возврат.
  // Если по товару данных нет — средние по магазину; процент возвратов у нового товара — из параметров (35%).
  const merged = mergeFin(finList || []).skus;
  const ms = Object.values(merged);
  const shipped = sum(ms, s => s.buyQty + s.retQty), returned = sum(ms, s => s.retQty);
  const avgLogistics = shipped > 0 ? -sum(ms, s => s.logistics) / shipped : null;
  const avgReturnCost = returned > 0 ? -sum(ms, s => s.returnLogistics) / returned : null;
  const actual = offer => {
    const s = merged[offer];
    const buy = s?.buyQty || 0, ret = s?.retQty || 0;
    const log = buy + ret > 0 ? -s.logistics / (buy + ret) : null;
    const rc = ret > 0 ? -s.returnLogistics / ret : null;
    return {
      logistics: log > 0 ? log : null,
      returnCost: rc > 0 ? rc : null,
      returnRatePct: buy + ret > 0 ? ret / (buy + ret) * 100 : null,
      sold: buy, returned: ret
    };
  };
  const offers = new Set([...(prices || []).map(p => p.offer), ...Object.keys(costs), ...Object.keys(byOffer)]);
  return [...offers].map(offer => {
    const pr = (prices || []).find(p => p.offer === offer) || {};
    const fbo = P.scheme !== 'FBS';
    const cm = pr.commissions || {};
    const act = actual(offer);
    const pick = (...v) => v.find(x => x !== null && x !== undefined && Number.isFinite(x) && x > 0);
    const tariff = tariffLogistics(cm, fbo), tariffRet = fbo ? cm.fboReturn : cm.fbsReturn;
    const byTariff = P.logisticsMode !== 'fact';
    const logistics = byTariff ? pick(tariff, act.logistics, avgLogistics, P.logistics) : pick(act.logistics, tariff, avgLogistics, P.logistics);
    const returnCost = byTariff ? pick(tariffRet, act.returnCost, avgReturnCost, P.returnCost) : pick(act.returnCost, tariffRet, avgReturnCost, P.returnCost);
    const cat = categories[offer] || null;
    const input = {
      cost: costs[offer]?.unitCost || 0,
      packaging: cat && P.packaging?.[cat.type] !== undefined ? Number(P.packaging[cat.type]) || 0 : Number(P.packDefault) || 0,
      ozonPack: Number(P.ozonPack) || 0,
      commissionPct: pick(fbo ? cm.fboPct : cm.fbsPct, P.commissionPct) || 0,
      logistics: round(logistics || 0, 2),
      returnCost: round(returnCost || 0, 2),
      returnRatePct: act.returnRatePct !== null ? round(act.returnRatePct, 1) : P.returnRatePct,
      acquiringPct: P.acquiringPct, drrPct: P.drrPct, extraPct: P.extraPct, targetMarginPct: P.targetMarginPct, vatPct: P.vatPct,
      taxMode: S.taxMode || 'usn_income', taxPct: Number(S.taxRate ?? 6),
      currentPrice: pr.price || 0
    };
    const which = (v, map) => Object.keys(map).find(k => map[k] && map[k] === v) || 'default';
    const src = {
      commission: (fbo ? cm.fboPct : cm.fbsPct) ? 'ozon' : 'default',
      logistics: which(logistics, { tariff, fact: act.logistics, avg: avgLogistics }),
      returnCost: which(returnCost, { tariff: tariffRet, fact: act.returnCost, avg: avgReturnCost }),
      category: cat?.category || null, type: cat?.type || null,
      tariffMin: fbo ? (cm.fboDirectMin || 0) + (cm.fboDelivery || 0) : (cm.fbsDirectMin || 0) + (cm.fbsFirstMileMin || 0) + (cm.fbsDelivery || 0),
      tariffMax: fbo ? (cm.fboDirect || 0) + (cm.fboDelivery || 0) : (cm.fbsDirect || 0) + (cm.fbsFirstMile || 0) + (cm.fbsDelivery || 0),
      returnRate: act.returnRatePct !== null ? 'fact' : 'default',
      sold: act.sold, returned: act.returned
    };
    const name = pr.name || costs[offer]?.name || byOffer[offer]?.name || offer;
    return { offer, name, input, src, costKnown: !!costs[offer], ozonMinPrice: pr.minPrice || null, ...calcPrice(input) };
  }).sort((a, b) => Number(b.belowMin) - Number(a.belowMin) || (a.name > b.name ? 1 : -1));
}

// Налоговые платежи ближайших 90 дней по итогам прошедших кварталов:
// УСН — авансом до 28-го числа месяца после квартала (за 4 квартал — до 28 апреля);
// НДС — тремя равными частями до 28-го числа каждого из трёх месяцев после квартала.
function taxPayments({ pnl, S, today }) {
  const out = [];
  const y0 = Number(today.slice(0, 4));
  const iso = (y, m) => `${y + Math.floor((m - 1) / 12)}-${String(((m - 1) % 12) + 1).padStart(2, '0')}-28`;
  for (const y of [y0 - 1, y0]) for (let q = 1; q <= 4; q++) {
    const months = [1, 2, 3].map(i => `${y}-${String((q - 1) * 3 + i).padStart(2, '0')}`);
    if (months[2] >= today.slice(0, 7)) continue; // квартал ещё не закончился
    const have = months.filter(m => pnl[m]);
    if (!have.length) continue;
    const partial = have.length < 3;
    const tax = sum(have, m => pnl[m].tax || 0), vat = sum(have, m => pnl[m].vat || 0);
    const qn = `${q} кв. ${y}`;
    const usnDue = q === 4 ? `${y + 1}-04-28` : iso(y, q * 3 + 1);
    if (tax > 0 && S.taxMode !== 'none') out.push({ date: usnDue, title: `${S.taxMode === 'usn_profit' ? 'УСН «доходы − расходы»' : 'УСН «доходы»'} ${Number(S.taxRate ?? 6)}% за ${qn}`, amount: round(tax), kind: 'tax', partial });
    if (vat > 0) for (let i = 1; i <= 3; i++) out.push({ date: iso(y, q * 3 + i), title: `НДС ${Number(S.vatRate)}% за ${qn} (${i}/3)`, amount: round(vat / 3), kind: 'tax', partial });
  }
  const until = D.addDays(today, 90);
  return out.filter(p => p.date >= today && p.date <= until).sort((a, b) => a.date.localeCompare(b.date));
}

// Поставки по кластерам Ozon (как «Планирование» в шаблоне STPulse): по каждому артикулу и кластеру —
// доступно на складах кластера, в пути, заказы за 28 дней с доставкой в кластер (локально — со склада этого же кластера).
function clusterRows({ clusterStocks, postings, categories = {}, stocks, today }) {
  const from = D.addDays(today, -27);
  const names = Object.fromEntries((stocks || []).map(s => [s.offer, s.name]));
  const by = {};
  const row = (offer, cluster) => by[offer + '|' + cluster] = by[offer + '|' + cluster] || {
    offer, cluster, available: 0, transit: 0, ads: 0, fboLocal: 0, fboFar: 0, fbsLocal: 0, fbsFar: 0
  };
  for (const s of clusterStocks || []) {
    const r = row(s.offer, s.cluster);
    r.available += s.available; r.transit += s.transit; r.ads = Math.max(r.ads, s.ads || 0);
  }
  let withCluster = 0;
  for (const p of postings || []) {
    if (p.status === 'cancelled' || !D.inRange(p.date, from, today) || !p.cluster) continue;
    withCluster++;
    const local = p.clusterFrom && p.clusterFrom === p.cluster;
    for (const i of p.items) {
      const r = row(i.offer, p.cluster);
      r[(p.scheme === 'FBO' ? 'fbo' : 'fbs') + (local ? 'Local' : 'Far')] += i.qty;
      if (!names[i.offer]) names[i.offer] = i.name;
    }
  }
  const rows = Object.values(by).map(r => ({ ...r, ads: round(r.ads, 3), name: names[r.offer] || r.offer, category: categories[r.offer]?.category || 'Без категории', type: categories[r.offer]?.type || '' }));
  return { rows, days: 28, from, to: today, ordersKnown: withCluster > 0 };
}

// РНП (рука на пульсе) по дням: заказы — из отправлений (по дате заказа), выкупы/возвраты/удержания — по дате начисления Ozon.
// Прогноз по заказам: выкупится (1 − доля возвратов товара), прибыль с выкупленной штуки — по формуле «Цены товара» при цене заказа.
// Факт: к выплате от Ozon − себестоимость выкупленного − НДС − налог (без постоянных расходов).
function rnpDays({ fin, postings, pricing, costs, S, today, ordered, names = {} }) {
  const { profitAt } = require('../brandos/pricing');
  const pr = Object.fromEntries((pricing || []).map(p => [p.offer, p]));
  const vatRate = Number(S.vatRate || 0), taxRate = Number(S.taxRate ?? 6) / 100;
  const taxOn = net => (S.taxMode === 'usn_income' || !S.taxMode ? Math.max(0, net) * taxRate : 0);
  const days = {}, offers = {};
  const blank = () => ({ ordQty: 0, ordSum: 0, fboQty: 0, fbsQty: 0, fboSum: 0, fbsSum: 0, cancelQty: 0, cancelSum: 0, fSales: 0, fRevenue: 0, fProfit: 0,
    sales: 0, returns: 0, payout: 0, commission: 0, logistics: 0, buyQty: 0, retQty: 0, cost: 0, vat: 0, tax: 0, profit: 0, hasFin: false, hasOrd: false });
  const day = d => (days[d] = days[d] || { date: d, ...blank() });
  const od = (offer, d) => { const o = offers[offer] = offers[offer] || { name: names[offer] || offer, days: {} }; return (o.days[d] = o.days[d] || blank()); };
  const firstPosting = (postings || []).reduce((m, p) => (!m || p.date < m ? p.date : m), '');

  for (const p of postings || []) {
    if (!p.date || p.date > today) continue;
    const D0 = day(p.date);
    for (const i of p.items) {
      const sum = i.qty * i.price, o = od(i.offer, p.date);
      if (!names[i.offer] && i.name) offers[i.offer].name = i.name;
      if (p.status === 'cancelled') { D0.cancelQty += i.qty; D0.cancelSum += sum; o.cancelQty += i.qty; o.cancelSum += sum; continue; }
      const k = p.scheme === 'FBO' ? 'fbo' : 'fbs';
      const r = pr[i.offer], rate = Math.min(0.9, (r ? Number(r.input.returnRatePct) : 35) / 100);
      const unitProfit = r?.costKnown ? profitAt(i.price, r.input).profit : null;
      for (const t of [D0, o]) {
        t.ordQty += i.qty; t.ordSum += sum; t[k + 'Qty'] += i.qty; t[k + 'Sum'] += sum; t.hasOrd = true;
        t.fSales += i.qty * (1 - rate); t.fRevenue += sum * (1 - rate);
        if (unitProfit === null) t.fProfit = null;
        else if (t.fProfit !== null) t.fProfit += i.qty * (1 - rate) * unitProfit;
      }
    }
  }
  const factOf = (t, net) => {
    const vat = vatRate > 0 ? Math.max(0, net) * vatRate / (100 + vatRate) : 0;
    t.vat = vat; t.tax = taxOn(net - vat); t.profit = t.cost === null ? null : t.payout - t.cost - vat - t.tax; t.hasFin = true;
  };
  for (const M of Object.values(fin || {})) for (const [d, Dy] of Object.entries(M.days || {})) {
    if (d > today) continue;
    const D0 = day(d);
    Object.assign(D0, { sales: Dy.sales, returns: Dy.returns, payout: Dy.payout, commission: Dy.commission || 0, logistics: Dy.logistics || 0, buyQty: Dy.buyQty || 0, retQty: Dy.retQty || 0 });
    let cost = !Dy.u && (Dy.buyQty || Dy.retQty || Dy.sales || Dy.returns) ? null : 0;
    for (const [offer, u] of Object.entries(Dy.u || {})) {
      const units = u.b - u.r;
      const c = costs[offer] ? units * costs[offer].unitCost : (u.b || u.r || u.rev) ? null : 0;
      if (c === null) cost = null;
      else if (cost !== null) cost += c;
      const o = od(offer, d);
      Object.assign(o, { sales: Math.max(0, u.rev), payout: u.pay, buyQty: u.b, retQty: u.r, cost: c });
      o.returns = 0; factOf(o, u.rev);
    }
    D0.cost = cost; factOf(D0, Dy.sales + Dy.returns);
  }
  const r2 = v => Math.round(v * 100) / 100;
  const clean = t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));
  return {
    days: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)).map(clean),
    offers: Object.fromEntries(Object.entries(offers).map(([k, o]) => [k, { name: o.name, days: Object.fromEntries(Object.entries(o.days).map(([d, t]) => [d, clean(t)])) }])),
    ordersFrom: firstPosting,
    ordered
  };
}

// Проблемные возвраты: по статусу Ozon и сроку в этом статусе — группа и что с ней делать.
// «В пути» до 14 дней — нормально, показываем отдельно, без тревоги.
const RETURN_GROUPS = [
  { id: 'lost', title: 'Ozon ищет товар', todo: 'Написать в поддержку Ozon и запросить компенсацию' },
  { id: 'late', title: 'Едет к вам дольше 2 недель', todo: 'Спросить поддержку, где товар' },
  { id: 'lateOzon', title: 'Не отправлен на склад Ozon дольше 2 недель', todo: 'Пока ждать; через месяц — запрос в поддержку' },
  { id: 'atOzon', title: 'FBS-возврат лежит на складе Ozon', todo: 'Проверить: перевели в сток FBO или нужно заказать вывоз' },
  { id: 'denied', title: 'Отказано в компенсации', todo: 'Оспорить свежие отказы в поддержке' },
  { id: 'writeOff', title: 'Списан без компенсации', todo: 'Запросить компенсацию в поддержке Ozon: «Возвраты → Утилизация и списания», номер отправления' },
  { id: 'writeOffWait', title: 'Списан, ждём компенсацию', todo: 'Ozon обычно платит в начале следующего месяца; если через 45 дней нет — запрос в поддержку' },
  { id: 'onWay', title: 'В пути, всё в порядке', todo: '' }
];
const WRITE_OFF_WAIT_DAYS = 45;
function returnRows(returns, today) {
  if (!returns) return null;
  const ago = d => Math.round((D.parse(today) - D.parse(d)) / 864e5);
  const groupOf = r => {
    const days = r.since ? ago(r.since) : 0;
    const moving = r.status === 'MovingToSeller' || r.status === 'MovingToOzon' || r.status === 'WaitingShipment';
    const toSeller = r.status === 'MovingToSeller' || (r.status === 'WaitingShipment' && r.schema === 'FBS');
    if (r.comp === 'Received' && (r.status === 'PotentiallyLost' || r.status === 'WriteOff')) return null; // компенсацию получили
    if (r.status === 'PotentiallyLost') return 'lost';
    if (moving) return days > 14 ? (toSeller ? 'late' : 'lateOzon') : 'onWay';
    if (r.status === 'ReturnedToOzon') return 'atOzon';
    if (r.status === 'CompensationRejected') return 'denied';
    if (r.status === 'WriteOff') return !r.comp && days <= WRITE_OFF_WAIT_DAYS ? 'writeOffWait' : 'writeOff';
    return null;
  };
  // Только текущий год — по дате последнего статуса (для списаний это дата списания)
  const year = today.slice(0, 4);
  const items = (returns.items || []).filter(r => (r.since || r.returnDate || '').startsWith(year));
  const counts = Object.fromEntries(Object.entries(returns.counts || {}).map(([k, c]) => [k, { name: c.name, ...(c.years?.[year] || { qty: 0, FBO: 0, FBS: 0 }) }]));
  // Сводка по списаниям для Главной: всего, компенсировано, ждём, без компенсации
  const wo = items.filter(r => r.status === 'WriteOff');
  const part = list => ({ qty: sum(list, r => r.qty), sum: round(sum(list, r => r.qty * r.price)) });
  const writeOffs = {
    all: part(wo), paid: part(wo.filter(r => r.comp === 'Received')),
    wait: part(wo.filter(r => groupOf(r) === 'writeOffWait')), unpaid: part(wo.filter(r => groupOf(r) === 'writeOff')),
    waitDays: WRITE_OFF_WAIT_DAYS
  };
  const rows = [];
  for (const r of items) {
    const g = groupOf(r);
    if (g) rows.push({ ...r, group: g, days: r.since ? ago(r.since) : null, sum: round(r.qty * r.price) });
  }
  const groups = RETURN_GROUPS.map(g => {
    const list = rows.filter(r => r.group === g.id);
    return { ...g, qty: sum(list, r => r.qty), sum: round(sum(list, r => r.sum)) };
  });
  const total = sum(Object.values(counts), c => c.qty);
  const order = Object.fromEntries(RETURN_GROUPS.map((g, i) => [g.id, i]));
  return { rows: rows.sort((a, b) => order[a.group] - order[b.group] || (b.days ?? 0) - (a.days ?? 0)), groups, counts, total, writeOffs, year };
}

// Расшифровка налогов по месяцу: из чего сложились продажи (база НДС и УСН) и по каким отчётам Ozon.
// Строки для скачивания: real — отчёт о реализации, acc — начисления по артикулам, mb — отчёт о выкупе товаров Ozon.
const COMP_NAMES = { ItemCompensation: 'Компенсация за товар', Compensation: 'Компенсация', B2CInsuranceCompensation: 'Страховая компенсация' };
function taxDocs({ fin, pnl, realization = {}, buyouts = {} }) {
  const r2 = v => Math.round(v * 100) / 100;
  const out = {};
  for (const [m, P] of Object.entries(pnl)) {
    const F = fin[m], T = F?.totals || {};
    const mb = T.mbSales || 0, R = realization[m];
    const mbRows = (buyouts[m] || []).map(p => {
      const qty = Number(p.quantity) || 1, price = Number(p.seller_price_per_instance) || 0;
      return [String(p.offer_id || p.sku), p.name || '', qty, price, r2(price * qty), Number(p.amount) || 0];
    });
    const mbByOffer = {};
    for (const x of mbRows) mbByOffer[x[0]] = (mbByOffer[x[0]] || 0) + x[4];
    const real = R ? (() => {
      const s = i => r2(sum(R.rows, x => x[i]));
      return { number: R.number, date: R.date, from: R.from, to: R.to, dQty: s(2), dSeller: s(3), dBuyer: s(4), dBonus: s(5), dPartner: s(6), rQty: s(7), rSeller: s(8), rBuyer: s(9), rBonus: s(10), rPartner: s(11) };
    })() : null;
    // Компенсации и декомпенсации Ozon — в базе УСН «доходы» (НДС с них нет). Без списка (месяц из отчёта) — одной суммой.
    const compList = [...(F?.comp || [])].sort((a, b) => a[0].localeCompare(b[0]));
    const compIn = compList.length ? sum(compList.filter(c => c[2] > 0), c => c[2]) : Math.max(0, T.compensation || 0);
    const compOut = compList.length ? sum(compList.filter(c => c[2] < 0), c => c[2]) : Math.min(0, T.compensation || 0);
    const usnComp = P.taxMode === 'usn_income' ? P.compensation : 0;
    out[m] = {
      source: F?.source === 'report' ? 'report' : F ? 'api' : null, period: F?.period || null,
      sales: round(T.sales - mb || 0), returns: round(T.returns || 0), mb: round(mb), mbQty: T.mbQty || 0,
      compIn: r2(compIn), compOut: r2(compOut), compN: compList.filter(c => c[2] > 0).length, decompN: compList.filter(c => c[2] < 0).length, usnComp,
      income: P.income, gross: P.revenue + P.income, vat: P.vat, vatRate: P.vatRate, base: P.revenue + P.income - P.vat + usnComp, usn: P.tax, taxRate: P.taxRate, taxMode: P.taxMode,
      buyQty: sum(Object.values(F?.skus || {}), s => s.buyQty - (s.mbQty || 0)), retQty: sum(Object.values(F?.skus || {}), s => s.retQty),
      real,
      files: {
        real: R ? R.rows : null,
        // начисления по артикулу без выкупов Ozon (они — отдельным отчётом): продано шт и ₽, возвращено шт и ₽
        acc: F ? Object.values(F.skus || {}).filter(s => s.buyQty - (s.mbQty || 0) || s.retQty)
          .map(s => [s.offer, s.name, s.buyQty - (s.mbQty || 0), r2(s.buyRev - (mbByOffer[s.offer] || 0)), s.retQty, r2(s.retRev)]) : null,
        mb: mbRows.length ? mbRows : null,
        comp: compList.length ? compList.map(([d, t, v]) => [d, COMP_NAMES[t] || t, v]) : null
      }
    };
  }
  return out;
}

// Жалобы и негативные отзывы для Главной. Актуальные — жалобы с долей больше нуля и отзывы на 1–3 звезды без ответа.
function feedbackBlock(fb) {
  if (!fb) return null;
  const complaints = (fb.complaints || []).filter(c => c.status !== 'UNKNOWN_STATUS' || c.value > 0);
  const negative = fb.reviews?.available ? [...fb.reviews.items].sort((a, b) => b.date.localeCompare(a.date)) : null;
  const open = negative ? negative.filter(r => !r.answered && r.status !== 'PROCESSED') : [];
  return {
    complaints, complaintsActive: complaints.filter(c => c.value > 0).length,
    score: fb.score, chats: { count: (fb.chats || []).length, messages: sum(fb.chats || [], c => c.unread) },
    reviews: negative, reviewsOpen: open.length
  };
}

// «Есть дешевле»: к карточке присоединились другие продавцы (часто китайские магазины) с ценой ниже нашей.
// sold30 — сколько штук продали за 30 дней, чтобы видеть, где это бьёт по продажам сильнее.
function cheaperRows({ prices, stocks, postings, skuMap, today }) {
  const skuOf = {};
  for (const s of stocks || []) if (s.skus?.length) skuOf[s.offer] = s.skus[0];
  for (const [sku, offer] of Object.entries(skuMap || {})) if (!skuOf[offer]) skuOf[offer] = sku;
  const sold = {}, from = D.addDays(today, -29);
  for (const p of postings || []) {
    if (p.status === 'cancelled' || p.date < from) continue;
    for (const i of p.items) sold[i.offer] = (sold[i.offer] || 0) + i.qty;
  }
  return (prices || []).filter(p => p.ozMin > 0 && p.ozIdx > 1)
    .map(p => ({ offer: p.offer, name: p.name, sku: skuOf[p.offer] || null, price: p.price, ozMin: p.ozMin, idx: p.ozIdx, sold30: sold[p.offer] || 0 }))
    .sort((a, b) => b.idx - a.idx);
}

// Расчёты с Ozon по балансу дня [на начало, начислено, выплачено (минус), на конец]:
// выплаты по датам, итоги по месяцам и сколько Ozon должен сейчас.
function settleBlock(balance, today) {
  if (!balance) return null;
  const days = Object.keys(balance).filter(d => d <= today).sort();
  if (!days.length) return null;
  const months = {}, payouts = [];
  for (const d of days) {
    const [o, a, p, c] = balance[d];
    if (!o && !a && !p && !c) continue; // дни до начала продаж
    const M = months[d.slice(0, 7)] = months[d.slice(0, 7)] || { month: d.slice(0, 7), opening: o, accrued: 0, paid: 0, closing: c };
    M.accrued += a; M.paid -= p; M.closing = c;
    if (p) payouts.push({ date: d, amount: -p });
  }
  const asOf = days[days.length - 1], lastPay = payouts[payouts.length - 1] || null;
  const sinceLast = days.filter(d => !lastPay || d > lastPay.date).reduce((s, d) => s + balance[d][1], 0);
  return {
    asOf, now: balance[asOf][3], lastPay, sinceLast,
    months: Object.values(months).sort((a, b) => b.month.localeCompare(a.month)),
    payouts: payouts.reverse(),
    days: days.filter(d => d >= addMonthsStart(today, -2)).map(d => [d, ...balance[d]]).reverse()
  };
}
const addMonthsStart = (today, n) => { const d = new Date(today.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

// Автоархив: артикулы, которые Ozon сам убрал в архив, с последним месяцем продаж.
function archiveRows(archive, fin) {
  const months = Object.keys(fin || {}).sort().reverse();
  return (archive || []).map(a => {
    const m = months.find(x => fin[x]?.skus?.[a.offer]?.buyQty > 0) || null;
    return { ...a, lastSale: m, soldYear: months.filter(x => x.slice(0, 4) === months[0]?.slice(0, 4)).reduce((s, x) => s + (fin[x]?.skus?.[a.offer]?.buyQty || 0), 0) };
  }).sort((a, b) => (b.lastSale || '').localeCompare(a.lastSale || '') || b.at.localeCompare(a.at));
}

// Переупаковка Ozon за 3 месяца: «Упаковка товаров партнёрами» + «Обеспечение материалами для упаковки».
// Ozon перепаковывает товар, если упаковка не подходит для склада; штуки — примерно, по тарифу за одну.
function repackRows(fin, today, perUnit, names = {}) {
  const months = [0, -1, -2].map(n => addMonthsStart(today, n).slice(0, 7));
  const by = {};
  for (const m of months) for (const s of Object.values(fin?.[m]?.skus || {})) {
    const v = Object.entries(s.svc || {}).filter(([k]) => /^(PackageCost|PackingFee)$/.test(k)).reduce((a, [, x]) => a + x, 0);
    const r = by[s.offer] = by[s.offer] || { offer: s.offer, name: names[s.offer] || (s.name !== s.offer ? s.name : ''), months: {}, sum: 0, sold: 0 };
    r.sold += s.buyQty || 0;
    if (!v) continue;
    r.months[m] = (r.months[m] || 0) - v; r.sum -= v;
  }
  const rows = Object.values(by).filter(r => r.sum > 0.5).map(r => {
    const units = perUnit ? Math.round(r.sum / perUnit) : null;
    return { ...r, units, share: units != null && r.sold ? Math.min(100, Math.round(units / r.sold * 100)) : null };
  });
  return { months, rows: rows.sort((a, b) => b.sum - a.sum), total: sum(rows, r => r.sum) };
}

function buildEconomics({ raw, purchases = [], fileCosts = [], pnlLines = [], settings = {}, pricing = {}, reportFin = {}, today = D.today() }) {
  const oz = raw.ozon;
  const costs = unitCosts(purchases, fileCosts);
  const S = settings;
  const P = { ...PRICING_DEFAULTS, vatPct: Number(S.vatRate || 0), ...(pricing || {}) };
  const out = { costs, pricingParams: P };
  // Месяцы: из API Ozon, а где API нет (история) — из загруженных отчётов «Юнит-экономика». API главнее.
  const fin = { ...Object.fromEntries(Object.entries(reportFin || {}).filter(([m]) => !oz?.fin?.[m])), ...(oz?.fin || {}) };
  const hasFin = Object.keys(fin).length > 0;
  if (!hasFin && !oz?.postings && !purchases.length && !fileCosts.length && !pnlLines.length) return out;
  const adsOf = m => (fin[m]?.source === 'report' ? 0 : out.pnl[m]?.ads || 0); // в отчёте реклама уже внутри «к выплате» по товару

  const finMonths = Object.keys(fin);
  const lineMonths = pnlLines.map(l => l.month);
  const cur = today.slice(0, 7);
  out.months = [...new Set([cur, ...finMonths, ...lineMonths])].sort().reverse().slice(0, 120);
  out.reportMonths = finMonths.filter(m => fin[m]?.source === 'report').sort();
  out.history = oz?.history || null;

  const perfByMonth = {};
  for (const c of raw.ozonPerf?.campaigns || []) for (const d of c.days) perfByMonth[d.date.slice(0, 7)] = (perfByMonth[d.date.slice(0, 7)] || 0) + d.spend;

  out.pnl = {};
  out.unit = {};
  const monthEnd = m => m + '-' + String(D.daysInMonth(m + '-01')).padStart(2, '0');
  const unitArgs = { postings: oz?.postings, stocks: oz?.stockTypes, prices: oz?.prices, skuMap: oz?.skuMap, costs, S };
  for (const m of out.months) {
    out.pnl[m] = pnlMonth({ month: m, fin: fin[m], perfSpend: perfByMonth[m] || 0, lines: pnlLines, costs, S, today });
    if (fin[m]?.source === 'report') out.pnl[m].source = 'report';
    if (oz || fin[m]) out.unit[m] = unitRows({ ...unitArgs, from: m + '-01', to: monthEnd(m), fin: fin[m], adsTotal: adsOf(m) });
  }
  // Период «все загруженные месяцы» — как выгрузка юнит-экономики Ozon за несколько месяцев
  if (finMonths.length > 1) {
    const ms = finMonths.slice().sort();
    out.unit.all = unitRows({ ...unitArgs, from: ms[0] + '-01', to: today, fin: mergeFin(ms.map(m => fin[m])), adsTotal: sum(ms, adsOf) });
    out.unitAllRange = { from: ms[0] + '-01', to: today };
  }

  if (oz) {
    out.stock = stockRows({ postings: oz.postings, stocks: oz.stockTypes, costs, S, today });
    out.pricing = pricingRows({ finList: Object.values(fin), prices: oz.prices, unit: out.unit[cur], costs, categories: oz.categories, P, S });
    // Типы товаров с категориями — для таблицы упаковки на странице «Цена товара»
    const types = {};
    for (const c of Object.values(oz.categories || {})) {
      const t = types[c.type] = types[c.type] || { type: c.type, category: c.category, count: 0 };
      t.count++;
    }
    out.productTypes = Object.values(types).sort((a, b) => a.category.localeCompare(b.category) || b.count - a.count);
    out.taxPayments = taxPayments({ pnl: out.pnl, S, today });
    out.taxDocs = taxDocs({ fin, pnl: out.pnl, realization: oz.realization, buyouts: oz.buyouts });
    out.rnp = rnpDays({ fin: oz.fin, postings: oz.postings, pricing: out.pricing, costs, S, today, ordered: oz.ordered, names: Object.fromEntries((oz.stockTypes || []).map(s => [s.offer, s.name])) });
    out.clusters = clusterRows({ clusterStocks: oz.clusterStocks, postings: oz.postings, categories: oz.categories, stocks: oz.stockTypes, today });
    out.returns = returnRows(oz.returns, today);
    out.feedback = feedbackBlock(oz.feedback);
    out.settle = settleBlock(oz.balance, today);
    out.autoArchive = archiveRows(oz.archive, fin);
    out.repack = repackRows(fin, today, Number(P.ozonPack) || 15, Object.fromEntries([...(oz.prices || []), ...(oz.stockTypes || [])].filter(s => s.name && s.name !== s.offer).map(s => [s.offer, s.name])));
    out.cheaper = cheaperRows({ prices: oz.prices, stocks: oz.stockTypes, postings: oz.postings, skuMap: oz.skuMap, today });

    // Графики Главной: выручка по дням (начисления Ozon) и заказы FBO/FBS по дням за текущий месяц
    const days = [];
    for (let d = cur + '-01'; d <= today; d = D.addDays(d, 1)) days.push(d);
    const finDays = oz.fin?.[cur]?.days || {};
    const ordDay = {};
    for (const p of oz.postings || []) {
      if (p.status === 'cancelled' || !D.inRange(p.date, cur + '-01', today)) continue;
      const o = ordDay[p.date] = ordDay[p.date] || { fbo: 0, fbs: 0, fboSum: 0, fbsSum: 0 };
      const k = p.scheme === 'FBO' ? 'fbo' : 'fbs';
      for (const i of p.items) { o[k] += i.qty; o[k + 'Sum'] += i.qty * i.price; }
    }
    out.daily = days.map(d => ({
      date: d,
      revenue: round((finDays[d]?.sales || 0) + (finDays[d]?.returns || 0)),
      fbo: ordDay[d]?.fbo || 0, fbs: ordDay[d]?.fbs || 0,
      fboSum: round(ordDay[d]?.fboSum || 0), fbsSum: round(ordDay[d]?.fbsSum || 0)
    }));
    out.dailyHasRevenue = Object.keys(finDays).length > 0;

    const o = ordersIn(oz.postings, cur + '-01', today);
    const T = oz.fin?.[cur]?.totals;
    const fs = Object.values(oz.fin?.[cur]?.skus || {});
    const buyQty = sum(fs, s => s.buyQty), retQty = sum(fs, s => s.retQty);
    out.tiles = {
      orders: { sum: round(o.all.sum), qty: oz.ordered?.from <= cur + '-01' && oz.ordered?.to >= today
        ? sum(Object.entries(oz.ordered.days).filter(([date]) => D.inRange(date, cur + '-01', today)), ([, qty]) => qty)
        : null },
      fbo: { sum: round(o.fbo.sum), qty: o.fbo.qty }, fbs: { sum: round(o.fbs.sum), qty: o.fbs.qty },
      buyouts: T ? { sum: round(T.sales), qty: buyQty, pct: pct(buyQty, buyQty + retQty) } : null,
      returns: T ? { sum: round(-T.returns), qty: retQty, pct: pct(retQty, buyQty + retQty) } : null,
      profit: { net: out.pnl[cur].net, margin: out.pnl[cur].margin },
      stock: { fbo: out.stock.summary.fbo, fbs: out.stock.summary.fbs }
    };
  }
  return out;
}

module.exports = { buildEconomics, unitCosts, pnlMonth, mergeFin, unitCol, PRICING_DEFAULTS };
