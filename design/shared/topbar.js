/* mapcro shared top bar: the in-game HUD top bar (citadel_hud_top_bar), rebuilt from its layout
   and styles. One implementation for every collection. A page adds
     <div class="tb-host" data-ids data-editable><script type="application/json">{...}</script></div>
   and includes this file. The JSON:
     { "viewer": "amber"|"sapphire",            friendly team on the left (TeamFriendly)
       "clock": 480,                            seconds (Scene.clock)
       "amber": [players], "sapphire": [players] }
   player: { "slot", "name", "hero" (heroes.vdata key without hero_), "initials",
             "souls" (PlayerState.souls), "ult" (PlayerState.ult_cooldown: 0-100 or null),
             "dead", "health" (parity only: 0-1; the board doesn't track health),
             "editing": "souls"|"ult" (shows the in-place editor) }
   Team totals are summed here, never stored. Sizes are Panorama px times --u, where
   --u = host width / 1260 (#TeamsContainer), so the bar scales without reflowing.
   Images come only from ../_art/topbar/topbar.css (git-ignored); CSS shapes stand in without it.
   design/parity/README.md has the spec. */
(function () {
  "use strict";
  var BAR = 1260, TEAM = 528, COL = 88;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // SoulsValue / team_networth: "k" from 1,000, one decimal below 10k, truncated, not rounded
  // (the screenshot shows 44.7k as "44k" and 42.1k as "42k").
  function souls(n, holder) {
    holder.textContent = "";
    if (n == null) { holder.textContent = "–"; return; }
    if (n < 1000) { holder.textContent = String(Math.floor(n)); return; }
    var v = n < 10000 ? (Math.floor(n / 100) / 10).toFixed(1) : String(Math.floor(n / 1000));
    holder.append(document.createTextNode(v), el("span", "demote", "k"));
  }
  function clock(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function player(p, team, side, ids, editable) {
    var c = el("div", "tb-player " + team + " " + side + (p.dead ? " dead" : ""));
    if (ids) c.dataset.dcId = "tb-player-" + p.slot;
    c.title = p.name + (p.hero ? ", " + p.heroName : "");
    // .SoulsValueContainer: behind the portrait, padding-top 20px
    var sv = el("div", "tb-souls" + (p.editing === "souls" ? " editing" : ""));
    var lab = el("span", "tb-souls-value");
    souls(p.souls, lab);
    sv.appendChild(lab);
    if (p.editing === "souls") sv.appendChild(el("i", "tb-caret"));
    if (ids) sv.dataset.dcId = "tb-souls-" + p.slot;
    if (editable) sv.title = "Click to edit souls";
    // CitadelHeroBadge.TopBar: disc + vertical portrait, opacity-masked so the bust spills over the rim
    var badge = el("div", "tb-badge");
    var disc = el("i", "tb-disc", p.initials || "");
    var img = el("i", "tb-img");
    img.classList.add("hero-vertical");   // image: ../_art/topbar/topbar.css on .hero-vertical[data-hero]
    img.dataset.hero = p.hero;
    badge.append(disc, img);
    if (ids) badge.dataset.dcId = "tb-portrait-" + p.slot;
    c.append(sv, badge);
    // #HealthBar: only where health is known (parity). The board has no health field.
    if (p.health != null && !p.dead) {
      var hb = el("div", "tb-health");
      var fill = el("i", "tb-health-fill");
      fill.style.height = (p.health * 100) + "%";
      hb.append(el("i", "tb-health-back"), fill, el("i", "tb-health-border"));
      c.appendChild(hb);
    }
    // .UltimateStatus, driven by PlayerState.ult_cooldown
    var u = p.ult;
    var ult = el("div", "tb-ult");
    if (u == null) ult.classList.add("untracked");
    else if (u <= 0) ult.classList.add("ready");
    else { ult.classList.add("cooldown"); ult.style.setProperty("--left", Math.min(100, u) + "%"); }
    ult.append(el("i", "tb-ult-bg"), el("i", "tb-ult-icon"), el("i", "tb-ult-sweep"), el("i", "tb-ult-fb"));
    if (p.editing === "ult") {
      ult.classList.add("adjusting");
      var h = el("i", "tb-ult-handle");
      h.style.transform = "translate(-50%, -50%) rotate(" + ((u || 0) * 3.6) + "deg) translateY(calc(-14 * var(--u)))";
      ult.append(h, el("b", "tb-ult-pct", u == null ? "untracked" : (u <= 0 ? "ready" : Math.round(u) + "% left")));
    }
    ult.title = u == null ? "Ult not tracked. Drag around the ring or scroll to set it." :
      (u <= 0 ? "Ult ready" : "Ult cooldown " + Math.round(u) + "% left. Drag or scroll to change; click for ready.");
    if (ids) ult.dataset.dcId = "tb-ult-" + p.slot;
    c.appendChild(ult);
    return c;
  }

  function score(team, total, right, ids) {
    var s = el("div", "tb-score " + team + (right ? " right" : ""));
    var bg = el("i", "tb-score-bg");
    var row = el("div", "tb-score-row");
    var lab = el("span", "tb-score-label");
    souls(total, lab);
    var ic = el("i", "tb-team-icon");
    if (right) row.append(ic, lab); else row.append(lab, ic);
    s.append(bg, row);
    if (ids) s.dataset.dcId = "tb-total-" + team;
    return s;
  }

  function mount(host) {
    var src = host.querySelector('script[type="application/json"]');
    if (!src) return;
    var d = JSON.parse(src.textContent);
    var ids = host.hasAttribute("data-ids"), editable = host.hasAttribute("data-editable");
    var friend = d.viewer === "sapphire" ? "sapphire" : "amber", enemy = friend === "amber" ? "sapphire" : "amber";
    var bar = el("div", "tb-bar");
    [[friend, "friend"], [enemy, "enemy"]].forEach(function (t) {
      var team = el("div", "tb-team " + t[1] + " " + t[0]);
      (d[t[0]] || []).forEach(function (p) { team.appendChild(player(p, t[0], t[1], ids, editable)); });
      bar.appendChild(team);
    });
    var center = el("div", "tb-center");
    var ck = el("div", "tb-clock" + (d.editingClock ? " editing" : ""));
    ck.appendChild(el("span", "tb-clock-label", clock(d.clock)));
    if (d.editingClock) ck.appendChild(el("i", "tb-caret"));
    if (ids) ck.dataset.dcId = "tb-clock";
    if (editable) ck.title = "Scene clock. Click to edit.";
    var sum = function (t) { return (d[t] || []).reduce(function (a, p) { return a + (p.souls || 0); }, 0); };
    var scores = el("div", "tb-scores");
    scores.append(score(friend, sum(friend), false, ids), score(enemy, sum(enemy), true, ids));
    center.append(ck, scores);
    bar.appendChild(center);
    host.appendChild(bar);
    host.classList.toggle("editable", editable);
    host.style.setProperty("--u", (host.clientWidth / BAR) + "px");
  }

  document.querySelectorAll(".tb-host").forEach(mount);
})();
