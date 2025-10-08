# BetAI-Local AI Face-Swap (Next.js + FastAPI + InsightFace)

Real-time **face-swap** demo: Next.js frontend + FastAPI backend using **InsightFace** and ONNX model `inswapper_128.onnx`.

![Demo preview](public/video.gif)
Camera → JPEG frames via WebSocket → backend → swapped JPEGs back → rendered live.

> ⚠️ The model file (`inswapper_128.onnx`) is **not** included in Git. Place it manually under `backend/models/`.

---

## 📦 Project Structure

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

## ✅ Requirements

- Node.js 18+
- Python 3.10+ (3.11 recommended)
- Git
- (Optional GPU) CUDA 12.x + cuDNN for `onnxruntime-gpu`

---

## ⚙️ Environment Variables

Create a `.env.local` in the root of the repo:

```bash
NEXT_PUBLIC_BACKEND_WS=ws://127.0.0.1:8000/ws
NEXT_PUBLIC_BACKEND_UPLOAD=http://127.0.0.1:8000/upload-reference
```

---

## 🧩 Backend (FastAPI)

1. Create and activate a virtual environment:
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

2. Install dependencies (CPU version):
```powershell
pip install --upgrade pip
pip install fastapi uvicorn numpy opencv-python insightface onnxruntime
```

> 💡 For GPU:
> ```powershell
> pip uninstall -y onnxruntime
> pip install onnxruntime-gpu
> ```
> Then verify:
> ```powershell
> python -c "import onnxruntime as ort; print(ort.get_available_providers())"
> ```
> You should see `'CUDAExecutionProvider'` in the list.

3. Copy the model file:
```powershell
mkdir models
# Place your inswapper_128.onnx in backend/models/
```

4. Run the backend:
```powershell
uvicorn backend.app:app --host 127.0.0.1 --port 8000 --reload
```

---

## 🌐 Frontend (Next.js)

From the repo root:

```powershell
npm install
npm run dev
```

Then open: [http://localhost:3000](http://localhost:3000)

---

## ▶️ Usage

1. Click **"Upload reference"** and select a face image.  
2. Click **"Start camera"**, then **"Connect WS"**.  
3. The live camera stream is processed and faces are swapped in real time.  
4. You can start **recording** and download the `.webm` file afterward.  
5. The reference thumbnail is displayed in the UI for clarity.

---

## 🧠 Main Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| `POST` | `/upload-reference` | Upload reference image |
| `GET` | `/reference-thumb` | Get the current reference thumbnail |
| `GET` | `/reference-info` | Get reference metadata |
| `WS` | `/ws` | Live JPEG frame streaming + swap response |

---

## ⚡ Performance Tips

### CPU
- Reduce resolution to `640×360` for smoother FPS.  
- In `app.py`, tweak:
  ```python
  det_size=(384,384)
  DETECT_EVERY = 6
  ```
- JPEG quality `0.65–0.75` is a good balance.

### GPU
- Use `onnxruntime-gpu` + CUDA 12.x.  
- You can increase detector size for more accuracy (`512×512` or `640×640`).

---

## 🧰 Troubleshooting

### ❌ `FileNotFoundError: inswapper_128.onnx should exist`
→ Model not found — ensure it’s in `backend/models/inswapper_128.onnx`.

### ❌ `cublasLt64_12.dll missing`
→ CUDA Toolkit 12.x not installed or not added to PATH.  
Check:
```powershell
python -c "import onnxruntime as ort; print(ort.get_available_providers())"
```

### ❌ Camera doesn’t start
→ Grant browser camera permission (HTTPS required in some browsers).

---

## 🚀 Quick Start

1️⃣ Clone repo  
2️⃣ Copy `inswapper_128.onnx` → `backend/models/`  
3️⃣ Install dependencies (`pip`, `npm`)  
4️⃣ Start backend → `uvicorn backend.app:app --reload`  
5️⃣ Start frontend → `npm run dev`  
6️⃣ Open [http://localhost:3000](http://localhost:3000)  
7️⃣ Upload reference → Start camera → Connect WS → 🎉

---
