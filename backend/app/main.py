from __future__ import annotations

from collections import defaultdict
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from app.document_store import ApplyResult, DocumentStore


app = FastAPI(title="Collaborative Editor Demo")
store = DocumentStore()


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[str, list[WebSocket]] = defaultdict(list)

    async def connect(self, document_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[document_id].append(websocket)

    def disconnect(self, document_id: str, websocket: WebSocket) -> None:
        connections = self._connections[document_id]
        if websocket in connections:
            connections.remove(websocket)
        if not connections:
            self._connections.pop(document_id, None)

    def count(self, document_id: str) -> int:
        return len(self._connections.get(document_id, []))

    async def broadcast(
        self, document_id: str, message: dict[str, Any], exclude: WebSocket | None = None
    ) -> None:
        for connection in list(self._connections.get(document_id, [])):
            if connection is not exclude:
                await connection.send_json(message)


manager = ConnectionManager()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws/{document_id}")
async def document_websocket(websocket: WebSocket, document_id: str) -> None:
    await manager.connect(document_id, websocket)
    try:
        await websocket.send_json(
            {
                "type": "snapshot",
                "document_id": document_id,
                "blocks": store.snapshot(document_id),
                "online_users": manager.count(document_id),
            }
        )
        await manager.broadcast(
            document_id,
            {"type": "presence", "online_users": manager.count(document_id)},
        )

        while True:
            operation = await websocket.receive_json()
            result = store.apply(document_id, operation)
            await websocket.send_json(result.message)
            if result.applied:
                await manager.broadcast(
                    document_id,
                    operation_event(operation, result),
                    exclude=websocket,
                )
    except WebSocketDisconnect:
        manager.disconnect(document_id, websocket)
        await manager.broadcast(
            document_id,
            {"type": "presence", "online_users": manager.count(document_id)},
        )


def operation_event(operation: dict[str, Any], result: ApplyResult) -> dict[str, Any]:
    event: dict[str, Any] = {
        "type": "operation",
        "operation_type": operation["type"],
        "tx_id": operation["tx_id"],
        "client_id": operation.get("client_id", "unknown"),
    }
    if "block" in result.message:
        event["block"] = result.message["block"]
    if operation["type"] == "create_block":
        event["after_block_id"] = operation.get("after_block_id")
    if "block_id" in result.message:
        event["block_id"] = result.message["block_id"]
    return event
