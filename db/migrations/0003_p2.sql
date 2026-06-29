-- 0003_p2.sql — P2: Knowledge Base content store + a generic starter doc set.
-- Convention (see migrate.ts): every statement ;-terminated + idempotent; no ; inside string literals.
-- blocks is JSON TEXT: {"blocks":[{"type":...,...}, ...]} rendered by the generic BlockRenderer.

CREATE TABLE IF NOT EXISTS kb_docs (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  blocks     TEXT NOT NULL DEFAULT '{"blocks":[]}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Generic starter docs (no personal/source-app content). Recipients edit or delete freely.
INSERT OR IGNORE INTO kb_docs (slug, title, blocks) VALUES
  ('welcome', 'Welcome to your dashboard',
   '{"blocks":[{"type":"hero","title":"Welcome to your dashboard","subtitle":"A quick tour of what you can do here."},{"type":"paragraph","text":"This dashboard is yours. Your data lives in your own database, isolated from everyone else."},{"type":"callout","variant":"info","title":"Tip","text":"Open Settings to rename the dashboard, switch theme, and choose which pages appear."},{"type":"list","items":["Track projects and goals","Use the built-in tools — image, speech, and OCR","Keep notes here in the knowledge base"]},{"type":"steps","items":[{"title":"Make it yours","text":"Set a display name and theme in Settings."},{"title":"Add real content","text":"Replace the demo projects and goals with your own."}]}]}'),
  ('customize', 'Customizing your dashboard',
   '{"blocks":[{"type":"heading","text":"Customizing your dashboard","level":2},{"type":"paragraph","text":"You control which pages show and in what order, all from the Settings page."},{"type":"steps","items":[{"title":"Open Settings"},{"title":"Toggle pages on or off"},{"title":"Reorder them with the arrows"},{"title":"Save your changes"}]},{"type":"callout","variant":"success","title":"Backup and transfer","text":"Use Export to download your config, and Import to carry your setup to a fresh fork."},{"type":"keyvalue","items":[{"key":"Home","value":"Always on"},{"key":"Theme","value":"Light, dark, or system"},{"key":"Tools","value":"Built in — image, speech-to-text, text-to-speech, OCR"}]}]}'),
  ('blocks-reference', 'Knowledge base block reference',
   '{"blocks":[{"type":"hero","title":"Block reference","subtitle":"Every section type the knowledge base can render."},{"type":"heading","text":"Text blocks","level":2},{"type":"paragraph","text":"Paragraphs hold plain text. The renderer escapes content, so docs are safe to author."},{"type":"list","ordered":false,"items":["An unordered list item","Another bullet point","A third bullet"]},{"type":"list","ordered":true,"items":["First numbered step","Second numbered step"]},{"type":"callout","variant":"warn","title":"Callout","text":"Callouts highlight a note in info, tip, success, or warn styles."},{"type":"code","language":"bash","code":"bun run dev"},{"type":"quote","text":"Simplicity is the ultimate sophistication.","cite":"Leonardo da Vinci"},{"type":"divider"},{"type":"image","src":"","alt":"Example image","caption":"Images render with an optional caption (a placeholder shows when no source is set)."},{"type":"table","headers":["Page","Purpose"],"rows":[["Home","Overview of your dashboard"],["Projects","The things you are building"]]},{"type":"steps","items":[{"title":"Author a doc","text":"Store blocks JSON in the kb_docs table."},{"title":"It renders","text":"The BlockRenderer maps each type to a component."}]},{"type":"keyvalue","items":[{"key":"Store","value":"D1 table kb_docs"},{"key":"Format","value":"JSON blocks"}]},{"type":"links","items":[{"label":"Cloudflare Workers","url":"https://workers.cloudflare.com"},{"label":"React Router","url":"https://reactrouter.com"}]}]}');
