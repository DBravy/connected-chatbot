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
  'response.user.txt'
];

// Ensure directories exist
async function ensureDirectories() {
  await fs.mkdir(PROMPTS_DIR, { recursive: true });
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  await fs.mkdir(DEFAULTS_DIR, { recursive: true });
}

// Create backup of current prompt
async function createBackup(filename, content) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUPS_DIR, `${filename}.${timestamp}.bak`);
  await fs.writeFile(backupPath, content, 'utf8');
  
  // Keep only last 10 backups per file
  const backups = await fs.readdir(BACKUPS_DIR);
  const fileBackups = backups
    .filter(b => b.startsWith(filename))
    .sort()
    .reverse();
    
  if (fileBackups.length > 10) {
    for (const oldBackup of fileBackups.slice(10)) {
      await fs.unlink(path.join(BACKUPS_DIR, oldBackup));
    }
  }
}

// Get backups for a specific file
async function getBackupsForFile(filename) {
  try {
    const backups = await fs.readdir(BACKUPS_DIR);
    const fileBackups = backups
      .filter(b => b.startsWith(filename + '.') && b.endsWith('.bak'))
      .map(b => {
        const match = b.match(/\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/);
        return {
          filename: b,
          timestamp: match ? match[1].replace(/-/g, ':').replace(/T(\d{2}):(\d{2}):(\d{2}):(\d{3})Z/, 'T$1:$2:$3.$4Z') : null
        };
      })
      .filter(b => b.timestamp)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return fileBackups;
  } catch (error) {
    return [];
  }
}

// Get the latest backup content
async function getLatestBackupContent(filename) {
  const backups = await getBackupsForFile(filename);
  if (backups.length === 0) {
    throw new Error('No backups available');
  }
  
  const latestBackup = backups[0];
  const backupPath = path.join(BACKUPS_DIR, latestBackup.filename);
  const content = await fs.readFile(backupPath, 'utf8');
  
  return {
    content,
    timestamp: latestBackup.timestamp
  };
}

// Batch update multiple prompts
async function batchUpdatePrompts(updates) {
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
        await createBackup(filename, existingContent);
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

  try {
    switch (method) {
      case 'GET':
        if (filename && action === 'backups') {
          // Get backup information for a specific prompt
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
          const { updates } = req.body;
          
          if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Updates object is required' });
          }
          
          const result = await batchUpdatePrompts(updates);
          
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
          // Update specific prompt (existing functionality)
          if (!PROMPT_FILES.includes(filename)) {
            return res.status(404).json({ error: 'Invalid prompt file' });
          }
          
          const { content } = req.body;
          if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Content must be a string' });
          }
          
          const filePath = path.join(PROMPTS_DIR, filename);
          
          // Create backup of existing content
          try {
            const existingContent = await fs.readFile(filePath, 'utf8');
            await createBackup(filename, existingContent);
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
        if (action === 'reset' && filename) {
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
              await createBackup(filename, currentContent);
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
          // Undo to previous version
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
            // (so the user can potentially redo if needed)
            if (currentContent) {
              await createBackup(filename, currentContent);
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
                await createBackup(fname, currentContent);
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