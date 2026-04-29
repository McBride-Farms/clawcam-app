const state = {
  events: [],
  devices: [],
  filterHost: "",
  sinceHours: 168,
  stream: null,
};

const view = document.getElementById("view");
const liveDot = document.getElementById("live-dot");
const liveText = document.getElementById("live-text");

function fmtTime(epoch) {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString();
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function cssToken(v) {
  return String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "");
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function boxMarkup(p, tx = 6, ty = 22) {
  const left = num(p.left);
  const top = num(p.top);
  const right = num(p.right);
  const bottom = num(p.bottom);
  const w = Math.max(0, right - left);
  const h = Math.max(0, bottom - top);
  const score = num(p.score);
  const label = `${p.class ?? ""} ${(score * 100).toFixed(0)}%`;
  return `<g><rect x="${left}" y="${top}" width="${w}" height="${h}"/><text x="${left + tx}" y="${top + ty}">${esc(label)}</text></g>`;
}

function setAuthToken(token) {
  localStorage.setItem("clawcam_token", token);
  document.cookie = `clawcam_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
}

function getAuthToken() {
  return localStorage.getItem("clawcam_token") || "";
}

async function api(path) {
  const headers = {};
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(path, { headers, credentials: "same-origin" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function route() {
  const hash = location.hash || "#/events";
  document.querySelectorAll(".nav a").forEach((a) => {
    a.classList.toggle("active", hash.startsWith("#/" + a.dataset.route));
  });
  const [_, page, arg] = hash.split("/");
  if (page === "event" && arg) return renderDetail(decodeURIComponent(arg));
  if (page === "devices") return renderDevices();
  if (page === "settings") return renderSettings();
  if (page === "live") return renderLive();
  return renderEvents();
}

let liveState = { hlsInstances: [], pollTimer: null, tiles: new Map(), cfg: null };

function sendPtz(host, body) {
  // Fire-and-forget — never block the UI on the network round-trip. The
  // device returns 200 immediately after writing the initial VISCA byte
  // (clawcam ≥ 0.5.6), but even with a slow link we don't want d-pad
  // press/release to feel laggy.
  fetch(`/api/devices/${encodeURIComponent(host)}/ptz`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  }).catch(() => {});
}

function wireTilePtz(tile, host) {
  // Home is a one-shot click; every other button is press-and-hold.
  // While held: fire a short burst, then re-fire it at REISSUE_MS intervals
  // so the motor stays running. On release: explicit stop. If the release
  // gets dropped by the network, the motor's own auto-stop kicks in after
  // BURST_MS — kept short so we don't over-pan when stop is lost. Each new
  // burst aborts the prior one server-side (clawcam ≥ 0.5.6), so BURST_MS
  // just needs a small safety margin over REISSUE_MS.
  const BURST_MS = 400;
  const REISSUE_MS = 250;

  const bodyFor = (action) => {
    switch (action) {
      case "up":       return { tilt: +1, duration_ms: BURST_MS };
      case "down":     return { tilt: -1, duration_ms: BURST_MS };
      case "left":     return { pan: -1,  duration_ms: BURST_MS };
      case "right":    return { pan: +1,  duration_ms: BURST_MS };
      case "zoom-in":  return { zoom: +1, duration_ms: BURST_MS };
      case "zoom-out": return { zoom: -1, duration_ms: BURST_MS };
      default: return null;
    }
  };

  tile.querySelectorAll(".ptz button[data-ptz]").forEach((b) => {
    const action = b.dataset.ptz;

    if (action === "home") {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        sendPtz(host, { home: true });
      });
      return;
    }

    const body = bodyFor(action);
    if (!body) return;

    let activePointer = null;
    let reissueTimer = null;

    const start = (e) => {
      if (activePointer !== null) return;
      e.preventDefault();
      e.stopPropagation();
      activePointer = e.pointerId;
      b.setPointerCapture?.(e.pointerId);
      b.classList.add("active");
      sendPtz(host, body);
      reissueTimer = setInterval(() => sendPtz(host, body), REISSUE_MS);
    };
    const stop = (e) => {
      if (activePointer === null) return;
      activePointer = null;
      if (reissueTimer) { clearInterval(reissueTimer); reissueTimer = null; }
      try { b.releasePointerCapture?.(e.pointerId); } catch {}
      b.classList.remove("active");
      sendPtz(host, { stop: true });
    };

    b.addEventListener("pointerdown", start);
    b.addEventListener("pointerup", stop);
    b.addEventListener("pointercancel", stop);
    b.addEventListener("pointerleave", stop);
  });

  wireTileJoystick(tile, host);
}

// Analog-ish pan/tilt via a draggable thumb. The on-device VISCA server
// sustains motion for the full duration_ms, so we just keep issuing fresh
// direction bursts every REISSUE_MS while the user's finger is down and
// fire a stop on release. Direction is quantized to {-1, 0, +1} per axis
// because VISCA drive takes integer direction bytes.
function wireTileJoystick(tile, host) {
  const root = tile.querySelector(".ptz-joystick");
  if (!root) return;
  const base = root.querySelector(".ptz-joystick-base");
  const thumb = root.querySelector(".ptz-joystick-thumb");
  if (!base || !thumb) return;

  const DEADZONE = 0.18;      // fraction of radius before we consider it "off-center"
  const REISSUE_MS = 250;     // re-send the direction burst every N ms while held
  const BURST_MS = 400;       // duration of each burst; must exceed REISSUE_MS so motion is continuous

  let pointerId = null;
  let lastDir = { pan: 0, tilt: 0 };
  let reissueTimer = null;

  function setThumb(dx, dy) {
    thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }
  function resetThumb() {
    thumb.style.transform = "translate(-50%, -50%)";
  }

  function dirFromNormalized(nx, ny) {
    return {
      pan:  Math.abs(nx) < DEADZONE ? 0 : (nx > 0 ? +1 : -1),
      tilt: Math.abs(ny) < DEADZONE ? 0 : (ny > 0 ? -1 : +1), // screen-y grows down, tilt=+1 is up
    };
  }

  function issueBurst(dir) {
    if (dir.pan === 0 && dir.tilt === 0) return;
    sendPtz(host, { pan: dir.pan, tilt: dir.tilt, duration_ms: BURST_MS });
  }

  function stopReissue() {
    if (reissueTimer) { clearInterval(reissueTimer); reissueTimer = null; }
  }

  function onDown(ev) {
    if (pointerId !== null) return;
    pointerId = ev.pointerId;
    base.setPointerCapture?.(pointerId);
    ev.preventDefault();
    ev.stopPropagation();
    onMove(ev);
  }

  function onMove(ev) {
    if (pointerId === null || ev.pointerId !== pointerId) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    let dx = ev.clientX - cx;
    let dy = ev.clientY - cy;
    const dist = Math.hypot(dx, dy);
    const thumbMax = radius * 0.7;
    if (dist > thumbMax) {
      dx = (dx / dist) * thumbMax;
      dy = (dy / dist) * thumbMax;
    }
    setThumb(dx, dy);
    const nx = dx / thumbMax;
    const ny = dy / thumbMax;
    const dir = dirFromNormalized(nx, ny);

    if (dir.pan !== lastDir.pan || dir.tilt !== lastDir.tilt) {
      // Direction changed — fire immediately and reset the reissue cadence.
      lastDir = dir;
      stopReissue();
      if (dir.pan === 0 && dir.tilt === 0) {
        sendPtz(host, { stop: true });
      } else {
        issueBurst(dir);
        reissueTimer = setInterval(() => issueBurst(lastDir), REISSUE_MS);
      }
    }
  }

  function onUp(ev) {
    if (pointerId === null || (ev && ev.pointerId !== pointerId)) return;
    try { base.releasePointerCapture?.(pointerId); } catch {}
    pointerId = null;
    resetThumb();
    stopReissue();
    if (lastDir.pan !== 0 || lastDir.tilt !== 0) {
      sendPtz(host, { stop: true });
    }
    lastDir = { pan: 0, tilt: 0 };
  }

  base.addEventListener("pointerdown", onDown);
  base.addEventListener("pointermove", onMove);
  base.addEventListener("pointerup", onUp);
  base.addEventListener("pointercancel", onUp);
  base.addEventListener("pointerleave", onUp);
}

async function renderLive() {
  stopLive();
  view.innerHTML = "";
  view.appendChild(document.getElementById("tpl-live").content.cloneNode(true));
  const grid = document.getElementById("live-grid");
  const focusBtn = document.getElementById("live-fullscreen");
  const cadenceSel = document.querySelector(".cadence");
  if (cadenceSel) cadenceSel.style.display = "none";

  let devices = [], streams = [], cfg = null;
  try {
    [devices, streams, cfg] = await Promise.all([
      api("/api/devices").then((r) => r.devices).catch(() => []),
      api("/api/streams").then((r) => r.streams).catch(() => []),
      api("/api/config").catch(() => ({ hls_base: `${location.origin.replace(/:\d+$/, "")}:8888` })),
    ]);
  } catch {}
  liveState.cfg = cfg;

  if (!devices.length) {
    grid.innerHTML = `<div class="empty-state">No devices yet. Register a camera to watch it here.</div>`;
    return;
  }

  const streamByName = new Map(streams.map((s) => [s.name, s]));
  liveState.tiles.clear();

  for (const d of devices) {
    const name = d.name || d.host;
    const stream = streamByName.get(name);
    const tile = el(`
      <div class="live-tile" data-host="${esc(d.host)}" data-name="${esc(name)}">
        <video muted autoplay playsinline></video>
        <img class="snapshot" alt="last snapshot" hidden>
        <div class="ph" hidden>offline</div>
        <svg class="overlay" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
        <div class="label"><span class="dot dead"></span><span>${esc(name)}</span></div>
        <div class="age">—</div>
        <div class="ptz" data-stop-focus title="Pan / Tilt / Zoom">
          <div class="ptz-joystick" aria-label="Pan/tilt joystick">
            <div class="ptz-joystick-base">
              <div class="ptz-joystick-thumb"></div>
            </div>
            <button class="ptz-home ptz-joystick-home" data-ptz="home" title="Re-center">⌂</button>
          </div>
          <div class="ptz-dpad">
            <button class="ptz-empty" tabindex="-1"></button>
            <button data-ptz="up" title="Tilt up">▲</button>
            <button class="ptz-empty" tabindex="-1"></button>
            <button data-ptz="left" title="Pan left">◀</button>
            <button class="ptz-home" data-ptz="home" title="Re-center">⌂</button>
            <button data-ptz="right" title="Pan right">▶</button>
            <button class="ptz-empty" tabindex="-1"></button>
            <button data-ptz="down" title="Tilt down">▼</button>
            <button class="ptz-empty" tabindex="-1"></button>
          </div>
          <div class="ptz-zoom">
            <button data-ptz="zoom-in" title="Zoom in">+</button>
            <span class="ptz-z-label">zoom</span>
            <button data-ptz="zoom-out" title="Zoom out">−</button>
          </div>
        </div>
      </div>
    `);
    tile.addEventListener("click", (e) => {
      if (e.target.closest("[data-stop-focus]")) return;
      document.querySelectorAll(".live-tile").forEach((t) => t.classList.remove("focus"));
      tile.classList.toggle("focus");
    });
    if (d.has_ptz) {
      wireTilePtz(tile, d.host);
    } else {
      tile.querySelector(".ptz")?.remove();
    }
    grid.appendChild(tile);
    liveState.tiles.set(name, { tile, device: d, hls: null, live: false });
    applyTileStream(name, stream);
  }

  focusBtn.onclick = () => {
    const first = grid.querySelector(".live-tile");
    if (first) first.classList.toggle("focus");
  };

  // Poll streams list so cameras reattach automatically when they come back.
  const tick = async () => {
    try {
      const { streams } = await api("/api/streams");
      const byName = new Map(streams.map((s) => [s.name, s]));
      for (const [name] of liveState.tiles) applyTileStream(name, byName.get(name));
    } catch {}
  };
  liveState.pollTimer = setInterval(tick, 5000);
}

function applyTileStream(name, stream) {
  const entry = liveState.tiles.get(name);
  if (!entry) return;
  const { tile, device } = entry;
  const video = tile.querySelector("video");
  const snap = tile.querySelector(".snapshot");
  const ph = tile.querySelector(".ph");
  const dot = tile.querySelector(".label .dot");
  const age = tile.querySelector(".age");

  if (stream?.ready) {
    if (entry.live) return; // already attached
    entry.live = true;
    snap.hidden = true; ph.hidden = true; video.hidden = false;
    const hlsUrl = `${liveState.cfg.hls_base}/${encodeURIComponent(name)}/index.m3u8`;
    const whepUrl = liveState.cfg.webrtc_base
      ? `${liveState.cfg.webrtc_base}/${encodeURIComponent(name)}/whep`
      : null;
    const player = attachLiveStream(video, { hlsUrl, whepUrl },
      () => {
        dot.classList.remove("dead", "reconnecting");
        age.textContent = entry.transport === "webrtc" ? "live · rtc" : "live";
        age.classList.remove("reconnecting");
      },
      () => {
        dot.classList.add("reconnecting");
        dot.classList.remove("dead");
        age.textContent = "reconnecting…";
        age.classList.add("reconnecting");
      },
      (transport) => { entry.transport = transport; });
    entry.hls = player;
  } else {
    if (entry.live) {
      try { entry.hls?.destroy?.(); } catch {}
      entry.hls = null; entry.live = false;
    }
    video.hidden = true;
    dot.classList.add("dead");
    age.textContent = "offline";
    // Try live JPEG (frame proxy). If that fails, show last event snapshot.
    const jpegUrl = `/api/devices/${encodeURIComponent(device.host)}/latest.jpg?t=${Date.now()}`;
    snap.hidden = false; ph.hidden = true;
    snap.onload = () => { age.textContent = "jpeg"; ph.hidden = true; };
    snap.onerror = () => {
      snap.onerror = null;
      snap.onload = null;
      loadLastSnapshot(device, snap, ph, age);
    };
    snap.src = jpegUrl;
  }
}

async function loadLastSnapshot(device, imgEl, phEl, ageEl) {
  try {
    const { events } = await api(`/api/events?host=${encodeURIComponent(device.host)}&limit=1`);
    const withImage = events.find((e) => e.image_file);
    if (withImage) {
      imgEl.src = `/media/${encodeURIComponent(withImage.image_file)}`;
      imgEl.hidden = false;
      phEl.hidden = true;
      ageEl.textContent = `last ${fmtTime(withImage.started_epoch)}`;
      return;
    }
  } catch {}
  imgEl.hidden = true;
  phEl.hidden = false;
  phEl.textContent = "offline · no snapshot";
  ageEl.textContent = "offline";
}

function attachLiveStream(video, urls, onPlay, onFail, onTransport) {
  // Tries WebRTC (WHEP against MediaMTX) first for sub-second latency, falls
  // back to HLS on failure. Wraps both with exponential backoff reconnection
  // so a transient stream blip recovers on its own. Returns a handle with
  // destroy() that closes the active player and stops the retry loop.
  const applyAspect = () => {
    const tile = video.closest(".live-tile");
    if (!tile || !video.videoWidth || !video.videoHeight) return;
    const ratio = video.videoWidth / video.videoHeight;
    tile.classList.toggle("portrait", ratio < 1);
    video.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  };
  video.addEventListener("loadedmetadata", applyAspect);
  video.addEventListener("resize", applyAspect);

  let pc = null;
  let hls = null;
  let retryTimer = null;
  let retryDelayMs = 1000;
  let stopped = false;
  // Once WebRTC has succeeded once, prefer it on reconnect. If the first
  // attempt fails, "stick" to HLS so we don't burn time retrying a broken
  // path on every backoff cycle.
  let mode = urls.whepUrl ? "webrtc" : "hls";
  let webrtcEverWorked = false;

  const cleanup = () => {
    try { pc?.close?.(); } catch {}
    try { hls?.destroy?.(); } catch {}
    pc = null;
    hls = null;
  };

  const fail = () => {
    if (stopped) return;
    onFail();
    cleanup();
    clearTimeout(retryTimer);
    if (mode === "webrtc" && !webrtcEverWorked && urls.hlsUrl) {
      // First WebRTC attempt failed → fall through to HLS immediately,
      // no backoff, so the user sees video as fast as possible.
      mode = "hls";
      attach();
      return;
    }
    retryTimer = setTimeout(() => {
      if (stopped) return;
      retryDelayMs = Math.min(retryDelayMs * 2, 15000);
      attach();
    }, retryDelayMs);
  };

  const attachWebrtc = async () => {
    onTransport?.("webrtc");
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (ev) => {
      if (ev.streams && ev.streams[0] && video.srcObject !== ev.streams[0]) {
        video.srcObject = ev.streams[0];
      }
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc?.iceConnectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") fail();
    };

    const localPc = pc;
    const setupTimeout = setTimeout(() => {
      if (pc === localPc) fail();
    }, 5000);

    try {
      const offer = await localPc.createOffer();
      await localPc.setLocalDescription(offer);
      // Wait briefly for ICE host candidates to gather; on LAN this is fast.
      await new Promise((resolve) => {
        if (localPc.iceGatheringState === "complete") return resolve();
        const handler = () => {
          if (localPc.iceGatheringState === "complete") {
            localPc.removeEventListener("icegatheringstatechange", handler);
            resolve();
          }
        };
        localPc.addEventListener("icegatheringstatechange", handler);
        setTimeout(resolve, 1500); // proceed even if gathering stalls
      });
      if (stopped || pc !== localPc) return;
      const resp = await fetch(urls.whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: localPc.localDescription.sdp,
      });
      if (!resp.ok) throw new Error(`whep ${resp.status}`);
      const answerSdp = await resp.text();
      if (stopped || pc !== localPc) return;
      await localPc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      const onLoaded = () => {
        clearTimeout(setupTimeout);
        retryDelayMs = 1000;
        webrtcEverWorked = true;
        onPlay();
      };
      video.addEventListener("loadeddata", onLoaded, { once: true });
      video.play().catch(() => {}); // muted autoplay should succeed
    } catch (e) {
      clearTimeout(setupTimeout);
      console.warn("webrtc attach failed, falling back to HLS:", e);
      fail();
    }
  };

  const attachHlsInner = () => {
    onTransport?.("hls");
    if (window.Hls && window.Hls.isSupported()) {
      hls = new Hls({ liveDurationInfinity: true, lowLatencyMode: true });
      hls.loadSource(urls.hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () =>
        video.play().then(() => {
          retryDelayMs = 1000;
          onPlay();
        }).catch(fail)
      );
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) fail(); });
      liveState.hlsInstances.push(hls);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = urls.hlsUrl;
      video.addEventListener("loadeddata", () => { retryDelayMs = 1000; onPlay(); });
      video.addEventListener("error", fail);
    } else {
      fail();
    }
  };

  const attach = () => {
    if (stopped) return;
    cleanup();
    // srcObject from a prior WebRTC session would mask a fresh HLS attach.
    if (video.srcObject) { try { video.srcObject = null; } catch {} }
    if (mode === "webrtc" && urls.whepUrl) {
      attachWebrtc();
    } else {
      attachHlsInner();
    }
  };

  attach();

  return {
    destroy: () => {
      stopped = true;
      clearTimeout(retryTimer);
      cleanup();
      if (video.srcObject) { try { video.srcObject = null; } catch {} }
    },
  };
}

function stopLive() {
  // Destroy per-tile player handles (closes RTCPeerConnections too).
  for (const entry of liveState.tiles?.values() ?? []) {
    try { entry.hls?.destroy?.(); } catch {}
    entry.hls = null;
    entry.live = false;
  }
  // Defensive: any raw Hls.js instances pushed by attachLiveStream's HLS path.
  for (const h of liveState.hlsInstances) {
    try { h.destroy(); } catch {}
  }
  liveState.hlsInstances = [];
  if (liveState.pollTimer) clearInterval(liveState.pollTimer);
  liveState.pollTimer = null;
  liveState.tiles?.clear();
}


async function renderEvents() {
  view.innerHTML = "";
  view.appendChild(document.getElementById("tpl-events").content.cloneNode(true));
  const hostSel = document.getElementById("filter-host");
  const sinceSel = document.getElementById("filter-since");
  document.getElementById("refresh").onclick = () => loadEvents();
  hostSel.addEventListener("change", () => {
    state.filterHost = hostSel.value;
    loadEvents();
  });
  sinceSel.addEventListener("change", () => {
    state.sinceHours = parseInt(sinceSel.value, 10);
    loadEvents();
  });
  sinceSel.value = String(state.sinceHours);
  await loadDeviceOptions(hostSel);
  await loadEvents();
}

async function loadDeviceOptions(sel) {
  const { devices } = await api("/api/devices");
  state.devices = devices;
  sel.innerHTML = `<option value="">All devices</option>` +
    devices.map((d) => `<option value="${esc(d.host)}" ${d.host === state.filterHost ? "selected" : ""}>${esc(d.name || d.host)}</option>`).join("");
}

async function loadEvents() {
  const params = new URLSearchParams();
  if (state.filterHost) params.set("host", state.filterHost);
  params.set("since_hours", String(state.sinceHours));
  params.set("limit", "100");
  const { events } = await api(`/api/events?${params}`);
  state.events = events;
  renderEventList();
}

function renderEventList() {
  const list = document.getElementById("events-list");
  if (!list) return;
  if (!state.events.length) {
    list.innerHTML = `<div class="empty-state">No events yet. Point a clawcam webhook at this server to see detections here.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const e of state.events) list.appendChild(eventCard(e));
}

