// Ozon Seller API: выручка по дням и по артикулам, финансы месяца, остатки,
// а также заказы FBO/FBS, финансовые операции по артикулам, остатки по типам складов, цены и комиссии.
// Документация: https://docs.ozon.ru/api/seller
const D = require('../dates');
const { addDays, monthStart } = D;
const { num } = require('../http');
const { aggregate, fromAccruals, addBuyouts } = require('../ozonfin');

const API = 'https://api-seller.ozon.ru';

module.exports = {
  id: 'ozon',
  name: 'Ozon',
  keys: ['OZON_CLIENT_ID', 'OZON_API_KEY'],
  async fetch({ env, today, request, sleep, prev: prevData }) {
    const headers = { 'Client-Id': env.OZON_CLIENT_ID, 'Api-Key': env.OZON_API_KEY };
    // Ozon ограничивает частоту запросов (аналитику — около одного в минуту, остальное мягче).
    // На ответ 429 повторяем с паузами 5, 20 и 61 секунда.
    const post = async (path, body) => {
      const waits = [5000, 20000, 61000];
      for (let attempt = 0; ; attempt++) {
        try {
          return await request(API + path, { method: 'POST', headers, body });
        } catch (e) {
          if (e.status !== 429 || attempt >= waits.length) throw e;
          await sleep(waits[attempt]);
        }
      }
    };

    // Отчёт о выкупленных Ozon товарах: очень строгий лимит (около запроса в минуту) — свои паузы.
    async function buyoutReport(from, to) {
      const waits = [20000, 40000, 61000, 61000];
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await request(API + '/v1/finance/products/buyout', { method: 'POST', headers, body: { date_from: from, date_to: to } });
          return r?.products || [];
        } catch (e) {
          if (e.status === 400) return []; // за старые периоды (до середины 2024) Ozon отчёт не выдаёт — считаем, что выкупов не было
          if (e.status !== 429 || attempt >= waits.length) throw e;
          await sleep(waits[attempt]);
        }
      }
    }

    // Аналитика пагинируется по 1000 строк; между запросами — пауза из-за лимита.
    async function analytics(dateFrom, dimension) {
      const rows = [];
      for (let offset = 0; offset < 20000; offset += 1000) {
        if (rows.length || offset) await sleep(61000);
        const r = await post('/v1/analytics/data', {
          date_from: dateFrom, date_to: today, metrics: ['revenue', 'ordered_units'], dimension, limit: 1000, offset
        });
        const data = r?.result?.data || [];
        rows.push(...data);
        if (data.length < 1000) break;
      }
      return rows;
    }

    // Дальше — данные для юнит-экономики, ОПиУ, склада и цены. Если какой-то метод недоступен ключу,
    // остальное всё равно загружается, а на странице «Интеграции» появляется предупреждение.
    const warnings = [];
    const optional = async (label, fn, fallback) => {
      try { return await fn(); } catch (e) { warnings.push(`${label}: ${e.status ? 'ошибка ' + e.status : e.message}`); return fallback; }
    };

    const stocks = [];
    for (let offset = 0; offset < 20000; offset += 1000) {
      const r = await post('/v2/analytics/stock_on_warehouses', { limit: 1000, offset, warehouse_type: 'ALL' });
      const rows = r?.result?.rows || [];
      for (const s of rows) stocks.push({ sku: String(s.sku), code: s.item_code, name: s.item_name, qty: num(s.free_to_sell_amount) });
      if (rows.length < 1000) break;
    }

    // Заказы за 60 дней: FBO — /v3/posting/fbo/list, FBS — /v4/posting/fbs/list (старые версии Ozon отключил).
    // Листаются курсором по 100 штук (больше Ozon не отдаёт); цена товара — объект { amount, currency }.
    const since = addDays(today, -60);
    const postings = await optional('заказы FBO/FBS', async () => {
      const out = [];
      const norm = (p, scheme) => ({
        n: p.posting_number, scheme, status: p.status,
        date: String(p.in_process_at || p.created_at || '').slice(0, 10),
        cluster: p.financial_data?.cluster_to || '', clusterFrom: p.financial_data?.cluster_from || '',
        items: (p.products || []).map(i => ({ sku: String(i.sku), offer: String(i.offer_id || i.sku), name: i.name, qty: num(i.quantity), price: num(i.price?.amount ?? i.price) }))
      });
      const filter = { since: since + 'T00:00:00.000Z', to: today + 'T23:59:59.999Z' };
      for (const [path, scheme] of [['/v3/posting/fbo/list', 'FBO'], ['/v4/posting/fbs/list', 'FBS']]) {
        let cursor = '';
        for (let i = 0; i < 1000; i++) {
          const r = await post(path, { dir: 'ASC', filter, limit: 100, cursor, with: { financial_data: true } });
          const res = r?.result || r || {};
          out.push(...(res.postings || []).map(p => norm(p, scheme)));
          cursor = res.cursor || '';
          if (!res.has_next || !cursor) break;
          await sleep(200);
        }
      }
      return out;
    }, null);

    // Выручка и штуки по дням и по артикулам — из заказов (без отменённых): быстро и без лимитов.
    // Аналитика Ozon отдаёт то же самое, но не чаще раза в минуту и по 1000 строк — только как запасной вариант.
    let days, skuDays;
    if (postings) {
      const byDate = {}, bySku = {};
      const from28 = addDays(today, -27);
      for (const p of postings) {
        if (p.status === 'cancelled') continue;
        for (const i of p.items) {
          const d = byDate[p.date] = byDate[p.date] || { date: p.date, revenue: 0, units: 0 };
          d.revenue += i.qty * i.price; d.units += i.qty;
          if (p.date >= from28) {
            const k = i.sku + '|' + p.date;
            const s = bySku[k] = bySku[k] || { sku: i.sku, name: i.name, date: p.date, revenue: 0, units: 0 };
            s.revenue += i.qty * i.price; s.units += i.qty;
          }
        }
      }
      days = Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
      skuDays = Object.values(bySku);
    } else {
      const byDay = await optional('аналитика по дням', () => analytics(addDays(today, -60), ['day']), []);
      await sleep(61000); // второй запрос аналитики — не раньше чем через минуту
      const bySkuDay = await optional('аналитика по артикулам', () => analytics(addDays(today, -27), ['sku', 'day']), []);
      days = byDay.map(r => ({ date: r.dimensions[0].id, revenue: num(r.metrics[0]), units: num(r.metrics[1]) }));
      skuDays = bySkuDay.map(r => ({ sku: String(r.dimensions[0].id), name: r.dimensions[0].name, date: r.dimensions[1].id, revenue: num(r.metrics[0]), units: num(r.metrics[1]) }));
    }

    const stockTypes = await optional('остатки FBO/FBS', async () => {
      const out = [];
      let cursor = '';
      for (let i = 0; i < 50; i++) {
        const r = await post('/v4/product/info/stocks', { filter: { visibility: 'ALL' }, limit: 1000, cursor });
        for (const it of r?.items || []) {
          const by = t => (it.stocks || []).filter(s => String(s.type).toLowerCase() === t).reduce((a, s) => a + num(s.present), 0);
          out.push({ offer: String(it.offer_id), productId: it.product_id, skus: (it.stocks || []).map(s => String(s.sku)), fbo: by('fbo'), fbs: by('fbs') });
        }
        cursor = r?.cursor || '';
        if (!cursor || !(r?.items || []).length) break;
      }
      return out;
    }, null);

    const prices = await optional('цены и комиссии', async () => {
      const out = [];
      let cursor = '';
      for (let i = 0; i < 50; i++) {
        const r = await post('/v5/product/info/prices', { filter: { visibility: 'ALL' }, limit: 1000, cursor });
        for (const it of r?.items || []) {
          const c = it.commissions || {};
          // Индекс цен Ozon: самая низкая цена этого же товара у других продавцов на Ozon (блок «Есть дешевле» в карточке).
          // Индекс больше 1 — у кого-то дешевле, чем у нас.
          const oz = it.price_indexes?.ozon_index_data || {};
          out.push({
            offer: String(it.offer_id), productId: it.product_id,
            price: num(it.price?.price), marketingPrice: num(it.price?.marketing_price), minPrice: num(it.price?.min_price),
            ozMin: num(oz.min_price), ozIdx: num(oz.price_index_value),
            commissions: {
              fboPct: num(c.sales_percent_fbo), fbsPct: num(c.sales_percent_fbs),
              fboDirect: num(c.fbo_direct_flow_trans_max_amount), fboDirectMin: num(c.fbo_direct_flow_trans_min_amount), fboDelivery: num(c.fbo_deliv_to_customer_amount), fboReturn: num(c.fbo_return_flow_amount),
              fbsDirect: num(c.fbs_direct_flow_trans_max_amount), fbsDirectMin: num(c.fbs_direct_flow_trans_min_amount), fbsDelivery: num(c.fbs_deliv_to_customer_amount),
              fbsFirstMile: num(c.fbs_first_mile_max_amount), fbsFirstMileMin: num(c.fbs_first_mile_min_amount), fbsReturn: num(c.fbs_return_flow_amount)
            }
          });
        }
        cursor = r?.cursor || '';
        if (!cursor || !(r?.items || []).length) break;
      }
      return out;
    }, null);

    // Связь Ozon SKU → артикул продавца (offer_id): всё считаем по артикулу продавца.
    const skuMap = { ...(prevData?.skuMap || {}) };
    for (const p of postings || []) for (const i of p.items) skuMap[i.sku] = i.offer;
    for (const s of stockTypes || []) for (const k of s.skus) skuMap[k] = s.offer;
    const names = {};
    for (const p of postings || []) for (const i of p.items) names[i.offer] = i.name;
    for (const r of skuDays) { const offer = skuMap[r.sku]; if (offer && !names[offer]) names[offer] = r.name; }
    for (const s of stocks) if (s.code && !names[s.code]) names[s.code] = s.name;
    for (const s of stockTypes || []) s.name = names[s.offer] || s.offer;
    for (const p of prices || []) p.name = names[p.offer] || p.offer;

    // Категория и тип товара (для упаковки по категориям). Дерево категорий большое — грузим раз в 30 дней.
    let catTree = prevData?.catTree && prevData.catTree.at > addDays(today, -30) ? prevData.catTree : null;
    let firstCard = null; // месяц создания самой ранней карточки — начало истории магазина
    const categories = await optional('категории товаров', async () => {
      if (!catTree) {
        const t = await post('/v1/description-category/tree', { language: 'DEFAULT' });
        const cats = {}, types = {};
        const walk = (list, parent) => {
          for (const c of list || []) {
            if (c.description_category_id) cats[c.description_category_id] = c.category_name;
            if (c.type_id) types[parent + ':' + c.type_id] = c.type_name;
            walk(c.children, c.description_category_id || parent);
          }
        };
        walk(t?.result);
        catTree = { at: today, cats, types };
      }
      const ids = [...new Set((prices || prevData?.prices || []).map(p => p.productId).filter(Boolean))];
      const out = {};
      for (let i = 0; i < ids.length; i += 1000) {
        const r = await post('/v3/product/info/list', { product_id: ids.slice(i, i + 1000) });
        for (const it of r?.items || []) {
          const created = String(it.created_at || '').slice(0, 7);
          if (/^\d{4}-\d{2}$/.test(created) && (!firstCard || created < firstCard)) firstCard = created;
          out[String(it.offer_id)] = {
            category: catTree.cats[it.description_category_id] || 'Без категории',
            type: catTree.types[it.description_category_id + ':' + it.type_id] || catTree.cats[it.description_category_id] || 'Без типа'
          };
        }
      }
      return out;
    }, prevData?.categories || {});

    // Остатки и средние продажи по кластерам Ozon (как на странице «Доступность товаров»): по 100 SKU за запрос.
    const clusterStocks = await optional('остатки по кластерам', async () => {
      const skus = [...new Set([...(stockTypes || []).flatMap(s => s.skus), ...Object.keys(skuMap)])].filter(Boolean);
      const out = [];
      for (let i = 0; i < skus.length; i += 100) {
        let r;
        for (let attempt = 0; attempt < 4; attempt++) {
          try { r = await post('/v1/analytics/stocks', { skus: skus.slice(i, i + 100) }); break; }
          catch (e) { if (attempt === 3 || (e.status && e.status < 500)) throw e; await sleep(3000 * (attempt + 1)); }
        }
        for (const it of r?.items || []) {
          out.push({
            sku: String(it.sku), offer: String(it.offer_id || skuMap[it.sku] || it.sku), cluster: it.cluster_name || '—', warehouse: it.warehouse_name,
            available: num(it.available_stock_count), transit: num(it.transit_stock_count) + num(it.requested_stock_count),
            ads: num(it.ads_cluster), idc: it.idc_cluster == null ? null : num(it.idc_cluster), grade: it.turnover_grade_cluster || '',
            noSales: num(it.days_without_sales_cluster)
          });
        }
        await sleep(400);
      }
      return out;
    }, prevData?.clusterStocks || []);

    // Возвраты и отмены (/v1/returns/list) — все за историю магазина, по 500 за запрос.
    // Закрытые без проблем (получены вами, вернулись в сток FBO, отменены) храним только счётчиком.
    const returns = await optional('возвраты', async () => {
      const OK = new Set(['ReceivedBySeller', 'Cancelled', 'CrmRejected', 'Rejected']);
      const counts = {}, items = [];
      let lastId = 0;
      for (let page = 0; page < 100; page++) {
        const r = await post('/v1/returns/list', { filter: {}, limit: 500, last_id: lastId });
        const list = r?.returns || [];
        for (const x of list) {
          const st = x.visual?.status || {}, schema = String(x.schema || '').toUpperCase();
          counts[st.sys_name] = counts[st.sys_name] || { name: st.display_name, qty: 0, FBO: 0, FBS: 0 };
          counts[st.sys_name].qty++; counts[st.sys_name][schema] = (counts[st.sys_name][schema] || 0) + 1;
          // по годам последнего статуса — на дашборде показываем только текущий год
          const year = (x.visual?.change_moment || x.logistic?.return_date || '').slice(0, 4);
          const years = counts[st.sys_name].years = counts[st.sys_name].years || {};
          const y = years[year] = years[year] || { qty: 0, FBO: 0, FBS: 0 };
          y.qty++; y[schema] = (y[schema] || 0) + 1;
          if (OK.has(st.sys_name) || (st.sys_name === 'ReturnedToOzon' && schema === 'FBO')) continue;
          items.push({
            posting: x.posting_number, offer: String(x.product?.offer_id || ''), name: x.product?.name || '',
            qty: num(x.product?.quantity) || 1, price: num(x.product?.price?.price), type: x.type, schema,
            status: st.sys_name, statusName: st.display_name, since: (x.visual?.change_moment || '').slice(0, 10),
            returnDate: (x.logistic?.return_date || '').slice(0, 10), place: x.place?.name || '', target: x.target_place?.name || '',
            reason: x.return_reason_name || '',
            // компенсация за списанный или потерянный товар: Received — получена, DecompensationSent — Ozon её забрал обратно
            comp: x.compensation_status?.status?.sys_name || null, compName: x.compensation_status?.status?.display_name || '',
            compDate: (x.compensation_status?.change_moment || '').slice(0, 10)
          });
        }
        if (!r?.has_next || !list.length) break;
        lastId = list[list.length - 1].id;
        await sleep(300);
      }
      return { counts, items };
    }, prevData?.returns || null);

    // Жалобы и отзывы. Списка жалоб по товарам («Товары → Жалобы») в API нет — берём долю жалоб из рейтинга продавца.
    // Отзывы (/v1/review/list) Ozon отдаёт только с подпиской Premium Plus; без неё — пометка, что недоступны.
    const feedback = await optional('жалобы и отзывы', async () => {
      const rating = await post('/v1/rating/summary', {});
      const items = (rating?.groups || []).flatMap(g => g.items || []);
      const complaints = items.filter(i => /^rating_delivery_complaints/.test(i.rating)).map(i => ({
        name: String(i.name || '').replace(/^Жалобы по /, ''), value: num(i.current_value), past: num(i.past_value), status: i.status
      }));
      const score = items.find(i => i.rating === 'rating_review_avg_score_total');
      const unread = [];
      await optional('чаты покупателей', async () => {
        let cursor;
        for (let page = 0; page < 10; page++) {
          const r = await post('/v3/chat/list', { filter: { chat_status: 'Opened', unread_only: true }, limit: 100, ...(cursor ? { cursor } : {}) });
          for (const c of r?.chats || []) if (/BUYER_SELLER/i.test(c.chat?.chat_type) && c.unread_count > 0) unread.push({ id: c.chat.chat_id, unread: c.unread_count });
          if (!r?.has_next) break;
          cursor = r.cursor;
        }
      });
      let reviews = { available: false };
      try {
        const bySku = Object.fromEntries(stocks.map(s => [s.sku, s]));
        const from = today.slice(0, 4) + '-01-01', list = [];
        let lastId = '';
        for (let page = 0; page < 50; page++) {
          const r = await post('/v1/review/list', { limit: 100, sort_dir: 'DESC', status: 'ALL', ...(lastId ? { last_id: lastId } : {}) });
          const rows = r?.reviews || [];
          for (const x of rows) {
            const date = String(x.published_at || '').slice(0, 10);
            if (date < from || num(x.rating) > 3) continue;
            const p = bySku[String(x.sku)] || {};
            list.push({ id: x.id, sku: String(x.sku), offer: p.code || '', name: p.name || '', rating: num(x.rating), text: String(x.text || '').slice(0, 500), date, status: x.status, answered: num(x.comments_amount) > 0 });
          }
          if (!r?.has_next || !rows.length || String(rows[rows.length - 1].published_at || '').slice(0, 10) < from) break;
          lastId = r.last_id;
        }
        reviews = { available: true, items: list };
      } catch (e) {
        if (e.status !== 403) throw e;
      }
      return { complaints, score: score ? { value: num(score.current_value), past: num(score.past_value) } : null, chats: unread, reviews };
    }, prevData?.feedback || null);

    // Расчёты с Ozon: баланс по дням (/v1/finance/balance) — остаток на начало, начислено, выплачено, остаток на конец.
    // Текущий и прошлый год; прошедшие дни берём из прошлой загрузки, последнюю неделю перечитываем (Ozon дописывает).
    // Новые дни — от сегодняшнего назад, не больше 200 за загрузку.
    const balance = await optional('расчёты с Ozon', async () => {
      const B = { ...(prevData?.balance || {}) };
      const from = (Number(today.slice(0, 4)) - 1) + '-01-01', fresh = addDays(today, -7);
      const todo = [];
      for (let d = today; d >= from; d = addDays(d, -1)) if (!B[d] || d >= fresh) todo.push(d);
      const r2 = v => Math.round(num(v) * 100) / 100;
      for (const d of todo.slice(0, 200)) {
        const t = (await post('/v1/finance/balance', { date_from: d, date_to: d }))?.total || {};
        B[d] = [r2(t.opening_balance?.value), r2(t.accrued?.value), r2((t.payments || []).reduce((a, p) => a + num(p.value), 0)), r2(t.closing_balance?.value)];
      }
      return B;
    }, prevData?.balance || null);

    // Автоархив: товары, которые Ozon сам убрал в архив (долго не было в наличии). Их надо вовремя восстанавливать.
    const archive = await optional('товары в автоархиве', async () => {
      const ids = [];
      let lastId = '';
      for (let page = 0; page < 50; page++) {
        const r = await post('/v3/product/list', { filter: { visibility: 'ARCHIVED' }, limit: 1000, last_id: lastId });
        const items = r?.result?.items || [];
        ids.push(...items.map(i => i.product_id));
        lastId = r?.result?.last_id || '';
        if (!lastId || items.length < 1000) break;
      }
      const out = [];
      for (let i = 0; i < ids.length; i += 1000) {
        const r = await post('/v3/product/info/list', { product_id: ids.slice(i, i + 1000) });
        for (const it of r?.items || []) {
          if (it.is_autoarchived) out.push({ offer: String(it.offer_id), name: it.name || '', sku: it.sku ? String(it.sku) : null, at: String(it.updated_at || '').slice(0, 10) });
        }
      }
      return out;
    }, prevData?.archive || null);

    // Финансы: начисления по дням (/v1/finance/accrual/by-day — замена отключённого /v3/finance/transaction/list).
    // Текущий месяц перечитываем каждый раз, прошлый — в первые 5 дней месяца (Ozon дописывает задним числом),
    // более старые — один раз при подключении, потом берём из прошлой загрузки.
    // FIN_VERSION меняется, когда меняется расчёт агрегатов: тогда месяцы перечитываются заново.
    // Начиная с версии 3 старые месяцы не стираются, а перечитываются постепенно (по ver у месяца) — на экране всё время есть данные.
    // 4 — цена продавца в начислениях умножается на количество штук в заказе; 5 — список компенсаций и декомпенсаций месяца.
    const FIN_VERSION = 5;
    const finFresh = prevData?.fin && prevData.finVersion >= 3;
    const fin = finFresh ? { ...prevData.fin } : {};
    const verOf = m => fin[m]?.ver || 3; // месяцы без пометки посчитаны версией 3 (до поштучной цены)
    // Месяц версии 4 без компенсаций не нужно перечитывать: в нём просто нечего перечислять.
    for (const [m, f] of Object.entries(fin)) if (f.ver === 4 && !f.totals?.compensation) fin[m] = { ...f, ver: FIN_VERSION };
    const historyEmpty = new Set(finFresh ? prevData?.historyEmpty || [] : []); // месяцы истории без начислений
    let accrualTypes = prevData?.accrualTypes || null;
    const buyoutsByMonth = { ...(prevData?.buyouts || {}) };
    await optional('финансовые начисления', async () => {
      if (!accrualTypes) {
        const t = await post('/v1/finance/accrual/types', {});
        accrualTypes = Object.fromEntries((t?.accrual_types || []).map(x => [x.id, x.name]));
      }
      const monthsBack = finFresh ? (D.dayOfMonth(today) <= 5 ? 1 : 0) : Math.min(12, Number(env.OZON_FINANCE_MONTHS) || 3);
      for (let k = monthsBack; k >= 0; k--) {
        const first = D.parse(monthStart(today)); first.setMonth(first.getMonth() - k);
        await loadMonth(D.iso(first).slice(0, 7));
      }
    }, null);

    // Начисления месяца по дням → агрегат + выкупы Ozon. Пустой месяц (продаж ещё не было) запоминается, чтобы не перечитывать.
    // reuseBuyouts — при перечитывании старого месяца берём уже сохранённый отчёт о выкупах (у него очень строгий лимит).
    async function loadMonth(month, reuseBuyouts = false) {
      const from = month + '-01';
      const end = addDays(D.iso(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)), -1);
      const to = end > today ? today : end;
      const accruals = [];
      for (let day = from; day <= to; day = addDays(day, 1)) {
        let lastId = '';
        for (let page = 0; page < 200; page++) {
          const r = await post('/v1/finance/accrual/by-day', lastId ? { date: day, last_id: lastId } : { date: day });
          accruals.push(...(r?.accruals || []));
          lastId = r?.last_id || '';
          if (!lastId) break;
        }
        await sleep(250);
      }
      const agg = aggregate(fromAccruals(accruals, accrualTypes), skuMap);
      // Выкупы Ozon (доставка в другие страны): продажа приходит отдельным отчётом, не в начислениях.
      // Если отчёт не ответил (лимит), берём выкупы прошлой загрузки — без них выручка месяца занижена.
      const fresh = reuseBuyouts && buyoutsByMonth[month] !== undefined ? null : await optional(`выкупы Ozon за ${month}`, () => buyoutReport(from, to), null);
      if (fresh) buyoutsByMonth[month] = fresh;
      const buyouts = buyoutsByMonth[month];
      const mAgg = buyouts?.length ? addBuyouts(agg[month], buyouts) : agg[month];
      if (mAgg) { fin[month] = { ...mAgg, ver: FIN_VERSION }; historyEmpty.delete(month); } else { delete fin[month]; historyEmpty.add(month); }
    }

    // История магазина: за каждую синхронизацию — ещё несколько месяцев назад (лимиты Ozon не дают взять всё сразу),
    // от самого раннего загруженного месяца до месяца первой карточки товара.
    // По старым месяцам разбивка дня по артикулам не хранится — она нужна только для РНП за последние месяцы.
    const shopStart = firstCard || prevData?.shopStart || null;
    const perSync = Number(env.OZON_HISTORY_MONTHS_PER_SYNC) || 6;
    const historyTodo = [];
    if (shopStart && accrualTypes) {
      for (let m = addDays(monthStart(today), -1).slice(0, 7); m >= shopStart; m = addDays(m + '-01', -1).slice(0, 7)) {
        if (!fin[m] && !historyEmpty.has(m)) historyTodo.push(m);
      }
    }
    // Месяцы, посчитанные прежней версией расчёта, — перечитываем первыми, от новых к старым.
    const stale = Object.keys(fin).filter(m => verOf(m) < FIN_VERSION).sort().reverse();
    const keepDaySku = addDays(monthStart(today), -190).slice(0, 7);
    for (const m of [...stale, ...historyTodo].slice(0, perSync)) {
      await optional(`история за ${m}`, () => loadMonth(m, true), null);
      if (fin[m] && m < keepDaySku) for (const d of Object.values(fin[m].days || {})) delete d.u;
    }
    const staleLeft = Object.keys(fin).filter(m => verOf(m) < FIN_VERSION).length;

    // Разовая дозагрузка выкупов за уже сохранённые месяцы, где их ещё не было (после обновления дашборда).
    for (const m of Object.keys(fin).sort()) {
      if (buyoutsByMonth[m] !== undefined) continue;
      const from = m + '-01', to = addDays(D.iso(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)), -1);
      const products = await optional(`выкупы Ozon за ${m}`, () => buyoutReport(from, to > today ? today : to), null);
      if (!products) continue;
      buyoutsByMonth[m] = products;
      if (products.length) fin[m] = addBuyouts(JSON.parse(JSON.stringify(fin[m])), products);
    }

    // Отчёты о реализации товаров (/v2/finance/realization) — официальный документ Ozon за месяц, по нему сверяем налоги.
    // Отчёт за прошлый месяц Ozon формирует в первые дни нового месяца; готовые отчёты не меняются — берём один раз.
    // Храним итог по артикулу: [артикул, продано шт, по цене продавца, оплатил покупатель, баллы, партнёры, возвращено шт, …то же по возвратам].
    const realization = { ...(prevData?.realization || {}) };
    await optional('отчёты о реализации', async () => {
      const last = addDays(monthStart(today), -1).slice(0, 7);
      const todo = Object.keys(fin).filter(m => m <= last && !realization[m]).sort().reverse().slice(0, 12);
      for (const m of todo) {
        let r;
        try { r = await post('/v2/finance/realization', { month: Number(m.slice(5, 7)), year: Number(m.slice(0, 4)) }); } catch (e) {
          if (e.status === 400 || e.status === 404) continue; // отчёт ещё не готов
          throw e;
        }
        const R = r?.result || r || {};
        if (!R.header || (m === last && !(R.rows || []).length)) continue;
        realization[m] = compactRealization(R);
        await sleep(500);
      }
    }, null);

    // Доля выплаты от выручки по месяцу (для сводки на Главной): к выплате / продажи без возвратов.
    const share = m => { const t = fin[m]?.totals; const net = t ? t.sales + t.returns : 0; return net > 0 ? { accruals_for_sale: net, other: t.payout - net } : null; };
    const finance = { current: share(today.slice(0, 7)), previous: share(addDays(monthStart(today), -1).slice(0, 7)) };

    const ordered = await optional('заказано по аналитике Ozon', async () => {
      const from = addDays(today, -60);
      const rows = await analytics(from, ['day']);
      if (!rows.length) return null;
      return { from, to: today, days: Object.fromEntries(rows.map(r => [r.dimensions[0].id, num(r.metrics[1])])) };
    }, null);

    return {
      days, skuDays, ordered,
      finance,
      stocks,
      postings: postings || prevData?.postings || [],
      stockTypes: stockTypes || prevData?.stockTypes || [],
      prices: prices || prevData?.prices || [],
      fin, finVersion: FIN_VERSION, skuMap, accrualTypes, warnings, categories, catTree, clusterStocks, returns, feedback,
      shopStart, historyEmpty: [...historyEmpty],
      history: { start: shopStart, loadedFrom: Object.keys(fin).sort()[0] || null, left: Math.max(0, historyTodo.length - Math.max(0, perSync - stale.length)), stale: staleLeft },
      buyouts: Object.fromEntries(Object.entries(buyoutsByMonth).filter(([m]) => fin[m])),
      realization, balance, archive
    };
  }
};

