# BetAI-Local AI Face-Swap (Next.js + FastAPI + InsightFace)

Real-time **face-swap** demo: Next.js frontend + FastAPI backend using **InsightFace** and ONNX model `inswapper_128.onnx`.

![Demo preview](public/video.gif)


> The model file (`inswapper_128.onnx`) is **not** included in Git. Place it manually under `backend/models/`.

---

## Project Structure

```
.
├─ app/                     # Next.js (App Router)
│  └─ page.tsx             # Frontend logic (camera, WS stream, recorder, reference preview)
├─ backend/
│  ├─ app.py               # FastAPI: upload, reference info, WS processing, watermark overlay
│  └─ models/
│     └─ inswapper_128.onnx  # <-- Put your ONNX model here
├─ .gitignore
└─ README.md
```

---

## Requirements

- Node.js 18+
- Python 3.10+ (3.11 recommended)
- Git
- (Optional GPU) CUDA 12.x + cuDNN for `onnxruntime-gpu`

---

## Environment Variables
```bash
NEXT_PUBLIC_BACKEND_WS=ws://127.0.0.1:8000/ws
NEXT_PUBLIC_BACKEND_UPLOAD=http://127.0.0.1:8000/upload-reference
```

---

## Install dependencies for Backend

2. For CPU:
```powershell
pip install --upgrade pip
pip install fastapi uvicorn numpy opencv-python insightface onnxruntime
```

> 💡 For GPU:
> ```powershell
> pip uninstall -y onnxruntime
> pip install onnxruntime-gpu
> ```

---

## Main Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| `POST` | `/upload-reference` | Upload reference image |
| `GET` | `/reference-thumb` | Get the current reference thumbnail |
| `GET` | `/reference-info` | Get reference metadata |
| `WS` | `/ws` | Live JPEG frame streaming + swap response |

### GPU
- Use `onnxruntime-gpu` + CUDA 12.x.  
- You can increase detector size for more accuracy (`512×512` or `640×640`).

## Quick Start

1 Clone repo  
2️ Place model in `backend/models/`(For example `inswapper_128.onnx`) 
3️ Install dependencies (`pip`, `npm`)  
4️ Start backend → `uvicorn backend.app:app --reload`  
5️ Start frontend → `npm run dev`

---
