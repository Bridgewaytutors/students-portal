/* Bridgeway results tracker — added to every student page by the admin console.
 *
 * Sends each finished game (score + what the student got wrong) to the tutor's
 * Google Sheet. The Sheet's web-app address lives in assets/results-config.json;
 * if that file is missing, this script does nothing.
 *
 * Automatic mode understands the Bridgeway game template (#stage, #fb, .done-box).
 * Other pages can report directly:
 *   BridgewayResults.manual = true;
 *   BridgewayResults.report({ game: 'Spelling', score: 7, total: 10,
 *     mistakes: [{ q: 'Spell "ocean"', chose: 'oshun', answer: 'ocean' }] });
 */
(function () {
  'use strict';
  if (window.BridgewayResults) return;

  var script = document.currentScript;
  var base = script ? new URL('.', script.src).href : null;
  var match = location.pathname.match(/\/s\/([^/]+)\/?/);
  var student = match ? decodeURIComponent(match[1]) : null;
  var QUEUE_KEY = 'bw-results-queue';
  var endpoint = null;
  var flushing = false;

  var api = { manual: false, report: report };
  window.BridgewayResults = api;

  var ready = base
    ? fetch(base + 'results-config.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (c) { endpoint = c && typeof c.endpoint === 'string' && /^https:\/\//.test(c.endpoint) ? c.endpoint : null; })
        .catch(function () {})
    : Promise.resolve();

  function readQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; } }
  function writeQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-50))); } catch (e) { /* storage blocked */ } }

  function send(p) {
    return fetch(endpoint, {
      method: 'POST', mode: 'no-cors', keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(p),
    }).then(function () { return true; }, function () { return false; });
  }

  async function flush() {
    if (!endpoint || flushing) return;
    flushing = true;
    try {
      var q = readQueue();
      if (!q.length) return;
      writeQueue([]);
      var failed = [];
      for (var i = 0; i < q.length; i++) if (!(await send(q[i]))) failed.push(q[i]);
      if (failed.length) writeQueue(failed.concat(readQueue())); // try again next visit
    } finally { flushing = false; }
  }

  function num(v) { var n = Number(v); return v === null || v === undefined || v === '' || !isFinite(n) ? null : n; }
  function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }

  function report(r) {
    if (!student || !r) return;
    var p = {
      student: student,
      page: clip(document.title, 200),
      at: new Date().toISOString(),
      game: clip(r.game, 200),
      score: num(r.score),
      total: num(r.total),
      missed: (r.missed || []).slice(0, 100).map(function (m) { return clip(m, 300); }),
      mistakes: (r.mistakes || []).slice(0, 100).map(function (m) {
        return { q: clip(m.q, 300), chose: clip(m.chose, 200), answer: clip(m.answer, 200), note: clip(m.note, 300) };
      }),
    };
    writeQueue(readQueue().concat([p]));
    ready.then(flush);
  }

  /* ---------- automatic mode for the Bridgeway game template ---------- */
  function text(el) { return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }

  // The question as the child sees it: everything in the stage except answer buttons,
  // inputs and drawings (e.g. "Work it out… 66,396 + 29,763").
  function questionText(stage) {
    return Array.prototype.filter.call(stage.children, function (c) {
      return !/^(BUTTON|INPUT|svg)$/i.test(c.tagName) && !c.querySelector('button, input') && !c.classList.contains('done-box');
    }).map(text).filter(Boolean).join(' ');
  }

  function auto() {
    var fb = document.getElementById('fb');
    var stage = document.getElementById('stage');
    var title = document.getElementById('gTitle');
    if (!fb || !stage) return;

    var mistakes = [];
    var lastKey = null;
    var reported = new WeakSet();

    // A new game (or "Play again") rewrites the title: start a fresh list.
    if (title) new MutationObserver(function () { mistakes = []; lastKey = null; })
      .observe(title, { childList: true, characterData: true, subtree: true });

    // Wrong answer: remember the question, what was chosen and the right answer.
    new MutationObserver(function () {
      if (api.manual || !/\bbad\b/.test(fb.className) || !text(fb)) return;
      if (stage.querySelector('.timer')) return; // timed rounds: the end-of-game list covers these
      var q = questionText(stage) || text(stage.querySelector('.q'));
      var key = q + '|' + text(fb);
      if (key === lastKey) return;
      lastKey = key;
      var wrongBtn = stage.querySelector('.wrong');
      var input = stage.querySelector('input');
      var rights = Array.prototype.map.call(stage.querySelectorAll('.right'), text).filter(Boolean);
      mistakes.push({
        q: q,
        chose: wrongBtn ? text(wrongBtn) : (input && input.value ? input.value : ''),
        answer: rights.join(', '),
        note: text(fb),
      });
    }).observe(fb, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    // End of a game: send the score and the review list.
    new MutationObserver(function () {
      if (api.manual) return;
      var box = stage.querySelector('.done-box');
      if (!box || reported.has(box)) return;
      reported.add(box);
      var big = text(box.querySelector('.big'));
      var m = big.match(/(\d+)\s*\/\s*(\d+)/) || big.match(/(\d+)/);
      report({
        game: text(title) || document.title,
        score: m ? m[1] : null,
        total: m && m[2] ? m[2] : null,
        missed: Array.prototype.map.call(box.querySelectorAll('.review li'), text),
        mistakes: mistakes,
      });
      mistakes = [];
      lastKey = null;
    }).observe(stage, { childList: true, subtree: true });
  }

  ready.then(flush); // send anything left over from an offline visit
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
})();
