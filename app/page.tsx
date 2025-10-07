"use client";

import { useEffect, useRef, useState } from "react";
import { Link } from "@heroui/link";
import { Snippet } from "@heroui/snippet";
import { Code } from "@heroui/code";
import { button as buttonStyles } from "@heroui/theme";

import { siteConfig } from "@/config/site";
import { title, subtitle } from "@/components/primitives";
import { GithubIcon } from "@/components/icons";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  // --- функция запуска камеры ---
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

  // --- стоп камеры ---
  const stopCamera = () => {
    const video = videoRef.current;
    if (video && video.srcObject) {
      const tracks = (video.srcObject as MediaStream).getTracks();
      tracks.forEach((t) => t.stop());
      video.srcObject = null;
      setIsRunning(false);
    }
  };

  // --- отрисовка кадра на canvas (демо) ---
  useEffect(() => {
    let frameId: number;
    const draw = () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c && v.readyState >= 2) {
        const ctx = c.getContext("2d");
        if (ctx) {
          c.width = v.videoWidth;
          c.height = v.videoHeight;
          ctx.drawImage(v, 0, 0, c.width, c.height);
          // пример простого эффекта: рамка
          ctx.strokeStyle = "violet";
          ctx.lineWidth = 6;
          ctx.strokeRect(20, 20, c.width - 40, c.height - 40);
        }
      }
      frameId = requestAnimationFrame(draw);
    };
    if (isRunning) frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [isRunning]);

  return (
    <section className="flex flex-col items-center text-center">
      <div className="mt-16 w-full max-w-3xl flex flex-col items-center gap-4">
        <h2 className="text-xl font-semibold">🎥 Webcam Demo</h2>

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
        </div>

        <div className="flex gap-3">
          {!isRunning ? (
            <button
              onClick={startCamera}
              className="px-4 py-2 rounded-xl bg-violet-600 text-white hover:bg-violet-700"
            >
              Запустить камеру
            </button>
          ) : (
            <button
              onClick={stopCamera}
              className="px-4 py-2 rounded-xl bg-gray-200 hover:bg-gray-300"
            >
              Остановить
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
