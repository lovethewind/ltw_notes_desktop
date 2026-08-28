/** 初始化笔记数据库结构、索引与兼容迁移。 */
function initializeNotesDatabase(database) {
  database.pragma("journal_mode = WAL")
  database.pragma("foreign_keys = ON")
  database.pragma("busy_timeout = 5000")
  database.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      deleted_root_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_updated_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_updated_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '无标题笔记',
      content TEXT NOT NULL DEFAULT '',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      deleted_by_folder_id TEXT,
      conflict_source_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_updated_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_notes_list
      ON notes(is_deleted, is_pinned, updated_at DESC);
    CREATE TABLE IF NOT EXISTS note_previews (
      note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      content_prefix TEXT NOT NULL DEFAULT ''
    );
    CREATE TRIGGER IF NOT EXISTS note_preview_insert AFTER INSERT ON notes BEGIN
      INSERT INTO note_previews(note_id, content_prefix)
      VALUES (new.id, substr(new.content, 1, 1440))
      ON CONFLICT(note_id) DO UPDATE SET content_prefix = excluded.content_prefix;
    END;
    CREATE TRIGGER IF NOT EXISTS note_preview_update AFTER UPDATE OF content ON notes BEGIN
      INSERT INTO note_previews(note_id, content_prefix)
      VALUES (new.id, substr(new.content, 1, 1440))
      ON CONFLICT(note_id) DO UPDATE SET content_prefix = excluded.content_prefix;
    END;
    CREATE TABLE IF NOT EXISTS note_tags (
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY(note_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS note_history (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      folder_id TEXT,
      tag_names TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_note_history_time
      ON note_history(note_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS note_assets (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      local_path TEXT NOT NULL,
      remote_url TEXT,
      server_source_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_note_assets_remote_url
      ON note_assets(remote_url) WHERE remote_url IS NOT NULL;
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(id);
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_session_tabs (
      note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_session_tabs_position
      ON workspace_session_tabs(position);
    CREATE TABLE IF NOT EXISTS note_view_states (
      note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      scroll_top INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_links (
      source_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      target_note_id TEXT NOT NULL,
      PRIMARY KEY(source_note_id, target_note_id)
    );
    CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_note_id);
  `)
  initializeNotePreviews(database)
  initializeNoteSearch(database)
  migrateLegacyColumns(database)
  pruneLegacyHistory(database)
  database.exec("CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, sort_order)")
  database.exec("CREATE INDEX IF NOT EXISTS idx_folders_deleted ON folders(is_deleted, deleted_root_id)")
  database.exec("CREATE INDEX IF NOT EXISTS idx_notes_conflict_source ON notes(conflict_source_id)")
}

function initializeNotePreviews(database) {
  const notePreviewVersion = database.prepare(
    "SELECT value FROM sync_state WHERE key = 'note_preview_version'"
  ).get()?.value
  if (notePreviewVersion === "1") return
  database.transaction(() => {
    database.exec(`
      INSERT OR REPLACE INTO note_previews(note_id, content_prefix)
      SELECT id, substr(content, 1, 1440) FROM notes
    `)
    database.prepare(`
      INSERT INTO sync_state(key, value) VALUES ('note_preview_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run()
  })()
}

function initializeNoteSearch(database) {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS note_search USING fts5(
      note_id UNINDEXED,
      title,
      content,
      tokenize = 'trigram'
    );
    CREATE TRIGGER IF NOT EXISTS note_search_insert AFTER INSERT ON notes BEGIN
      INSERT INTO note_search(note_id, title, content) VALUES (new.id, new.title, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS note_search_update AFTER UPDATE OF title, content ON notes BEGIN
      DELETE FROM note_search WHERE note_id = old.id;
      INSERT INTO note_search(note_id, title, content) VALUES (new.id, new.title, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS note_search_delete AFTER DELETE ON notes BEGIN
      DELETE FROM note_search WHERE note_id = old.id;
    END;
  `)
  const noteSearchVersion = database.prepare(
    "SELECT value FROM sync_state WHERE key = 'note_search_version'"
  ).get()?.value
  if (noteSearchVersion === "1") return
  database.transaction(() => {
    database.exec("DELETE FROM note_search")
    database.exec(`
      INSERT INTO note_search(note_id, title, content)
      SELECT id, title, content FROM notes
    `)
    database.prepare(`
      INSERT INTO sync_state(key, value) VALUES ('note_search_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run()
  })()
}

function migrateLegacyColumns(database) {
  const folderColumns = database.prepare("PRAGMA table_info(folders)").all()
  if (!folderColumns.some((column) => column.name === "parent_id")) {
    database.exec("ALTER TABLE folders ADD COLUMN parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL")
  }
  for (const [columnName, definition] of [
    ["is_deleted", "INTEGER NOT NULL DEFAULT 0"],
    ["deleted_at", "TEXT"],
    ["deleted_root_id", "TEXT"]
  ]) {
    if (!folderColumns.some((column) => column.name === columnName)) {
      database.exec(`ALTER TABLE folders ADD COLUMN ${columnName} ${definition}`)
    }
  }
  const noteColumns = database.prepare("PRAGMA table_info(notes)").all()
  if (!noteColumns.some((column) => column.name === "deleted_by_folder_id")) {
    database.exec("ALTER TABLE notes ADD COLUMN deleted_by_folder_id TEXT")
  }
  if (!noteColumns.some((column) => column.name === "conflict_source_id")) {
    database.exec("ALTER TABLE notes ADD COLUMN conflict_source_id TEXT REFERENCES notes(id) ON DELETE SET NULL")
  }
  for (const tableName of ["folders", "tags", "notes"]) {
    const columns = database.prepare(`PRAGMA table_info(${tableName})`).all()
    if (!columns.some((column) => column.name === "server_updated_at")) {
      database.exec(`ALTER TABLE ${tableName} ADD COLUMN server_updated_at TEXT`)
    }
  }
  const historyColumns = database.prepare("PRAGMA table_info(note_history)").all()
  if (!historyColumns.some((column) => column.name === "dirty")) {
    database.exec("ALTER TABLE note_history ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1")
  }
  const assetColumns = database.prepare("PRAGMA table_info(note_assets)").all()
  if (!assetColumns.some((column) => column.name === "server_source_id")) {
    database.exec("ALTER TABLE note_assets ADD COLUMN server_source_id TEXT")
  }
}

function pruneLegacyHistory(database) {
  database.exec(`
    DELETE FROM note_history
    WHERE id IN (
      SELECT id
      FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY note_id ORDER BY created_at DESC, id DESC
        ) AS position
        FROM note_history
      )
      WHERE position > 50
    )
  `)
}

module.exports = { initializeNotesDatabase }
