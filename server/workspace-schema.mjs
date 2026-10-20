export function installWorkspaceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_folders(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT REFERENCES workspace_folders(id),
      service TEXT NOT NULL CHECK(service IN ('shared','police','ambulance')),
      created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_documents(
      id TEXT PRIMARY KEY,folder_id TEXT NOT NULL REFERENCES workspace_folders(id),title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('file','document')),filename TEXT,mime TEXT,size INTEGER NOT NULL DEFAULT 0,
      storage_name TEXT,template_key TEXT,content TEXT NOT NULL DEFAULT '',fields TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workspace_documents_folder ON workspace_documents(folder_id);
    CREATE TABLE IF NOT EXISTS training_courses(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',qualification TEXT NOT NULL DEFAULT '',
      valid_months INTEGER NOT NULL DEFAULT 0,service TEXT NOT NULL CHECK(service IN ('shared','police','ambulance')),
      active INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS training_completions(
      id TEXT PRIMARY KEY,course_id TEXT NOT NULL REFERENCES training_courses(id),
      personnel_id TEXT REFERENCES personnel(id) ON DELETE SET NULL,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      completed_on TEXT NOT NULL,expires_on TEXT,note TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS employee_requests(
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      service TEXT NOT NULL CHECK(service IN ('shared','police','ambulance')),
      type TEXT NOT NULL CHECK(type IN ('leave','training','material')),title TEXT NOT NULL,description TEXT NOT NULL,
      start_date TEXT,end_date TEXT,course_id TEXT REFERENCES training_courses(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      review_reason TEXT NOT NULL DEFAULT '',reviewed_by TEXT,reviewed_at TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS employee_requests_user ON employee_requests(user_id);
    CREATE TABLE IF NOT EXISTS form_drafts(
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,key TEXT NOT NULL,value TEXT NOT NULL,
      updated_at TEXT NOT NULL,PRIMARY KEY(user_id,key)
    );
  `);
  const now = new Date().toISOString();
  for (const [folderId, name, service] of [
    ["workspace-shared", "Gedeelde documenten", "shared"],
    ["workspace-handbooks", "Handboeken", "shared"],
    ["workspace-police", "Politie", "police"],
    ["workspace-ambulance", "Ambulance", "ambulance"],
  ]) {
    db.prepare(
      `INSERT OR IGNORE INTO workspace_folders
      (id,name,parent_id,service,created_by,created_at,updated_at) VALUES(?,?,NULL,?,'system',?,?)`,
    ).run(folderId, name, service, now, now);
  }
}
