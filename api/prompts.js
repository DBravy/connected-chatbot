// api/prompts.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const PROMPTS_DIR = path.resolve(__dirname, '../prompts');
const BACKUPS_DIR = path.resolve(__dirname, '../prompts/backups');
const DEFAULTS_DIR = path.resolve(__dirname, '../prompts/defaults');

// Available prompt files
const PROMPT_FILES = [
  'reducer.user.txt',
  'general.user.txt', 
  'options.user.txt',
  'selector.system.txt',
  'response.user.txt',
  'wildness.user.txt'
];

// Ensure directories exist
async function ensureDirectories() {
  await fs.mkdir(PROMPTS_DIR, { recursive: true });
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  await fs.mkdir(DEFAULTS_DIR, { recursive: true });
}

// Create backup of current prompt with optional commit message
// api/prompts.js
async function createBackup(filename, content, commitMessage = null) {
  const now = new Date();
  const iso = now.toISOString();                        // one source of truth
  const stamp = iso.replace(/[:.]/g, '-');              // safe for filenames
  const backupFilename = `${filename}.${stamp}.bak`;
  const backupPath = path.join(BACKUPS_DIR, backupFilename);

  const metadata = {
    filename,
    timestamp: iso,                                     // exactly matches backupFilename’s instant
    backupFilename,
    commitMessage: commitMessage || null,
    contentLength: content.length,
    contentHash: generateSimpleHash(content),
  };

  await fs.writeFile(backupPath, content, 'utf8');
  const metadataPath = path.join(BACKUPS_DIR, `${backupFilename}.meta`);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
}


