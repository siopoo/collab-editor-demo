import { useEffect, useRef } from "react";

import type { Block } from "./collaboration";
import { useCollaborativeDocument } from "./useCollaborativeDocument";

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
        <span className="block-id">{block.id.slice(0, 8)}</span>
        <span>v{block.version}</span>
        {pending && <span className="pending-dot">pending</span>}
        <button
          className="delete-button"
          type="button"
          disabled={pending || block.version === 0}
          onClick={onDelete}
          aria-label={`Delete block ${block.id.slice(0, 8)}`}
        >
          Delete
        </button>
      </div>
      <div
        ref={editorRef}
        className="editable"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={`Editable block ${block.id.slice(0, 8)}`}
        data-placeholder="Start typing…"
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Interview demo</p>
          <h1>Collaborative Editor</h1>
        </div>
        <dl className="status-grid">
          <div>
            <dt>Document ID</dt>
            <dd>{documentId}</dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>
              <span className={`status status-${editor.connectionStatus.toLowerCase()}`}>
                {editor.connectionStatus}
              </span>
            </dd>
          </div>
          <div>
            <dt>Online Users</dt>
            <dd>{editor.onlineUsers}</dd>
          </div>
        </dl>
      </header>

      {editor.lastConflict !== "—" && (
        <aside className="conflict-banner" role="alert">
          {editor.lastConflict}
        </aside>
      )}

      <section className="workspace" aria-label="Document blocks">
        <div className="workspace-heading">
          <div>
            <h2>Document blocks</h2>
            <p>Each block has a stable ID and an independent server version.</p>
          </div>
          <button className="add-button" type="button" onClick={editor.createBlock}>
            + Add block
          </button>
        </div>

        <div className="block-list">
          {editor.blocks.length === 0 ? (
            <button className="empty-state" type="button" onClick={editor.createBlock}>
              <span>No blocks yet</span>
              Create the first block
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

      <section className="debug-panel" aria-label="Collaboration debug information">
        <div>
          <span>Last ACK</span>
          <code>{editor.lastAck}</code>
        </div>
        <div>
          <span>Pending Operations</span>
          <code>{Object.keys(editor.pending).length}</code>
        </div>
        <div>
          <span>Last Conflict</span>
          <code>{editor.lastConflict}</code>
        </div>
      </section>
    </main>
  );
}
