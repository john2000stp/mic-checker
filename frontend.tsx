import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";

const FFT_SIZE = 2048;
const SMOOTHING = 0.8;
const HISTORY_LEN = 60;
const VAD_THRESHOLD_DB = 12;
const VAD_ON_FRAMES = 4;
const VAD_OFF_FRAMES = 10;
const VAD_HISTORY_LEN = 150;

// PFRS-matched palette
const C = {
  bg:     "#F5F0EB",  // warm cream
  fg:     "#000000",
  yellow: "#FF3300",  // accent (orange-red)
  green:  "#1a6b1a",  // dark green — readable on cream
  red:    "#CC0000",
  orange: "#FF3300",
  dim:    "#6B7280",  // gray-500
  dim2:   "#C8C3BC",  // muted cream-grey for inactive
  panel:  "#F5F0EB",
} as const;

const MONO = "'Space Mono', 'Courier New', monospace";
const SANS = "'Inter', system-ui, sans-serif";

type Status = "idle" | "requesting" | "active" | "error";
type TooltipAlign = "center" | "left" | "right";

function dbToPercent(db: number): number {
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function ratingLabel(snr: number): { label: string; color: string } {
  if (snr >= 30) return { label: "EXCELLENT", color: C.green };
  if (snr >= 20) return { label: "GOOD",      color: "#4a7c00" };
  if (snr >= 10) return { label: "FAIR",      color: "#b35c00" };
  return           { label: "POOR",           color: C.red };
}

function speechBandLabel(ratio: number): { label: string; color: string } {
  if (ratio >= 0.60) return { label: "STRONG",   color: C.green };
  if (ratio >= 0.40) return { label: "MODERATE", color: "#b35c00" };
  return               { label: "WEAK",          color: C.red };
}

function dynamicRangeLabel(dr: number): { label: string; color: string } {
  if (dr >= 20) return { label: "EXCELLENT", color: C.green };
  if (dr >= 12) return { label: "GOOD",      color: "#4a7c00" };
  if (dr >= 6)  return { label: "FAIR",      color: "#b35c00" };
  return          { label: "POOR",           color: C.red };
}

// ── Mic type detection ────────────────────────────────────────────────────────

type MicType = "builtin" | "bluetooth" | "usb" | "wired" | "unknown";

const MIC_META: Record<MicType, { label: string; color: string }> = {
  builtin:   { label: "Built-in",  color: "#6B7280" },
  bluetooth: { label: "Bluetooth", color: "#0055CC" },
  usb:       { label: "USB",       color: "#1a6b1a" },
  wired:     { label: "Wired",     color: "#4a7c00" },
  unknown:   { label: "Unknown",   color: "#6B7280" },
};

function detectMicType(label: string, sampleRate: number): MicType {
  // Bluetooth HSP/HFP profile drops to 8 kHz or 16 kHz — most reliable signal
  if (sampleRate <= 16000) return "bluetooth";

  const l = label.toLowerCase();

  if (/bluetooth|airpod|beats|bose|sony|jabra|plantronics|sennheiser|galaxy.?bud|pixel.?bud|jbl|anker|soundcore|earbuds?|headphones?.+wireless|wireless.+headphones?/i.test(l))
    return "bluetooth";

  if (/built.?in|internal|macbook|imac|mac.?mini|surface|thinkpad|laptop|notebook|default/i.test(l))
    return "builtin";

  if (/usb|yeti|snowball|rode|nt-usb|shure|sm7|audio.technica|at2020|hyperx|logitech|elgato|fifine|samson|maono|focusrite|scarlett|behringer/i.test(l))
    return "usb";

  if (/headset|headphone|earphone|external|line.?in|analog|3\.5|jack|aux|microphone.+wired/i.test(l))
    return "wired";

  return "unknown";
}

// ── Speech test helpers ───────────────────────────────────────────────────────

const TEST_DURATION_MS = 10_000;
const STORAGE_KEY = "mic-checker-results";

type TestPhase = "idle" | "countdown" | "recording" | "done";

type TestResult = {
  id: string;
  timestamp: number;
  avgVolumeDb: number;
  peakDb: number;
  noiseFloorDb: number;
  snr: number;
  speechBandRatio: number;
  dynamicRangeDb: number;
  speechActivityPct: number;
  clippingEvents: number;
  score: number;
  grade: string;
};

function computeTestScore(r: Pick<TestResult, "snr" | "speechBandRatio" | "dynamicRangeDb" | "noiseFloorDb">): number {
  const snrPts   = Math.min(r.snr / 30, 1) * 40;
  const bandPts  = Math.min(r.speechBandRatio / 0.7, 1) * 25;
  const dynPts   = Math.min(r.dynamicRangeDb / 25, 1) * 20;
  const noisePts = Math.min(Math.max(-r.noiseFloorDb - 20, 0) / 40, 1) * 15;
  return Math.round(snrPts + bandPts + dynPts + noisePts);
}

function scoreGrade(score: number): { grade: string; label: string; color: string } {
  if (score >= 80) return { grade: "A", label: "Dictation-ready", color: C.green };
  if (score >= 60) return { grade: "B", label: "Good",            color: "#4a7c00" };
  if (score >= 40) return { grade: "C", label: "Fair",            color: "#b35c00" };
  if (score >= 20) return { grade: "D", label: "Poor",            color: C.red };
  return                   { grade: "F", label: "Not suitable",   color: C.red };
}

function loadResults(): TestResult[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); }
  catch { return []; }
}

