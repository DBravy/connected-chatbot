import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChatHandler } from './lib/chatHandler.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const chatHandler = new ChatHandler();

// chatHandler.debugDatabase();

// Chat endpoint
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
  console.log(`\n🚀 Bachelor Party Chatbot Server running on port ${port}`);
  console.log(`📱 Open http://localhost:${port} to test the chat interface`);
});