import { useCallback, useEffect, useRef, useState } from "react";

import {
  type Block,
  type ClientOperation,
  type CollaborationState,
  type ServerMessage,
  canSendOperation,
  initialState,
  reduceServerMessage,
} from "./collaboration";

export type ConnectionStatus = "Connected" | "Reconnecting" | "Disconnected";

function getClientId(): string {
  const stored = sessionStorage.getItem("collab-editor-client-id");
  if (stored) return stored;
  const clientId = crypto.randomUUID();
  sessionStorage.setItem("collab-editor-client-id", clientId);
  return clientId;
}

export function useCollaborativeDocument(documentId: string) {
  const [state, setState] = useState<CollaborationState>(() => ({
    ...initialState,
    pending: {},
  }));
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("Reconnecting");
  const stateRef = useRef(state);
  const websocketRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef(getClientId());
  const draftsRef = useRef(new Map<string, string>());
  const inFlightByBlockRef = useRef(new Map<string, string>());
  const debounceTimersRef = useRef(new Map<string, number>());
  const sendAttemptsRef = useRef(new Map<string, number>());
  const lastSentSocketRef = useRef(new Map<string, WebSocket>());

  const commit = useCallback(
    (update: (current: CollaborationState) => CollaborationState) => {
      const next = update(stateRef.current);
      stateRef.current = next;
      setState(next);
    },
    [],
  );

  const sendOperation = useCallback((operation: ClientOperation) => {
      const socket = websocketRef.current;
      const attempts = sendAttemptsRef.current.get(operation.tx_id) ?? 0;
      if (
        socket?.readyState !== WebSocket.OPEN ||
        lastSentSocketRef.current.get(operation.tx_id) === socket ||
        !canSendOperation(attempts)
      ) {
        return false;
      }
      socket.send(JSON.stringify(operation));
      sendAttemptsRef.current.set(operation.tx_id, attempts + 1);
      lastSentSocketRef.current.set(operation.tx_id, socket);
      return true;
  }, []);

  const queueOperation = useCallback(
    (operation: ClientOperation) => {
      commit((current) => ({
        ...current,
        pending: { ...current.pending, [operation.tx_id]: operation },
      }));
      sendOperation(operation);
    },
    [commit, sendOperation],
  );

  const flushUpdate = useCallback(
    (blockId: string) => {
      if (inFlightByBlockRef.current.has(blockId)) return;
      const block = stateRef.current.blocks.find((candidate) => candidate.id === blockId);
      const text = draftsRef.current.get(blockId);
      if (!block || text === undefined) return;

      const txId = crypto.randomUUID();
      inFlightByBlockRef.current.set(blockId, txId);
      queueOperation({
        type: "update_block",
        tx_id: txId,
        client_id: clientIdRef.current,
        block_id: blockId,
        base_version: block.version,
        text,
      });
    },
    [queueOperation],
  );

  useEffect(() => {
    let stopped = false;
    let reconnectTimer: number | undefined;
    const configuredBase = import.meta.env.VITE_WS_URL?.replace(/\/$/, "");
    const websocketBase = configuredBase ?? `ws://${window.location.hostname}:8000`;
    const websocketUrl = `${websocketBase}/ws/${encodeURIComponent(documentId)}`;

    const scheduleReconnect = () => {
      if (stopped) return;
      if (!navigator.onLine) {
        setConnectionStatus("Disconnected");
        return;
      }
      setConnectionStatus("Reconnecting");
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, 1200);
    };

    const handleMessage = (message: ServerMessage) => {
      if (message.type === "snapshot") {
        const retained: Record<string, ClientOperation> = {};
        const expired: ClientOperation[] = [];
        Object.values(stateRef.current.pending).forEach((operation) => {
          const attempts = sendAttemptsRef.current.get(operation.tx_id) ?? 0;
          if (canSendOperation(attempts)) retained[operation.tx_id] = operation;
          else expired.push(operation);
        });
        expired.forEach((operation) => {
          inFlightByBlockRef.current.delete(operation.block_id);
          draftsRef.current.delete(operation.block_id);
          sendAttemptsRef.current.delete(operation.tx_id);
          lastSentSocketRef.current.delete(operation.tx_id);
        });
        commit((current) =>
          reduceServerMessage(
            {
              ...current,
              pending: retained,
              lastAck:
                expired.length > 0
                  ? `${expired.at(-1)?.tx_id}: 已达到重试上限`
                  : current.lastAck,
            },
            message,
          ),
        );
        Object.values(retained).forEach(sendOperation);
        return;
      }

      const pendingOperation =
        "tx_id" in message ? stateRef.current.pending[message.tx_id] : undefined;
      commit((current) => reduceServerMessage(current, message));

      if (message.type === "operation" && message.block) {
        if (!inFlightByBlockRef.current.has(message.block.id)) {
          draftsRef.current.delete(message.block.id);
        }
        return;
      }

      if (message.type === "conflict" && pendingOperation) {
        inFlightByBlockRef.current.delete(pendingOperation.block_id);
        draftsRef.current.set(message.block.id, message.block.text);
        sendAttemptsRef.current.delete(message.tx_id);
        lastSentSocketRef.current.delete(message.tx_id);
        return;
      }

      if (message.type !== "ack" || !pendingOperation) return;
      inFlightByBlockRef.current.delete(pendingOperation.block_id);
      sendAttemptsRef.current.delete(message.tx_id);
      lastSentSocketRef.current.delete(message.tx_id);
      if (!message.success) {
        websocketRef.current?.close();
        return;
      }
      if (
        (pendingOperation.type === "update_block" ||
          pendingOperation.type === "create_block") &&
        message.block
      ) {
        const latestDraft = draftsRef.current.get(pendingOperation.block_id);
        if (latestDraft !== undefined && latestDraft !== message.block.text) {
          window.setTimeout(() => flushUpdate(pendingOperation.block_id), 0);
        } else {
          draftsRef.current.delete(pendingOperation.block_id);
        }
      }
    };

    function connect() {
      if (stopped || !navigator.onLine) {
        setConnectionStatus("Disconnected");
        return;
      }
      setConnectionStatus("Reconnecting");
      const socket = new WebSocket(websocketUrl);
      websocketRef.current = socket;

      socket.onopen = () => setConnectionStatus("Connected");
      socket.onmessage = (event) => {
        try {
          handleMessage(JSON.parse(event.data) as ServerMessage);
        } catch (error) {
          console.error("Ignored invalid WebSocket message", error);
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (websocketRef.current === socket) websocketRef.current = null;
        scheduleReconnect();
      };
    }

    const handleOnline = () => {
      if (!websocketRef.current) connect();
    };
    const handleOffline = () => {
      window.clearTimeout(reconnectTimer);
      setConnectionStatus("Disconnected");
      websocketRef.current?.close();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      const socket = websocketRef.current;
      websocketRef.current = null;
      socket?.close();
    };
  }, [commit, documentId, flushUpdate, sendOperation]);

  const updateBlock = useCallback(
    (blockId: string, text: string) => {
      draftsRef.current.set(blockId, text);
      commit((current) => ({
        ...current,
        blocks: current.blocks.map((block) =>
          block.id === blockId ? { ...block, text } : block,
        ),
      }));
      const previousTimer = debounceTimersRef.current.get(blockId);
      window.clearTimeout(previousTimer);
      debounceTimersRef.current.set(
        blockId,
        window.setTimeout(() => flushUpdate(blockId), 300),
      );
    },
    [commit, flushUpdate],
  );

  const createBlock = useCallback(() => {
    const previousBlock = stateRef.current.blocks.at(-1);
    const block: Block = { id: crypto.randomUUID(), text: "", version: 0 };
    const txId = crypto.randomUUID();
    inFlightByBlockRef.current.set(block.id, txId);
    commit((current) => ({ ...current, blocks: [...current.blocks, block] }));
    queueOperation({
      type: "create_block",
      tx_id: txId,
      client_id: clientIdRef.current,
      block_id: block.id,
      after_block_id: previousBlock?.id ?? null,
      text: block.text,
    });
  }, [commit, queueOperation]);

  const deleteBlock = useCallback(
    (blockId: string) => {
      if (inFlightByBlockRef.current.has(blockId)) return;
      const block = stateRef.current.blocks.find((candidate) => candidate.id === blockId);
      if (!block || block.version === 0) return;
      window.clearTimeout(debounceTimersRef.current.get(blockId));
      draftsRef.current.delete(blockId);
      commit((current) => ({
        ...current,
        blocks: current.blocks.filter((candidate) => candidate.id !== blockId),
      }));
      queueOperation({
        type: "delete_block",
        tx_id: crypto.randomUUID(),
        client_id: clientIdRef.current,
        block_id: blockId,
        base_version: block.version,
      });
    },
    [commit, queueOperation],
  );

  const isBlockPending = useCallback(
    (blockId: string) =>
      Object.values(state.pending).some((operation) => operation.block_id === blockId),
    [state.pending],
  );

  return {
    ...state,
    connectionStatus,
    updateBlock,
    createBlock,
    deleteBlock,
    isBlockPending,
  };
}