function saveResult(r: TestResult): void {
  const all = loadResults();
  localStorage.setItem(STORAGE_KEY, JSON.stringify([r, ...all].slice(0, 20)));
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

function InfoTooltip({ text, align = "center" }: { text: string; align?: TooltipAlign }) {
  const [visible, setVisible] = useState(false);

  const boxPos =
    align === "left"  ? { left: 0 } :
    align === "right" ? { right: 0 } :
                        { left: "50%", transform: "translateX(-50%)" };

  const arrowPos =
    align === "left"  ? { left: 10 } :
    align === "right" ? { right: 10 } :
                        { left: "50%", transform: "translateX(-50%)" };

  return (
    <span
      style={{ position: "relative", display: "inline-flex", alignItems: "center", verticalAlign: "middle", flexShrink: 0 }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          border: `1px solid ${C.dim}`,
          color: C.dim,
          fontSize: 10,
          fontWeight: 700,
          fontStyle: "italic",
          cursor: "default",
          lineHeight: 1,
          userSelect: "none",
          fontFamily: MONO,
        }}
        aria-label="More info"
      >
        i
      </span>
      {visible && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            ...boxPos,
            background: C.fg,
            border: `2px solid ${C.fg}`,
            padding: "10px 12px",
            fontSize: 12,
            color: C.bg,
            width: 240,
            lineHeight: 1.6,
            zIndex: 1000,
            pointerEvents: "none",
            textAlign: "left",
            textTransform: "none",
            letterSpacing: "normal",
            fontWeight: "normal",
            fontFamily: SANS,
          }}
        >
          {text}
          <span
            style={{
              position: "absolute",
              top: "100%",
              ...arrowPos,
              width: 0,
              height: 0,
              borderLeft: "6px solid transparent",
              borderRight: "6px solid transparent",
              borderTop: `6px solid ${C.fg}`,  // arrow matches black tooltip bg
            }}
          />
        </div>
      )}
    </span>
  );
}

function SectionLabel({ children, tooltip, align }: { children: React.ReactNode; tooltip: string; align?: TooltipAlign }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: C.dim, textTransform: "uppercase", letterSpacing: 3, fontWeight: 700, fontFamily: MONO }}>
      {children}
      <InfoTooltip text={tooltip} align={align ?? "left"} />
    </div>
  );
}

// ── VU Meter ─────────────────────────────────────────────────────────────────

function VUMeter({ level, peak }: { level: number; peak: number }) {
  const bars = 24;
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 80 }}>
      {Array.from({ length: bars }, (_, i) => {
        const threshold = ((i + 1) / bars) * 100;
        const active = level >= threshold;
        const isPeak = Math.abs(peak - threshold) < 100 / bars;
        let color = C.yellow;
        if (threshold > 85) color = C.red;
        else if (threshold > 65) color = C.orange;
        const barH = 20 + (i / bars) * 60;
        return (
          <div
            key={i}
            style={{
              flex: 1,
              height: barH,
              background: active ? color : isPeak ? color : C.dim2,
              opacity: isPeak && !active ? 0.8 : 1,
              transition: "background 0.04s",
            }}
          />
        );
      })}
    </div>
  );
}

// ── Waveform ──────────────────────────────────────────────────────────────────

function Waveform({ dataRef }: { dataRef: React.RefObject<Uint8Array | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    function draw() {
      const data = dataRef.current;
      const w = canvas!.width;
      const h = canvas!.height;
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);

      // Centre line
      ctx.strokeStyle = C.dim2;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      ctx.strokeStyle = C.yellow;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (data) {
        const step = Math.ceil(data.length / w);
        for (let x = 0; x < w; x++) {
          const v = (data[x * step] / 128) - 1;
          const y = (v * h) / 2 + h / 2;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
      } else {
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
      }
      ctx.stroke();
      rafRef.current = requestAnimationFrame(draw);
    }

    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={592}
      height={80}
      style={{ width: "100%", height: 80, display: "block", border: `1px solid ${C.dim2}` }}
    />
  );
}

// ── Spectrum ──────────────────────────────────────────────────────────────────

