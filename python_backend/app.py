import base64
import io
import json
import os
import threading
from typing import List, Tuple, Optional

import cv2
import numpy as np
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(BASE_DIR, "dataset")
MODEL_DIR = os.path.join(BASE_DIR, "model")
LABELS_PATH = os.path.join(MODEL_DIR, "labels.json")
TRAINER_PATH = os.path.join(MODEL_DIR, "trainer.yml")
CASCADE_PATH = os.path.join(BASE_DIR, "haarcascade_frontalface_default.xml")

os.makedirs(DATASET_DIR, exist_ok=True)
os.makedirs(MODEL_DIR, exist_ok=True)


def ensure_cascade() -> str:
    # Prefer OpenCV built-in cascades path to avoid network dependency
    try:
        builtin_dir = getattr(cv2.data, "haarcascades", None)
        if isinstance(builtin_dir, str):
            builtin_path = os.path.join(builtin_dir, "haarcascade_frontalface_default.xml")
            if os.path.exists(builtin_path):
                return builtin_path
    except Exception:
        pass
    # Fallback to local file if provided alongside the app
    if os.path.exists(CASCADE_PATH):
        return CASCADE_PATH
    # If neither is available, instruct how to fix
    raise RuntimeError(
        "Haar 模型文件缺失。请安装 opencv-contrib-python(-headless) 或将 haarcascade_frontalface_default.xml 复制到 python_backend 目录。"
    )


def load_labels() -> dict:
    if os.path.exists(LABELS_PATH):
        with open(LABELS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"name_to_id": {}, "id_to_name": {}}


def save_labels(labels: dict) -> None:
    with open(LABELS_PATH, "w", encoding="utf-8") as f:
        json.dump(labels, f, ensure_ascii=False, indent=2)


# --- Utilities & Defaults ---
import re

DEFAULT_THRESHOLD: float = 80.0  # LBPH: 越小越相似；> 阈值则视为“未知”


def sanitize_name(name: str) -> str:
    """Sanitize user provided name to be filesystem-safe and consistent.
    保留中英文、数字、下划线和中横线，并限制长度，避免路径穿越等问题。
    """
    s = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fa5]+", "_", str(name).strip())
    return (s[:50] or "user")


def create_recognizer():
    """Create LBPH recognizer with unified parameters.
    统一参数，避免不同入口训练出来的模型行为不一致。
    """
    return cv2.face.LBPHFaceRecognizer_create(radius=1, neighbors=8, grid_x=8, grid_y=8)


def get_or_create_label_id(name: str, labels: dict) -> int:
    name = name.strip()
    if name in labels["name_to_id"]:
        return labels["name_to_id"][name]
    new_id = 1 + max([int(i) for i in labels["id_to_name"].keys()] or [0])
    labels["name_to_id"][name] = new_id
    labels["id_to_name"][str(new_id)] = name
    save_labels(labels)
    return new_id


def decode_image_base64(image_base64: str) -> np.ndarray:
    if image_base64.startswith("data:image"):
        image_base64 = image_base64.split(",", 1)[1]
    img_bytes = base64.b64decode(image_base64)
    img_array = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Invalid image data")
    return img


def _iou(box_a: Tuple[int, int, int, int], box_b: Tuple[int, int, int, int]) -> float:
    ax, ay, aw, ah = box_a
    bx, by, bw, bh = box_b
    ax2, ay2 = ax + aw, ay + ah
    bx2, by2 = bx + bw, by + bh

    inter_x1 = max(ax, bx)
    inter_y1 = max(ay, by)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    inter_area = inter_w * inter_h
    if inter_area <= 0:
        return 0.0
    area_a = aw * ah
    area_b = bw * bh
    return inter_area / float(area_a + area_b - inter_area + 1e-6)


def _nms_boxes(boxes: List[Tuple[int, int, int, int]], iou_threshold: float = 0.35) -> List[Tuple[int, int, int, int]]:
    if len(boxes) <= 1:
        return boxes
    # sort by area descending
    boxes_sorted = sorted(boxes, key=lambda b: b[2] * b[3], reverse=True)
    kept: List[Tuple[int, int, int, int]] = []
    for b in boxes_sorted:
        if all(_iou(b, k) < iou_threshold for k in kept):
            kept.append(b)
    return kept


def detect_faces_bgr(image_bgr: np.ndarray) -> List[Tuple[int, int, int, int]]:
    cascade_path = ensure_cascade()
    # Improve robustness with histogram equalization
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    h, w = gray.shape[:2]
    # 自适应最小人脸尺寸，避免远距离/小脸漏检；至少 80px
    min_side = min(w, h)
    min_size = int(max(80, min_side * 0.2))
    face_cascade = cv2.CascadeClassifier(cascade_path)
    faces = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.08,
        minNeighbors=6,
        minSize=(min_size, min_size)
    )
    # Deduplicate highly overlapping boxes (sometimes cascade returns multiple for one face)
    faces_list: List[Tuple[int, int, int, int]] = [tuple(map(int, f)) for f in faces]
    faces_nms = _nms_boxes(faces_list, iou_threshold=0.35)
    return faces_nms


