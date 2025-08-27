// seed-prompts-to-supabase.js
// ESM script to push local prompt .txt files to Supabase.
// Usage: node seed-prompts-to-supabase.js

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PROJECT_ROOT = process.cwd();
const PROMPTS_DIR   = path.resolve(PROJECT_ROOT, 'prompts');
const DEFAULTS_DIR  = path.resolve(PROMPTS_DIR, 'defaults');
const BACKUPS_DIR   = path.resolve(PROMPTS_DIR, 'backups');

// ---- knobs ----
const INCLUDE_DEFAULTS_IF_MISSING = true;   // seed defaults only when a prompt row is missing
const MIGRATE_BACKUPS            = true;    // also import prompts/backups/*.bak into prompt_backups

// ---------- helpers ----------
async function dirExists(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

async function listTxt(dir) {
  const out = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.txt')) out.push(path.join(dir, e.name));
    }
  } catch {}
  return out;
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function fname(p) { return path.basename(p); }

function nowISO() { return new Date().toISOString(); }

function logOk(...args)    { console.log('✅', ...args); }
function logInfo(...args)  { console.log('•', ...args); }
function logWarn(...args)  { console.warn('⚠️', ...args); }
function logErr(...args)   { console.error('❌', ...args); }

// ---------- DB ops ----------
async function hasPromptRow(filename) {
  const { data, error } = await supabase
    .from('prompts')
    .select('filename')
    .eq('filename', filename)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return !!data;
}

async function upsertPrompt(filename, content) {
  const { error } = await supabase
    .from('prompts')
    .upsert({ filename, content, updated_at: nowISO() }, { onConflict: 'filename' });
  if (error) throw error;
}

async function insertBackup({ filename, content, commit_message, created_at }) {
  const row = { filename, content, commit_message: commit_message ?? null };
  if (created_at) row.created_at = created_at; // allow preserving timestamp
  const { error } = await supabase.from('prompt_backups').insert(row);
  if (error) throw error;
}

// Parse timestamp from "<original>.<YYYY-MM-DDTHH-MM-SS-mmmZ>.bak"
function parseBakTimestamp(bakName) {
  const m = bakName.match(/\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/);
  if (!m) return null;
  // turn "T12-34-56-789Z" back into "T12:34:56.789Z"
  return m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
}

function baseNameFromBak(bakName) {
  // strips ".<stamp>.bak" from end, preserves dots in the original filename (e.g., "reducer.user.txt")
  return bakName.replace(/\.\d{4}-\d{2}-\d{2}T.*\.bak$/, '');
}

async function importTopLevelTxt() {
  const files = await listTxt(PROMPTS_DIR);
  let count = 0;
  for (const p of files) {
    const filename = fname(p);
    // skip defaults folder files accidentally found
    if (filename === 'defaults' || filename === 'backups') continue;
    const content = await fs.readFile(p, 'utf8');
    await upsertPrompt(filename, content);
    await insertBackup({
      filename,
      content,
      commit_message: 'seed: import from local prompts/',
      created_at: nowISO()
    });
    logOk(`upserted ${filename}`);
    count++;
  }
  if (!count) logWarn('No .txt files found in prompts/');
  return count;
}

async function importDefaultsIfMissing() {
  if (!INCLUDE_DEFAULTS_IF_MISSING) return 0;
  if (!(await dirExists(DEFAULTS_DIR))) return 0;

  const files = await listTxt(DEFAULTS_DIR);
  let count = 0;
  for (const p of files) {
    const filename = fname(p);
    const exists = await hasPromptRow(filename);
    if (exists) {
      logInfo(`defaults/${filename} skipped (row already exists)`);
      continue;
    }
    const content = await fs.readFile(p, 'utf8');
    await upsertPrompt(filename, content);
    await insertBackup({
      filename,
      content,
      commit_message: 'seed: defaults (created because missing in DB)',
      created_at: nowISO()
    });
    logOk(`seeded from defaults/${filename}`);
    count++;
  }
  return count;
}

async function importBackups() {
  if (!MIGRATE_BACKUPS) return 0;
  if (!(await dirExists(BACKUPS_DIR))) return 0;

  const entries = await fs.readdir(BACKUPS_DIR, { withFileTypes: true });
  let count = 0;

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.bak')) continue;
    const bakPath = path.join(BACKUPS_DIR, e.name);

    const filename = baseNameFromBak(e.name);
    const content  = await fs.readFile(bakPath, 'utf8');

    // best-effort: look for sidecar .meta generated by your FS flow
    const metaPath = bakPath + '.meta';
    let created_at = parseBakTimestamp(e.name);
    let commit_message = null;
    if (await fileExists(metaPath)) {
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
        created_at = meta.timestamp || created_at || nowISO();
        commit_message = meta.commitMessage ?? null;
      } catch {}
    }

    await insertBackup({ filename, content, commit_message, created_at });
    logOk(`backup → ${filename} @ ${created_at || 'now'}`);
    count++;
  }
  if (!count) logWarn('No .bak backups found in prompts/backups/');
  return count;
}

(async function run() {
  console.log('🚀 Seeding prompts to Supabase…');
  console.log('   prompts dir   :', PROMPTS_DIR);
  console.log('   defaults dir  :', DEFAULTS_DIR, INCLUDE_DEFAULTS_IF_MISSING ? '(enabled)' : '(disabled)');
  console.log('   backups dir   :', BACKUPS_DIR, MIGRATE_BACKUPS ? '(enabled)' : '(disabled)');

  try {
    const top = await importTopLevelTxt();
    const defs = await importDefaultsIfMissing();
    const baks = await importBackups();

    console.log('\n🎉 Done.');
    console.log(`   upserted current prompts : ${top}`);
    console.log(`   seeded from defaults     : ${defs}`);
    console.log(`   imported backups         : ${baks}`);
    process.exit(0);
  } catch (err) {
    // common failure: tables not created yet
    logErr(err.message || err);
    if ((err.code || '').startsWith('42P01')) {
      logWarn('It looks like the tables are missing. Create them first:');
      console.log(`
create table if not exists public.prompts (
  filename text primary key,
  content  text not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.prompt_backups (
  id bigserial primary key,
  filename text not null,
  content  text not null,
  commit_message text,
  created_at timestamptz not null default now()
);
create index if not exists idx_prompt_backups_filename_created_desc
  on public.prompt_backups (filename, created_at desc);
      `.trim());
    }
    process.exit(1);
  }
})();
