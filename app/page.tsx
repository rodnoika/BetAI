"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS || "ws://127.0.0.1:8000/ws";
const UPLOAD_URL =
  process.env.NEXT_PUBLIC_BACKEND_UPLOAD ||
  "http://127.0.0.1:8000/upload-reference";
const PROCESS_URL =
  process.env.NEXT_PUBLIC_BACKEND_PROCESS_VIDEO ||
  "http://127.0.0.1:8000/process-video";

type DetectedFace = { idx: number; bbox: [number, number, number, number]; score: number };

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
  const processingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobStartTimeRef = useRef<number | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recState, setRecState] = useState<"idle" | "recording" | "stopped">("idle");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const [refId, setRefId] = useState<string | null>(null);
  const [refThumbUrl, setRefThumbUrl] = useState<string | null>(null);
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoStatus, setVideoStatus] = useState("");
  const [isVideoProcessing, setIsVideoProcessing] = useState(false);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [processedVideoUrl, setProcessedVideoUrl] = useState<string | null>(null);
  const [detectedFaces, setDetectedFaces] = useState<DetectedFace[]>([]);
  const [detectPreview, setDetectPreview] = useState<string | null>(null);
  const [detectSize, setDetectSize] = useState<{ w: number; h: number } | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [targetMsg, setTargetMsg] = useState<string>("");
  const [selectedTargetIdx, setSelectedTargetIdx] = useState<number | null>(null);
  const [hasBackendTarget, setHasBackendTarget] = useState(false);
  const lastDetectBlobRef = useRef<Blob | null>(null);

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
  const clearProcessingTimer = () => {
    if (processingTimerRef.current) {
      clearInterval(processingTimerRef.current);
      processingTimerRef.current = null;
    }
  };
  const etaTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clearEtaTimer = () => {
    if (etaTimerRef.current) {
      clearInterval(etaTimerRef.current);
      etaTimerRef.current = null;
    }
  };
  const clearJobPoll = () => {
    if (jobPollRef.current) {
      clearInterval(jobPollRef.current);
      jobPollRef.current = null;
    }
  };

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

  useEffect(() => {
    return () => clearProcessingTimer();
  }, []);

  useEffect(() => {
    return () => clearEtaTimer();
  }, []);

  useEffect(() => {
    return () => clearJobPoll();
  }, []);

  useEffect(() => {
    return () => {
      if (detectPreview) URL.revokeObjectURL(detectPreview);
    };
  }, [detectPreview]);

  const refreshTargetInfo = async () => {
    try {
      const r = await fetch(`${BACKEND_ORIGIN}/target-info`);
      const j = await r.json();
      setHasBackendTarget(!!j?.has_target);
    } catch {
      setHasBackendTarget(false);
    }
  };

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

  const captureFrame = async (): Promise<{ blob: Blob; url: string; w: number; h: number }> => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) {
      throw new Error("Нет активного кадра видео.");
    }
    const w = v.videoWidth || 640;
    const h = v.videoHeight || 360;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Нет доступа к canvas.");
    ctx.drawImage(v, 0, 0, w, h);
    const blob: Blob = await new Promise((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error("Не удалось получить кадр."))), "image/jpeg", 0.85)
    );
    const url = URL.createObjectURL(blob);
    return { blob, url, w, h };
  };

  const scanFaces = async () => {
    if (isDetecting) return;
    setIsDetecting(true);
    setTargetMsg("Сканируем лица...");
    try {
      const { blob, url, w, h } = await captureFrame();
      if (detectPreview) URL.revokeObjectURL(detectPreview);
      lastDetectBlobRef.current = blob;
      setDetectPreview(url);
      setDetectSize({ w, h });

      const fd = new FormData();
      fd.append("img", blob, "frame.jpg");
      const res = await fetch(`${BACKEND_ORIGIN}/detect-faces`, { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j?.ok) throw new Error(j?.msg || "Не удалось найти лица.");
      setDetectedFaces(j.faces || []);
      setTargetMsg(`Найдено лиц: ${j.count ?? (j.faces?.length || 0)}`);
    } catch (err: any) {
      setDetectedFaces([]);
      setTargetMsg(err?.message || "Ошибка сканирования.");
      alert(err?.message || "Ошибка сканирования.");
    } finally {
      setIsDetecting(false);
    }
  };

  const selectTargetFace = async (idx: number) => {
    if (idx === undefined || idx === null) return;
    const blob = lastDetectBlobRef.current;
    if (!blob) return alert("Сначала просканируйте кадр.");
    const fd = new FormData();
    fd.append("idx", String(idx));
    fd.append("img", blob, "frame.jpg");
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/select-target`, { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j?.ok) throw new Error(j?.msg || "Не удалось выбрать лицо.");
      setSelectedTargetIdx(idx);
      setTargetMsg(j.msg || "Целевое лицо выбрано");
      setHasBackendTarget(true);
      refreshTargetInfo();
    } catch (err: any) {
      alert(err?.message || "Ошибка выбора лица.");
    }
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

  const getVideoDuration = (file: File) =>
    new Promise<number>((resolve) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(v.duration || 0);
      };
      v.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(0);
      };
      v.src = url;
    });

  const formatEta = (seconds: number) => {
    const s = Math.max(0, Math.round(seconds));
    if (s >= 90) {
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return `${m}м ${rem}с`;
    }
    return `${s}с`;
  };

  const onUploadVideo = async (file: File) => {
    if (!file) return;
    if (isVideoProcessing) {
      alert("Дождитесь завершения текущей обработки.");
      return;
    }
    if (!hasBackendTarget) {
      const go = confirm("Целевое лицо не выбрано. Продолжить со случайным лицом?");
      if (!go) return;
    }
    if (processedVideoUrl) {
      URL.revokeObjectURL(processedVideoUrl);
      setProcessedVideoUrl(null);
    }
    setVideoProgress(0);
    setVideoStatus("Загружаем видео...");
    setIsVideoProcessing(true);
    setEtaSeconds(null);
    clearEtaTimer();
    clearJobPoll();

    const fd = new FormData();
    fd.append("video", file);

    let jobId: string | null = null;
    try {
      const res = await fetch(PROCESS_URL, { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j?.ok || !j.job_id) {
        const msg = j?.msg || "Сервер не принял видео.";
        throw new Error(msg);
      }
      jobId = j.job_id as string;
    } catch (err: any) {
      setIsVideoProcessing(false);
      setVideoStatus(err?.message || "Ошибка отправки");
      alert(err?.message || "Ошибка отправки видео.");
      return;
    }

    const duration = await getVideoDuration(file).catch(() => 0);
    const estimatedSeconds = Math.max(10, Math.min(300, duration * 1.1 + 8));
    setEtaSeconds(estimatedSeconds);
    jobStartTimeRef.current = Date.now();
    etaTimerRef.current = setInterval(() => {
      setEtaSeconds((s) => {
        if (s === null) return s;
        const next = Math.max(0, s - 1);
        if (next === 0) clearEtaTimer();
        return next;
      });
    }, 1000);

    const computeEta = (progress: number) => {
      if (!jobStartTimeRef.current || progress <= 0) return null;
      const elapsed = (Date.now() - jobStartTimeRef.current) / 1000;
      const remaining = elapsed * (100 - progress) / Math.max(progress, 1e-3);
      return remaining;
    };

    const pollJob = async () => {
      if (!jobId) return;
      try {
        const res = await fetch(`${BACKEND_ORIGIN}/job-status/${jobId}`);
        const j = await res.json();
        if (!res.ok || !j?.ok) {
          throw new Error(j?.msg || "Ошибка статуса");
        }
        const prog = typeof j.progress === "number" ? j.progress : 0;
        setVideoProgress(Math.max(0, Math.min(100, prog)));
        if (j.msg) setVideoStatus(j.msg);

        if (j.status === "processing") {
          const eta = computeEta(prog);
          setEtaSeconds(eta !== null ? eta : etaSeconds);
          return;
        }

        if (j.status === "done") {
          const resVideo = await fetch(`${BACKEND_ORIGIN}/job-result/${jobId}`);
          if (!resVideo.ok) {
            throw new Error("Не удалось получить файл результата.");
          }
          const blob = await resVideo.blob();
          const url = URL.createObjectURL(blob);
          setProcessedVideoUrl(url);
          setVideoProgress(100);
          setVideoStatus("Готово");
          setEtaSeconds(0);
          setIsVideoProcessing(false);
          clearJobPoll();
          clearEtaTimer();
          return;
        }

        if (j.status === "error") {
          throw new Error(j.msg || "Ошибка обработки.");
        }
      } catch (err: any) {
        setIsVideoProcessing(false);
        setVideoStatus(err?.message || "Ошибка обработки.");
        setEtaSeconds(null);
        clearJobPoll();
        clearEtaTimer();
        alert(err?.message || "Ошибка обработки.");
      }
    };

    pollJob();
    jobPollRef.current = setInterval(pollJob, 1000);
  };

  useEffect(() => {
    refreshRefInfo();
    refreshTargetInfo();
    const t = setInterval(() => {
      refreshRefInfo();
      refreshTargetInfo();
    }, 5000);
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

        <div className="w-full p-4 rounded-2xl border flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm font-semibold">Целевое лицо (выбор конкретного человека)</div>
            {targetMsg && (
              <span className="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-800">
                {targetMsg}
              </span>
            )}
            <span className="text-xs px-2 py-1 rounded-full border">
              Текущая цель: {hasBackendTarget ? "установлена" : "не выбрана"}
            </span>
            <button
              onClick={scanFaces}
              disabled={isDetecting || !isRunning}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white disabled:opacity-50"
            >
              {isDetecting ? "Сканируем..." : "Сканировать кадр"}
            </button>
          </div>

          {detectPreview ? (
            <div
              className="relative w-full max-w-3xl border rounded-xl overflow-hidden"
              style={{ aspectRatio: detectSize ? `${detectSize.w}/${detectSize.h}` : "16/9" }}
            >
              <img src={detectPreview} alt="Detected frame" className="w-full h-full object-contain" />
              {detectSize &&
                detectedFaces.map((f) => {
                  const [x1, y1, x2, y2] = f.bbox;
                  const left = (x1 / detectSize.w) * 100;
                  const top = (y1 / detectSize.h) * 100;
                  const width = ((x2 - x1) / detectSize.w) * 100;
                  const height = ((y2 - y1) / detectSize.h) * 100;
                  const isSelected = selectedTargetIdx === f.idx;
                  return (
                    <div
                      key={f.idx}
                      className={`absolute border-2 cursor-pointer ${isSelected ? "border-emerald-400" : "border-yellow-400"} bg-yellow-300/10`}
                      style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                      onClick={() => selectTargetFace(f.idx)}
                      title="Выбрать это лицо"
                    >
                      <div className="absolute -top-5 left-0 text-xs font-semibold bg-black text-white px-1 rounded">
                        #{f.idx}
                      </div>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="text-sm opacity-70">
              Нажмите "Сканировать кадр", затем кликните по нужному лицу, чтобы привязать подмену именно к нему.
            </div>
          )}
        </div>

        <div className="w-full p-4 rounded-2xl border flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm font-semibold">Видео с подменой лица (загрузка файла)</div>
            {videoStatus && (
              <span className="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-800">
                {videoStatus}
              </span>
            )}
            {isVideoProcessing && etaSeconds !== null && (
              <span className="text-xs px-2 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                ETA ~ {formatEta(etaSeconds)}
              </span>
            )}
            <label className="px-4 py-2 rounded-xl bg-slate-900 text-white cursor-pointer">
              Upload video
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => e.target.files && onUploadVideo(e.target.files[0])}
              />
            </label>
          </div>

          {(isVideoProcessing || videoProgress > 0) && (
            <div className="w-full h-2 rounded-full bg-gray-200 overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all duration-200"
                style={{ width: `${Math.min(100, Math.max(2, videoProgress))}%` }}
              />
            </div>
          )}

          {processedVideoUrl && (
            <div className="grid md:grid-cols-2 gap-3 items-center">
              <video
                controls
                src={processedVideoUrl}
                className="w-full rounded-xl border bg-black"
              />
              <div className="flex gap-3 items-center">
                <a
                  href={processedVideoUrl}
                  download={`faceswap_${Date.now()}.mp4`}
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white"
                >
                  Скачать результат
                </a>
                <div className="text-xs opacity-70">Готовый файл можно скачать или просмотреть справа.</div>
              </div>
            </div>
          )}
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
