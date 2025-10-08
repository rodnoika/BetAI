from fastapi import FastAPI, WebSocket, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketDisconnect
import asyncio, os, numpy as np, cv2, insightface

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000","http://127.0.0.1:3000"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "inswapper_128.onnx")

PROVIDERS = ['CUDAExecutionProvider', 'CPUExecutionProvider']

face_app = insightface.app.FaceAnalysis(name="buffalo_l", providers=PROVIDERS)

face_app.prepare(ctx_id=0, det_size=(384, 384))

if not os.path.exists(MODEL_PATH):
    raise FileNotFoundError(f"inswapper_128.onnx not found at: {MODEL_PATH}")

swapper = insightface.model_zoo.get_model(MODEL_PATH, providers=PROVIDERS)
if swapper is None:
    raise RuntimeError("Failed to load inswapper from local file. Check onnxruntime/insightface versions/CUDA setup.")

REF_FACE = None
LAST_TGT_BBOX = None
FRAMES_SINCE_DET = 0
DETECT_EVERY = 4  

def area(face):
    x1, y1, x2, y2 = face.bbox.astype(int)
    return max(0, x2 - x1) * max(0, y2 - y1)

def largest_face(faces):
    return max(faces, key=area) if faces else None

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
    face = largest_face(faces)
    if face is None:
        return {"ok": False, "msg": "Лицо не найдено"}

    REF_FACE = face
    return {"ok": True, "id": "char_1"}

@app.websocket("/ws")
async def ws_stream(ws: WebSocket):
    global LAST_TGT_BBOX, FRAMES_SINCE_DET
    await ws.accept()
    try:
        while True:
            data = await ws.receive_bytes()
            while True:
                try:
                    data = await asyncio.wait_for(ws.receive_bytes(), timeout=0.001)
                except asyncio.TimeoutError:
                    break

            frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                await ws.send_bytes(data)
                continue

            h, w = frame.shape[:2]
            if w > 640:
                scale = 640.0 / w
                frame = cv2.resize(frame, (640, int(h * scale)), interpolation=cv2.INTER_AREA)

            if REF_FACE is None:
                out = overlay_watermark(frame, "Upload reference to start")
            else:
                FRAMES_SINCE_DET += 1
                tgt = None

                if LAST_TGT_BBOX is not None and (FRAMES_SINCE_DET % DETECT_EVERY != 0):
                    class FakeFace:
                        pass
                    tgt = FakeFace()
                    tgt.bbox = np.array(LAST_TGT_BBOX, dtype=np.float32)
                    tgt.kps = LAST_TGT_KPS
                    tgt.landmark_2d_106 = LAST_TGT_LM106
                    tgt.normed_embedding = LAST_TGT_EMB
                else:
                    faces = face_app.get(frame)
                    tgt = largest_face(faces)
                    FRAMES_SINCE_DET = 0
                    if tgt is not None:
                        LAST_TGT_BBOX = tgt.bbox.astype(float).tolist()
                        LAST_TGT_KPS = getattr(tgt, "kps", None)
                        LAST_TGT_LM106 = getattr(tgt, "landmark_2d_106", None)
                        LAST_TGT_EMB = getattr(tgt, "normed_embedding", None)

                if tgt is None:
                    out = overlay_watermark(frame)
                else:
                    try:
                        out = swapper.get(frame, tgt, REF_FACE, paste_back=True)
                        out = overlay_watermark(out)
                    except Exception as e:
                        out = overlay_watermark(frame, f"swap error: {e}")

            ok, buf = cv2.imencode(".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
            await ws.send_bytes(buf.tobytes())
    except WebSocketDisconnect:
        pass

