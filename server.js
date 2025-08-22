import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChatHandler } from './api/chatHandler.js';
import aiPromptModifierHandler from './api/ai-prompt-modifier.js';

import fs from 'fs/promises';
import OpenAI from 'openai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const chatHandler = new ChatHandler();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Paths for prompts
const PROMPTS_DIR = path.resolve(__dirname, 'prompts');
const BACKUPS_DIR = path.resolve(__dirname, 'prompts/backups');
const DEFAULTS_DIR = path.resolve(__dirname, 'prompts/defaults');

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

async function getBackupsForFile(filename) {
  try {
    const backups = await fs.readdir(BACKUPS_DIR);
    const fileBackups = backups
      .filter(b => b.startsWith(filename + '.') && b.endsWith('.bak'))
      .map(b => {
        const match = b.match(/\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/);
        return {
          filename: b,
          timestamp: match
            ? match[1].replace(/-/g, ':')
                .replace(/T(\d{2}):(\d{2}):(\d{2}):(\d{3})Z/, 'T$1:$2:$3.$4Z')
            : null
        };
      })
      .filter(b => b.timestamp)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return fileBackups;
  } catch {
    return [];
  }
}

async function getLatestBackupContent(filename) {
  const backups = await getBackupsForFile(filename);
  if (backups.length === 0) throw new Error('No backups available');
  const latestBackup = backups[0];
  const backupPath = path.join(BACKUPS_DIR, latestBackup.filename);
  const content = await fs.readFile(backupPath, 'utf8');
  return { content, timestamp: latestBackup.timestamp };
}

// Initialize directories on startup
ensureDirectories();

// Existing chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    
    if (!conversationId || !message) {
      return res.status(400).json({ error: 'Missing conversationId or message' });
    }

    const result = await chatHandler.handleMessage(conversationId, message);
    res.json(result);
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Prompts API endpoints
// Get all prompts
app.get('/api/prompts', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Prompts API error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// Get specific prompt
app.get('/api/prompts/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

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
  } catch (error) {
    console.error('Prompts API error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

app.put('/api/prompts/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    if (!filename || !PROMPT_FILES.includes(filename)) {
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
  } catch (error) {
    console.error('Prompts update error:', error);
    res.status(500).json({ 
      error: 'Failed to update prompt',
      details: error.message 
    });
  }
});


// GET /api/prompts/:filename/backups
app.get('/api/prompts/:filename/backups', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!PROMPT_FILES.includes(filename)) {
      return res.status(404).json({ error: 'Prompt file not found' });
    }
    const backups = await getBackupsForFile(filename);
    res.json({
      hasBackups: backups.length > 0,
      backupCount: backups.length,
      latestBackup: backups.length > 0
        ? new Date(backups[0].timestamp).toLocaleString()
        : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list backups', details: error.message });
  }
});

// POST /api/prompts/:filename/undo
app.post('/api/prompts/:filename/undo', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!PROMPT_FILES.includes(filename)) {
      return res.status(404).json({ error: 'Invalid prompt file' });
    }

    const filePath = path.join(PROMPTS_DIR, filename);

    // Backup current content (if any) so the user can redo
    let currentContent = '';
    try { currentContent = await fs.readFile(filePath, 'utf8'); } catch {}

    const backup = await getLatestBackupContent(filename);
    await fs.writeFile(filePath, backup.content, 'utf8');

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
    res.status(500).json({ error: 'Failed to undo changes', details: error.message });
  }
});

app.post('/api/prompts/:filename/reset', async (req, res) => {
  try {
    const { filename } = req.params;
    
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
  } catch (error) {
    console.error('Prompts reset error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// AI Prompt Modifier endpoint
app.post('/api/ai-prompt-modifier', (req, res) => {
  // Delegate to the real handler that lives in ./api/ai-prompt-modifier.js
  return aiPromptModifierHandler(req, res);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/conversation', async (req, res) => {
    try {
      const { conversationId } = req.body;
      
      if (!conversationId) {
        return res.status(400).json({ error: 'Missing conversationId' });
      }
  
      const conversation = chatHandler.getConversation(conversationId);
      res.json({
        state: conversation.state,
        messages: conversation.messages,
        data: conversation.data
      });
    } catch (error) {
      console.error('Conversation error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

app.listen(port, () => {
  console.log(`🚀 Bachelor Party Chatbot Server running on port ${port}`);
  console.log(`📱 Open http://localhost:${port} to test the chat interface`);
  console.log(`⚙️  Open http://localhost:${port}/prompts.html to manage prompts`);
});