function Spectrum({
  dataRef,
  sampleRateRef,
}: {
  dataRef: React.RefObject<Uint8Array | null>;
  sampleRateRef: React.RefObject<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    function draw() {
      const data = dataRef.current;
      const w = canvas!.width;
      const h = canvas!.height;
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);

      const sampleRate = sampleRateRef.current;
      const binCount = data ? data.length : FFT_SIZE / 2;
      const binWidth = sampleRate / FFT_SIZE;
      const speechLowBin = Math.floor(300 / binWidth);
      const speechHighBin = Math.ceil(3400 / binWidth);
      const speechLowX = (speechLowBin / binCount) * w;
      const speechHighX = (speechHighBin / binCount) * w;

      // Speech band tint
      ctx.fillStyle = "rgba(255,51,0,0.07)";
      ctx.fillRect(speechLowX, 0, speechHighX - speechLowX, h);

      // Band boundary lines
      ctx.strokeStyle = C.yellow;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(speechLowX, 0);
      ctx.lineTo(speechLowX, h);
      ctx.moveTo(speechHighX, 0);
      ctx.lineTo(speechHighX, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label
      ctx.fillStyle = C.yellow;
      ctx.font = `bold 9px "Courier New", monospace`;
      ctx.textAlign = "center";
      ctx.fillText("SPEECH BAND", (speechLowX + speechHighX) / 2, 11);

      if (data) {
        const barW = Math.max(1, w / data.length);
        for (let i = 0; i < data.length; i++) {
          const v = data[i] / 255;
          const barH = v * h;
          const inSpeechBand = i >= speechLowBin && i <= speechHighBin;
          ctx.fillStyle = inSpeechBand ? C.yellow : `rgba(0,0,0,${0.12 + v * 0.88})`;
          ctx.fillRect(i * barW, h - barH, barW - 1, barH);
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    }

    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={592}
      height={80}
      style={{ width: "100%", height: 80, display: "block", border: `1px solid ${C.dim2}` }}
    />
  );
}

// ── VAD history strip ─────────────────────────────────────────────────────────

function VadHistory({ historyRef }: { historyRef: React.RefObject<Uint8Array> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    function draw() {
      const data = historyRef.current;
      const w = canvas!.width;
      const h = canvas!.height;
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);

      const cellW = w / data.length;
      for (let i = 0; i < data.length; i++) {
        ctx.fillStyle = data[i] ? C.green : C.dim2;
        ctx.fillRect(i * cellW, 1, Math.max(1, cellW - 1), h - 2);
      }
      rafRef.current = requestAnimationFrame(draw);
    }

    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={592}
      height={20}
      style={{ width: "100%", height: 20, display: "block", border: `1px solid ${C.dim2}` }}
    />
  );
}

// ── Shared panel wrapper ──────────────────────────────────────────────────────

function Panel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      border: `2px solid ${C.fg}`,
      padding: "14px 16px",
      ...style,
    }}>
      {children}
    </div>
  );
}

// ── Speech Test modal ─────────────────────────────────────────────────────────

