/* mapcro shared minimap: the in-game minimap HUD, rebuilt from the game's HUD sources.
   One implementation for every collection. A page adds
     <div class="mm-host" data-viewpoint="amber|sapphire|neutral" ...>[<svg class="mm-overlay" viewBox="0 0 1000 1000">board layers</svg>]</div>
   and includes minimap-data.js and this file. Attributes:
     data-viewpoint  amber (Amber friendly, bottom), sapphire (Sapphire friendly, map turned 180deg), neutral (spectator tints)
     data-view       "x y w h" in map units (0..1000): zoom or crop; default "0 0 1000 1000"
     data-crop       present: fill the host box with the view, no frame (gesture close-ups)
     data-detail     "lite": terrain, lanes and lane objectives only (thumbnails); no frame
     data-player     present: draw the local player marker at the friendly spawn
     data-ids        present: give markers stable data-dc-id anchors (one map per page)
   Images come only from CSS variables in ../_art/parity/parity.css (git-ignored). Without it
   every layer falls back to CSS shapes. See design/parity/README.md for the spec. */
(function () {
  "use strict";
  var D = window.MAPCRO_MINIMAP;
  if (!D) return;
  var ENEMY = "#DC4C2F", OFFWHITE = "#FFEFD7", TEAM = { amber: "#E7B659", sapphire: "#5B79E6" };
  var LANE = { yellow: "#FFDF40", blue: "#2EC7E6", purple: "#6BB247" };
  var LANE_NAME = { yellow: "west", blue: "mid", purple: "east" };
  var MAP_PX = 360; // #hud_minimap

  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function wash(o, vp) {
    if (vp === "neutral") return TEAM[o.team] || OFFWHITE;
    if (o.team !== vp) return ENEMY;
    if ((o.k === "t1" || o.k === "t2" || o.k === "barracks") && LANE[o.lane]) return LANE[o.lane];
    return OFFWHITE;
  }
  // The image itself is set by ../_art/parity/parity.css on [data-img] (washed: image + own-alpha
  // mask) or [data-pimg] (plain), so no url() ever sits in a custom property.
  function layer(img, w, extra) {
    var i = el("i", w ? "w" : "p");
    i.setAttribute(w ? "data-img" : "data-pimg", img);
    if (w) i.style.setProperty("--wash", w);
    if (extra) i.style.cssText += extra;
    return i;
  }
  function fb(shape, color, k) {
    var b = el("b", "fb " + shape);
    b.style.setProperty("--c", color);
    b.style.setProperty("--k", k);
    return b;
  }
  // One marker: centred at (x, y)% of the map, `px` Panorama px wide on the 360 px map.
  function marker(kind, x, y, px, z, title) {
    var m = el("div", "mk " + kind, { title: title });
    m.style.left = x + "%";
    m.style.top = y + "%";
    m.style.width = m.style.height = (px / MAP_PX * 100) + "%";
    m.style.zIndex = z;
    return m;
  }

  function objectives(vp, lite, ids) {
    var out = [];
    D.objectives.forEach(function (o) {
      if (lite && (o.k === "barracks" || o.k === "shrine")) return;
      var c = wash(o, vp), m, name = LANE_NAME[o.lane] || "";
      var friend = vp === "neutral" ? o.team === "amber" : o.team === vp;
      if (o.k === "t1") {
        m = marker("t1", o.x, o.y, 40, 15, "Guardian (" + o.team + ", " + name + " lane)");
        m.append(fb("diamond", c, 0.34), layer("boss-health", c), layer("boss-health-fill", c));
        if (ids) m.dataset.dcId = "obj-guardian-" + o.team + "-" + name;
      } else if (o.k === "t2") {
        m = marker("t2", o.x, o.y, 64, 15, "Walker (" + o.team + ", " + name + " lane)");
        m.append(fb("diamond", c, 0.4), layer("boss-health-t2", c), layer("boss-health-fill-t2", c));
        if (ids) m.dataset.dcId = "obj-walker-" + o.team + "-" + name;
      } else if (o.k === "barracks") {
        m = marker("barracks", o.x, o.y, 40, 15, "Base guardian (" + o.team + ", " + name + ")");
        m.append(fb("diamond", c, 0.34), layer("boss-health", c), layer("boss-health-fill", c));
      } else if (o.k === "shrine") {
        m = marker("shrine", o.x, o.y, 32, 15, "Shrine (" + o.team + ")");
        m.append(fb("diamond-o", c, 0.4), layer("boss-health-t2", c), layer("boss-health-fill-t2", c));
      } else if (o.k === "t3") {
        var rot = friend ? " transform: rotate(180deg);" : "";
        m = marker("t3", o.x, o.y, 80, 15, "Patron (" + o.team + ")");
        m.append(fb(friend ? "arch-down" : "arch", c, 0.62), layer("boss-health-final", c, rot), layer("boss-health-final-fill", c, rot),
                 layer("boss-health-final-stage2", c), layer("boss-health-final-stage2-fill", c));
        if (ids) m.dataset.dcId = "obj-patron-" + o.team;
      } else if (o.k === "midboss") {
        m = marker("midboss", o.x, o.y, 64, 4, "Mid boss");
        m.append(fb("star", "#d9b24a", 0.5), layer("super-neutral-marker"));
        if (ids) m.dataset.dcId = "mid-boss";
      }
      if (m) out.push(m);
    });
    return out;
  }

  function others(vp, player) {
    var out = [], tiers = { weak: "neutral-small", medium: "neutral-medium", strong: "neutral-large", vaults: "neutral-vault" };
    D.camps.forEach(function (c) {
      if (!tiers[c.t]) return;
      var m = marker("camp", c.x, c.y, 24, 2, "Camp (" + c.t + ")");
      m.append(fb(c.t === "vaults" ? "sq" : "tri", "#9fc6bb", 0.35), layer(tiers[c.t]));
      out.push(m);
    });
    D.shops.forEach(function (s) {
      var m = marker("shop", s.x, s.y, 36, 3, "Shop");
      m.append(fb("sq", "#3fd28a", 0.4), layer("shop", null, " inset: 25%; filter: drop-shadow(0 0 calc(8 * var(--u)) #000);"));
      out.push(m);
    });
    var k = marker("koth", D.koth.x, D.koth.y, 32, 0, "Unstable Rift");
    k.append(fb("dot", "#99FFD6", 0.5), layer("koth", null, " inset: 15%;"));
    out.push(k);
    D.powerups.forEach(function (p) {
      var m = marker("powerup", p.x, p.y, 20, 0, p.kind === "health" ? "Powerup: health" : "Powerup: casting");
      var c = p.kind === "health" ? "#D7FF9A" : "#E1A6FF";
      m.append(fb("dot", c, 0.7), layer(p.kind === "health" ? "powerup-health" : "powerup-magic", c));
      out.push(m);
    });
    if (player && vp !== "neutral") {
      var s = D.spawn[vp], lp = el("div", "mk player", { title: "You (local player marker)" });
      lp.style.left = s.x + "%"; lp.style.top = s.y + "%"; lp.style.width = lp.style.height = "15%"; lp.style.zIndex = 18;
      lp.append(fb("dot", "#3ddc6a", 0.3), layer("player-marker-self", null, " inset: -5%; transform: rotate(-90deg);"),
                layer("player-marker-self-spec", null, " inset: -5%; transform: rotate(-90deg);"));
      if (vp === "sapphire") lp.classList.add("turned");
      out.push(lp);
    }
    return out;
  }

  function lanes(vp) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "lanes");
    svg.setAttribute("viewBox", "0 0 1000 1000");
    svg.setAttribute("aria-hidden", "true");
    // The lane lines are drawn by code on a UICanvas in game: friendly half in the lane colour,
    // enemy half in ColorEnemyObjective. Split at the map's centre line (world y = 0).
    var amberHalf = vp === "neutral" ? null : (vp === "amber" ? "friend" : "enemy");
    [["bottom", "0 500 1000 500"], ["top", "0 0 1000 500"]].forEach(function (half) {
      var g = document.createElementNS(NS, "svg");
      var vb = half[1].split(" ");
      g.setAttribute("x", vb[0]); g.setAttribute("y", vb[1]); g.setAttribute("width", vb[2]); g.setAttribute("height", vb[3]);
      g.setAttribute("viewBox", half[1]);
      var isAmber = half[0] === "bottom";
      D.lanes.forEach(function (l) {
        var p = document.createElementNS(NS, "path");
        p.setAttribute("d", l.d);
        var color;
        if (vp === "neutral") color = isAmber ? TEAM.amber : TEAM.sapphire;
        else color = (isAmber ? amberHalf : (amberHalf === "friend" ? "enemy" : "friend")) === "friend" ? LANE[l.lane] : ENEMY;
        p.setAttribute("stroke", color);
        g.appendChild(p);
      });
      svg.appendChild(g);
    });
    return svg;
  }

  function frame() {
    var f = el("div", "mm-frame");
    f.innerHTML = '<svg class="frame-fb" viewBox="0 0 100 100" aria-hidden="true"><path d="M50 7 a43 43 0 1 1 -0.01 0Z M39 9 a11 11 0 0 1 22 0 M39 91 a11 11 0 0 0 22 0"/></svg><i class="frame-art"></i>';
    return f;
  }

  function mount(host) {
    var vp = host.dataset.viewpoint || "amber";
    var lite = host.dataset.detail === "lite";
    var crop = host.hasAttribute("data-crop");
    var ids = host.hasAttribute("data-ids");
    var view = (host.dataset.view || "0 0 1000 1000").split(/\s+/).map(Number);
    var overlay = [].slice.call(host.querySelectorAll(":scope > .mm-overlay"));
    host.classList.add("vp-" + vp);
    if (lite) host.classList.add("lite");
    if (crop) host.classList.add("mm-crop");
    if (view[2] < 1000) host.classList.add("zoomed");
    if (!lite && !crop) {
      var f = frame();
      if (ids) f.dataset.dcId = "map-frame";
      host.appendChild(f);
    }
    var clip = el("div", "mm-clip"), zoom = el("div", "mm-zoom"), rot = el("div", "mm-rot");
    var terrain = el("i", "terrain", { "data-pimg": "terrain-mid" });
    if (ids) { terrain.dataset.dcId = "map-terrain"; }
    rot.append(terrain, el("i", "mm-shade"), lanes(vp));
    var objs = el("div", "mm-objs");
    if (ids) objs.dataset.dcId = "objectives";
    objectives(vp, lite, ids).forEach(function (m) { objs.appendChild(m); });
    if (!lite) others(vp, host.hasAttribute("data-player")).forEach(function (m) { objs.appendChild(m); });
    rot.appendChild(objs);
    zoom.appendChild(rot);
    overlay.forEach(function (o) { zoom.appendChild(o); });
    clip.appendChild(zoom);
    host.appendChild(clip);
    // Zoom/crop: the map square is sized from the clip box, in px, so markers keep HUD proportions.
    var w = clip.clientWidth || host.clientWidth;
    var size = w * 1000 / view[2];
    zoom.style.width = zoom.style.height = size + "px";
    zoom.style.left = (-view[0] / 1000 * size) + "px";
    zoom.style.top = (-view[1] / 1000 * size) + "px";
    host.style.setProperty("--u", (w / MAP_PX) + "px"); // one Panorama px at the unzoomed size
    host.style.setProperty("--mk-scale", String(view[2] / 1000));
  }

  function icon(host) {
    var kind = host.dataset.mmIcon, c = host.dataset.wash || OFFWHITE;
    var m = el("div", "mk " + kind);
    m.style.left = m.style.top = "50%"; m.style.width = m.style.height = "100%";
    var L = { t1: ["boss-health", "boss-health-fill"], t2: ["boss-health-t2", "boss-health-fill-t2"], t3: ["boss-health-final", "boss-health-final-fill"] }[kind];
    if (L) { m.append(fb(kind === "t3" ? "arch" : "diamond", c, 0.5), layer(L[0], c), layer(L[1], c)); }
    else if (kind === "midboss") m.append(fb("star", "#d9b24a", 0.6), layer("super-neutral-marker"));
    else if (kind === "camp") m.append(fb("tri", "#9fc6bb", 0.5), layer("neutral-medium"));
    else if (kind === "shop") m.append(fb("sq", "#3fd28a", 0.5), layer("shop"));
    else if (kind === "koth") { m.classList.add("koth"); m.append(fb("dot", "#99FFD6", 0.5), layer("koth", null, " inset: 15%;")); }
    host.appendChild(m);
  }

  document.querySelectorAll(".mm-host").forEach(mount);
  document.querySelectorAll("[data-mm-icon]").forEach(icon);
})();
