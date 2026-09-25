from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from threading import RLock
from typing import Any


@dataclass(frozen=True)
class ApplyResult:
    message: dict[str, Any]
    applied: bool


@dataclass
class DocumentState:
    blocks: list[dict[str, Any]] = field(default_factory=list)
    processed_transactions: dict[str, dict[str, Any]] = field(default_factory=dict)


class DocumentStore:
    """Thread-safe in-memory authoritative state for all demo documents."""

    def __init__(self) -> None:
        self._documents: dict[str, DocumentState] = {}
        self._lock = RLock()

    def apply(self, document_id: str, operation: dict[str, Any]) -> ApplyResult:
        with self._lock:
            document = self._document(document_id)
            tx_id = operation.get("tx_id")
            if not isinstance(tx_id, str) or not tx_id:
                return ApplyResult(self._error_ack("", "tx_id is required."), False)

            previous = document.processed_transactions.get(tx_id)
            if previous is not None:
                return ApplyResult(deepcopy(previous), False)

            operation_type = operation.get("type")
            if operation_type == "create_block":
                result = self._create(document, operation)
            elif operation_type == "update_block":
                result = self._update(document, operation)
            elif operation_type == "delete_block":
                result = self._delete(document, operation)
            else:
                result = ApplyResult(
                    self._error_ack(tx_id, "Unsupported operation type."), False
                )

            document.processed_transactions[tx_id] = deepcopy(result.message)
            return result

    def snapshot(self, document_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return deepcopy(self._document(document_id).blocks)

    def _document(self, document_id: str) -> DocumentState:
        return self._documents.setdefault(document_id, DocumentState())

    @staticmethod
    def _block_index(document: DocumentState, block_id: str) -> int | None:
        return next(
            (index for index, block in enumerate(document.blocks) if block["id"] == block_id),
            None,
        )

    def _create(
        self, document: DocumentState, operation: dict[str, Any]
    ) -> ApplyResult:
        tx_id = operation["tx_id"]
        block_id = operation.get("block_id")
        text = operation.get("text", "")
        if not isinstance(block_id, str) or not block_id:
            return ApplyResult(self._error_ack(tx_id, "block_id is required."), False)
        if not isinstance(text, str):
            return ApplyResult(self._error_ack(tx_id, "text must be a string."), False)
        if self._block_index(document, block_id) is not None:
            return ApplyResult(self._error_ack(tx_id, "Block already exists."), False)

        block = {"id": block_id, "text": text, "version": 1}
        after_block_id = operation.get("after_block_id")
        if after_block_id is None:
            document.blocks.append(block)
        else:
            after_index = self._block_index(document, after_block_id)
            if after_index is None:
                return ApplyResult(
                    self._error_ack(tx_id, "after_block_id does not exist."), False
                )
            document.blocks.insert(after_index + 1, block)

        return ApplyResult(
            {
                "type": "ack",
                "tx_id": tx_id,
                "success": True,
                "operation_type": "create_block",
                "block": deepcopy(block),
            },
            True,
        )

    def _update(
        self, document: DocumentState, operation: dict[str, Any]
    ) -> ApplyResult:
        tx_id = operation["tx_id"]
        block_id = operation.get("block_id")
        index = self._block_index(document, block_id)
        if index is None:
            return ApplyResult(self._error_ack(tx_id, "Block does not exist."), False)

        block = document.blocks[index]
        conflict = self._version_conflict(operation, block)
        if conflict is not None:
            return conflict
        text = operation.get("text")
        if not isinstance(text, str):
            return ApplyResult(self._error_ack(tx_id, "text must be a string."), False)

        block["text"] = text
        block["version"] += 1
        return ApplyResult(
            {
                "type": "ack",
                "tx_id": tx_id,
                "success": True,
                "operation_type": "update_block",
                "block": deepcopy(block),
            },
            True,
        )

    def _delete(
        self, document: DocumentState, operation: dict[str, Any]
    ) -> ApplyResult:
        tx_id = operation["tx_id"]
        block_id = operation.get("block_id")
        index = self._block_index(document, block_id)
        if index is None:
            return ApplyResult(self._error_ack(tx_id, "Block does not exist."), False)

        conflict = self._version_conflict(operation, document.blocks[index])
        if conflict is not None:
            return conflict
        document.blocks.pop(index)
        return ApplyResult(
            {
                "type": "ack",
                "tx_id": tx_id,
                "success": True,
                "operation_type": "delete_block",
                "block_id": block_id,
            },
            True,
        )

    @staticmethod
    def _version_conflict(
        operation: dict[str, Any], block: dict[str, Any]
    ) -> ApplyResult | None:
        if operation.get("base_version") == block["version"]:
            return None
        return ApplyResult(
            {
                "type": "conflict",
                "tx_id": operation["tx_id"],
                "message": "Block version does not match the server version.",
                "block": deepcopy(block),
            },
            False,
        )

    @staticmethod
    def _error_ack(tx_id: str, error: str) -> dict[str, Any]:
        return {"type": "ack", "tx_id": tx_id, "success": False, "error": error}
