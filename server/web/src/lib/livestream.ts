// WebRTC-first live attach helper ported from server/public/app.js
// (attachLiveStream, lines 578-789). Same behaviour:
//
//   1. If a WHEP URL is configured, try WebRTC for sub-second latency.
//   2. On WebRTC failure (first attempt), fall through to HLS immediately
//      so the user sees a frame as fast as possible.
//   3. HLS path probes the ABR master playlist with a HEAD; on 5xx it
//      downgrades to the single-rendition mediamtx URL automatically.
//   4. Exponential backoff (1s → 15s cap) on subsequent failures.
//   5. Exposes setLevel(idx) / setLevelByHeight(h) for the quality picker.
//
// Once WebRTC has succeeded once, the helper sticks to it on reconnect —
// that mirrors the legacy `webrtcEverWorked` guard so a single ICE blip
// doesn't permanently drop us to HLS.
//
// Returns a handle whose `hls` reference is exposed via a callback so the
// telemetry painter in LiveTile can read `hls.latency` for delay timing.

import Hls from "hls.js";

export interface LiveStreamUrls {
  /** Preferred HLS URL — the clawcam-app ABR master (`/api/streams/.../master.m3u8`). */
  hlsUrl: string | null;
  /** Single-rendition fallback (mediamtx direct). Used if the master probe fails. */
  hlsFallbackUrl: string;
  /** WHEP endpoint for WebRTC. `null` disables the WebRTC attempt entirely. */
  whepUrl: string | null;
}

export interface HlsLevel {
  index: number;
  height: number;
  bitrate: number;
}

export interface LevelChange {
  height: number;
  isAuto: boolean;
  isOverride: boolean;
}

export interface QualityCb {
  onLevels?: (levels: HlsLevel[]) => void;
  onLevelChange?: (info: LevelChange) => void;
}

export interface LiveStreamHandle {
  destroy: () => void;
  /** Pin to a specific level index. -1 = auto. No-op on WebRTC / native HLS. */
  setLevel: (idx: number) => void;
  /** Convenience: pin by rendition height (e.g. 720). 0/-1 = auto. */
  setLevelByHeight: (height: number) => void;
  /**
   * Current HLS.js latency in seconds, or `null` if WebRTC / not yet
   * populated. The telemetry painter uses this to delay overlay frames so
   * bboxes land with the matching video frame instead of 1-2s early.
   */
  getLatencySecs: () => number | null;
}