def save_face_sample(name: str, image_bgr: np.ndarray) -> str:
    safe_name = sanitize_name(name)
    faces = detect_faces_bgr(image_bgr)
    if len(faces) == 0:
        raise ValueError("未检测到人脸")
    # Take the largest face
    x, y, w, h = sorted(faces, key=lambda b: b[2] * b[3], reverse=True)[0]
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    face_gray = gray[y : y + h, x : x + w]
    # Normalize to fixed size for recognizer
    face_gray = cv2.resize(face_gray, (200, 200))
    person_dir = os.path.join(DATASET_DIR, safe_name)
    os.makedirs(person_dir, exist_ok=True)
    idx = 1
    while True:
        filename = os.path.join(person_dir, f"{idx:03d}.png")
        if not os.path.exists(filename):
            break
        idx += 1
    cv2.imwrite(filename, face_gray)
    return filename


def build_training_data() -> Tuple[List[np.ndarray], List[int]]:
    labels = load_labels()
    images: List[np.ndarray] = []
    ids: List[int] = []
    for name in os.listdir(DATASET_DIR):
        person_dir = os.path.join(DATASET_DIR, name)
        if not os.path.isdir(person_dir):
            continue
        label_id = get_or_create_label_id(name, labels)
        for file in os.listdir(person_dir):
            if not file.lower().endswith((".png", ".jpg", ".jpeg")):
                continue
            path = os.path.join(person_dir, file)
            img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
            if img is None:
                continue
            images.append(img)
            ids.append(label_id)
    return images, ids


def train_model_async():
    def _train():
        images, ids = build_training_data()
        if len(images) == 0:
            return
        recognizer = create_recognizer()
        recognizer.train(images, np.array(ids))
        tmp = TRAINER_PATH + ".tmp"
        recognizer.save(tmp)
        os.replace(tmp, TRAINER_PATH)

    threading.Thread(target=_train, daemon=True).start()


def load_recognizer():
    if not os.path.exists(TRAINER_PATH):
        return None
    recognizer = create_recognizer()
    recognizer.read(TRAINER_PATH)
    return recognizer


class RegisterPayload(BaseModel):
    name: str
    image_base64: object  # str 或 List[str]


class RecognizePayload(BaseModel):
    image_base64: str
    threshold: Optional[float] = None


app = FastAPI(title="Community Face Backend (OpenCV)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/people")
def people():
    labels = load_labels()
    return {"people": list(labels["name_to_id"].keys())}


@app.post("/register")
def register(payload: RegisterPayload):
    if not payload.name or not payload.image_base64:
        raise HTTPException(status_code=400, detail="缺少参数")
    try:
        safe_name = sanitize_name(payload.name)
        saved = []
        if isinstance(payload.image_base64, list):
            for item in payload.image_base64:
                img = decode_image_base64(item)
                path = save_face_sample(safe_name, img)
                saved.append(path)
        else:
            img = decode_image_base64(str(payload.image_base64))
            path = save_face_sample(safe_name, img)
            saved.append(path)
        # ensure label exists and save
        labels = load_labels()
        _ = get_or_create_label_id(safe_name, labels)
        # retrain in background
        train_model_async()
        return {"ok": True, "saved": saved}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/recognize")
def recognize(payload: RecognizePayload):
    try:
        img = decode_image_base64(payload.image_base64)
        faces = detect_faces_bgr(img)
        if len(faces) == 0:
            return {"ok": True, "result": []}
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        recognizer = load_recognizer()
        labels = load_labels()
        results = []
        thr = float(payload.threshold) if payload.threshold is not None else DEFAULT_THRESHOLD
        for (x, y, w, h) in faces:
            face = cv2.resize(gray[y : y + h, x : x + w], (200, 200))
            if recognizer is None:
                results.append({"rect": [int(x), int(y), int(w), int(h)], "name": "未知", "confidence": None})
                continue
            label_id, dist = recognizer.predict(face)
            name = labels["id_to_name"].get(str(label_id), "未知")
            if dist > thr:
                name = "未知"
            results.append({
                "rect": [int(x), int(y), int(w), int(h)],
                "name": name,
                "confidence": float(dist),
            })
        return {"ok": True, "result": results, "threshold": thr}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/train")
def train():
    images, ids = build_training_data()
    if len(images) == 0:
        raise HTTPException(status_code=400, detail="没有训练样本")
    recognizer = create_recognizer()
    recognizer.train(images, np.array(ids))
    tmp = TRAINER_PATH + ".tmp"
    recognizer.save(tmp)
    os.replace(tmp, TRAINER_PATH)
    return {"ok": True, "samples": len(images)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=False)


