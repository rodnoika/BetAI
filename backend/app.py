from fastapi import FastAPI, WebSocket, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketDisconnect
from fastapi.responses import Response, JSONResponse, FileResponse
import asyncio, os, tempfile, uuid, threading, concurrent.futures
import numpy as np, cv2, insightface, onnxruntime as ort

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

JOBS = {}
job_lock = threading.Lock()
executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)

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

def process_frame_with_cache(frame, cache):
    """Run swap on a frame using a tiny cache to reduce detector calls."""
    if REF_FACE is None:
        return overlay_watermark(frame, "")

    cache["frames_since_det"] += 1
    use_cache = (
        cache["bbox"] is not None and
        cache["kps"] is not None and
        cache["emb"] is not None and
        (cache["frames_since_det"] % DETECT_EVERY != 0)
    )

    if use_cache:
        class FakeFace: pass
        tgt = FakeFace()
        tgt.bbox = np.array(cache["bbox"], dtype=np.float32)
        tgt.kps = cache["kps"]
        tgt.landmark_2d_106 = cache["lm106"]
        tgt.normed_embedding = cache["emb"]
    else:
        faces = face_app.get(frame)
        tgt = largest_face(faces)
        cache["frames_since_det"] = 0
        if tgt is not None:
            cache["bbox"] = tgt.bbox.astype(float).tolist()
            cache["kps"] = getattr(tgt, "kps", None)
            cache["lm106"] = getattr(tgt, "landmark_2d_106", None)
            cache["emb"] = getattr(tgt, "normed_embedding", None)

    if tgt is None:
        return overlay_watermark(frame)
    try:
        return swapper.get(frame, tgt, REF_FACE, paste_back=True)
    except Exception as e:
        return overlay_watermark(frame, f"swap error: {e}")

def register_job(job_id, status="queued", progress=0.0, msg="", result_path=None):
    with job_lock:
        JOBS[job_id] = {
            "status": status,
            "progress": float(progress),
            "msg": msg,
            "result_path": result_path,
        }

def update_job(job_id, **kwargs):
    with job_lock:
        if job_id not in JOBS:
            return
        JOBS[job_id].update(kwargs)

def get_job(job_id):
    with job_lock:
        return JOBS.get(job_id)

def process_video_job(job_id, in_path, filename):
    cache = {"bbox": None, "kps": None, "lm106": None, "emb": None, "frames_since_det": 0}

    cap = cv2.VideoCapture(in_path)
    if not cap.isOpened():
        update_job(job_id, status="error", msg="Не удалось прочитать видео.")
        os.remove(in_path)
        return

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 360)
    if width <= 0 or height <= 0:
        width, height = 640, 360
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    tmp_out = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
    tmp_out.close()
    writer = cv2.VideoWriter(
        tmp_out.name,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps if fps > 0 else 25.0,
        (width, height),
    )
    if not writer.isOpened():
        cap.release()
        os.remove(in_path)
        os.remove(tmp_out.name)
        update_job(job_id, status="error", msg="Не удалось подготовить файл для записи.")
        return

    try:
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            out = process_frame_with_cache(frame, cache)
            writer.write(out)
            idx += 1
            if frame_count > 0 and idx % 5 == 0:
                progress = min(99.0, (idx / frame_count) * 100.0)
                update_job(job_id, status="processing", progress=progress, msg="Обработка...")
        update_job(job_id, status="done", progress=100.0, msg="Готово", result_path=tmp_out.name)
    except Exception as e:
        update_job(job_id, status="error", msg=f"Ошибка обработки: {e}")
        try:
            os.remove(tmp_out.name)
        except OSError:
            pass
    finally:
        cap.release()
        writer.release()
        try:
            os.remove(in_path)
        except OSError:
            pass

@app.post("/process-video")
async def process_video(video: UploadFile = File(...)):
    """Accept a video, enqueue face swap job, return job id."""
    if REF_FACE is None:
        return JSONResponse({"ok": False, "msg": "Загрузите эталонное лицо перед обработкой видео."}, status_code=400)

    tmp_in = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(video.filename or ".mp4")[1] or ".mp4")
    try:
        while True:
            chunk = await video.read(1024 * 1024)
            if not chunk:
                break
            tmp_in.write(chunk)
        tmp_in.flush()
    finally:
        tmp_in.close()

    job_id = uuid.uuid4().hex
    register_job(job_id, status="queued", progress=0.0, msg="В очереди...")
    executor.submit(process_video_job, job_id, tmp_in.name, video.filename or "video.mp4")

    return JSONResponse({"ok": True, "job_id": job_id})

@app.get("/job-status/{job_id}")
async def job_status(job_id: str):
    job = get_job(job_id)
    if job is None:
        return JSONResponse({"ok": False, "msg": "job not found"}, status_code=404)
    return JSONResponse({
        "ok": True,
        "job_id": job_id,
        "status": job["status"],
        "progress": job.get("progress", 0.0),
        "msg": job.get("msg", ""),
        "ready": job["status"] == "done",
    })

@app.get("/job-result/{job_id}")
async def job_result(job_id: str):
    job = get_job(job_id)
    if job is None:
        return JSONResponse({"ok": False, "msg": "job not found"}, status_code=404)
    if job["status"] != "done" or not job.get("result_path"):
        return JSONResponse({"ok": False, "msg": "not ready"}, status_code=400)
    path = job["result_path"]
    if not os.path.exists(path):
        return JSONResponse({"ok": False, "msg": "file missing"}, status_code=404)
    return FileResponse(path, media_type="video/mp4", filename=f"faceswap_{job_id}.mp4")

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
