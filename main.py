"""
Collaborative Whiteboard – FastAPI WebSocket Server (Phase 3)
=============================================================
Run with:
    pip install fastapi "uvicorn[standard]" motor
    uvicorn main:app --reload --port 8000

Requires a local MongoDB instance on mongodb://localhost:27017.
Install MongoDB: https://www.mongodb.com/docs/manual/installation/

Message types (client → server):
    DRAWING_UPDATE   { action: "ADD"|"UPDATE", element: {...} }
    DELETE_ELEMENT   { id: "element_id" }
    MOUSE_MOVE       { x, y }
    CLEAR_CANVAS     {}

Message types (server → client):
    INITIAL_STATE    { elements: [...] }          — sent only to the joining user
    DRAWING_UPDATE   { action, element }           — relayed to all other peers
    DELETE_ELEMENT   { id }                        — relayed to all other peers
    MOUSE_MOVE       { x, y }                      — relayed to all other peers
    CLEAR_CANVAS     {}                            — relayed to all other peers
    PEER_COUNT_UPDATE { count }                    — broadcast to everyone in room
    USER_LEFT        { userId }                    — relayed to all other peers
"""

import json
import logging
from collections import defaultdict
from typing import Dict, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("whiteboard")

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Collaborative Whiteboard", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── MongoDB ───────────────────────────────────────────────────────────────────

mongo_client: AsyncIOMotorClient = None
db = None
elements_col = None   # collection: whiteboard_app.elements


@app.on_event("startup")
async def startup():
    global mongo_client, db, elements_col
    mongo_client = AsyncIOMotorClient("mongodb://localhost:27017")
    db = mongo_client["whiteboard_app"]
    elements_col = db["elements"]
    # Index on element id for fast upserts, and on room_id for initial-state queries
    await elements_col.create_index("id", unique=True)
    await elements_col.create_index("room_id")
    log.info("MongoDB connected — whiteboard_app.elements ready")


@app.on_event("shutdown")
async def shutdown():
    if mongo_client:
        mongo_client.close()


# ── DB helpers ────────────────────────────────────────────────────────────────

async def db_upsert(element: dict, room_id: str) -> None:
    """Insert or fully replace an element document keyed on element['id']."""
    doc = {**element, "room_id": room_id}
    # Remove MongoDB's _id so we don't accidentally overwrite it
    doc.pop("_id", None)
    await elements_col.update_one(
        {"id": element["id"]},
        {"$set": doc},
        upsert=True,
    )


async def db_delete(element_id: str) -> None:
    await elements_col.delete_one({"id": element_id})


async def db_delete_room(room_id: str) -> None:
    result = await elements_col.delete_many({"room_id": room_id})
    log.info(f"[{room_id}] Cleared {result.deleted_count} elements from DB")


async def db_load_room(room_id: str) -> List[dict]:
    """Return all elements for a room, stripping MongoDB's internal _id."""
    cursor = elements_col.find({"room_id": room_id}, {"_id": 0})
    docs = await cursor.to_list(length=None)
    # Strip room_id before sending to clients — it's server-internal
    for doc in docs:
        doc.pop("room_id", None)
    return docs


# ── Connection Manager ────────────────────────────────────────────────────────

class ConnectionManager:
    """
    rooms: { room_id: { user_id: WebSocket } }
    """

    def __init__(self) -> None:
        self.rooms: Dict[str, Dict[str, WebSocket]] = defaultdict(dict)

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def connect(self, ws: WebSocket, room_id: str, user_id: str) -> None:
        await ws.accept()
        self.rooms[room_id][user_id] = ws
        count = len(self.rooms[room_id])
        log.info(f"[{room_id}] + {user_id}  ({count} online)")

    def disconnect(self, room_id: str, user_id: str) -> None:
        room = self.rooms.get(room_id, {})
        room.pop(user_id, None)
        log.info(f"[{room_id}] - {user_id}  ({len(room)} remaining)")
        if not room:
            self.rooms.pop(room_id, None)

    def user_count(self, room_id: str) -> int:
        return len(self.rooms.get(room_id, {}))

    # ── Sending ───────────────────────────────────────────────────────────────

    async def send(self, ws: WebSocket, payload: dict) -> None:
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            raise Exception("Failed to send message")

    async def broadcast(
        self,
        message: dict,
        room_id: str,
        exclude_user_id: str | None = None,
    ) -> None:
        """Send to everyone in room, optionally skipping the sender."""
        room = self.rooms.get(room_id, {})
        dead: List[str] = []
        raw = json.dumps(message)

        for uid, ws in list(room.items()):
            if uid == exclude_user_id:
                continue
            try:
                await ws.send_text(raw)
            except Exception:
                dead.append(uid)

        for uid in dead:
            log.warning(f"[{room_id}] Pruning stale connection: {uid}")
            room.pop(uid, None)

    async def broadcast_peer_count(self, room_id: str) -> None:
        """Tell everyone in the room how many users are currently connected."""
        count = self.user_count(room_id)
        await self.broadcast(
            {"type": "PEER_COUNT_UPDATE", "userId": "server", "payload": {"count": count}},
            room_id,
        )


