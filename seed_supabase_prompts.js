// seed_supabase_prompts.js
// Usage:
//   1) npm i pg glob
//   2) Set DATABASE_URL (Supabase "Direct" connection string)
//   3) Put your prompt .txt files in ./prompts (e.g., reducer.user.txt)
//   4) node seed_supabase_prompts.js
//
// Files are named: <key>.<role>.txt
//   - key: e.g. reducer, selector, editor, response, general
//   - role: 'system' or 'user'
// Namespace defaults to 'default', version defaults to 1.
// Re-running will upsert (update content).

import fs from 'fs';
import path from 'path';
import glob from 'glob';
import { Pool } from 'pg';

const {
  DATABASE_URL,
  PROMPT_NAMESPACE = 'default',
  PROMPT_VERSION = '1',
} = process.env;

if (!DATABASE_URL) {
  console.error('❌ Set DATABASE_URL to your Supabase direct connection string.');
  console.error('   Supabase → Project Settings → Database → Connection Info → "Direct connections"');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // works for Supabase
});

const SCHEMA_SQL = `
create extension if not exists pgcrypto;

create table if not exists app_prompts (
  id uuid primary key default gen_random_uuid(),
  namespace text not null default 'default',
  key text not null,
  role text not null check (role in ('system','user')),
  version int not null default 1,
  content text not null,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(namespace, key, role, version)
);

create or replace view app_prompts_current as
select distinct on (namespace, key, role)
  namespace, key, role, version, content, updated_at
from app_prompts
where is_active = true
order by namespace, key, role, version desc, updated_at desc;
`;

const UPSERT_SQL = `
insert into app_prompts(namespace, key, role, version, content, is_active)
values ($1, $2, $3, $4, $5, true)
on conflict (namespace, key, role, version)
do update set content = excluded.content, is_active = true, updated_at = now();
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log('🔧 Creating table/view if needed…');
    await client.query(SCHEMA_SQL);

    const files = glob.sync(path.join('prompts', '*.txt'));
    if (!files.length) {
      console.log('⚠️  No .txt files found in ./prompts');
      return;
    }

    const version = parseInt(PROMPT_VERSION, 10) || 1;
    const inserted = [];

    for (const file of files) {
      const base = path.basename(file, '.txt'); // e.g., reducer.user
      const parts = base.split('.');            // ['reducer','user']
      if (parts.length !== 2) {
        console.warn(`Skipping ${file} — filename must be <key>.<role>.txt`);
        continue;
      }
      const [key, role] = parts;
      if (!['system', 'user'].includes(role)) {
        console.warn(`Skipping ${file} — role must be "system" or "user"`);
        continue;
      }

      const content = fs.readFileSync(file, 'utf8');
      if (!content.trim()) {
        console.warn(`Skipping ${file} — file is empty`);
        continue;
      }

      await client.query(UPSERT_SQL, [
        PROMPT_NAMESPACE,
        key,
        role,
        version,
        content, // raw text, ${...} included — no escaping needed
      ]);

      inserted.push({ namespace: PROMPT_NAMESPACE, key, role, version, file });
      console.log(`✅ Upserted ${key}.${role} v${version} from ${file}`);
    }

    console.log('\n🎉 Done. Inserted/updated prompts:');
    inserted.forEach(i =>
      console.log(` - ${i.namespace}.${i.key}.${i.role} v${i.version} ← ${i.file}`)
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