function TestModal({
  phase, countdown, progress, volumeDb, result, onClose, onRetry,
}: {
  phase: TestPhase;
  countdown: number;
  progress: number;
  volumeDb: number;
  result: TestResult | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const levelPct = dbToPercent(volumeDb);

  const header = (title: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
      <div style={{ fontSize: 10, color: C.dim, fontFamily: MONO, letterSpacing: "0.25em", textTransform: "uppercase", fontWeight: 700 }}>
        {title}
      </div>
      <button
        onClick={onClose}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, lineHeight: 1, color: C.fg, padding: "0 2px", fontFamily: SANS }}
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  );

  let content: React.ReactNode;

  if (phase === "countdown") {
    content = (
      <>
        {header("Speech Test")}
        <div style={{ textAlign: "center", padding: "32px 0 24px" }}>
          <div style={{ fontSize: 96, fontWeight: 900, fontFamily: SANS, lineHeight: 1, color: C.yellow }}>{countdown}</div>
          <div style={{ fontSize: 10, color: C.dim, marginTop: 14, fontFamily: MONO, letterSpacing: "0.3em" }}>GET READY TO SPEAK</div>
        </div>
      </>
    );
  } else if (phase === "recording") {
    content = (
      <>
        {header("Recording")}
        <div style={{ fontSize: 12, color: C.dim, fontFamily: MONO, letterSpacing: "0.1em", marginBottom: 16 }}>
          Speak naturally in your normal voice...
        </div>
        <div style={{ height: 6, background: C.dim2, marginBottom: 16 }}>
          <div style={{ height: "100%", width: `${progress}%`, background: C.yellow, transition: "width 0.05s" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 10, color: C.dim, fontFamily: MONO, flexShrink: 0 }}>Level</div>
          <div style={{ flex: 1, height: 10, background: C.dim2 }}>
            <div style={{ height: "100%", width: `${levelPct}%`, background: C.fg, transition: "width 0.04s" }} />
          </div>
          <div style={{ fontSize: 10, color: C.dim, fontFamily: MONO, flexShrink: 0, minWidth: 28, textAlign: "right" }}>{Math.round(progress)}%</div>
        </div>
      </>
    );
  } else if (phase === "done" && result) {
    const g = scoreGrade(result.score);
    const noiseRating = result.noiseFloorDb < -45 ? { label: "GOOD", color: C.green }
      : result.noiseFloorDb < -35 ? { label: "FAIR", color: "#b35c00" }
      : { label: "POOR", color: C.red };
    const rows: { label: string; value: string; color: string }[] = [
      { label: "SNR",            value: `${result.snr.toFixed(1)} dB`,                   color: ratingLabel(result.snr).color },
      { label: "Speech Band",    value: `${(result.speechBandRatio * 100).toFixed(1)}%`, color: speechBandLabel(result.speechBandRatio).color },
      { label: "Dynamic Range",  value: `${result.dynamicRangeDb.toFixed(1)} dB`,        color: dynamicRangeLabel(result.dynamicRangeDb).color },
      { label: "Noise Floor",    value: `${result.noiseFloorDb.toFixed(1)} dB`,          color: noiseRating.color },
      { label: "Speech Activity",value: `${result.speechActivityPct.toFixed(0)}%`,       color: C.dim },
    ];
    content = (
      <>
        {header("Result")}
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 20 }}>
          <span style={{ fontSize: 80, fontWeight: 900, fontFamily: SANS, lineHeight: 1, color: g.color }}>{g.grade}</span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: g.color, fontFamily: MONO }}>
              {result.score}<span style={{ fontSize: 12, fontWeight: 400 }}>/100</span>
            </div>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, letterSpacing: "0.1em", marginTop: 3 }}>{g.label}</div>
          </div>
        </div>

        {rows.map(({ label, value, color }) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: `1px solid ${C.dim2}` }}>
            <span style={{ fontSize: 10, color: C.dim, fontFamily: MONO, letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</span>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <span style={{ fontSize: 12, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{value}</span>
              {label !== "Speech Activity" && (
                <span style={{ fontSize: 10, fontFamily: MONO, color, minWidth: 56, textAlign: "right", letterSpacing: "0.05em" }}>
                  {color === C.green || color === "#4a7c00" ? "GOOD" : color === "#b35c00" ? "FAIR" : "POOR"}
                </span>
              )}
            </div>
          </div>
        ))}

        <div style={{ marginTop: 16, fontSize: 10, color: C.dim, fontFamily: MONO }}>
          {new Date(result.timestamp).toLocaleString()}
        </div>

        <button
          onClick={onRetry}
          style={{ marginTop: 16, width: "100%", padding: "10px", fontSize: 11, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", border: `2px solid ${C.fg}`, background: "transparent", color: C.fg, cursor: "pointer", fontFamily: MONO }}
        >
          Test Again
        </button>
      </>
    );
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 24 }}
      onClick={onClose}
    >
      <div
        style={{ background: C.bg, border: `2px solid ${C.fg}`, width: "100%", maxWidth: 440, padding: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [volumeDb, setVolumeDb] = useState(-60);
  const [peakDb, setPeakDb] = useState(-60);
  const [noiseFloorDb, setNoiseFloorDb] = useState(-60);
  const [snr, setSnr] = useState(0);
  const [clipping, setClipping] = useState(false);
  const [speechBandRatio, setSpeechBandRatio] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speechDynamicRange, setSpeechDynamicRange] = useState(0);
  const [hasEnoughVadData, setHasEnoughVadData] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const timeDataRef = useRef<Uint8Array | null>(null);
  const freqDataRef = useRef<Uint8Array | null>(null);
  const floatFreqRef = useRef<Float32Array | null>(null);
  const sampleRateRef = useRef(44100);

  const volumeHistory = useRef<number[]>([]);
  const peakHold = useRef(-60);
  const peakTimer = useRef(0);

  const vadStateRef = useRef<"silent" | "speaking">("silent");
  const vadConsecutiveRef = useRef(0);
  const vadHistoryRef = useRef(new Uint8Array(VAD_HISTORY_LEN));
  const speechAccum = useRef({ sum: 0, count: 0 });
  const silenceAccum = useRef({ sum: 0, count: 0 });
  const frameCountRef = useRef(0);

  // Mic detection
  const [micLabel, setMicLabel] = useState("");
  const [micType, setMicType] = useState<MicType>("unknown");

  // Speech test
  const [testPhase, setTestPhase] = useState<TestPhase>("idle");
  const [testCountdown, setTestCountdown] = useState(3);
  const [testProgress, setTestProgress] = useState(0);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testHistory, setTestHistory] = useState<TestResult[]>([]);
  const isTestRecordingRef = useRef(false);
  const testTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const testDataRef = useRef<{ volumes: number[]; bandRatios: number[]; vadFrames: boolean[]; clipping: number }>({ volumes: [], bandRatios: [], vadFrames: [], clipping: 0 });

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    streamRef.current = null;
    timeDataRef.current = null;
    freqDataRef.current = null;
    floatFreqRef.current = null;
    peakHold.current = -60;
    volumeHistory.current = [];
    vadStateRef.current = "silent";
    vadConsecutiveRef.current = 0;
    vadHistoryRef.current = new Uint8Array(VAD_HISTORY_LEN);
    speechAccum.current = { sum: 0, count: 0 };
    silenceAccum.current = { sum: 0, count: 0 };
    frameCountRef.current = 0;
    if (testTimerRef.current) { clearInterval(testTimerRef.current); testTimerRef.current = null; }
    isTestRecordingRef.current = false;
    setTestPhase("idle");
    setStatus("idle");
    setVolumeDb(-60);
    setPeakDb(-60);
    setNoiseFloorDb(-60);
    setSnr(0);
    setClipping(false);
    setSpeechBandRatio(0);
    setIsSpeaking(false);
    setSpeechDynamicRange(0);
    setHasEnoughVadData(false);
    setMicLabel("");
    setMicType("unknown");
  }, []);

  const start = useCallback(async () => {
    setStatus("requesting");
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      sampleRateRef.current = ctx.sampleRate;

      const trackLabel = stream.getAudioTracks()[0]?.label ?? "";
      setMicLabel(trackLabel);
      setMicType(detectMicType(trackLabel, ctx.sampleRate));

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;
      source.connect(analyser);
      analyserRef.current = analyser;

      timeDataRef.current = new Uint8Array(analyser.fftSize);
      freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      floatFreqRef.current = new Float32Array(analyser.frequencyBinCount);

      setStatus("active");

      function tick() {
        const analyser = analyserRef.current;
        if (!analyser) return;

        analyser.getByteTimeDomainData(timeDataRef.current!);
        analyser.getByteFrequencyData(freqDataRef.current!);
        analyser.getFloatFrequencyData(floatFreqRef.current!);
        frameCountRef.current++;

        // RMS volume
        let sum = 0;
        for (const v of timeDataRef.current!) {
          const s = (v - 128) / 128;
          sum += s * s;
        }
        const rms = Math.sqrt(sum / timeDataRef.current!.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : -60;
        const clampedDb = Math.max(-60, Math.min(0, db));

        setVolumeDb(clampedDb);
        setClipping(clampedDb > -1);

        // Peak hold (3s decay)
        if (clampedDb > peakHold.current) {
          peakHold.current = clampedDb;
          peakTimer.current = Date.now();
        } else if (Date.now() - peakTimer.current > 3000) {
          peakHold.current = Math.max(peakHold.current - 0.5, clampedDb);
        }
        setPeakDb(peakHold.current);

        // Noise floor
        const history = volumeHistory.current;
        history.push(clampedDb);
        if (history.length > HISTORY_LEN) history.shift();
        const noiseFloor = Math.min(...history);
        setNoiseFloorDb(noiseFloor);
        setSnr(Math.max(0, peakHold.current - noiseFloor));

        // Speech band energy ratio (300 Hz – 3400 Hz)
        const binWidth = sampleRateRef.current / FFT_SIZE;
        const speechLowBin = Math.floor(300 / binWidth);
        const speechHighBin = Math.ceil(3400 / binWidth);
        const floatFreq = floatFreqRef.current!;
        let speechEnergy = 0;
        let totalEnergy = 0;
        for (let i = 0; i < floatFreq.length; i++) {
          const linear = floatFreq[i] > -Infinity ? Math.pow(10, floatFreq[i] / 20) : 0;
          const e = linear * linear;
          totalEnergy += e;
          if (i >= speechLowBin && i <= speechHighBin) speechEnergy += e;
        }
        setSpeechBandRatio(totalEnergy > 0 ? speechEnergy / totalEnergy : 0);

        // VAD (after 30-frame warm-up)
        if (frameCountRef.current >= 30) {
          const targetSpeaking = clampedDb > noiseFloor + VAD_THRESHOLD_DB;
          const currentlySpeaking = vadStateRef.current === "speaking";

          if (targetSpeaking === currentlySpeaking) {
            vadConsecutiveRef.current = 0;
          } else {
            vadConsecutiveRef.current++;
            const needed = targetSpeaking ? VAD_ON_FRAMES : VAD_OFF_FRAMES;
            if (vadConsecutiveRef.current >= needed) {
              vadStateRef.current = targetSpeaking ? "speaking" : "silent";
              vadConsecutiveRef.current = 0;
            }
          }

          const speaking = vadStateRef.current === "speaking";
          setIsSpeaking(speaking);

          if (isTestRecordingRef.current) {
            const ratio = totalEnergy > 0 ? speechEnergy / totalEnergy : 0;
            testDataRef.current.volumes.push(clampedDb);
            testDataRef.current.bandRatios.push(ratio);
            testDataRef.current.vadFrames.push(speaking);
            if (clampedDb > -1) testDataRef.current.clipping++;
          }

          const hist = vadHistoryRef.current;
          hist.copyWithin(0, 1);
          hist[hist.length - 1] = speaking ? 1 : 0;

          if (speaking) {
            speechAccum.current.sum += clampedDb;
            speechAccum.current.count++;
          } else {
            silenceAccum.current.sum += clampedDb;
            silenceAccum.current.count++;
          }

          const hasBothSamples = speechAccum.current.count >= 30 && silenceAccum.current.count >= 30;
          setHasEnoughVadData(hasBothSamples);

          if (hasBothSamples) {
            const avgSpeech = speechAccum.current.sum / speechAccum.current.count;
            const avgSilence = silenceAccum.current.sum / silenceAccum.current.count;
            setSpeechDynamicRange(Math.max(0, avgSpeech - avgSilence));
          }
        }

        rafRef.current = requestAnimationFrame(tick);
      }

      tick();
    } catch (e: any) {
      setError(e.message || "Microphone access denied");
      setStatus("error");
    }
  }, []);

  useEffect(() => () => stop(), []);
  useEffect(() => { setTestHistory(loadResults()); }, []);

  const startTest = useCallback(() => {
    if (status !== "active") return;
    testDataRef.current = { volumes: [], bandRatios: [], vadFrames: [], clipping: 0 };
    setTestPhase("countdown");
    setTestCountdown(3);
    setTestResult(null);

    let count = 3;
    const countInterval = setInterval(() => {
      count--;
      setTestCountdown(count);
      if (count > 0) return;
      clearInterval(countInterval);

      isTestRecordingRef.current = true;
      setTestPhase("recording");
      setTestProgress(0);

      const startTime = Date.now();
      testTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const pct = Math.min((elapsed / TEST_DURATION_MS) * 100, 100);
        setTestProgress(pct);
        if (elapsed < TEST_DURATION_MS) return;

        clearInterval(testTimerRef.current!);
        testTimerRef.current = null;
        isTestRecordingRef.current = false;

        const { volumes, bandRatios, vadFrames, clipping } = testDataRef.current;
        if (volumes.length < 10) { setTestPhase("idle"); return; }

        const avgVolumeDb = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        const peakDb      = Math.max(...volumes);
        const sortedVols  = [...volumes].sort((a, b) => a - b);
        const floorSlice  = sortedVols.slice(0, Math.max(1, Math.ceil(sortedVols.length * 0.15)));
        const noiseFloorDb = floorSlice.reduce((a, b) => a + b, 0) / floorSlice.length;
        const snr          = Math.max(0, peakDb - noiseFloorDb);
        const speechBandRatio = bandRatios.reduce((a, b) => a + b, 0) / bandRatios.length;
        const speakingVols = volumes.filter((_, i) => vadFrames[i]);
        const silentVols   = volumes.filter((_, i) => !vadFrames[i]);
        const avgSpeaking  = speakingVols.length > 0 ? speakingVols.reduce((a, b) => a + b, 0) / speakingVols.length : avgVolumeDb;
        const avgSilent    = silentVols.length   > 0 ? silentVols.reduce((a, b) => a + b, 0)   / silentVols.length   : noiseFloorDb;
        const dynamicRangeDb   = Math.max(0, avgSpeaking - avgSilent);
        const speechActivityPct = (vadFrames.filter(Boolean).length / vadFrames.length) * 100;

        const score = computeTestScore({ snr, speechBandRatio, dynamicRangeDb, noiseFloorDb });
        const { grade } = scoreGrade(score);

        const result: TestResult = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          avgVolumeDb, peakDb, noiseFloorDb, snr, speechBandRatio,
          dynamicRangeDb, speechActivityPct, clippingEvents: clipping, score, grade,
        };
        saveResult(result);
        setTestResult(result);
        setTestHistory(loadResults());
        setTestPhase("done");
      }, 50);
    }, 1000);
  }, [status]);

  const cancelTest = useCallback(() => {
    if (testTimerRef.current) { clearInterval(testTimerRef.current); testTimerRef.current = null; }
    isTestRecordingRef.current = false;
    setTestPhase("idle");
  }, []);

  const volumePct = dbToPercent(volumeDb);
  const peakPct = dbToPercent(peakDb);
  const snrRating = ratingLabel(snr);
  const speechRating = speechBandLabel(speechBandRatio);
  const drRating = dynamicRangeLabel(speechDynamicRange);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {testPhase !== "idle" && (
        <TestModal
          phase={testPhase}
          countdown={testCountdown}
          progress={testProgress}
          volumeDb={volumeDb}
          result={testResult}
          onClose={cancelTest}
          onRetry={() => { cancelTest(); setTimeout(startTest, 100); }}
        />
      )}

      {/* Header */}
      <div style={{ borderBottom: `2px solid ${C.fg}`, paddingBottom: 16, marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: C.yellow, letterSpacing: "0.3em", marginBottom: 8, fontFamily: MONO, fontWeight: 700 }}>// DIAGNOSTIC TOOL</div>
        <h1 style={{ fontSize: 52, fontWeight: 900, letterSpacing: "-0.03em", lineHeight: 0.88, textTransform: "uppercase", fontFamily: SANS }}>
          Mic<br />Checker
        </h1>
      </div>

      {status === "idle" || status === "requesting" || status === "error" ? (
        <div style={{ padding: "40px 0" }}>
          {error && (
            <p style={{ color: C.red, marginBottom: 16, fontSize: 13, border: `2px solid ${C.red}`, padding: "8px 12px" }}>
              ERROR: {error}
            </p>
          )}
          <button
            onClick={start}
            disabled={status === "requesting"}
            style={{
              padding: "14px 32px",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              border: `2px solid ${C.fg}`,
              background: status === "requesting" ? C.dim2 : C.fg,
              color: status === "requesting" ? C.dim : C.bg,
              cursor: status === "requesting" ? "not-allowed" : "pointer",
              display: "block",
              width: "100%",
              fontFamily: MONO,
            }}
          >
            {status === "requesting" ? "Requesting access..." : "Start Mic Check"}
          </button>
        </div>
      ) : (
        <>
          {/* Speech test trigger + history */}
          <button
            onClick={startTest}
            style={{
              padding: "13px",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              border: `2px solid ${C.fg}`,
              background: C.fg,
              color: C.bg,
              cursor: "pointer",
              fontFamily: MONO,
              width: "100%",
            }}
          >
            Run Speech Test
          </button>

          {testHistory.length > 0 && (
            <Panel>
              <div style={{ marginBottom: 10 }}>
                <SectionLabel tooltip="Saved results from previous speech tests. Up to 20 results are stored in your browser.">Past Results</SectionLabel>
              </div>
              {testHistory.slice(0, 5).map((r) => {
                const g = scoreGrade(r.score);
                return (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: `1px solid ${C.dim2}` }}>
                    <span style={{ fontSize: 10, color: C.dim, fontFamily: MONO }}>
                      {new Date(r.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                      <span style={{ fontSize: 11, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: C.dim }}>{r.score}/100</span>
                      <span style={{ fontSize: 13, fontWeight: 700, fontFamily: SANS, color: g.color, minWidth: 16, textAlign: "center" }}>{g.grade}</span>
                    </div>
                  </div>
                );
              })}
            </Panel>
          )}

          {/* Mic detection */}
          <Panel>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 10, color: C.dim, fontFamily: MONO, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 5 }}>
                  Microphone
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS, color: C.fg, maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {micLabel || "Unknown device"}
                </div>
                <div style={{ fontSize: 10, color: C.dim, fontFamily: MONO, marginTop: 4 }}>
                  {sampleRateRef.current.toLocaleString()} Hz
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                <span style={{
                  display: "inline-block",
                  padding: "4px 10px",
                  border: `2px solid ${MIC_META[micType].color}`,
                  color: MIC_META[micType].color,
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: MONO,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                }}>
                  {MIC_META[micType].label}
                </span>
              </div>
            </div>
            {micType === "bluetooth" && sampleRateRef.current <= 16000 && (
              <div style={{ marginTop: 12, padding: "8px 10px", background: "#FFF3CD", border: "2px solid #b35c00", fontSize: 11, color: "#b35c00", fontFamily: MONO, letterSpacing: "0.05em" }}>
                Bluetooth mic active at {sampleRateRef.current.toLocaleString()} Hz — too narrow for accurate dictation. Use a wired or USB mic for best results.
              </div>
            )}
            {micType === "bluetooth" && sampleRateRef.current > 16000 && (
              <div style={{ marginTop: 12, padding: "8px 10px", background: "#FFF3CD", border: "2px solid #b35c00", fontSize: 11, color: "#b35c00", fontFamily: MONO, letterSpacing: "0.05em" }}>
                Bluetooth detected — mic quality depends on the headset profile in use. Audio may degrade if audio playback is active simultaneously.
              </div>
            )}
          </Panel>

          {/* Signal Quality */}
          <Panel>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, color: C.dim, letterSpacing: "0.2em", display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, textTransform: "uppercase" }}>
                Signal Quality
                <InfoTooltip
                  text="An overall score based on how much louder your voice is than background noise. 'Good' or better means speech recognition software should work reliably."
                  align="left"
                />
              </span>
              <span style={{ fontWeight: 700, color: snrRating.color, fontSize: 16, letterSpacing: "0.1em", fontFamily: MONO }}>
                {snrRating.label}
              </span>
            </div>
          </Panel>

          {/* VU Meter */}
          <Panel>
            <div style={{ marginBottom: 12 }}>
              <SectionLabel tooltip="How loud your mic input is right now. Yellow bars are a healthy speaking level, orange is loud, red risks distortion. Aim to stay in the yellow while talking.">
                LEVEL
              </SectionLabel>
            </div>
            <VUMeter level={volumePct} peak={peakPct} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10, color: C.dim, letterSpacing: "0.05em", fontFamily: MONO }}>
              <span>-60 dB</span>
              <span>-30 dB</span>
              <span>0 dB</span>
            </div>
          </Panel>

          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            {[
              {
                label: "VOLUME",
                value: `${volumeDb.toFixed(1)} dB`,
                tooltip: "Your current loudness in decibels. −18 dB to −6 dB while speaking is a healthy range — loud enough for clear capture without risk of distortion.",
                align: "left" as TooltipAlign,
              },
              {
                label: "PEAK HOLD",
                value: `${peakDb.toFixed(1)} dB`,
                tooltip: "The loudest moment recorded in the past few seconds. Watch this to catch spikes where you might be speaking too loudly or bumping the mic.",
                align: "center" as TooltipAlign,
              },
              {
                label: "SNR",
                value: `${snr.toFixed(1)} dB`,
                color: snrRating.color,
                tooltip: "Signal-to-Noise Ratio — how much louder your voice is than background hiss. Speech recognition needs at least 20 dB to work reliably; 30 dB+ is ideal.",
                align: "right" as TooltipAlign,
              },
            ].map(({ label, value, color, tooltip, align }) => (
              <div
                key={label}
                style={{ border: `2px solid ${C.fg}`, padding: "12px 10px", textAlign: "center" }}
              >
                <div style={{ fontSize: 10, color: C.dim, marginBottom: 6, letterSpacing: "0.15em", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, fontFamily: MONO, textTransform: "uppercase" }}>
                  {label}
                  <InfoTooltip text={tooltip} align={align} />
                </div>
                <div style={{ fontWeight: 700, fontSize: 16, fontVariantNumeric: "tabular-nums", color: color ?? C.fg, fontFamily: MONO }}>
                  {value}
                </div>
              </div>
            ))}
          </div>

          {/* Noise floor */}
          <Panel>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, color: C.dim, letterSpacing: "0.2em", display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, textTransform: "uppercase" }}>
                Noise Floor (est.)
                <InfoTooltip
                  text="How loud your mic is when you're not speaking — this is your room's background noise. Lower is better; quieter than −45 dB is ideal for dictation."
                  align="left"
                />
              </span>
              <span style={{ fontWeight: 700, fontSize: 16, fontVariantNumeric: "tabular-nums", fontFamily: MONO }}>
                {noiseFloorDb.toFixed(1)} dB
              </span>
            </div>
          </Panel>

          {/* Speech Band Energy */}
          <Panel>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <SectionLabel tooltip="The share of captured sound energy in the 300 Hz–3.4 kHz range — the frequencies that carry most of what makes speech understandable. A high percentage means the mic is focused on your voice rather than low rumble or high-frequency hiss.">
                  SPEECH BAND ENERGY
                </SectionLabel>
                <div style={{ fontSize: 10, color: C.dim, marginTop: 4, letterSpacing: 1 }}>300 Hz – 3.4 kHz</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontWeight: 700, fontSize: 22, color: speechRating.color, fontVariantNumeric: "tabular-nums", fontFamily: MONO }}>
                  {(speechBandRatio * 100).toFixed(1)}%
                </div>
                <div style={{ fontSize: 10, color: speechRating.color, letterSpacing: "0.15em", marginTop: 2, fontFamily: MONO }}>{speechRating.label}</div>
              </div>
            </div>
            {/* Progress track */}
            <div style={{ height: 10, background: C.dim2, border: `1px solid ${C.dim}`, position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  top: 0, left: 0, bottom: 0,
                  width: `${speechBandRatio * 100}%`,
                  background: speechRating.color,
                  transition: "width 0.1s",
                }}
              />
              {/* 60% ideal marker */}
              <div style={{ position: "absolute", top: -4, left: "60%", bottom: -4, width: 2, background: C.fg, opacity: 0.4 }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, color: C.dim, letterSpacing: "0.1em", fontFamily: MONO }}>
              <span>0%</span>
              <span style={{ color: C.dim }}>ideal ≥60%</span>
              <span>100%</span>
            </div>
          </Panel>

          {/* VAD */}
          <Panel>
            <div style={{ marginBottom: 12 }}>
              <SectionLabel tooltip="Automatically detects when you're speaking versus silent. Activates after a short warm-up. The strip below shows the last 2.5 seconds of detected speech (green) vs. silence.">
                VOICE ACTIVITY DETECTION
              </SectionLabel>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              {/* Speaking indicator */}
              <div
                style={{
                  padding: "4px 10px",
                  border: `2px solid ${isSpeaking ? C.yellow : C.dim}`,
                  background: isSpeaking ? C.yellow : "transparent",
                  color: isSpeaking ? "#fff" : C.dim,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.15em",
                  transition: "all 0.08s",
                  flexShrink: 0,
                  fontFamily: MONO,
                  textTransform: "uppercase",
                }}
              >
                {isSpeaking ? "Speaking" : "Silent"}
              </div>

              {/* Dynamic range */}
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                {hasEnoughVadData ? (
                  <span style={{ fontFamily: MONO }}>
                    <span style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em" }}>Dyn Range </span>
                    <span style={{ fontWeight: 700, color: drRating.color, fontVariantNumeric: "tabular-nums", fontSize: 13 }}>
                      {speechDynamicRange.toFixed(1)} dB
                    </span>
                    <span style={{ fontSize: 10, color: drRating.color, marginLeft: 6, letterSpacing: "0.1em" }}>{drRating.label}</span>
                  </span>
                ) : (
                  <span style={{ fontSize: 10, color: C.dim, letterSpacing: "0.05em", fontFamily: MONO }}>
                    Speak + stay silent to calibrate
                  </span>
                )}
                <InfoTooltip
                  text="How much louder your average speaking level is compared to when you're silent. A bigger gap makes it easier for speech-to-text to isolate your voice from background noise. Aim for 20 dB or more."
                  align="right"
                />
              </div>
            </div>

            <VadHistory historyRef={vadHistoryRef} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, color: C.dim, letterSpacing: "0.1em", fontFamily: MONO }}>
              <span>2.5s ago</span>
              <span>now</span>
            </div>
          </Panel>

          {/* Clipping warning */}
          {clipping && (
            <div style={{
              padding: "12px 16px",
              border: `2px solid ${C.red}`,
              background: C.red,
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.15em",
              textAlign: "center",
              fontFamily: MONO,
            }}>
              Clipping detected — lower your mic gain
            </div>
          )}

          {/* Waveform */}
          <Panel>
            <div style={{ marginBottom: 10 }}>
              <SectionLabel tooltip="A real-time picture of the raw sound wave. Clear peaks when you speak and a flat centre line when quiet is ideal. A completely flat line means no signal; a solid filled block means you're clipping — too loud.">
                WAVEFORM
              </SectionLabel>
            </div>
            <Waveform dataRef={timeDataRef} />
          </Panel>

          {/* Spectrum */}
          <Panel>
            <div style={{ marginBottom: 10 }}>
              <SectionLabel tooltip="Shows how much energy your mic captures at each frequency, from low (left) to high (right). Yellow bars are the speech band — they should light up when you talk. Strong activity outside that region (rumble left, hiss right) can hurt dictation accuracy.">
                FREQUENCY SPECTRUM
              </SectionLabel>
            </div>
            <Spectrum dataRef={freqDataRef} sampleRateRef={sampleRateRef} />
          </Panel>

          <button
            onClick={stop}
            style={{
              padding: "12px",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              border: `2px solid ${C.fg}`,
              background: "transparent",
              color: C.fg,
              cursor: "pointer",
              fontFamily: MONO,
              width: "100%",
            }}
          >
            Stop
          </button>
        </>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
