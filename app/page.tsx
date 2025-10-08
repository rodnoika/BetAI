"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS || "ws://127.0.0.1:8000/ws";
const UPLOAD_URL =
  process.env.NEXT_PUBLIC_BACKEND_UPLOAD ||
  "http://127.0.0.1:8000/upload-reference";


export default function Home() {
  const BACKEND_ORIGIN = useMemo(() => {
    try {
      return new URL(UPLOAD_URL).origin;
    } catch {
      return "http://127.0.0.1:8000";
    }
  }, []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);  
  const outCanvasRef = useRef<HTMLCanvasElement | null>(null); 

  const [isRunning, setIsRunning] = useState(false);
  const [wsState, setWsState] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const rafRef = useRef<number | null>(null);
  const inflightRef = useRef(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recState, setRecState] = useState<"idle" | "recording" | "stopped">("idle");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const [refId, setRefId] = useState<string | null>(null);
  const [refThumbUrl, setRefThumbUrl] = useState<string | null>(null);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setIsRunning(true);
    } catch (err) {
      console.error("Camera error:", err);
      alert("Не удалось получить доступ к камере.");
    }
  };

  const stopCamera = () => {
    const v = videoRef.current;
    if (v?.srcObject) {
      (v.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    }
    setIsRunning(false);
  };

  const connectWs = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    setWsState("connecting");
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => setWsState("connected");
    ws.onclose = () => {
      setWsState("disconnected");
      wsRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      inflightRef.current = false;
    };
    ws.onerror = () => setWsState("disconnected");
    ws.onmessage = async (e) => {
      const outC = outCanvasRef.current;
      if (!outC) return;
      const bmp = await createImageBitmap(new Blob([e.data]));
      const ctx = outC.getContext("2d");
      if (!ctx) return;
      if (outC.width !== bmp.width || outC.height !== bmp.height) {
        outC.width = bmp.width;
        outC.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0, outC.width, outC.height);
      inflightRef.current = false;
    };
    wsRef.current = ws;
  };

  const disconnectWs = () => wsRef.current?.close();

  useEffect(() => {
    let raf: number | null = null;
    const loop = async () => {
      const ws = wsRef.current;
      const v = videoRef.current;
      const c = canvasRef.current;
      rafRef.current = raf = requestAnimationFrame(loop);
      if (!ws || ws.readyState !== WebSocket.OPEN || !v || !c || v.readyState < 2) return;
      if (inflightRef.current) return;

      const ctx = c.getContext("2d");
      if (!ctx) return;

      const targetW = 960; 
      const s = targetW / (v.videoWidth || targetW);
      const w = targetW;
      const h = Math.max(1, Math.round((v.videoHeight || targetW * 9 / 16) * s));
      if (c.width !== w || c.height !== h) {
        c.width = w; c.height = h;
      }
      ctx.drawImage(v, 0, 0, w, h);

      const blob: Blob = await new Promise((res) =>
        c.toBlob((b) => res(b!), "image/jpeg", 0.7)!
      );
      try {
        inflightRef.current = true;
        ws.send(await blob.arrayBuffer());
      } catch {
        inflightRef.current = false;
      }
    };

    if (isRunning && wsState === "connected") {
      rafRef.current = raf = requestAnimationFrame(loop);
    } else if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      inflightRef.current = false;
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      inflightRef.current = false;
    };
  }, [isRunning, wsState]);

  const refreshRefInfo = async () => {
    try {
      const r = await fetch(`${BACKEND_ORIGIN}/reference-info`);
      const j = await r.json();
      setRefId(j?.id || null);
      if (j?.thumb) {
        setRefThumbUrl(`${BACKEND_ORIGIN}${j.thumb}?ts=${Date.now()}`);
      } else {
        setRefThumbUrl(null);
      }
    } catch {}
  };

  const onUploadRef = async (file: File) => {
    const fd = new FormData();
    fd.append("img", file);
    const res = await fetch(UPLOAD_URL, { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    if (!j?.ok) {
      alert(j?.msg || "Сервер не принял изображение (нет лица?).");
      return;
    }
    setRefId(j.id || null);
    if (j.thumb) {
      setRefThumbUrl(`${BACKEND_ORIGIN}${j.thumb}?ts=${Date.now()}`);
    }
  };

  useEffect(() => {
    refreshRefInfo();
    const t = setInterval(refreshRefInfo, 5000);
    return () => clearInterval(t);
  }, [BACKEND_ORIGIN]);

  const startRecording = () => {
    if (recState === "recording") return;
    const outC = outCanvasRef.current;
    if (!outC) return alert("Нет выходного канваса для записи.");
    const stream = outC.captureStream(30); // 30 FPS
    const mime =
      MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm;codecs=vp8";

    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
    chunksRef.current = [];
    rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mime });
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      setRecState("stopped");
    };
    rec.start();
    recorderRef.current = rec;
    setRecState("recording");
  };

  const stopRecording = () => {
    if (recorderRef.current && recState === "recording") {
      recorderRef.current.stop();
    }
  };

  return (
    <section className="flex flex-col items-center justify-center gap-4 py-8 md:py-10">
      <div className="mt-6 w-full max-w-6xl flex flex-col items-center gap-6">
        <h2 className="text-xl font-semibold">AI Bet</h2>

        <div className="w-full flex items-center gap-4 p-3 rounded-xl border">
          <div className="text-sm opacity-70">Reference:</div>
          <div className="flex items-center gap-3">
            {refThumbUrl ? (
              <img src={refThumbUrl} alt="Reference" className="w-14 h-14 rounded-lg object-cover border" />
            ) : (
              <div className="w-14 h-14 rounded-lg border grid place-items-center text-xs opacity-60">нет</div>
            )}
            <div className="text-sm">Name: {refId || "—"}</div>
          </div>

          <label className="ml-auto px-4 py-2 rounded-xl bg-slate-900 text-white cursor-pointer">
            Upload reference
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files && onUploadRef(e.target.files[0])}
            />
          </label>
        </div>

        <div className="grid md:grid-cols-2 gap-4 w-full">
          <div className="relative border rounded-2xl overflow-hidden w-full bg-black" style={{ aspectRatio: "16/9" }}>
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-cover opacity-60"
              muted
              playsInline
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full object-contain"
            />
            <div className="absolute left-2 top-2 text-[11px] bg-white/20 backdrop-blur text-white px-2 py-0.5 rounded">
              Input
            </div>
          </div>

          <div className="relative border rounded-2xl overflow-hidden w-full bg-black" style={{ aspectRatio: "16/9" }}>
            <canvas
              ref={outCanvasRef}
              className="absolute inset-0 w-full h-full object-contain"
            />
            <div className="absolute left-2 top-2 text-[11px] bg-white/20 backdrop-blur text-white px-2 py-0.5 rounded">
              Output
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 w-full">
          {isRunning ? (
            <button onClick={stopCamera} className="px-4 py-2 rounded-xl bg-gray-200 hover:bg-gray-300">
              Camera: Stop
            </button>
          ) : (
            <button onClick={startCamera} className="px-4 py-2 rounded-xl bg-violet-600 text-white hover:bg-violet-700">
              Camera: Start
            </button>
          )}

          {wsState !== "connected" ? (
            <button onClick={connectWs} className="px-4 py-2 rounded-xl bg-black text-white">
              Turn on WS
            </button>
          ) : (
            <button onClick={disconnectWs} className="px-4 py-2 rounded-xl bg-gray-200 hover:bg-gray-300">
              Turn off WS
            </button>
          )}

          {recState !== "recording" ? (
            <button onClick={startRecording} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700">
              ⏺ Record
            </button>
          ) : (
            <button onClick={stopRecording} className="px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700">
              ⏹ Stop recording
            </button>
          )}

          <span className="text-sm opacity-70 self-center">
            WS: {wsState} • {new URL(WS_URL).host}
          </span>

          {downloadUrl && (
            <a
              href={downloadUrl}
              download={`faceswap_${Date.now()}.webm`}
              className="ml-auto px-4 py-2 rounded-xl bg-slate-800 text-white"
            >
              ⬇️ Download
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