export function attachLiveStream(
  video: HTMLVideoElement,
  urls: LiveStreamUrls,
  onPlay: () => void,
  onFail: () => void,
  onTransport: (t: "webrtc" | "hls") => void,
  qualityCb?: QualityCb,
): LiveStreamHandle {
  // Apply portrait/aspect class on `.live-tile` whenever the video's
  // intrinsic size changes. Matches the original behaviour — found via
  // `video.closest('.live-tile')` so we don't need a separate ref plumbed
  // through.
  const applyAspect = () => {
    const tile = video.closest(".live-tile") as HTMLElement | null;
    if (!tile || !video.videoWidth || !video.videoHeight) return;
    const ratio = video.videoWidth / video.videoHeight;
    tile.classList.toggle("portrait", ratio < 1);
    video.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  };
  video.addEventListener("loadedmetadata", applyAspect);
  video.addEventListener("resize", applyAspect);

  let pc: RTCPeerConnection | null = null;
  let hls: Hls | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = 1000;
  let stopped = false;
  // Once WebRTC has succeeded once, prefer it on reconnect.
  let mode: "webrtc" | "hls" = urls.whepUrl ? "webrtc" : "hls";
  let webrtcEverWorked = false;

  const cleanup = () => {
    try { pc?.close(); } catch {}
    try { hls?.destroy(); } catch {}
    pc = null;
    hls = null;
  };

  const fail = () => {
    if (stopped) return;
    onFail();
    cleanup();
    if (retryTimer) clearTimeout(retryTimer);
    if (mode === "webrtc" && !webrtcEverWorked && urls.hlsUrl) {
      // First WebRTC attempt failed → drop to HLS immediately, no backoff.
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
    onTransport("webrtc");
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (ev) => {
      if (ev.streams && ev.streams[0] && video.srcObject !== ev.streams[0]) {
        video.srcObject = ev.streams[0];
      }
    };
    pc.oniceconnectionstatechange = () => {
      // Only "failed" is terminal; "disconnected" often recovers on its
      // own, "closed" only fires when we tore the PC down ourselves.
      if (pc?.iceConnectionState === "failed") fail();
    };

    const localPc = pc;
    const setupTimeout = setTimeout(() => {
      if (pc === localPc) fail();
    }, 5000);

    try {
      const offer = await localPc.createOffer();
      await localPc.setLocalDescription(offer);
      // Wait briefly for ICE host candidates to gather; on LAN this is fast.
      await new Promise<void>((resolve) => {
        if (localPc.iceGatheringState === "complete") return resolve();
        const handler = () => {
          if (localPc.iceGatheringState === "complete") {
            localPc.removeEventListener("icegatheringstatechange", handler);
            resolve();
          }
        };
        localPc.addEventListener("icegatheringstatechange", handler);
        setTimeout(() => resolve(), 1500); // proceed even if gathering stalls
      });
      if (stopped || pc !== localPc) return;
      if (!urls.whepUrl) throw new Error("no whepUrl");
      const resp = await fetch(urls.whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: localPc.localDescription?.sdp ?? "",
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
      // eslint-disable-next-line no-console
      console.warn("webrtc attach failed, falling back to HLS:", e);
      fail();
    }
  };

  const attachHlsInner = async () => {
    onTransport("hls");
    // Prefer the ABR master playlist; HEAD-probe it first so HLS.js doesn't
    // burn retry cycles against a known-503.
    let chosen: string = urls.hlsUrl ?? urls.hlsFallbackUrl;
    if (
      urls.hlsUrl &&
      urls.hlsFallbackUrl &&
      urls.hlsUrl !== urls.hlsFallbackUrl
    ) {
      try {
        const probe = await fetch(urls.hlsUrl, {
          method: "HEAD",
          signal: AbortSignal.timeout(2000),
        });
        if (!probe.ok) chosen = urls.hlsFallbackUrl;
      } catch {
        chosen = urls.hlsFallbackUrl;
      }
    }
    if (stopped) return;
    if (Hls.isSupported()) {
      hls = new Hls({ liveDurationInfinity: true, lowLatencyMode: true });
      const localHls = hls;
      hls.loadSource(chosen);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (qualityCb?.onLevels) {
          const levels: HlsLevel[] = (localHls.levels || []).map((l, i) => ({
            index: i,
            height: l.height || 0,
            bitrate: l.bitrate || 0,
          }));
          qualityCb.onLevels(levels);
        }
        video
          .play()
          .then(() => {
            retryDelayMs = 1000;
            onPlay();
          })
          .catch(fail);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const lvl = localHls.levels?.[data.level];
        if (!lvl || !qualityCb?.onLevelChange) return;
        qualityCb.onLevelChange({
          height: lvl.height || 0,
          isAuto: !!localHls.autoLevelEnabled,
          isOverride: !localHls.autoLevelEnabled,
        });
      });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) fail();
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = chosen;
      video.addEventListener("loadeddata", () => {
        retryDelayMs = 1000;
        onPlay();
      });
      video.addEventListener("error", fail);
    } else {
      fail();
    }
  };

  const attach = () => {
    if (stopped) return;
    cleanup();
    // srcObject from a prior WebRTC session would mask a fresh HLS attach.
    if (video.srcObject) {
      try { video.srcObject = null; } catch {}
    }
    if (mode === "webrtc" && urls.whepUrl) {
      void attachWebrtc();
    } else {
      void attachHlsInner();
    }
  };

  attach();

  return {
    destroy: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      cleanup();
      if (video.srcObject) {
        try { video.srcObject = null; } catch {}
      }
      video.removeEventListener("loadedmetadata", applyAspect);
      video.removeEventListener("resize", applyAspect);
    },
    setLevel: (idx: number) => {
      if (!hls) return;
      hls.currentLevel = typeof idx === "number" ? idx : -1;
    },
    setLevelByHeight: (height: number) => {
      if (!hls) return;
      if (!height || height < 0) {
        hls.currentLevel = -1;
        return;
      }
      const i = (hls.levels || []).findIndex((l) => l.height === height);
      if (i >= 0) hls.currentLevel = i;
    },
    getLatencySecs: () => {
      if (!hls) return null;
      const latency = (hls as unknown as { latency?: number }).latency;
      return typeof latency === "number" && latency > 0 ? latency : null;
    },
  };
}
