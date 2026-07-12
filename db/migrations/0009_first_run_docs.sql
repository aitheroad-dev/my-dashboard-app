-- 0009: W1 first-run docs (recipient doctrine R1). Two KB docs that teach a NEW owner
-- what the Assistant can build — they also feed the Assistant's own grounding (KB titles
-- appear in dashboard context). INSERT OR IGNORE: never clobbers a doc the owner already
-- created/edited under the same slug; the migration itself is name-tracked and runs once.

INSERT OR IGNORE INTO kb_docs (slug, title, blocks, updated_at) VALUES (
  'build-your-first-page',
  'Build your first page',
  '{"blocks":[
    {"type":"hero","title":"Build your first page","subtitle":"Your dashboard builds itself — you just describe what you want."},
    {"type":"paragraph","text":"Open the Assistant and describe the page you want. You approve every change before it happens — the Assistant proposes, you confirm."},
    {"type":"steps","items":[
      {"title":"Open the Assistant page"},
      {"title":"Say what you want","text":"For example: create a journal page, or: I want to track my holdings."},
      {"title":"Review the proposal card it shows you"},
      {"title":"Tap Approve","text":"The page appears in your sidebar."},
      {"title":"Add content by chat","text":"Add single entries, or import many rows at once."}
    ]},
    {"type":"callout","variant":"tip","text":"Ready-made templates: journal (situation_log), holdings, listings, advisor claims (advisor_corpus), sites (site_registry), clients (clients_crm), sessions, meetings tracker. Or describe a fully custom page and the Assistant will design one."},
    {"type":"paragraph","text":"Have existing data? Paste it in the chat and ask the Assistant to import it — it can load up to 100 records at a time into any page you created."}
  ]}',
  strftime('%Y-%m-%dT%H:%M:%SZ','now')
);

INSERT OR IGNORE INTO kb_docs (slug, title, blocks, updated_at) VALUES (
  'assistant-guide',
  'What your Assistant can do',
  '{"blocks":[
    {"type":"hero","title":"What your Assistant can do","subtitle":"Reads run instantly. Every change waits for your approval."},
    {"type":"heading","level":2,"text":"Answer questions"},
    {"type":"paragraph","text":"It sees your board, your pages, and your knowledge base, and answers grounded in them."},
    {"type":"heading","level":2,"text":"Run your board"},
    {"type":"paragraph","text":"Add, move, edit and delete cards — each change shows a confirmation card first. It can set due dates, priorities, labels and checklists."},
    {"type":"heading","level":2,"text":"Create pages"},
    {"type":"paragraph","text":"Apply a template or design a custom page (a data type, its fields, and a list view). You preview and approve the structure before it exists."},
    {"type":"heading","level":2,"text":"Fill pages with content"},
    {"type":"paragraph","text":"Add, edit or delete records on any page it created — or bulk-import up to 100 rows from data you paste."},
    {"type":"heading","level":2,"text":"Write documentation"},
    {"type":"paragraph","text":"It can create and update knowledge-base documents like this one."},
    {"type":"callout","variant":"info","text":"Safety model: the Assistant can never change anything by itself. Writes are proposals; only your explicit approval commits them, and every committed change lands in the activity log."}
  ]}',
  strftime('%Y-%m-%dT%H:%M:%SZ','now')
);
