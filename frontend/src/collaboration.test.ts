import { describe, expect, it } from "vitest";

import {
  canSendOperation,
  initialState,
  reduceServerMessage,
} from "./collaboration";


describe("reduceServerMessage", () => {
  it("replaces local state with an authoritative snapshot", () => {
    const state = reduceServerMessage(initialState, {
      type: "snapshot",
      document_id: "demo",
      online_users: 2,
      blocks: [{ id: "one", text: "Shared", version: 3 }],
    });

    expect(state.blocks).toEqual([{ id: "one", text: "Shared", version: 3 }]);
    expect(state.onlineUsers).toBe(2);
  });

  it("applies a remote update by stable block id", () => {
    const existing = {
      ...initialState,
      blocks: [{ id: "one", text: "Before", version: 1 }],
    };

    const state = reduceServerMessage(existing, {
      type: "operation",
      operation_type: "update_block",
      tx_id: "remote-update",
      client_id: "other-client",
      block: { id: "one", text: "After", version: 2 },
    });

    expect(state.blocks).toEqual([{ id: "one", text: "After", version: 2 }]);
  });

  it("uses the latest server block and records a visible conflict", () => {
    const existing = {
      ...initialState,
      blocks: [{ id: "one", text: "Local draft", version: 1 }],
      pending: {
        "local-update": {
          type: "update_block" as const,
          tx_id: "local-update",
          client_id: "client-a",
          block_id: "one",
          base_version: 1,
          text: "Local draft",
        },
      },
    };

    const state = reduceServerMessage(existing, {
      type: "conflict",
      tx_id: "local-update",
      message: "Block version does not match the server version.",
      block: { id: "one", text: "Server copy", version: 2 },
    });

    expect(state.blocks).toEqual([{ id: "one", text: "Server copy", version: 2 }]);
    expect(state.pending).toEqual({});
    expect(state.lastConflict).toBe("内容发生并发修改，已同步服务器最新版本。");
  });

  it("reapplies pending local edits over a reconnect snapshot", () => {
    const existing = {
      ...initialState,
      pending: {
        retry: {
          type: "update_block" as const,
          tx_id: "retry",
          client_id: "client-a",
          block_id: "one",
          base_version: 1,
          text: "Offline draft",
        },
      },
    };

    const state = reduceServerMessage(existing, {
      type: "snapshot",
      document_id: "demo",
      online_users: 1,
      blocks: [{ id: "one", text: "Before disconnect", version: 1 }],
    });

    expect(state.blocks).toEqual([
      { id: "one", text: "Offline draft", version: 1 },
    ]);
    expect(state.pending).toHaveProperty("retry");
  });

  it("keeps newer local text when a create acknowledgement arrives", () => {
    const existing = {
      ...initialState,
      blocks: [{ id: "one", text: "Typed before ACK", version: 0 }],
      pending: {
        create: {
          type: "create_block" as const,
          tx_id: "create",
          client_id: "client-a",
          block_id: "one",
          after_block_id: null,
          text: "",
        },
      },
    };

    const state = reduceServerMessage(existing, {
      type: "ack",
      tx_id: "create",
      success: true,
      operation_type: "create_block",
      block: { id: "one", text: "", version: 1 },
    });

    expect(state.blocks).toEqual([
      { id: "one", text: "Typed before ACK", version: 1 },
    ]);
    expect(state.pending).toEqual({});
  });
});

describe("canSendOperation", () => {
  it("stops retrying after three total sends", () => {
    expect(canSendOperation(0)).toBe(true);
    expect(canSendOperation(2)).toBe(true);
    expect(canSendOperation(3)).toBe(false);
  });
});
