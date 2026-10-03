(() => {
  'use strict';
  const validMode = value => value === 'api' || value === 'subscription';
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const percent = value => number(value) !== null && value <= 100 ? value : null;
  function quotaPercentages(item = {}) {
    const used = percent(item.usedPercent), suppliedRemaining = percent(item.remainingPercent);
    return { used, remaining: suppliedRemaining === null && used !== null ? 100 - used : suppliedRemaining };
  }
  function quotaBubbleText(subscription={},minutes=300) {
    const item=(subscription.windows||[]).find(w=>w.windowDurationMins===minutes);
    const remaining=item?quotaPercentages(item).remaining:null;
    return (minutes===10080?'每周 ':'')+'剩余 '+(remaining===null?'--':Number(remaining.toFixed(1))+'%');
  }
  function quotaResetText(subscription={}) {
    const credits=subscription.resetCredits, count=credits?.availableCount;
    return '剩余重置 '+(credits?.state==='observed'&&Number.isSafeInteger(count)&&count>=0?count:'--')+' 次';
  }
  function windowText(item) {
    const { used, remaining } = quotaPercentages(item), parts = [];
    if (used !== null) parts.push(`已用 ${used.toFixed(1)}%`);
    if (remaining !== null) parts.push(`剩余 ${remaining.toFixed(1)}%`);
    return (parts.join(' · ') || '额度比例未知') + (item.stale ? '（快照已过期）' : '');
  }
  function tokenText(value) { const n = number(value); return n === null ? '暂无记录' : n.toLocaleString() + ' token'; }
  function quotaLabel(item = {}) {
    const minutes = number(item.windowDurationMins);
    let label = minutes === 300 ? '5 小时额度' : minutes === 10080 ? '每周额度' : typeof item.label === 'string' && !/^(primary|secondary)$/i.test(item.label) ? item.label : '';
    if (!label && minutes > 0) label = minutes % 1440 === 0 ? `${minutes / 1440} 天额度` : minutes % 60 === 0 ? `${minutes / 60} 小时额度` : `${minutes} 分钟额度`;
    label ||= '额度窗口';
    const bucket = String(item.bucketName || item.bucketId || '').trim();
    return bucket && !label.includes(bucket) ? `${bucket} · ${label}` : label;
  }
  function formatDate(value) { if (value === null || value === undefined || value === '') return '未知'; const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString() : '未知'; }
  function subscriptionNotes(sub = {}, error = '') {
    const notes = [], source = sub.sourceLabel || sub.source || sub.query?.source;
    if (source) notes.push('来源：' + ({ 'session-log': '官方额度快照（本机日志）', 'local-session': '官方额度快照（本机日志）', 'local-log': '官方额度快照（本机日志）' }[source] || String(source)));
    else notes.push('来源：未提供');
    const observed = sub.observedAt ?? sub.queriedAt ?? sub.query?.observedAt;
    if (observed !== null && observed !== undefined) notes.push('快照时间：' + formatDate(observed));
    const failure = error || sub.queryError || sub.query?.error || sub.error;
    if (failure) notes.push('读取未完成：' + (typeof failure === 'string' ? failure : failure.message || failure.reason || '暂时无法读取，请刷新重试'));
    if (sub.stale) notes.push('正在显示上次可用数据。');
    return notes;
  }
  function noticeText(value) {
    if (!value || value.notify === false) return '';
    if (value.failureKind === 'high-demand') return '本轮请求未完成：服务繁忙';
    const tokens = number(value.tokens);
    if (value.completionKind === 'failed') return tokens === null ? '本轮未完成 · 用量暂无记录' : '本轮未完成 · 本机已观测 ' + tokenText(tokens);
    if (value.completionKind === 'cancelled') return tokens === null ? '本轮已取消 · 用量暂无记录' : '本轮已取消 · 本机已观测 ' + tokenText(tokens);
    return tokens === null ? '这轮用量暂无记录' : '这轮吃了 ' + tokenText(tokens) + '（本机已观测）';
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { validMode, windowText, tokenText, noticeText, quotaLabel, quotaPercentages, quotaBubbleText, quotaResetText, subscriptionNotes, formatDate };
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const key = 'dshw-account-view';
  let mode = 'subscription', card = null, content = null, root = null, generation = 0, switching = false, latestNotice = null, latestInsights = null, queryError = '';
  let modeButtons = [], status = null, modeRevision = 0;
  try { const saved = localStorage.getItem(key); if (validMode(saved)) mode = saved; } catch {}
  function text(parent, tag, value) { const el = document.createElement(tag); el.textContent = value; parent.append(el); return el; }
  function close() { card?.remove(); card = content = null; }
  function position() {
    if (!card) return;
    const anchor = (root || document).querySelector('.dshwv-img') || document.querySelector('.dshwv-img');
    if (!anchor) return;
    const bounds = anchor.getBoundingClientRect(), width = card.offsetWidth || 280, height = card.offsetHeight || 220;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, bounds.right - width)) + 'px';
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, bounds.top - height - 10 >= 8 ? bounds.top - height - 10 : bounds.bottom + 10)) + 'px';
    if(card.style.left!==left)card.style.left=left;
    if(card.style.top!==top)card.style.top=top;
  }
  function updateButtons() { for (const button of modeButtons) { button.disabled = switching; button.setAttribute('aria-pressed', String(button.dataset.mode === mode)); } for(const el of document.querySelectorAll('[data-account-api]'))el.hidden=mode==='subscription';
    for (const el of document.querySelectorAll('[data-account-subscription]')) el.hidden = mode !== 'subscription';
    document.documentElement.dataset.accountMode = mode;
    if(status)status.textContent = mode === 'subscription' ? '订阅额度' : 'API 余额';
    for (const el of document.querySelectorAll('.whale-mode-description')) el.textContent = mode === 'subscription' ? '查看官方额度快照（本机日志）与 token 用量' : '查看当前 API 余额与消费记录';
    for (const el of document.querySelectorAll('.whale-mode-open')) el.textContent = mode === 'subscription' ? '查看订阅额度 →' : '配置 API 余额 →';
  }
  function followCard(ownCard) {
    if (card !== ownCard) return;
    position(); window.requestAnimationFrame(() => followCard(ownCard));
  }
  function commit(next) {
    if (mode !== next) generation++;
    mode = next; try { localStorage.setItem(key, mode); } catch {}
    close(); latestNotice = null; updateButtons();
    window.dispatchEvent(new CustomEvent('whale-account-view', { detail: { mode } }));
  }
  async function setMode(next) {
    if (!validMode(next) || switching) return false;
    modeRevision++; switching = true; updateButtons(); if (status) status.textContent = '正在保存…';
    try {
      const response = await fetch('/api/display-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next }) });
      if (!response.ok) throw Error('切换失败，请重试');
      const result = await response.json();
      if (result.ok === false || (result.mode || result.displayMode) !== next) throw Error('模式未保存，请重试');
      commit(next); if (status) status.textContent = next === 'subscription' ? '已切换。点击下方按钮查看额度。' : '已切换为 API 余额模式。'; return true;
    } catch (e) { if (status) status.textContent = e.message || '切换失败，请重试'; return false; }
    finally { switching = false; updateButtons(); }
  }
  function renderCard() {
    if (!content || !card) return;
    content.replaceChildren(); const sub = latestInsights?.subscription || {};
    if (!sub.available) text(content, 'p', sub.reason || '暂时没有可用额度，请登录 Codex 订阅账号后刷新。');
    if (!(sub.windows || []).length && sub.available) text(content, 'p', '快照中没有可用额度窗口');
    for (const item of sub.windows || []) {
      const section = text(content, 'section', ''); text(section, 'strong', quotaLabel(item)); text(section, 'p', windowText({ ...item, stale: item.stale || sub.stale }));
      const { used } = quotaPercentages(item);
      if (used !== null) { const meter = document.createElement('progress'); meter.max = 100; meter.value = used; meter.setAttribute('aria-label', quotaLabel(item) + '已用'); section.append(meter); }
      text(section, 'small', '重置：' + formatDate(item.resetsAt));
    }
    for (const note of subscriptionNotes(sub, queryError)) text(content, 'small', note);
    text(content,'small',quotaResetText(sub));
    const tokens = sub.tokens || latestInsights?.tokens || {};
    text(content, 'p', '本机近 7 天：' + tokenText(tokens.total)); text(content, 'p', '本机滚动 5 小时：' + tokenText(tokens.last5Hours));
    if (tokens.complete === false) text(content, 'small', '扫描尚不完整，仅显示部分记录。');
    text(content, 'small', 'token 是本机观测，不包含其他设备，不能用官方百分比换算剩余 token。');
    const notice = noticeText(latestNotice); if (notice) text(content, 'p', notice); position();
  }
  async function refresh(force = true,{resetForce=force}={}) {
    if (mode !== 'subscription') return null;
    const own = ++generation;
    if (content) { content.replaceChildren(); text(content, 'p', '正在读取 Codex 订阅额度快照…'); position(); }
    try {
      const response = await fetch('/api/insights' + (force ? '?refresh=1' + (resetForce ? '' : '&resets=cache') : ''), { cache: 'no-store' }); if (!response.ok) throw Error('暂时无法读取 Codex 订阅额度快照');
      const data = await response.json(); if (own !== generation || mode !== 'subscription') return null;
      latestInsights = data; queryError = data.error || ''; renderCard();
      window.dispatchEvent(new CustomEvent('whale-insights', { detail: data })); return data;
    } catch (e) {
      if (own === generation && mode === 'subscription') {
        queryError = e.message || '读取失败，请稍后重试';
        latestInsights = { ...latestInsights, subscription: { ...latestInsights?.subscription, queryError, stale: true } }; renderCard();
        window.dispatchEvent(new CustomEvent('whale-insights', { detail: latestInsights }));
      }
      return null;
    }
  }
  function toggleBubble(anchorRoot) {
    if (mode !== 'subscription') return false;
    if (card) { close(); return true; }
    root = anchorRoot?.querySelector ? anchorRoot : document;
    card = document.createElement('section'); card.className = 'whale-account-card'; card.setAttribute('aria-label', '会员订阅额度');
    const header = text(card, 'div', ''); header.className = 'whale-account-header'; text(header, 'strong', '会员订阅额度');
    const closeButton = text(header, 'button', '关闭'); closeButton.onclick = close;
    content = text(card, 'div', ''); const refreshButton = text(card, 'button', '刷新'); refreshButton.onclick = refresh;
    document.body.append(card); followCard(card); refresh(); return true;
  }
  function notice(value) {
    if (mode !== 'subscription') return;
    latestNotice = value;
    refresh(true,{resetForce:false});
  }
  function init() {
    const style = document.createElement('style'); style.textContent = `.whale-account-card{position:fixed;z-index:2147483646;width:280px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;padding:14px;border:1px solid #9fcbd5;border-radius:16px;background:#f6fdff;color:#173d48;box-shadow:0 8px 26px #163f4433;font:13px/1.5 system-ui;pointer-events:auto}.whale-account-card p{margin:8px 0}.whale-account-card small{display:block;color:#496873}.whale-account-card progress{width:100%;accent-color:#258b9c}.whale-account-header{display:flex;justify-content:space-between;align-items:center}.whale-account-card button,.whale-account-menu button{cursor:pointer;border:1px solid #9fcbd5;border-radius:8px;padding:5px 9px;background:#fff;color:#173d48}.whale-account-menu{font:12px/1.5 system-ui;padding:5px}.whale-account-menu summary{cursor:pointer}.whale-account-menu button[aria-pressed=true]{background:#237f91;color:white}.whale-account-menu small{display:block;max-width:230px;margin-top:5px}`; document.head.append(style);
    const menu = document.querySelector('.dshwv-menu');
    if (menu) {
      const details = text(menu, 'section', ''); details.className = 'whale-account-menu'; text(details, 'strong', '大肥龙 · 控制面板'); menu.prepend(details);
      const open = text(details, 'button', ''); open.className = 'whale-mode-open'; open.onclick = () => window.dispatchEvent(new Event(mode === 'subscription' ? 'whale-open-insights' : 'whale-open-settings'));
      status = text(details, 'small', ''); status.setAttribute('role', 'status'); updateButtons();
      const view = menu.querySelector('.dshwv-menuview');
      if (view) {
        const rows = [...view.children];
        const groups = ['外观与位置', '声音与气泡', '用量与资源'].map(label => {
          const group = document.createElement('details'); group.className = 'whale-menu-group';
          text(group, 'summary', label); view.append(group); return group;
        });
        groups[0].open = true;
        for (const child of rows) {
          if (child.classList.contains('dshwv-menu-sep')) { child.remove(); continue; }
          const label = child.textContent;
          const index = /音效|音量|气泡|消耗提示|声音/.test(label) ? 1 : /币种|汇率|资源|工坊|API|额度|峰谷/.test(label) ? 2 : 0;
          groups[index].append(child);
        }
      }
    }
    syncMode().then(()=>refresh(false));
    setInterval(syncMode,5000);
    window.addEventListener('resize', position);
    window.addEventListener('whale-mode-changing', close);
  }
  async function syncMode() {
    const revision=modeRevision;
    try{const response=await fetch('/api/display-mode',{cache:'no-store'});if(!response.ok)return false;
      const data=await response.json(),next=data.mode||data.displayMode;
      if(validMode(next)&&!switching&&revision===modeRevision){if(mode!==next)commit(next);return true;}
    }catch{}return false;
  }
  window.WhaleAccountView = { get mode() { return mode; }, get insights() { return latestInsights; }, toggleBubble, refresh, notice, close, setMode, syncMode, quotaLabel, quotaPercentages, quotaBubbleText, quotaResetText, windowText, subscriptionNotes, formatDate };
  // Deferred scripts run at readyState=interactive before the widget creates its menu.
  if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