function eventCard(e) {
  const classes = (e.classes || "").split(",").filter(Boolean);
  const card = el(`
    <a href="#/event/${encodeURIComponent(e.event_id)}" class="event">
      ${e.image_file
        ? `<img class="thumb" src="/media/${encodeURIComponent(e.image_file)}" alt="event" loading="lazy">`
        : `<div class="thumb empty">(no image)</div>`}
      <div class="meta">
        <div class="row1">
          <span class="host" title="${esc(e.host)}">${esc(e.host)}</span>
          <span class="status-pill ${cssToken(e.status)}">${esc(e.status)}</span>
        </div>
        <div class="when">${fmtTime(e.started_epoch)}${e.duration_secs ? ` · ${e.duration_secs.toFixed(1)}s` : ""}</div>
        <div class="classes">${classes.map((c) => `<span class="tag">${esc(c)}</span>`).join("") || `<span class="mute">—</span>`}</div>
      </div>
    </a>
  `);
  return card;
}

async function renderDetail(id) {
  view.innerHTML = "";
  const node = document.getElementById("tpl-detail").content.cloneNode(true);
  view.appendChild(node);
  const body = document.getElementById("detail-body");
  body.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const { event, phases } = await api(`/api/events/${encodeURIComponent(id)}`);
    body.innerHTML = "";
    const startPayload = phases.find((p) => p.phase === "start")?.payload;
    const endPayload = phases.find((p) => p.phase === "end")?.payload;
    const preFiles = (startPayload?.pre_frame_files) || [];
    const tracks = (endPayload?.tracks || startPayload?.tracks || []);

    if (event.image_file) {
      const wrap = el(`<div class="hero-wrap"></div>`);
      const img = el(`<img class="hero" src="/media/${encodeURIComponent(event.image_file)}" alt="event">`);
      const svg = el(`<svg class="hero-overlay" preserveAspectRatio="none"></svg>`);
      wrap.appendChild(img);
      wrap.appendChild(svg);
      body.appendChild(wrap);
      const preds = startPayload?.predictions || [];
      const drawBoxes = () => {
        const W = img.naturalWidth || 1920;
        const H = img.naturalHeight || 1080;
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        svg.innerHTML = preds.map((p) => boxMarkup(p)).join("");
      };
      if (img.complete) drawBoxes(); else img.addEventListener("load", drawBoxes, { once: true });
    }

    body.appendChild(el(`
      <div class="meta-grid">
        <div class="k">Device</div><div>${esc(event.host)}</div>
        <div class="k">Started</div><div>${new Date(event.started_epoch * 1000).toLocaleString()}</div>
        <div class="k">Duration</div><div>${event.duration_secs ? event.duration_secs.toFixed(1) + "s" : "—"}</div>
        <div class="k">Status</div><div>${esc(event.status)}</div>
        <div class="k">Event ID</div><div><code>${esc(event.event_id)}</code></div>
      </div>
    `));

    if (event.clip_file) {
      body.appendChild(el(`<h2>Clip</h2>`));
      const vidWrap = el(`<div class="hero-wrap clip-wrap"></div>`);
      const vid = el(`<video controls playsinline preload="metadata" src="/media/${encodeURIComponent(event.clip_file)}"></video>`);
      const vsvg = el(`<svg class="hero-overlay" preserveAspectRatio="none"></svg>`);
      vidWrap.appendChild(vid);
      vidWrap.appendChild(vsvg);
      body.appendChild(vidWrap);

      const clipPreds = endPayload?.clip_predictions || [];
      if (clipPreds.length) {
        // Sort by t (should already be, but be defensive)
        clipPreds.sort((a, b) => a.t - b.t);
        const drawAt = (t) => {
          // nearest sample within 0.6s window
          let sample = null, bestDiff = Infinity;
          for (const s of clipPreds) {
            const d = Math.abs(s.t - t);
            if (d < bestDiff) { bestDiff = d; sample = s; }
          }
          const W = vid.videoWidth || 1920;
          const H = vid.videoHeight || 1080;
          vsvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
          if (!sample || bestDiff > 0.6) { vsvg.innerHTML = ""; return; }
          vsvg.innerHTML = (sample.boxes || []).map((p) => boxMarkup(p)).join("");
        };
        vid.addEventListener("timeupdate", () => drawAt(vid.currentTime));
        vid.addEventListener("seeked", () => drawAt(vid.currentTime));
        vid.addEventListener("loadedmetadata", () => drawAt(vid.currentTime || 0));
      }
    }

    if (preFiles.length) {
      body.appendChild(el(`<h2>Pre-detection frames</h2>`));
      const strip = el(`<div class="frame-strip"></div>`);
      for (const f of preFiles) strip.appendChild(el(`<img src="/media/${encodeURIComponent(f)}" loading="lazy">`));
      body.appendChild(strip);
    }

    if (tracks.length) {
      body.appendChild(el(`<h2>Tracks</h2>`));
      for (const t of tracks) {
        body.appendChild(el(`
          <div class="track">
            <span class="cls">${esc(t.class)}</span>
            <span>id=${esc(t.track_id)}</span>
            <span>dur=${(t.duration_secs || 0).toFixed(1)}s</span>
            <span>motion=${(t.movement_px || 0).toFixed(0)}px</span>
            ${t.is_stationary ? `<span>stationary</span>` : ""}
          </div>
        `));
      }
    }

    body.appendChild(el(`<h2>Phases</h2>`));
    for (const p of phases) {
      const box = el(`
        <div class="phase">
          <div class="ph-title">${esc(p.phase)}${p.detail ? ` · ${esc(p.detail)}` : ""} <span class="mute" style="color:var(--muted); font-weight:normal">${fmtTime(p.epoch)}</span></div>
          <pre></pre>
        </div>
      `);
      box.querySelector("pre").textContent = JSON.stringify(p.payload, null, 2);
      body.appendChild(box);
    }
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Failed to load: ${esc(e.message)}</div>`;
  }
}

async function renderDevices() {
  view.innerHTML = "";
  view.appendChild(document.getElementById("tpl-devices").content.cloneNode(true));
  const list = document.getElementById("devices-list");
  const { devices } = await api("/api/devices");
  if (!devices.length) {
    list.innerHTML = `<div class="empty-state">No devices have reported yet.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const d of devices) {
    list.appendChild(el(`
      <div class="device">
        <div>
          <div class="host">${esc(d.name || d.host)}</div>
          <div class="mute">${esc(d.host)}</div>
        </div>
        <div class="mute">${d.event_count} events</div>
        <div class="mute">first: ${fmtTime(d.first_seen)}</div>
        <div class="mute">last: ${fmtTime(d.last_seen)}</div>
      </div>
    `));
  }
}

