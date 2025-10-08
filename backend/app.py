from fastapi import FastAPI, WebSocket, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketDisconnect
import os, numpy as np, cv2, insightface

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000","http://127.0.0.1:3000"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)
MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "inswapper_128.onnx")

face_app = insightface.app.FaceAnalysis(name="buffalo_l", providers=['CPUExecutionProvider'])
face_app.prepare(ctx_id=0, det_size=(640, 640))

if not os.path.exists(MODEL_PATH):
    raise FileNotFoundError(f"inswapper_128.onnx not found at: {MODEL_PATH}")

swapper = insightface.model_zoo.get_model(MODEL_PATH, providers=['CPUExecutionProvider'])
if swapper is None:
    raise RuntimeError("Failed to load inswapper from local file. Check onnxruntime/insightface versions.")

REF_FACE = None

def largest_face(faces):
    return max(faces, key=lambda f: (f.bbox[2]-f.bbox[0])*(f.bbox[1]-f.bbox[3]), default=None)

def overlay_watermark(img, text="AI face swap (local)"):
    out = img.copy()
    h, w = out.shape[:2]
    cv2.putText(out, text, (10, h-20), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0,0,0), 4, cv2.LINE_AA)
    cv2.putText(out, text, (10, h-20), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255,255,255), 2, cv2.LINE_AA)
    return out

@app.post("/upload-reference")
async def upload_reference(img: UploadFile = File(...)):
    global REF_FACE
    data = np.frombuffer(await img.read(), np.uint8)
    frame = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if frame is None:
        return {"ok": False, "msg": "Не удалось прочитать файл"}
    faces = face_app.get(frame)
    face = max(faces, key=lambda f: (f.bbox[2]-f.bbox[0])*(f.bbox[3]-f.bbox[1])) if faces else None
    if face is None:
        return {"ok": False, "msg": "Лицо не найдено"}
    REF_FACE = face
    return {"ok": True, "id": "char_1"}

@app.websocket("/ws")
async def ws_stream(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            data = await ws.receive_bytes()
            frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                await ws.send_bytes(data); continue

            if REF_FACE is None:
                out = overlay_watermark(frame, "Upload reference to start")
            else:
                faces = face_app.get(frame)
                tgt = max(faces, key=lambda f: (f.bbox[2]-f.bbox[0])*(f.bbox[3]-f.bbox[1])) if faces else None
                if tgt is None:
                    out = overlay_watermark(frame)
                else:
                    out = swapper.get(frame, tgt, REF_FACE, paste_back=True)
                    out = overlay_watermark(out)

            ok, buf = cv2.imencode(".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            await ws.send_bytes(buf.tobytes())
    except WebSocketDisconnect:
        pass