// Отчёт о реализации → номер, дата, период и строки по артикулу. Цена продавца = оплатил покупатель (amount)
// + баллы за скидки (bonus) + программы партнёров (софинансирование банка, ПВЗ, звёзды) — проверено на отчётах за 2026 год.
function compactRealization(R) {
  const H = R.header || {}, by = {}, names = {};
  const part = c => [num(c.quantity), num(c.amount), num(c.bonus), num(c.bank_coinvestment) + num(c.pick_up_point_coinvestment) + num(c.stars)];
  for (const row of R.rows || []) {
    const offer = String(row.item?.offer_id || row.item?.sku || '');
    names[offer] = row.item?.name || offer;
    const o = by[offer] = by[offer] || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const price = num(row.seller_price_per_instance);
    for (const [c, k] of [[row.delivery_commission, 0], [row.return_commission, 5]]) {
      if (!c) continue;
      const [q, a, b, p] = part(c);
      o[k] += q; o[k + 1] += price * q; o[k + 2] += a; o[k + 3] += b; o[k + 4] += p;
    }
  }
  const r2 = v => Math.round(v * 100) / 100;
  return {
    number: String(H.number || ''), date: String(H.doc_date || '').slice(0, 10), from: String(H.start_date || '').slice(0, 10), to: String(H.stop_date || '').slice(0, 10),
    rows: Object.entries(by).map(([offer, v]) => [offer, names[offer], ...v.map(r2)])
  };
}
