from fastapi.testclient import TestClient

from app.main import app


def test_two_clients_receive_presence_ack_and_operation_broadcast() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/integration-test") as first:
            assert first.receive_json() == {
                "type": "snapshot",
                "document_id": "integration-test",
                "blocks": [],
                "online_users": 1,
            }
            assert first.receive_json() == {"type": "presence", "online_users": 1}

            with client.websocket_connect("/ws/integration-test") as second:
                assert second.receive_json() == {
                    "type": "snapshot",
                    "document_id": "integration-test",
                    "blocks": [],
                    "online_users": 2,
                }
                assert second.receive_json() == {"type": "presence", "online_users": 2}
                assert first.receive_json() == {"type": "presence", "online_users": 2}

                operation = {
                    "type": "create_block",
                    "tx_id": "ws-create",
                    "client_id": "client-a",
                    "block_id": "ws-block",
                    "after_block_id": None,
                    "text": "Shared text",
                }
                first.send_json(operation)

                assert first.receive_json() == {
                    "type": "ack",
                    "tx_id": "ws-create",
                    "success": True,
                    "operation_type": "create_block",
                    "block": {"id": "ws-block", "text": "Shared text", "version": 1},
                }
                assert second.receive_json() == {
                    "type": "operation",
                    "operation_type": "create_block",
                    "tx_id": "ws-create",
                    "client_id": "client-a",
                    "after_block_id": None,
                    "block": {"id": "ws-block", "text": "Shared text", "version": 1},
                }
