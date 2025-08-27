// api/prompts.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config ----------
const PROMPTS_DIR   = path.resolve(__dirname, '../prompts');
const BACKUPS_DIR   = path.resolve(__dirname, '../prompts/backups');   // used only for FS fallback
const DEFAULTS_DIR  = path.resolve(__dirname, '../prompts/defaults');

const PROMPT_FILES = [
  'reducer.user.txt',
  'general.user.txt',
  'options.user.txt',
  'selector.system.txt',
  'response.user.txt',
  'wildness.user.txt',
];

// Supabase (DB-first)
const hasSupabase =
  !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = hasSupabase
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// ---------- Small helpers ----------
async function ensureDirectories() {
  // Only useful for FS fallback/local dev
  await fs.mkdir(PROMPTS_DIR, { recursive: true });
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  await fs.mkdir(DEFAULTS_DIR, { recursive: true });
}

function okFilename(name) {
  return PROMPT_FILES.includes(name);
}

function generateSimpleHash(content) {
  // Tiny non-crypto hash; keeps response shape compatible
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 31 + content.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

async function readDefault(filename) {
  const p = path.join(DEFAULTS_DIR, filename);
  return fs.readFile(p, 'utf8');
}

// ---------- DB layer ----------
async function dbGetPrompt(filename) {
  const { data, error } = await supabase
    .from('prompts')
    .select('content, updated_at')
    .eq('filename', filename)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function dbUpsertPrompt(filename, content) {
  const { error } = await supabase
    .from('prompts')
    .upsert({ filename, content, updated_at: new Date().toISOString() }, { onConflict: 'filename' });
  if (error) throw error;
}

async function dbInsertBackup(filename, content, commitMessage = null) {
  const { error } = await supabase
    .from('prompt_backups')
    .insert({ filename, content, commit_message: commitMessage });
  if (error) throw error;
}

async function dbGetHistory(filename) {
  const { data, error } = await supabase
    .from('prompt_backups')
    .select('id, created_at, commit_message, content')
    .eq('filename', filename)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function dbGetBackupByTimestamp(filename, isoTs) {
  const { data, error } = await supabase
    .from('prompt_backups')
    .select('id, filename, content, commit_message, created_at')
    .eq('filename', filename)
    .eq('created_at', isoTs) // Expecting exact ISO string from UI
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ---------- FS fallback (local/dev) ----------
async function fsReadCurrent(filename) {
  const p = path.join(PROMPTS_DIR, filename);
  return fs.readFile(p, 'utf8');
}

async function fsWriteCurrent(filename, content) {
  const p = path.join(PROMPTS_DIR, filename);
  await fs.writeFile(p, content, 'utf8');
}

async function fsCreateBackup(filename, content, commitMessage = null) {
  const iso = new Date().toISOString();
  const stamp = iso.replace(/[:.]/g, '-');
  const backupFilename = `${filename}.${stamp}.bak`;
  const backupPath = path.join(BACKUPS_DIR, backupFilename);
  await fs.writeFile(backupPath, content, 'utf8');
  // store commit message in sidecar .meta for parity
  await fs.writeFile(
    path.join(BACKUPS_DIR, `${backupFilename}.meta`),
    JSON.stringify({ filename, timestamp: iso, commitMessage, contentLength: content.length, contentHash: generateSimpleHash(content) }, null, 2),
    'utf8'
  );
}

async function fsListHistory(filename) {
  const all = await fs.readdir(BACKUPS_DIR);
  const matches = all.filter(n => n.startsWith(filename + '.') && n.endsWith('.bak'));
  const out = [];
  for (const bak of matches) {
    const m = bak.match(/\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/);
    if (!m) continue;
    const ts = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
    const content = await fs.readFile(path.join(BACKUPS_DIR, bak), 'utf8');
    let commitMessage = null;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(BACKUPS_DIR, `${bak}.meta`), 'utf8'));
      commitMessage = meta.commitMessage ?? null;
    } catch {}
    out.push({ created_at: ts, commit_message: commitMessage, content });
  }
  // newest first
  out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return out;
}

async function fsGetBackupByTimestamp(filename, isoTs) {
  const stamp = isoTs.replace(/[:.]/g, '-');
  const bak = `${filename}.${stamp}.bak`;
  const p = path.join(BACKUPS_DIR, bak);
  try {
    const content = await fs.readFile(p, 'utf8');
    return { filename, content, commit_message: null, created_at: isoTs };
  } catch {
    return null;
  }
}

// ---------- Uniform storage API (DB first, FS fallback) ----------
async function storageRead(filename) {
  if (hasSupabase) {
    const row = await dbGetPrompt(filename);
    if (row) return { content: row.content, source: 'db' };
    // fall back to default on first read
    try {
      const content = await readDefault(filename);
      return { content, source: 'default-file' };
    } catch {
      return { content: `# ${filename}\n# This prompt template is not yet configured.`, source: 'empty' };
    }
  } else {
    try {
      const content = await fsReadCurrent(filename);
      return { content, source: 'fs' };
    } catch {
      try {
        const content = await readDefault(filename);
        return { content, source: 'default-file' };
      } catch {
        return { content: `# ${filename}\n# This prompt template is not yet configured.`, source: 'empty' };
      }
    }
  }
}

async function storageWrite(filename, newContent, commitMessage = null) {
  // backup old
  const existing = await storageMaybeCurrent(filename);
  if (existing) {
    if (hasSupabase) {
      await dbInsertBackup(filename, existing, commitMessage);
    } else {
      await fsCreateBackup(filename, existing, commitMessage);
    }
  }
  // write new
  if (hasSupabase) {
    await dbUpsertPrompt(filename, newContent);
  } else {
    await fsWriteCurrent(filename, newContent);
  }
}

async function storageMaybeCurrent(filename) {
  if (hasSupabase) {
    const row = await dbGetPrompt(filename);
    return row?.content ?? null;
  } else {
    try { return await fsReadCurrent(filename); } catch { return null; }
  }
}

async function storageHistory(filename) {
  if (hasSupabase) return dbGetHistory(filename);
  return fsListHistory(filename);
}

async function storageBackupByTimestamp(filename, isoTs) {
  if (hasSupabase) return dbGetBackupByTimestamp(filename, isoTs);
  return fsGetBackupByTimestamp(filename, isoTs);
}

// ---------- HTTP handler ----------
export default async function handler(req, res) {
  // CORS (keeps your prompts.html working locally or on Vercel)
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  await ensureDirectories(); // harmless on Vercel; used locally

  const { query, method } = req;
  const filename = query.filename;
  const action = query.action;
  const version = query.version;

  try {
    switch (method) {
      // ---------------- GET ----------------
      case 'GET': {
        if (filename && action === 'history') {
          if (!okFilename(filename)) return res.status(404).json({ error: 'Prompt file not found' });
          const historyRows = await storageHistory(filename);

          // Format like your UI expects
          const versions = historyRows.map((r, idx) => ({
            filename: 'backup',
            timestamp: r.created_at,
            commitMessage: r.commit_message ?? null,
            contentLength: r.content.length,
            contentHash: generateSimpleHash(r.content),
            version: historyRows.length - idx,  // older get smaller numbers
            isCurrent: false,
          }));

          // Prepend a "current" pseudo-version
          const current = await storageRead(filename);
          versions.unshift({
            filename: 'current',
            timestamp: new Date().toISOString(),
            commitMessage: 'Current version',
            contentLength: current.content.length,
            contentHash: generateSimpleHash(current.content),
            version: versions.length + 1,
            isCurrent: true,
          });

          return res.json({ filename, versions, totalVersions: versions.length });
        }

        if (filename && action === 'version' && version) {
          if (!okFilename(filename)) return res.status(404).json({ error: 'Invalid prompt file' });
          const bak = await storageBackupByTimestamp(filename, version);
          if (!bak) return res.status(404).json({ error: 'Version not found' });
          return res.json({ filename, timestamp: bak.created_at, content: bak.content });
        }

        if (filename && action === 'backups') {
          if (!okFilename(filename)) return res.status(404).json({ error: 'Prompt file not found' });
          const hist = await storageHistory(filename);
          return res.json({
            hasBackups: hist.length > 0,
            backupCount: hist.length,
            latestBackup: hist[0]?.created_at ?? null,
          });
        }

        if (filename) {
          if (!okFilename(filename)) return res.status(404).json({ error: 'Invalid prompt file' });
          const { content, source } = await storageRead(filename);
          return res.json({ content, source });
        }

        // no filename => return all prompts object
        const entries = await Promise.all(
          PROMPT_FILES.map(async f => {
            const { content } = await storageRead(f);
            return [f, content];
          })
        );
        return res.json({ prompts: Object.fromEntries(entries) });
      }

      // ---------------- PUT ----------------
      case 'PUT': {
        if (action === 'batch') {
          const { updates, commitMessage } = req.body || {};
          if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Updates object is required' });
          }
          const results = [];
          const errors = [];

          for (const [file, content] of Object.entries(updates)) {
            if (!okFilename(file)) {
              errors.push({ file, error: 'Invalid prompt file' });
              continue;
            }
            try {
              await storageWrite(file, String(content), commitMessage ?? null);
              results.push({ file, success: true });
            } catch (e) {
              errors.push({ file, error: e.message });
            }
          }

          if (errors.length) {
            return res.status(207).json({ message: 'Batch update completed with some errors', results, errors });
          }
          return res.json({ success: true, message: 'Batch update completed', results });
        }

        if (!okFilename(filename)) return res.status(404).json({ error: 'Invalid prompt file' });

        const { content, commitMessage } = req.body || {};
        if (typeof content !== 'string') return res.status(400).json({ error: '`content` must be a string' });

        await storageWrite(filename, content, commitMessage ?? null);

        return res.json({
          success: true,
          message: 'Prompt updated successfully',
          filename,
          timestamp: new Date().toISOString(),
        });
      }

      // ---------------- POST ----------------
      case 'POST': {
        if (action === 'revert' && filename && version) {
          if (!okFilename(filename)) return res.status(404).json({ error: 'Invalid prompt file' });

          const bak = await storageBackupByTimestamp(filename, version);
          if (!bak) return res.status(404).json({ error: 'Version not found' });

          // Backup current before reverting (preserves undo)
          const current = await storageMaybeCurrent(filename);
          if (current) {
            if (hasSupabase) await dbInsertBackup(filename, current, `auto-backup before revert -> ${version}`);
            else await fsCreateBackup(filename, current, `auto-backup before revert -> ${version}`);
          }

          // Write reverted content
          if (hasSupabase) await dbUpsertPrompt(filename, bak.content);
          else await fsWriteCurrent(filename, bak.content);

          return res.json({
            success: true,
            message: `Reverted to version ${version}`,
            content: bak.content,
            revertedToTimestamp: bak.created_at,
          });
        }

        if (action === 'reset' && filename) {
          if (!okFilename(filename)) return res.status(404).json({ error: 'Invalid prompt file' });

          const def = await readDefault(filename).catch(() => null);
          if (!def) return res.status(404).json({ error: 'No default exists for this file' });

          const current = await storageMaybeCurrent(filename);
          if (current) {
            if (hasSupabase) await dbInsertBackup(filename, current, 'auto-backup before reset');
            else await fsCreateBackup(filename, current, 'auto-backup before reset');
          }

          if (hasSupabase) await dbUpsertPrompt(filename, def);
          else await fsWriteCurrent(filename, def);

          return res.json({ success: true, message: 'Prompt reset to default', content: def });
        }

        return res.status(400).json({ error: 'Invalid action' });
      }

      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Prompts API]', error);
    return res.status(500).json({ error: 'Internal server error', details: String(error?.message || error) });
  }
}
