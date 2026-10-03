(() => {
  'use strict';
  const key = 'dshw-v3-feedback', events = { press: '按下', release: '松开', success: '完成提示', cancelled: '取消提示', failed: '拥挤失败提示' };
  const defaults = () => ({ version: 2, feel: 'balanced', events: Object.fromEntries(Object.keys(events).map(k => [k, { preset: k === 'press' || k === 'release' || k === 'success' ? 'original' : 'silent', volume: 1, volumeSet: false }])) });
  let settings = defaults(), masterVolume = .9;
  const originalPreviews = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    const oldStock = saved && !saved.version && saved.feel === 'balanced' && Object.keys(events).every(k => saved.events?.[k]?.preset === settings.events[k].preset && saved.events[k].volume === .8 && Object.keys(saved.events[k]).length === 2);
    if (saved && !oldStock) {
      settings.feel = saved.feel || settings.feel;
      for (const k of Object.keys(events)) if (saved.events?.[k]) settings.events[k] = { ...settings.events[k], ...saved.events[k], ...(!saved.version ? { legacyScale: true } : {}) };
    }
  } catch {}
  const clamp = value => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : .9));
  function volume(event, master = masterVolume, override) {
    const cfg = (override || settings).events[event];
    if (!cfg || cfg.preset === 'silent' || !(master > 0)) return 0;
    return cfg.volumeSet ? clamp(cfg.volume) : cfg.legacyScale ? clamp(cfg.volume) * clamp(master) : clamp(master);
  }
  function usesOriginal(event) { return settings.events[event]?.preset === 'original'; }
  function play(event, url, master = 1, override) {
    const cfg = (override || settings).events[event];
    if (!cfg) return false;
    const level = volume(event, master, override);
    if (cfg.preset === 'original' && window.WhaleReferenceAudio) {
      if (override) window.WhaleReferenceAudio.markPreview(true);
      try { const audio = window.WhaleReferenceAudio.sound(url); audio.volume = level; audio.play().catch(() => {}); }
      finally { if (override) window.WhaleReferenceAudio.markPreview(false); }
    } else window.WhaleAudio.play({ channel: override ? 'preview' : event === 'press' || event === 'release' ? 'gesture' : 'notice', url, preset: cfg.preset, volume: level });
    return true;
  }
  function open() {
    const draft = JSON.parse(JSON.stringify(settings)), dialog = document.createElement('dialog'); dialog.className = 'whale-v3-dialog';
    const title = document.createElement('h2'); title.textContent = '音效、提示与手感'; dialog.append(title);
    const help = document.createElement('p'); help.textContent = '保存后生效；取消或 Esc 放弃修改。默认跟随按压音量，调整下面的滑块后使用独立音量。按压音量为 0 时全部静音。原音效保留原版衔接，音效组完整连播。'; dialog.append(help);
    const feelLabel = document.createElement('label'); feelLabel.textContent = '按压手感'; const feel = document.createElement('select');
    for (const [value, text] of Object.entries({ balanced: '均衡 · 75/140ms', crisp: '清脆 · 65/125ms', soft: '柔和 · 85/155ms' })) feel.add(new Option(text, value));
    feel.value = draft.feel; feel.onchange = () => { draft.feel = feel.value; }; feelLabel.append(feel); dialog.append(feelLabel);
    for (const [event, label] of Object.entries(events)) {
      const row = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = label; row.append(legend);
      const select = document.createElement('select');
      for (const [value, text] of Object.entries({ original: '现有音效', pearl: '珍珠', bubble: '水泡', glass: '风铃', silent: '静音' })) { if (value === 'original' && !['press','release','success'].includes(event)) continue; select.add(new Option(text, value)); }
      select.value = draft.events[event].preset; select.onchange = () => { draft.events[event].preset = select.value; };
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '1'; slider.step = '.01'; slider.value = volume(event, masterVolume, draft); slider.setAttribute('aria-label', label + '音量');
      const number = document.createElement('output'); number.textContent = (!draft.events[event].volumeSet && !draft.events[event].legacyScale ? '跟随 · ' : '') + Math.round(slider.value * 100) + '%';
      slider.oninput = () => { draft.events[event].volume = Number(slider.value); draft.events[event].volumeSet = true; delete draft.events[event].legacyScale; number.textContent = Math.round(slider.value * 100) + '%'; };
      const preview = document.createElement('button'); preview.type = 'button'; preview.textContent = '试听'; preview.onclick = () => {
        if (draft.events[event].preset === 'original' && originalPreviews.has(event)) {
          window.WhaleReferenceAudio?.markPreview(true);
          try { originalPreviews.get(event)(volume(event, masterVolume, draft)); }
          finally { window.WhaleReferenceAudio?.markPreview(false); }
        } else play(event, window.WhaleFeedbackSources?.[event] || '/dsh-whale/sound/press.mp3?set=duck', masterVolume, draft);
      };
      row.append(select, slider, number, preview); dialog.append(row);
    }
    const actions = document.createElement('div'); actions.className = 'dialog-actions';
    const cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.onclick = () => dialog.close();
    const save = document.createElement('button'); save.textContent = '保存'; save.className = 'primary'; save.onclick = () => { try { localStorage.setItem(key, JSON.stringify(draft)); settings = draft; dialog.close(); } catch { window.whaleToast?.('设置未能保存，请检查存储空间。'); } };
    actions.append(cancel, save); dialog.append(actions); dialog.addEventListener('close', () => { window.WhaleAudio.stop('preview'); window.WhaleReferenceAudio?.stopPreview(); dialog.remove(); }); document.body.append(dialog); dialog.showModal();
  }
  window.WhaleFeedback = { play, open, volume, usesOriginal, setPreviewHandler: (event, handler) => { originalPreviews.set(event, handler); }, setMasterVolume: value => { masterVolume = clamp(value); }, get feel() { return settings.feel; } };
})();