function renderSettings() {
  view.innerHTML = "";
  view.appendChild(document.getElementById("tpl-settings").content.cloneNode(true));
  const base = location.origin;
  document.getElementById("hook-url").textContent = `${base}/hooks/clawcam`;
  document.getElementById("stream-url").textContent = `${base}/api/stream`;
  document.getElementById("clawcam-example").textContent =
    `clawcam setup <name> \\
  --webhook ${base}/hooks/clawcam \\
  --webhook-token YOUR_SHARED_TOKEN`;
}

function connectStream() {
  if (state.stream) state.stream.close();
  const es = new EventSource("/api/stream");
  state.stream = es;
  // EventSource auto-reconnects on its own, but we want to distinguish a
  // transient blip from a hard outage. Show "reconnecting…" immediately on
  // error, then escalate to "disconnected" if we can't re-open within 15s.
  let sseConnected = false;
  let sseDisconnectTimer = null;
  es.onopen = () => {
    sseConnected = true;
    if (sseDisconnectTimer) { clearTimeout(sseDisconnectTimer); sseDisconnectTimer = null; }
    liveDot.classList.remove("off", "lost");
    liveDot.classList.add("on");
    liveText.textContent = "live";
  };
  es.onerror = () => {
    sseConnected = false;
    liveDot.classList.add("off");
    liveDot.classList.remove("on");
    liveText.textContent = "reconnecting…";
    if (!sseDisconnectTimer) {
      sseDisconnectTimer = setTimeout(() => {
        if (!sseConnected) {
          liveDot.classList.add("lost");
          liveText.textContent = "disconnected";
        }
      }, 15000);
    }
  };
  es.addEventListener("event", (m) => {
    let data;
    try { data = JSON.parse(m.data); } catch { return; }
    showFlash(data);
    if (location.hash.startsWith("#/events") || !location.hash || location.hash === "#/") {
      loadEvents().catch(() => {});
    }
  });
  es.addEventListener("telemetry", (m) => {
    let data;
    try { data = JSON.parse(m.data); } catch { return; }
    drawOverlay(data);
  });
}

