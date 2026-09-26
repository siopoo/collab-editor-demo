export type Block = {
  id: string;
  text: string;
  version: number;
};

type OperationBase = {
  tx_id: string;
  client_id: string;
  block_id: string;
};

export type CreateBlockOperation = OperationBase & {
  type: "create_block";
  after_block_id: string | null;
  text: string;
};

export type UpdateBlockOperation = OperationBase & {
  type: "update_block";
  base_version: number;
  text: string;
};

export type DeleteBlockOperation = OperationBase & {
  type: "delete_block";
  base_version: number;
};

export type ClientOperation =
  | CreateBlockOperation
  | UpdateBlockOperation
  | DeleteBlockOperation;

export type ServerMessage =
  | {
      type: "snapshot";
      document_id: string;
      blocks: Block[];
      online_users: number;
    }
  | { type: "presence"; online_users: number }
  | {
      type: "ack";
      tx_id: string;
      success: boolean;
      operation_type?: ClientOperation["type"];
      block?: Block;
      block_id?: string;
      error?: string;
    }
  | {
      type: "conflict";
      tx_id: string;
      message: string;
      block: Block;
    }
  | {
      type: "operation";
      operation_type: ClientOperation["type"];
      tx_id: string;
      client_id: string;
      block?: Block;
      block_id?: string;
      after_block_id?: string | null;
    };

export type CollaborationState = {
  blocks: Block[];
  onlineUsers: number;
  pending: Record<string, ClientOperation>;
  lastAck: string;
  lastConflict: string;
};

export const initialState: CollaborationState = {
  blocks: [],
  onlineUsers: 0,
  pending: {},
  lastAck: "—",
  lastConflict: "—",
};

export const MAX_OPERATION_SENDS = 3;

export function canSendOperation(attempts: number): boolean {
  return attempts < MAX_OPERATION_SENDS;
}

function localizeServerError(error?: string): string {
  const messages: Record<string, string> = {
    "tx_id is required.": "缺少 tx_id。",
    "Unsupported operation type.": "不支持的操作类型。",
    "block_id is required.": "缺少 block_id。",
    "text must be a string.": "text 必须是字符串。",
    "Block already exists.": "文本块已存在。",
    "after_block_id does not exist.": "after_block_id 对应的文本块不存在。",
    "Block does not exist.": "文本块不存在。",
  };
  if (!error) return "未知错误。";
  return messages[error] ?? "服务器拒绝了该操作。";
}

function upsertBlock(blocks: Block[], block: Block): Block[] {
  const index = blocks.findIndex((candidate) => candidate.id === block.id);
  if (index === -1) return [...blocks, block];
  return blocks.map((candidate) => (candidate.id === block.id ? block : candidate));
}

function insertBlock(
  blocks: Block[],
  block: Block,
  afterBlockId: string | null | undefined,
): Block[] {
  if (blocks.some((candidate) => candidate.id === block.id)) {
    return upsertBlock(blocks, block);
  }
  if (afterBlockId == null) return [...blocks, block];
  const index = blocks.findIndex((candidate) => candidate.id === afterBlockId);
  if (index === -1) return [...blocks, block];
  return [...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)];
}

function withoutPending(
  pending: Record<string, ClientOperation>,
  txId: string,
): Record<string, ClientOperation> {
  const next = { ...pending };
  delete next[txId];
  return next;
}

function overlayPendingOperations(
  blocks: Block[],
  pending: Record<string, ClientOperation>,
): Block[] {
  return Object.values(pending).reduce((current, operation) => {
    if (operation.type === "create_block") {
      return insertBlock(
        current,
        { id: operation.block_id, text: operation.text, version: 0 },
        operation.after_block_id,
      );
    }
    if (operation.type === "delete_block") {
      return current.filter((block) => block.id !== operation.block_id);
    }
    return current.map((block) =>
      block.id === operation.block_id ? { ...block, text: operation.text } : block,
    );
  }, blocks);
}

export function reduceServerMessage(
  state: CollaborationState,
  message: ServerMessage,
): CollaborationState {
  switch (message.type) {
    case "snapshot":
      return {
        ...state,
        blocks: overlayPendingOperations(message.blocks, state.pending),
        onlineUsers: message.online_users,
      };
    case "presence":
      return { ...state, onlineUsers: message.online_users };
    case "operation": {
      if (message.operation_type === "delete_block" && message.block_id) {
        return {
          ...state,
          blocks: state.blocks.filter((block) => block.id !== message.block_id),
        };
      }
      if (!message.block) return state;
      return {
        ...state,
        blocks:
          message.operation_type === "create_block"
            ? insertBlock(state.blocks, message.block, message.after_block_id)
            : upsertBlock(state.blocks, message.block),
      };
    }
    case "ack": {
      if (!state.pending[message.tx_id]) return state;
      const pending = withoutPending(state.pending, message.tx_id);
      if (!message.success) {
        return {
          ...state,
          pending,
          lastAck: `${message.tx_id}: 失败 — ${localizeServerError(message.error)}`,
        };
      }
      let blocks = state.blocks;
      if (message.operation_type === "delete_block" && message.block_id) {
        blocks = blocks.filter((block) => block.id !== message.block_id);
      } else if (message.block) {
        const current = blocks.find((block) => block.id === message.block?.id);
        const acknowledged =
          (message.operation_type === "update_block" ||
            message.operation_type === "create_block") &&
          current
            ? { ...message.block, text: current.text }
            : message.block;
        blocks = upsertBlock(blocks, acknowledged);
      }
      return {
        ...state,
        blocks,
        pending,
        lastAck: `${message.tx_id}: 成功`,
      };
    }
    case "conflict":
      if (!state.pending[message.tx_id]) return state;
      return {
        ...state,
        blocks: upsertBlock(state.blocks, message.block),
        pending: withoutPending(state.pending, message.tx_id),
        lastConflict:
          "该文本块已被其他客户端修改，本地内容已同步为服务器最新版本。",
      };
  }
}