manager = ConnectionManager()


# ── WebSocket Endpoint ────────────────────────────────────────────────────────

ALLOWED_TYPES = {"DRAWING_UPDATE", "DELETE_ELEMENT", "MOUSE_MOVE", "CLEAR_CANVAS"}


@app.websocket("/ws/{room_id}/{user_id}")
async def websocket_endpoint(ws: WebSocket, room_id: str, user_id: str) -> None:

    await manager.connect(ws, room_id, user_id)

    # 1. Send this user the persisted board state (history load)
    existing = await db_load_room(room_id)
    await manager.send(ws, {
        "type": "INITIAL_STATE",
        "userId": "server",
        "payload": {"elements": existing},
    })
    log.info(f"[{room_id}] Sent {len(existing)} persisted elements to {user_id}")

    # 2. Broadcast updated peer count to everyone (including the new user)
    await manager.broadcast_peer_count(room_id)

    try:
        while True:
            raw = await ws.receive_text()

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning(f"[{room_id}/{user_id}] Malformed JSON — dropped")
                continue

            msg_type = msg.get("type", "")

            if msg_type not in ALLOWED_TYPES:
                log.warning(f"[{room_id}/{user_id}] Unknown type '{msg_type}' — dropped")
                continue

            payload = msg.get("payload", {})

            # ── DRAWING_UPDATE (ADD or UPDATE) ────────────────────────────────
            if msg_type == "DRAWING_UPDATE":
                action  = payload.get("action", "")
                element = payload.get("element", {})
                el_id   = element.get("id", "?")

                if action in ("ADD", "UPDATE") and element:
                    await db_upsert(element, room_id)
                    log.info(f"[{room_id}] {user_id} → {action} {el_id}")

                await manager.broadcast(msg, room_id, exclude_user_id=user_id)

            # ── DELETE_ELEMENT ────────────────────────────────────────────────
            elif msg_type == "DELETE_ELEMENT":
                el_id = payload.get("id", "")
                if el_id:
                    await db_delete(el_id)
                    log.info(f"[{room_id}] {user_id} → DELETE {el_id}")
                await manager.broadcast(msg, room_id, exclude_user_id=user_id)

            # ── CLEAR_CANVAS ──────────────────────────────────────────────────
            elif msg_type == "CLEAR_CANVAS":
                await db_delete_room(room_id)
                await manager.broadcast(msg, room_id, exclude_user_id=user_id)

            # ── MOUSE_MOVE (relay only, no DB) ────────────────────────────────
            elif msg_type == "MOUSE_MOVE":
                await manager.broadcast(msg, room_id, exclude_user_id=user_id)

    except WebSocketDisconnect:
        manager.disconnect(room_id, user_id)

        await manager.broadcast(
            {"type": "USER_LEFT", "userId": "server", "payload": {"userId": user_id}},
            room_id,
            exclude_user_id=user_id,
        )
        # Broadcast updated peer count after disconnect
        await manager.broadcast_peer_count(room_id)


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    rooms = {
        room_id: {"users": list(users.keys()), "count": len(users)}
        for room_id, users in manager.rooms.items()
    }
    total_elements = await elements_col.count_documents({}) if elements_col else 0
    return {"status": "ok", "rooms": rooms, "total_elements_in_db": total_elements}
