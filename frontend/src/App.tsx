import { useEffect, useRef } from "react";

import type { Block } from "./collaboration";
import {
  type ConnectionStatus,
  useCollaborativeDocument,
} from "./useCollaborativeDocument";

const connectionStatusLabels: Record<ConnectionStatus, string> = {
  Connected: "已连接",
  Reconnecting: "正在重连",
  Disconnected: "已断开",
};

function EditableBlock({
  block,
  pending,
  onChange,
  onDelete,
}: {
  block: Block;
  pending: boolean;
  onChange: (text: string) => void;
  onDelete: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editorRef.current && editorRef.current.innerText !== block.text) {
      editorRef.current.innerText = block.text;
    }
  }, [block.text]);

  return (
    <article className="editor-block">
      <div className="block-meta">
        <span className="block-id">文本块 ID：{block.id.slice(0, 8)}</span>
        <span>版本 {block.version}</span>
        {pending && <span className="pending-dot">待确认</span>}
        <button
          className="delete-button"
          type="button"
          disabled={pending || block.version === 0}
          onClick={onDelete}
          aria-label={`删除文本块 ${block.id.slice(0, 8)}`}
        >
          删除
        </button>
      </div>
      <div
        ref={editorRef}
        className="editable"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={`可编辑文本块 ${block.id.slice(0, 8)}`}
        data-placeholder="请输入内容…"
        suppressContentEditableWarning
        onInput={(event) => onChange(event.currentTarget.innerText)}
      />
    </article>
  );
}

function getDocumentId(): string {
  return new URLSearchParams(window.location.search).get("doc")?.trim() || "demo";
}

export default function App() {
  const documentId = getDocumentId();
  const editor = useCollaborativeDocument(documentId);
  const pendingOperationCount = Object.keys(editor.pending).length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">面试作品</p>
          <h1>协同编辑器</h1>
        </div>
        <dl className="status-grid">
          <div>
            <dt>文档 ID</dt>
            <dd>{documentId}</dd>
          </div>
          <div>
            <dt>连接状态</dt>
            <dd>
              <span className={`status status-${editor.connectionStatus.toLowerCase()}`}>
                {connectionStatusLabels[editor.connectionStatus]}
              </span>
            </dd>
          </div>
          <div>
            <dt>在线人数</dt>
            <dd>{editor.onlineUsers}</dd>
          </div>
        </dl>
      </header>

      {editor.lastConflict !== "—" && (
        <aside className="conflict-banner" role="alert">
          {editor.lastConflict}
        </aside>
      )}

      <section className="workspace" aria-label="文档文本块">
        <div className="workspace-heading">
          <div>
            <h2>文档内容</h2>
            <p>每个文本块都有稳定的 ID 和独立的服务器版本。</p>
          </div>
          <button className="add-button" type="button" onClick={editor.createBlock}>
            + 新建文本块
          </button>
        </div>

        <div className="block-list">
          {editor.blocks.length === 0 ? (
            <button className="empty-state" type="button" onClick={editor.createBlock}>
              <span>当前文档还没有内容</span>
              新建第一个文本块
            </button>
          ) : (
            editor.blocks.map((block) => (
              <EditableBlock
                key={block.id}
                block={block}
                pending={editor.isBlockPending(block.id)}
                onChange={(text) => editor.updateBlock(block.id, text)}
                onDelete={() => editor.deleteBlock(block.id)}
              />
            ))
          )}
        </div>
      </section>

      <section className="debug-panel" aria-label="协同调试信息">
        <div>
          <span>最近一次 ACK</span>
          <code>{editor.lastAck === "—" ? "暂无 ACK" : editor.lastAck}</code>
        </div>
        <div>
          <span>待确认操作</span>
          <code>
            {pendingOperationCount === 0
              ? "当前没有待确认操作"
              : `${pendingOperationCount} 项`}
          </code>
        </div>
        <div>
          <span>最近一次冲突</span>
          <code>{editor.lastConflict === "—" ? "暂无冲突" : editor.lastConflict}</code>
        </div>
      </section>
    </main>
  );
}
