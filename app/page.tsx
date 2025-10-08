"use client";

import { useEffect, useRef, useState } from "react";

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS || "ws://127.0.0.1:8000/ws";
const UPLOAD_URL =
  process.env.NEXT_PUBLIC_BACKEND_UPLOAD ||
  "http://127.0.0.1:8000/upload-reference";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const outImgRef = useRef<HTMLImageElement | null>(null);

  const [isRunning, setIsRunning] = useState(false);
  const [wsState, setWsState] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const rafRef = useRef<number | null>(null);

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

  // --- WebSocket ---
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
    };
    ws.onerror = () => setWsState("disconnected");
    ws.onmessage = (e) => {
      const url = URL.createObjectURL(new Blob([e.data]));
      const img = outImgRef.current;
      if (img) {
        const old = img.src;
        img.src = url;
        if (old) URL.revokeObjectURL(old);
      }
    };
    wsRef.current = ws;
  };

  const disconnectWs = () => wsRef.current?.close();

  useEffect(() => {
    let last = 0;
    const loop = async (t: number) => {
      const ws = wsRef.current;
      const v = videoRef.current;
      const c = canvasRef.current;
      rafRef.current = requestAnimationFrame(loop);
      if (!ws || ws.readyState !== WebSocket.OPEN || !v || !c || v.readyState < 2) return;

      if (t - last < 33) return;
      last = t;

      const ctx = c.getContext("2d");
      if (!ctx) return;
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      ctx.drawImage(v, 0, 0, c.width, c.height);

      ctx.strokeStyle = "violet";
      ctx.lineWidth = 6;
      ctx.strokeRect(20, 20, c.width - 40, c.height - 40);

      const blob: Blob = await new Promise((res) =>
        c.toBlob((b) => res(b!), "image/jpeg", 0.8)!
      );
      try {
        ws.send(await blob.arrayBuffer());
      } catch {}
    };

    if (isRunning && wsState === "connected") {
      rafRef.current = requestAnimationFrame(loop);
    } else if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isRunning, wsState]);

  const onUploadRef = async (file: File) => {
    const fd = new FormData();
    fd.append("img", file);
    const res = await fetch(UPLOAD_URL, { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    if (!j?.ok) alert(j?.msg || "Сервер не принял изображение (нет лица?).");
  };

  return (
    <section className="flex flex-col items-center justify-center gap-4 py-8 md:py-10">

      <div className="mt-16 w-full max-w-4xl flex flex-col items-center gap-4">
        <h2 className="text-xl font-semibold">🎥 Webcam → WS → Output</h2>

        <div className="grid md:grid-cols-2 gap-4 w-full">
          <div className="relative border rounded-2xl overflow-hidden w-full aspect-video bg-black">
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
              Вход (отправляется на сервер)
            </div>
          </div>

          <div className="relative border rounded-2xl overflow-hidden w-full aspect-video bg-black">
            <img
              ref={outImgRef}
              className="absolute inset-0 w-full h-full object-contain"
              alt="AI output"
            />
            <div className="absolute left-2 top-2 text-[11px] bg-white/20 backdrop-blur text-white px-2 py-0.5 rounded">
              Выход (от сервера)
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          {isRunning ? (
            <button onClick={stopCamera} className="px-4 py-2 rounded-xl bg-gray-200 hover:bg-gray-300">
              Камера: стоп
            </button>
          ) : (
            <button onClick={startCamera} className="px-4 py-2 rounded-xl bg-violet-600 text-white hover:bg-violet-700">
              Камера: старт
            </button>
          )}

          {wsState !== "connected" ? (
            <button onClick={connectWs} className="px-4 py-2 rounded-xl bg-black text-white">
              Подключить WS
            </button>
          ) : (
            <button onClick={disconnectWs} className="px-4 py-2 rounded-xl bg-gray-200 hover:bg-gray-300">
              Отключить WS
            </button>
          )}

          <label className="px-4 py-2 rounded-xl bg-slate-900 text-white cursor-pointer">
            Загрузить референс
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files && onUploadRef(e.target.files[0])}
            />
          </label>

          <span className="text-sm opacity-70 self-center">
            WS: {wsState} • {WS_URL.replace(/^ws(s)?:\/\//, "")}
          </span>
        </div>
      </div>
    </section>
  );
}
