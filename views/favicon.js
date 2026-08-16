// Animated browser-tab icon: a crescent moon over someone asleep while the
// phone rings — the whole product promise in 32 pixels. ("Your pipeline works
// the night shift; you wake up to it.")
//
// Browsers don't animate SVG favicons, so we draw frames to a canvas and swap
// the icon href on a timer. Zero dependencies, ~2KB, pauses when the tab is
// hidden so it costs nothing in the background.
(function () {
  var S = 64;                       // draw big, browsers downscale cleanly
  var c = document.createElement('canvas'); c.width = c.height = S;
  var x = c.getContext('2d');
  if (!x) return;

  // Drop every static icon link before adding ours. Two earlier attempts
  // failed here: reusing the SVG link left type="image/svg+xml" declared
  // against PNG bytes, and merely appending a PNG link let Chrome keep
  // preferring the static SVG (it ranks SVG highest when several are
  // declared). Exactly one icon link, PNG-typed, leaves nothing to prefer.
  // The markup keeps the static <link>s for crawlers and no-JS contexts;
  // they only come out once this script is actually running.
  var stale = document.querySelectorAll("link[rel~='icon'], link[rel='shortcut icon']");
  for (var i = 0; i < stale.length; i++) stale[i].parentNode.removeChild(stale[i]);

  var link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  document.head.appendChild(link);

  var INK = '#151228', PAPER = '#f4f1ea', RED = '#c02a1b', GOLD = '#f0c860';
  var t = 0, timer = null;

  function rr(px, py, w, h, r) {           // rounded rect path
    x.beginPath();
    x.moveTo(px + r, py);
    x.arcTo(px + w, py, px + w, py + h, r);
    x.arcTo(px + w, py + h, px, py + h, r);
    x.arcTo(px, py + h, px, py, r);
    x.arcTo(px, py, px + w, py, r);
    x.closePath();
  }

  function frame() {
    // ring cadence: two quick rings, then a rest — like a real phone
    var cyc = t % 20;
    var ringing = cyc < 3 || (cyc >= 5 && cyc < 8);
    var wob = ringing ? Math.sin(t * 2.4) * 0.30 : 0;   // handset rock
    var pulse = ringing ? (cyc % 3) / 3 : 0;

    // --- night sky ---
    x.clearRect(0, 0, S, S);
    x.fillStyle = INK; rr(0, 0, S, S, 13); x.fill();

    // --- stars ---
    x.fillStyle = 'rgba(244,241,234,.55)';
    [[13, 13, 1.3], [52, 20, 1], [43, 9, 1.1], [9, 30, 1]].forEach(function (s) {
      x.beginPath(); x.arc(s[0], s[1], s[2], 0, 6.284); x.fill();
    });

    // --- crescent moon (top-right): full disc minus an offset disc ---
    x.save();
    x.fillStyle = GOLD;
    x.beginPath(); x.arc(46, 17, 10, 0, 6.284); x.fill();
    x.globalCompositeOperation = 'destination-out';
    x.beginPath(); x.arc(41.5, 14, 9.5, 0, 6.284); x.fill();
    x.restore();

    // --- sleeper: pillow, head, blanket ---
    x.fillStyle = '#2a2547';                       // bed shadow
    rr(6, 42, 52, 17, 5); x.fill();
    x.fillStyle = PAPER;                           // pillow
    rr(9, 40, 15, 10, 4); x.fill();
    x.fillStyle = '#e8b48f';                       // head
    x.beginPath(); x.arc(21, 44, 6.2, 0, 6.284); x.fill();
    x.fillStyle = '#6b5ea8';                       // blanket
    rr(26, 43, 31, 13, 5); x.fill();
    // closed eye
    x.strokeStyle = '#3a2f2a'; x.lineWidth = 1.4; x.lineCap = 'round';
    x.beginPath(); x.arc(23, 43.5, 2.2, 0.15, 2.9); x.stroke();

    // --- zzz drifting up from the sleeper ---
    var zf = (t % 12) / 12;
    x.fillStyle = 'rgba(244,241,234,' + (0.75 - zf * 0.6).toFixed(2) + ')';
    x.font = 'bold 9px system-ui,sans-serif';
    x.fillText('z', 15, 34 - zf * 6);
    x.font = 'bold 7px system-ui,sans-serif';
    x.fillText('z', 10, 29 - zf * 5);

    // --- the phone, ringing on the nightstand ---
    x.save();
    x.translate(45, 34);
    x.rotate(wob);
    // handset body
    x.fillStyle = RED;
    rr(-7.5, -5.5, 15, 11, 3.5); x.fill();
    // screen glow when it rings
    x.fillStyle = ringing ? '#ffe9a8' : '#7a1b12';
    rr(-5.5, -3.5, 11, 7, 2); x.fill();
    x.restore();

    // ring arcs radiating out
    if (ringing) {
      x.strokeStyle = 'rgba(240,200,96,' + (0.95 - pulse * 0.65).toFixed(2) + ')';
      x.lineWidth = 2;
      for (var i = 1; i <= 2; i++) {
        var r = 10 + i * 4.5 + pulse * 3;
        x.beginPath(); x.arc(45, 34, r, -1.15, 1.15); x.stroke();          // right
        x.beginPath(); x.arc(45, 34, r, Math.PI - 1.15, Math.PI + 1.15); x.stroke(); // left
      }
    }

    try { link.href = c.toDataURL('image/png'); } catch (e) { stop(); }
    t++;
  }

  function start() { if (!timer) { frame(); timer = setInterval(frame, 130); } }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // Don't burn cycles in a background tab.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });
  start();
})();
