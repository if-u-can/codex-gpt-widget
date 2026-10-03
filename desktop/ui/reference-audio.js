/*
 * Web Audio sound wrapper adapted from dsh-whale-widget 0.3.18.
 * Copyright (c) 2026 MeteorNOX. Code is distributed under the MIT license;
 * see the accompanying LICENSE and third-party notices. Audio assets retain
 * their original provenance and are not relicensed by this wrapper.
 */
(() => {
  'use strict';
  let ctx = null, idle = null, enabled = () => true, composing = false, previewMark = 0;
  const decoded = new Map(), pending = new Map(), playing = new Set(), previews = new Set();
  const nowMs = () => typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  function isEnabled() { try { return enabled() !== false; } catch { return false; } }
  function suspend() {
    if (idle !== null) { clearTimeout(idle); idle = null; }
    if (ctx && ctx.state === 'running') { try { const p = ctx.suspend(); p?.catch?.(() => {}); } catch {} }
  }
  function audio() {
    if (!isEnabled()) return null;
    try {
      if (!ctx) {
        const Audio = window.AudioContext || window.webkitAudioContext;
        ctx = new Audio({ latencyHint: 'interactive' });
      }
      if (ctx.state === 'suspended') { try { const p = ctx.resume(); p?.catch?.(() => {}); } catch {} }
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => { idle = null; suspend(); }, 60000);
      return ctx;
    } catch { return null; }
  }
  function buffer(url) {
    if (decoded.has(url)) return Promise.resolve(decoded.get(url));
    if (pending.has(url)) return pending.get(url);
    const job = fetch(url, { cache: 'no-store' }).then(response => {
      if (!response.ok) throw Error('音频读取失败');
      return response.arrayBuffer();
    }).then(bytes => {
      if (!bytes || !bytes.byteLength) throw Error('音频内容为空');
      const c = audio();
      if (!c) throw Error('音效已关闭');
      return c.decodeAudioData(bytes);
    }).then(result => { decoded.set(url, result); return result; }).finally(() => pending.delete(url));
    pending.set(url, job);
    return job;
  }
  function warm(urls) {
    if (!isEnabled()) return Promise.resolve([]);
    audio();
    return Promise.allSettled((Array.isArray(urls) ? urls : [urls]).filter(Boolean).map(url => buffer(String(url))));
  }
  function stop(el) {
    el._token++;
    const node = el._node;
    el._node = null;
    el._playingSince = null;
    playing.delete(el);
    if (node) {
      try { node.onended = null; node.stop(); } catch {}
    }
    if (el._gain) { try { el._gain.disconnect(); } catch {} el._gain = null; }
  }
  function stopAll() { for (const el of [...playing]) stop(el); }
  function stopPreview() { for (const el of [...previews]) stop(el); previews.clear(); }
  function markPreview(on) { previewMark = Math.max(0, previewMark + (on === false ? -1 : 1)); }
  function sound(url) {
    const el = {
      preload: 'auto', volume: 1, onended: null, loop: false,
      _url: String(url || ''), _alt: '', _node: null, _gain: null,
      _offset: 0, _token: 0, _playingSince: null, _preview: previewMark > 0,
    };
    if (previewMark > 0) previews.add(el);
    Object.defineProperty(el, 'src', {
      get: () => el._url,
      set(value) { stop(el); el._url = String(value || ''); el._offset = 0; },
    });
    Object.defineProperty(el, 'currentTime', {
      get() {
        if (el._node && el._playingSince !== null) {
          const value = el._offset + (nowMs() - el._playingSince) / 1000;
          const duration = el.duration;
          return Math.max(0, Number.isFinite(duration) && duration > 0 ? Math.min(value, duration) : value);
        }
        return el._offset;
      },
      set(value) { el._offset = Number(value) || 0; stop(el); },
    });
    Object.defineProperty(el, 'duration', {
      get() { const result = decoded.get(el._url); return result && Number.isFinite(result.duration) && result.duration > 0 ? result.duration : NaN; },
    });
    function begin(c, result, delay) {
      try {
        el._gain = c.createGain();
        el._gain.connect(c.destination);
        el._gain.gain.value = Math.max(0, Math.min(1, Number(el.volume) || 0));
        const node = c.createBufferSource();
        node.buffer = result;
        node.connect(el._gain);
        node.onended = () => {
          if (el._node !== node) return;
          el._node = null;
          el._playingSince = null;
          playing.delete(el);
          previews.delete(el);
          if (el._gain) { try { el._gain.disconnect(); } catch {} el._gain = null; }
          if (typeof el.onended === 'function') { try { el.onended(); } catch {} }
        };
        el._node = node;
        el._playingSince = nowMs() + delay * 1000;
        playing.add(el);
        node.start(delay > 0 ? c.currentTime + delay : 0, Math.max(0, el._offset) % Math.max(.001, result.duration));
      } catch { stop(el); }
    }
    function start(delaySec) {
      if (!isEnabled() || !(Number(el.volume) > 0) || !el._url) return Promise.resolve();
      const c = audio();
      if (!c) return Promise.resolve();
      // Replay cancels this element's previous source and decode token only;
      // other sounds are deliberately independent, as in the reference widget.
      stop(el);
      const token = ++el._token;
      const delay = Math.max(0, Number(delaySec) || 0);
      if (el._preview) previews.add(el);
      const cached = decoded.get(el._url);
      if (cached) { begin(c, cached, delay); return Promise.resolve(); }
      const tryUrl = el._url;
      playing.add(el);
      buffer(tryUrl).then(result => {
        if (token !== el._token || !isEnabled()) return;
        begin(c, result, delay);
      }).catch(() => {
        if (token !== el._token) return;
        playing.delete(el);
        if (!el._alt || el._url !== tryUrl || !isEnabled()) return;
        const alt = el._alt;
        el._alt = '';
        el._url = alt;
        warm([alt]);
        start(delay);
      });
      return Promise.resolve();
    }
    el.play = () => start(0);
    el.playAt = delaySec => start(delaySec);
    el.pause = () => stop(el);
    return el;
  }
  function setEnabled(getter) { enabled = typeof getter === 'function' ? getter : () => getter !== false; if (!isEnabled()) { stopAll(); suspend(); } }
  function unlock(event) {
    if (composing || event?.isComposing || event?.keyCode === 229 || !isEnabled()) return;
    audio();
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('compositionstart', () => { composing = true; }, true);
    document.addEventListener('compositionend', () => { composing = false; }, true);
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); });
  }
  window.addEventListener('beforeunload', () => { stopAll(); suspend(); });
  window.WhaleReferenceAudio = Object.freeze({ sound, warm, setEnabled, stopAll, suspend, markPreview, stopPreview });
})();
