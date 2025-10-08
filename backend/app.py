from fastapi import FastAPI, WebSocket, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketDisconnect
from fastapi.responses import Response, JSONResponse
import asyncio, os, numpy as np, cv2, insightface, onnxruntime as ort

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000","http://127.0.0.1:3000"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "inswapper_128.onnx")

avail = ort.get_available_providers()
PROVIDERS = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if 'CUDAExecutionProvider' in avail else ['CPUExecutionProvider']
print("ORT available providers:", avail)
print("Using providers:", PROVIDERS)

face_app = insightface.app.FaceAnalysis(name="buffalo_l", providers=PROVIDERS)
face_app.prepare(ctx_id=0, det_size=(384, 384)) 

if not os.path.exists(MODEL_PATH):
    raise FileNotFoundError(f"inswapper_128.onnx not found at: {MODEL_PATH}")

swapper = insightface.model_zoo.get_model(MODEL_PATH, providers=PROVIDERS)
if swapper is None:
    raise RuntimeError("Failed to load inswapper.")

REF_FACE = None           
REF_ID = None              
REF_THUMB_JPG = None       
LAST_TGT_BBOX = None
LAST_TGT_KPS = None
LAST_TGT_LM106 = None
LAST_TGT_EMB = None
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

def make_thumb(bgr, max_w=256):
    h, w = bgr.shape[:2]
    if w > max_w:
        s = max_w / float(w)
        bgr = cv2.resize(bgr, (max_w, int(h*s)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    return buf.tobytes() if ok else None

@app.post("/upload-reference")
async def upload_reference(img: UploadFile = File(...)):
    global REF_FACE, REF_ID, REF_THUMB_JPG
    data = np.frombuffer(await img.read(), np.uint8)
    frame = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if frame is None:
        return {"ok": False, "msg": "Не удалось прочитать файл"}

    faces = face_app.get(frame)
    face = largest_face(faces)
    if face is None:
        return {"ok": False, "msg": "Лицо не найдено"}

    REF_FACE = face
    REF_ID = (img.filename or "char").split("/")[-1][:64]
    REF_THUMB_JPG = make_thumb(frame)

    return {
        "ok": True,
        "id": REF_ID,
        "thumb": "/reference-thumb" if REF_THUMB_JPG else None
    }

@app.get("/reference-thumb")
async def reference_thumb():
    if REF_THUMB_JPG is None:
        return Response(status_code=404)
    return Response(content=REF_THUMB_JPG, media_type="image/jpeg")

@app.get("/reference-info")
async def reference_info():
    return JSONResponse({
        "id": REF_ID,
        "thumb": "/reference-thumb" if REF_THUMB_JPG else None,
        "has_face": REF_FACE is not None
    })

@app.websocket("/ws")
async def ws_stream(ws: WebSocket):
    global LAST_TGT_BBOX, LAST_TGT_KPS, LAST_TGT_LM106, LAST_TGT_EMB, FRAMES_SINCE_DET
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
                s = 640.0 / w
                frame = cv2.resize(frame, (640, int(h*s)), interpolation=cv2.INTER_AREA)

            if REF_FACE is None:
                out = overlay_watermark(frame, "")
            else:
                FRAMES_SINCE_DET += 1
                use_cache = (
                    LAST_TGT_BBOX is not None and
                    LAST_TGT_KPS is not None and
                    LAST_TGT_EMB is not None and
                    (FRAMES_SINCE_DET % DETECT_EVERY != 0)
                )

                if use_cache:
                    class FakeFace: pass
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
                    except Exception as e:
                        out = overlay_watermark(frame, f"swap error: {e}")

            ok, buf = cv2.imencode(".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
            await ws.send_bytes(buf.tobytes())
    except WebSocketDisconnect:
        pass
