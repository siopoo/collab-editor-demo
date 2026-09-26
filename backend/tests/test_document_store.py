import pytest

from app.document_store import DocumentStore


@pytest.fixture
def store() -> DocumentStore:
    return DocumentStore()


def create_operation(tx_id: str = "tx-create") -> dict:
    return {
        "type": "create_block",
        "tx_id": tx_id,
        "client_id": "client-a",
        "block_id": "block-1",
        "after_block_id": None,
        "text": "Hello",
    }


def test_create_block_adds_a_stable_block(store: DocumentStore) -> None:
    result = store.apply("demo", create_operation())

    assert result.applied is True
    assert result.message == {
        "type": "ack",
        "tx_id": "tx-create",
        "success": True,
        "operation_type": "create_block",
        "block": {"id": "block-1", "text": "Hello", "version": 1},
    }
    assert store.snapshot("demo") == [
        {"id": "block-1", "text": "Hello", "version": 1}
    ]


def test_update_block_changes_text_and_increments_version(store: DocumentStore) -> None:
    store.apply("demo", create_operation())

    result = store.apply(
        "demo",
        {
            "type": "update_block",
            "tx_id": "tx-update",
            "client_id": "client-a",
            "block_id": "block-1",
            "base_version": 1,
            "text": "Hello, team",
        },
    )

    assert result.applied is True
    assert result.message["block"] == {
        "id": "block-1",
        "text": "Hello, team",
        "version": 2,
    }


def test_delete_block_removes_it_from_the_document(store: DocumentStore) -> None:
    store.apply("demo", create_operation())

    result = store.apply(
        "demo",
        {
            "type": "delete_block",
            "tx_id": "tx-delete",
            "client_id": "client-a",
            "block_id": "block-1",
            "base_version": 1,
        },
    )

    assert result.applied is True
    assert result.message == {
        "type": "ack",
        "tx_id": "tx-delete",
        "success": True,
        "operation_type": "delete_block",
        "block_id": "block-1",
    }
    assert store.snapshot("demo") == []


def test_two_updates_with_same_base_version_produce_one_success_and_one_conflict(
    store: DocumentStore,
) -> None:
    store.apply("demo", create_operation())
    store.apply(
        "demo",
        {
            "type": "update_block",
            "tx_id": "tx-first-update",
            "client_id": "client-a",
            "block_id": "block-1",
            "base_version": 1,
            "text": "Server wins",
        },
    )

    result = store.apply(
        "demo",
        {
            "type": "update_block",
            "tx_id": "tx-stale-update",
            "client_id": "client-b",
            "block_id": "block-1",
            "base_version": 1,
            "text": "Stale edit",
        },
    )

    assert result.applied is False
    assert result.message == {
        "type": "conflict",
        "tx_id": "tx-stale-update",
        "message": "Block version does not match the server version.",
        "block": {"id": "block-1", "text": "Server wins", "version": 2},
    }
    assert store.snapshot("demo")[0]["text"] == "Server wins"


def test_duplicate_tx_id_returns_original_ack_without_applying_twice(
    store: DocumentStore,
) -> None:
    operation = create_operation()

    first = store.apply("demo", operation)
    duplicate = store.apply("demo", operation)

    assert first.message == duplicate.message
    assert duplicate.applied is False
    assert store.snapshot("demo") == [
        {"id": "block-1", "text": "Hello", "version": 1}
    ]


def test_retried_update_with_same_tx_id_does_not_increment_version_twice(
    store: DocumentStore,
) -> None:
    store.apply("demo", create_operation())
    operation = {
        "type": "update_block",
        "tx_id": "tx-update",
        "client_id": "client-a",
        "block_id": "block-1",
        "base_version": 1,
        "text": "Updated once",
    }

    first = store.apply("demo", operation)
    retry = store.apply("demo", operation)

    assert first.message == retry.message
    assert retry.applied is False
    assert store.snapshot("demo") == [
        {"id": "block-1", "text": "Updated once", "version": 2}
    ]


def test_update_after_delete_is_rejected_without_recreating_block(
    store: DocumentStore,
) -> None:
    store.apply("demo", create_operation())
    store.apply(
        "demo",
        {
            "type": "delete_block",
            "tx_id": "tx-delete",
            "client_id": "client-a",
            "block_id": "block-1",
            "base_version": 1,
        },
    )

    result = store.apply(
        "demo",
        {
            "type": "update_block",
            "tx_id": "tx-late-update",
            "client_id": "client-b",
            "block_id": "block-1",
            "base_version": 1,
            "text": "Late edit",
        },
    )

    assert result.applied is False
    assert result.message == {
        "type": "ack",
        "tx_id": "tx-late-update",
        "success": False,
        "error": "Block does not exist.",
    }
    assert store.snapshot("demo") == []