// Telemetry (bboxes) arrives via SSE with no appreciable network delay, but
// the HLS video stream plays ~1–2 s behind real time due to segment buffering.
// If we paint bboxes the moment they arrive, they sit ahead of the video
// frame they describe. We defer each overlay paint by roughly the video's
// live-edge latency so bbox and frame land together.
function drawOverlay(t) {
  if (!t.host || !t.width || !t.height) return;
  const tiles = document.querySelectorAll(".live-tile");
  for (const tile of tiles) {
    const host = tile.dataset.host;
    const name = tile.dataset.name;
    if (t.host !== host && t.host !== name) continue;
    const entry = liveState.tiles.get(name);
    const delayMs = estimateVideoDelayMs(entry);
    if (tile._overlayDelay) clearTimeout(tile._overlayDelay);
    tile._overlayDelay = setTimeout(() => paintOverlay(tile, t), delayMs);
  }
}

function estimateVideoDelayMs(entry) {
  const hls = entry?.hls;
  // hls.js populates `latency` (seconds) for live LL-HLS streams once a few
  // segments have loaded. Before that, fall back to a conservative default
  // tuned for MediaMTX at 2 s segments.
  if (hls && typeof hls.latency === "number" && hls.latency > 0.2) {
    return Math.min(5000, Math.round(hls.latency * 1000));
  }
  return 1400;
}

function paintOverlay(tile, t) {
  const svg = tile.querySelector("svg.overlay");
  if (!svg) return;
  const W = num(t.width);
  const H = num(t.height);
  if (!W || !H) return;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const preds = t.predictions || [];
  svg.innerHTML = preds.map((p) => boxMarkup(p, 4, 14)).join("");
  // Clear the overlay if no fresh paint arrives within 1.5 s.
  if (tile._overlayTimer) clearTimeout(tile._overlayTimer);
  tile._overlayTimer = setTimeout(() => { svg.innerHTML = ""; }, 1500);
}

function showFlash(ev) {
  const existing = document.querySelector(".flash");
  if (existing) existing.remove();
  const f = el(`<div class="flash">new ${esc(ev.phase)} · ${esc(ev.host)}</div>`);
  f.onclick = () => { location.hash = `#/event/${encodeURIComponent(ev.event_id)}`; f.remove(); };
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 5000);
}

window.addEventListener("hashchange", () => { stopLive(); route(); });
route();
connectStream();
