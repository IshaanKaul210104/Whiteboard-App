"""
Collaborative Whiteboard – FastAPI WebSocket Server
====================================================
Run with:
    pip install fastapi uvicorn
    uvicorn main:app --reload --port 8000

Architecture
------------
- Each room is an isolated broadcast group.
- The server is a pure relay: it receives a JSON message from one client
  and fans it out to every OTHER client in the same room.
- No persistence — board state lives in the clients.

Message envelope (all messages share this shape):
    {
        "type":    "DRAWING_UPDATE" | "MOUSE_MOVE" | "CLEAR_CANVAS",
        "userId":  "<string>",      # sender's ephemeral ID
        "payload": { ... }          # type-specific data (see below)
    }

DRAWING_UPDATE payload:
    { "action": "ADD" | "UPDATE" | "DELETE", "element": { ...elementObject } }

MOUSE_MOVE payload:
    { "x": float, "y": float }

CLEAR_CANVAS payload:
    {}
"""

import json
import logging
from collections import defaultdict
from typing import Dict, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("whiteboard")

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Collaborative Whiteboard", version="2.0.0")

# Allow the React dev-server (and any localhost origin) to connect.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Connection Manager ────────────────────────────────────────────────────────

class ConnectionManager:
    """
    Tracks live WebSocket connections grouped by room_id.

    rooms: { room_id: { user_id: WebSocket } }
    """

    def __init__(self) -> None:
        # room_id → { user_id → WebSocket }
        self.rooms: Dict[str, Dict[str, WebSocket]] = defaultdict(dict)

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def connect(self, websocket: WebSocket, room_id: str, user_id: str) -> None:
        await websocket.accept()
        self.rooms[room_id][user_id] = websocket
        peer_count = len(self.rooms[room_id])
        log.info(f"[{room_id}] + {user_id}  ({peer_count} peer{'s' if peer_count != 1 else ''} total)")

        # Notify the new user how many peers are already in the room
        await websocket.send_text(json.dumps({
            "type": "ROOM_INFO",
            "userId": "server",
            "payload": {
                "yourId": user_id,
                "peers": [uid for uid in self.rooms[room_id] if uid != user_id],
            },
        }))

    def disconnect(self, room_id: str, user_id: str) -> None:
        room = self.rooms.get(room_id, {})
        room.pop(user_id, None)
        log.info(f"[{room_id}] - {user_id}  ({len(room)} remaining)")
        # Clean up empty rooms
        if not room:
            self.rooms.pop(room_id, None)

    # ── Broadcast ─────────────────────────────────────────────────────────────

    async def broadcast(
        self,
        message: str,
        room_id: str,
        exclude_user_id: str,
    ) -> None:
        """Send `message` to every connection in `room_id` except the sender."""
        room = self.rooms.get(room_id, {})
        dead: List[str] = []

        for uid, ws in room.items():
            if uid == exclude_user_id:
                continue
            try:
                await ws.send_text(message)
            except Exception:
                # Socket died mid-flight — mark for cleanup
                dead.append(uid)

        for uid in dead:
            log.warning(f"[{room_id}] Removing stale connection: {uid}")
            room.pop(uid, None)

    def user_count(self, room_id: str) -> int:
        return len(self.rooms.get(room_id, {}))


manager = ConnectionManager()


# ── WebSocket Endpoint ────────────────────────────────────────────────────────

@app.websocket("/ws/{room_id}/{user_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str,
    user_id: str,
) -> None:
    """
    One persistent connection per (room_id, user_id) pair.

    Expected message types from the client:
        DRAWING_UPDATE  – shape added, updated, or deleted
        MOUSE_MOVE      – cursor position (throttled on client side)
        CLEAR_CANVAS    – wipe the whole board

    The server validates the type and relays the raw JSON to all other peers.
    Unknown message types are logged and dropped.
    """
    await manager.connect(websocket, room_id, user_id)

    try:
        while True:
            raw = await websocket.receive_text()

            # Parse & validate envelope
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning(f"[{room_id}/{user_id}] Malformed JSON — dropped")
                continue

            msg_type = msg.get("type", "")

            if msg_type not in ("DRAWING_UPDATE", "MOUSE_MOVE", "CLEAR_CANVAS"):
                log.warning(f"[{room_id}/{user_id}] Unknown type '{msg_type}' — dropped")
                continue

            if msg_type == "DRAWING_UPDATE":
                action = msg.get("payload", {}).get("action", "?")
                el_id  = msg.get("payload", {}).get("element", {}).get("id", "?")
                log.info(f"[{room_id}] {user_id} → DRAWING_UPDATE action={action} id={el_id}")

            elif msg_type == "CLEAR_CANVAS":
                log.info(f"[{room_id}] {user_id} → CLEAR_CANVAS")

            # Relay to everyone else in the room (MOUSE_MOVE logged at DEBUG only)
            await manager.broadcast(raw, room_id, exclude_user_id=user_id)

    except WebSocketDisconnect:
        manager.disconnect(room_id, user_id)
        # Tell remaining peers this user left so they can remove their cursor
        await manager.broadcast(
            json.dumps({
                "type": "USER_LEFT",
                "userId": "server",
                "payload": { "userId": user_id },
            }),
            room_id,
            exclude_user_id=user_id,
        )


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "rooms": {
            room_id: list(users.keys())
            for room_id, users in manager.rooms.items()
        },
    }
