from fastapi import FastAPI, WebSocket, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketDisconnect
import numpy as np, cv2

app = FastAPI()

# CORS: разрешаем фронту с localhost:3000 (или оставь "*" на локалке)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/upload-reference")
async def upload_reference(img: UploadFile = File(...)):
    # читаем файл (просто для эхо-демо)
    await img.read()
    return {"ok": True, "id": "char_1"}

@app.websocket("/ws")
async def ws_stream(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            data = await ws.receive_bytes()   # получили JPEG
            frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            if frame is not None:
                h, w = frame.shape[:2]
                cv2.putText(frame, "echo server", (10, h-20),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0,0,0), 4, cv2.LINE_AA)
                cv2.putText(frame, "echo server", (10, h-20),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255,255,255), 2, cv2.LINE_AA)
                ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                await ws.send_bytes(buf.tobytes())
            else:
                await ws.send_bytes(data)
    except WebSocketDisconnect:
        pass
