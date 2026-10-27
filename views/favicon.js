// Animated browser-tab icon: the Dawnpipe brand mark, alive — the sun rises
// over the horizon when the tab opens, then settles into the logo with a
// gentle shimmer. Same red dawn as /favicon.ico and the search-results icon,
// so the brand is one mark everywhere.
//
// Browsers don't animate SVG favicons, so we draw frames to a canvas and swap
// the icon href on a timer. Zero dependencies, ~2KB, pauses when the tab is
// hidden so it costs nothing in the background.
(function () {
  var S = 64;                       // draw big, browsers downscale cleanly
  var c = document.createElement('canvas'); c.width = c.height = S;
  var x = c.getContext('2d');
  if (!x) return;

  // Swap the tab icon by REPLACING the link element, never by mutating .href
  // on a surviving one. Both matter and both were learned the hard way:
  //   - leaving the static /favicon.svg link in place lets Chrome keep
  //     preferring it (it ranks SVG highest when several are declared), so the
  //     tab shows a still image no matter what we draw;
  //   - mutating .href on an existing link is frequently ignored outright, so
  //     the frames advance in the DOM while the painted icon never changes.
  // Clearing every icon link and appending a fresh one each frame leaves
  // nothing to prefer and forces the repaint. The markup keeps its static
  // <link>s for crawlers and no-JS contexts; they only come out once this
  // script is actually running.
  function setIcon(href) {
    var stale = document.querySelectorAll("link[rel~='icon'], link[rel='shortcut icon']");
    for (var i = 0; i < stale.length; i++) stale[i].parentNode.removeChild(stale[i]);
    var l = document.createElement('link');
    l.rel = 'icon';
    l.type = 'image/png';
    l.href = href;
    document.head.appendChild(l);
  }

  var RED = '#c02a1b', CREAM = '#fbfaf6';
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

  // Geometry mirrors the static mark: sun r=15 centered x=32 sitting on a
  // rounded horizon bar at y=37.
  var BAR_Y = 37, BAR_H = 5.5, SUN_R = 15, SUN_X = 32;
  var RISE_FRAMES = 26;             // ~3.4s sunrise on tab open

  function frame() {
    // Ease-out rise from fully below the horizon to the logo position, then
    // hold there — dawn happens once; it does not undo itself.
    var p = Math.min(t / RISE_FRAMES, 1);
    p = 1 - (1 - p) * (1 - p);      // easeOutQuad
    var cy = BAR_Y + (SUN_R + 2) * (1 - p);

    x.clearRect(0, 0, S, S);
    x.fillStyle = RED; rr(0, 0, S, S, 13); x.fill();

    // sun disc...
    x.fillStyle = CREAM;
    x.beginPath(); x.arc(SUN_X, cy, SUN_R, 0, 6.284); x.fill();
    // ...hidden below the horizon line (the ground swallows it)
    x.fillStyle = RED;
    x.fillRect(0, BAR_Y, S, S - BAR_Y);
    // the horizon bar itself
    x.fillStyle = CREAM;
    rr(10, BAR_Y, 44, BAR_H, BAR_H / 2); x.fill();

    // Once risen: a slow shimmer of rays, breathing on a ~4s cycle. Subtle on
    // purpose — the tab should read as the logo, not as an alert.
    if (p >= 1) {
      var breathe = (Math.sin((t - RISE_FRAMES) / 15 * Math.PI) + 1) / 2;   // 0..1
      x.strokeStyle = 'rgba(251,250,246,' + (0.25 + breathe * 0.45).toFixed(2) + ')';
      x.lineWidth = 2; x.lineCap = 'round';
      for (var a = -150; a <= -30; a += 30) {
        var rad = a * Math.PI / 180;
        var r0 = SUN_R + 3 + breathe * 1.5, r1 = r0 + 4;
        x.beginPath();
        x.moveTo(SUN_X + Math.cos(rad) * r0, BAR_Y + Math.sin(rad) * r0);
        x.lineTo(SUN_X + Math.cos(rad) * r1, BAR_Y + Math.sin(rad) * r1);
        x.stroke();
      }
    }

    try { setIcon(c.toDataURL('image/png')); } catch (e) { stop(); }
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