// Generate a simple hash for content comparison
function generateSimpleHash(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

// Get comprehensive version history for a file

async function getVersionHistory(filename) {
  try {
    const all = await fs.readdir(BACKUPS_DIR);

    // Get all backups for this file, sorted newest first
    const fileBackups = all
      .filter(name => name.startsWith(filename + '.') && name.endsWith('.bak'))
      .map(name => {
        const m = name.match(/\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/);
        if (!m) return null;
        const ts = m[1].replace(
          /T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
          'T$1:$2:$3.$4Z'
        );
        return { filename: name, timestamp: ts };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // Newest first

    // Add metadata and assign version numbers (newest gets highest version number)
    const versionsWithMetadata = await Promise.all(
      fileBackups.map(async (backup, idx) => {
        const metadataPath = path.join(BACKUPS_DIR, `${backup.filename}.meta`);
        try {
          const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
          return { 
            ...backup, 
            ...metadata, 
            version: fileBackups.length - idx  // Newest backup gets highest version number
          };
        } catch {
          return {
            ...backup,
            commitMessage: null,
            contentLength: null,
            contentHash: null,
            version: fileBackups.length - idx,
          };
        }
      })
    );

    // Add current version at the top
    try {
      const currentPath = path.join(PROMPTS_DIR, filename);
      const currentContent = await fs.readFile(currentPath, 'utf8');
      const currentVersion = {
        filename: 'current',
        timestamp: new Date().toISOString(),
        commitMessage: 'Current version',
        contentLength: currentContent.length,
        contentHash: generateSimpleHash(currentContent),
        version: versionsWithMetadata.length + 1, // Current gets highest version number
        isCurrent: true,
      };
      
      // Return with current first, then historical versions in chronological order (newest first)
      return [currentVersion, ...versionsWithMetadata];
    } catch {
      // No current file, just return historical versions
      return versionsWithMetadata;
    }
  } catch {
    return [];
  }
}

// Get content of a specific version
async function getVersionContent(filename, versionTimestamp) {
  if (versionTimestamp === 'current') {
    const filePath = path.join(PROMPTS_DIR, filename);
    return await fs.readFile(filePath, 'utf8');
  }

  const stamp = versionTimestamp.replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  const backupPath = path.join(BACKUPS_DIR, `${filename}.${stamp}.bak`);
  try {
    return await fs.readFile(backupPath, 'utf8');
  } catch (e) {
    // Fallback: look up by metadata timestamp
    const entries = await fs.readdir(BACKUPS_DIR);
    for (const entry of entries) {
      if (entry.startsWith(`${filename}.`) && entry.endsWith('.bak.meta')) {
        const meta = JSON.parse(await fs.readFile(path.join(BACKUPS_DIR, entry), 'utf8'));
        if (meta.timestamp === versionTimestamp && meta.backupFilename) {
          return await fs.readFile(path.join(BACKUPS_DIR, meta.backupFilename), 'utf8');
        }
      }
    }
    throw e;
  }
}

// Revert to a specific version
async function revertToVersion(filename, versionTimestamp) {
  // Get the content of the target version
  const targetContent = await getVersionContent(filename, versionTimestamp);
  
  // Create backup of current version before reverting
  try {
    const currentPath = path.join(PROMPTS_DIR, filename);
    const currentContent = await fs.readFile(currentPath, 'utf8');
    await createBackup(filename, currentContent, `Pre-revert backup (reverting to ${versionTimestamp})`);
  } catch {
    // Current file doesn't exist, no backup needed
  }
  
  // Write the target version as current
  const filePath = path.join(PROMPTS_DIR, filename);
  await fs.writeFile(filePath, targetContent, 'utf8');
  
  return { content: targetContent, timestamp: versionTimestamp };
}

// Get backups for a specific file (simplified for backward compatibility)
async function getBackupsForFile(filename) {
  const history = await getVersionHistory(filename);
  return history.slice(1); // Exclude current version
}

// Get the latest backup content
async function getLatestBackupContent(filename) {
  const backups = await getBackupsForFile(filename);
  if (backups.length === 0) {
    throw new Error('No backups available');
  }
  
  const latestBackup = backups[0];
  const content = await getVersionContent(filename, latestBackup.timestamp);
  
  return {
    content,
    timestamp: latestBackup.timestamp
  };
}

// Batch update multiple prompts
async function batchUpdatePrompts(updates, commitMessage = null) {
  const results = [];
  const errors = [];
  
  for (const [filename, content] of Object.entries(updates)) {
    try {
      if (!PROMPT_FILES.includes(filename)) {
        errors.push({ filename, error: 'Invalid prompt file' });
        continue;
      }
      
      if (typeof content !== 'string') {
        errors.push({ filename, error: 'Content must be a string' });
        continue;
      }
      
      const filePath = path.join(PROMPTS_DIR, filename);
      
      // Create backup of existing content
      try {
        const existingContent = await fs.readFile(filePath, 'utf8');
        await createBackup(filename, existingContent, commitMessage);
      } catch {
        // File doesn't exist yet, no backup needed
      }
      
      // Write new content
      await fs.writeFile(filePath, content, 'utf8');
      
      results.push({
        filename,
        success: true,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      errors.push({
        filename,
        error: error.message
      });
    }
  }
  
  return { results, errors };
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  await ensureDirectories();

  const { query, method } = req;
  const filename = query.filename;
  const action = query.action;
  const version = query.version;

  try {
    switch (method) {
      case 'GET':
        if (filename && action === 'history') {
          // Get version history for a specific prompt
          if (!PROMPT_FILES.includes(filename)) {
            return res.status(404).json({ error: 'Prompt file not found' });
          }
          
          const history = await getVersionHistory(filename);
          res.json({ 
            filename,
            versions: history,
            totalVersions: history.length
          });
          
        } else if (filename && action === 'version' && version) {
          // Get content of a specific version
          if (!PROMPT_FILES.includes(filename)) {
            return res.status(404).json({ error: 'Prompt file not found' });
          }
          
          try {
            const content = await getVersionContent(filename, version);
            res.json({ 
              filename, 
              version,
              content 
            });
          } catch (error) {
            res.status(404).json({ error: 'Version not found' });
          }
          
        } else if (filename && action === 'backups') {
          // Get backup information for a specific prompt (backward compatibility)
          if (!PROMPT_FILES.includes(filename)) {
            return res.status(404).json({ error: 'Prompt file not found' });
          }
          
          const backups = await getBackupsForFile(filename);
          res.json({ 
            hasBackups: backups.length > 0,
            backupCount: backups.length,
            latestBackup: backups.length > 0 ? new Date(backups[0].timestamp).toLocaleString() : null
          });
          
        } else if (filename) {
          // Get specific prompt
          if (!PROMPT_FILES.includes(filename)) {
            return res.status(404).json({ error: 'Prompt file not found' });
          }
          
          const filePath = path.join(PROMPTS_DIR, filename);
          try {
            const content = await fs.readFile(filePath, 'utf8');
            res.json({ filename, content });
          } catch (error) {
            // If file doesn't exist, try to get from defaults
            try {
              const defaultPath = path.join(DEFAULTS_DIR, filename);
              const content = await fs.readFile(defaultPath, 'utf8');
              res.json({ filename, content, isDefault: true });
            } catch {
              res.status(404).json({ error: 'Prompt file not found' });
            }
          }
        } else {
          // Get all prompts
          const prompts = {};
          
          for (const file of PROMPT_FILES) {
            try {
              const filePath = path.join(PROMPTS_DIR, file);
              const content = await fs.readFile(filePath, 'utf8');
              prompts[file] = content;
            } catch {
              // Try defaults if main file doesn't exist
              try {
                const defaultPath = path.join(DEFAULTS_DIR, file);
                const content = await fs.readFile(defaultPath, 'utf8');
                prompts[file] = content;
              } catch {
                prompts[file] = `# ${file}\n# This prompt template is not yet configured.`;
              }
            }
          }
          
          res.json({ prompts });
        }
        break;

      case 'PUT':
        // Update specific prompt or batch update
        if (action === 'batch') {
          // Batch update multiple prompts
          const { updates, commitMessage } = req.body;
          
          if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Updates object is required' });
          }
          
          const result = await batchUpdatePrompts(updates, commitMessage);
          
          if (result.errors.length > 0) {
            res.status(207).json({ // 207 Multi-Status
              message: 'Batch update completed with some errors',
              results: result.results,
              errors: result.errors
            });
          } else {
            res.json({
              success: true,
              message: `Successfully updated ${result.results.length} prompt(s)`,
              results: result.results
            });
          }
          
        } else if (filename) {
          // Update specific prompt
          if (!PROMPT_FILES.includes(filename)) {
            return res.status(404).json({ error: 'Invalid prompt file' });
          }
          
          const { content, commitMessage } = req.body;
          if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Content must be a string' });
          }
          
          const filePath = path.join(PROMPTS_DIR, filename);
          
          // Create backup of existing content
          try {
            const existingContent = await fs.readFile(filePath, 'utf8');
            await createBackup(filename, existingContent, commitMessage);
          } catch {
            // File doesn't exist yet, no backup needed
          }
          
          // Write new content
          await fs.writeFile(filePath, content, 'utf8');
          
          res.json({ 
            success: true, 
            message: 'Prompt updated successfully',
            filename,
            timestamp: new Date().toISOString()
          });
        } else {
          res.status(400).json({ error: 'Filename is required for single updates' });
        }
        break;

      case 'POST':
        if (action === 'revert' && filename && version) {
          // Revert to specific version
          if (!PROMPT_FILES.includes(filename)) {
            return res.status(404).json({ error: 'Invalid prompt file' });
          }
          
          try {
            const result = await revertToVersion(filename, version);
            res.json({ 
              success: true, 
              message: `Reverted to version ${version}`,
              content: result.content,
              revertedToTimestamp: result.timestamp
            });
          } catch (error) {
            res.status(500).json({ 
              error: 'Failed to revert to version',
              details: error.message 
            });
          }
          
        } else if (action === 'reset' && filename) {
          // Reset to default
          if (!PROMPT_FILES.includes(filename)) {
            return res.status(404).json({ error: 'Invalid prompt file' });
          }
          
          const filePath = path.join(PROMPTS_DIR, filename);
          const defaultPath = path.join(DEFAULTS_DIR, filename);
          
          try {
            // Backup current version
            try {
              const currentContent = await fs.readFile(filePath, 'utf8');
              await createBackup(filename, currentContent, 'Pre-reset backup');
            } catch {
              // No current file to backup
            }
            
            // Copy from defaults
            const defaultContent = await fs.readFile(defaultPath, 'utf8');
            await fs.writeFile(filePath, defaultContent, 'utf8');
            
            res.json({ 
              success: true, 
              message: 'Prompt reset to default',
              content: defaultContent 
            });
          } catch (error) {
            res.status(500).json({ 
              error: 'Failed to reset prompt',
              details: error.message 
            });
          }
          
        } else if (action === 'undo' && filename) {
          // Undo to previous version (backward compatibility)
          if (!PROMPT_FILES.includes(filename)) {
            return res.status(404).json({ error: 'Invalid prompt file' });
          }
          
          try {
            const filePath = path.join(PROMPTS_DIR, filename);
            
            // Get current content to backup before undo
            let currentContent = '';
            try {
              currentContent = await fs.readFile(filePath, 'utf8');
            } catch {
              // File doesn't exist
            }
            
            // Get the latest backup
            const backup = await getLatestBackupContent(filename);
            
            // Write the backup content as the current content
            await fs.writeFile(filePath, backup.content, 'utf8');
            
            // If we had current content, create a backup of it 
            if (currentContent) {
              await createBackup(filename, currentContent, 'Pre-undo backup');
            }
            
            res.json({ 
              success: true, 
              message: 'Changes undone successfully',
              content: backup.content,
              restoredFrom: new Date(backup.timestamp).toLocaleString()
            });
          } catch (error) {
            res.status(500).json({ 
              error: 'Failed to undo changes',
              details: error.message 
            });
          }
          
        } else if (action === 'batch-reset') {
          // Reset multiple prompts to defaults
          const { filenames } = req.body;
          
          if (!filenames || !Array.isArray(filenames)) {
            return res.status(400).json({ error: 'Filenames array is required' });
          }
          
          const results = [];
          const errors = [];
          
          for (const fname of filenames) {
            try {
              if (!PROMPT_FILES.includes(fname)) {
                errors.push({ filename: fname, error: 'Invalid prompt file' });
                continue;
              }
              
              const filePath = path.join(PROMPTS_DIR, fname);
              const defaultPath = path.join(DEFAULTS_DIR, fname);
              
              // Backup current version if it exists
              try {
                const currentContent = await fs.readFile(filePath, 'utf8');
                await createBackup(fname, currentContent, 'Pre-batch-reset backup');
              } catch {
                // No current file to backup
              }
              
              // Copy from defaults
              const defaultContent = await fs.readFile(defaultPath, 'utf8');
              await fs.writeFile(filePath, defaultContent, 'utf8');
              
              results.push({
                filename: fname,
                success: true,
                timestamp: new Date().toISOString()
              });
              
            } catch (error) {
              errors.push({
                filename: fname,
                error: error.message
              });
            }
          }
          
          if (errors.length > 0) {
            res.status(207).json({
              message: 'Batch reset completed with some errors',
              results,
              errors
            });
          } else {
            res.json({
              success: true,
              message: `Successfully reset ${results.length} prompt(s) to defaults`,
              results
            });
          }
          
        } else {
          res.status(400).json({ error: 'Invalid action' });
        }
        break;

      default:
        res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Prompts API error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}