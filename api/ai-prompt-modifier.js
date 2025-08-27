// api/ai-prompt-modifier.js
import dotenv from 'dotenv';
import OpenAI from 'openai';
dotenv.config();

const HANDLER_VERSION = 'qna-2025-08-27-1';

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY. Add it to your environment or .env file.');
  return new OpenAI({ apiKey });
}

// Heuristic scrubber: remove meta like “No changes needed…”
function sanitize(answer) {
  const META_PATTERNS = [
    /no changes needed/gi,
    /does not (?:require|need) (?:any )?changes?/gi,
    /seems to seek clarification rather than (?:a )?modification/gi,
    /the existing prompts already/gi,
    /no update to the prompt files/gi
  ];
  let out = answer;
  for (const re of META_PATTERNS) {
    // drop any sentence containing these phrases
    out = out
      .split(/\n+/)
      .filter(line => !re.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  // If we scrubbed too much, fall back to original
  if (!out) out = answer;
  return out;
}

function buildSystemMessage() {
  // Lock the persona: Q&A ONLY.
  return [
    {
      role: 'system',
      content:
        [
          'You are the Connected codebase **Q&A** assistant.',
          'Your ONLY job is to answer technical questions about the code and architecture.',
          'DO NOT discuss whether prompts need changes. DO NOT classify the request.',
          'NEVER write phrases like “No changes needed” or talk about modifying prompts.',
          'Answer directly. If helpful, reference specific files, functions, and flows.'
        ].join(' ')
    }
  ];
}

function buildUserMessage({ userMessage, currentPrompts }) {
  // Keep enough context to answer questions about the system,
  // without inviting “prompt editing” behavior.
  const promptNames = Object.keys(currentPrompts || {});
  const promptSummary =
    promptNames.length
      ? `Available prompt files (for reference only): ${promptNames.join(', ')}.`
      : 'No prompt files provided in the request.';
  const instructions = [
    'Answer the user clearly and directly.',
    'If they ask “what does X do?”, explain X precisely and cite where in the system it’s implemented.',
    'If code needs to be referenced, quote short, relevant snippets only.'
  ].join(' ');

  return {
    role: 'user',
    content:
      `User question: "${userMessage}". ${promptSummary} ${instructions}`
  };
}


// System understanding - now focused on explaining rather than modifying
const SYSTEM_KNOWLEDGE = `
You are an expert AI assistant that helps clients understand the Connected bachelor party planning system. Your role is to answer questions about the codebase, explain how the system works, and help clients understand the prompt templates without them needing to contact the developer.

## SYSTEM ARCHITECTURE:

### Core Components:
1. **Chat Interface** (public/index.html) - The main user-facing chat interface where customers interact with the bot
2. **Chat Handler** (api/chatHandler.js) - Core conversation engine that manages state and routing
3. **Prompt Templates** - Six specialized AI prompts that control different aspects of conversation
4. **Service Catalog** - JSON data files containing venue, activity, and service information
5. **Prompt Management Interface** (prompts.html) - Admin interface for viewing and understanding prompts

### How the System Works:

#### Conversation Flow:
1. User sends a message through the chat interface
2. ChatHandler receives the message and determines conversation state
3. Based on state, appropriate prompt template is selected and sent to OpenAI
4. AI response is processed and formatted
5. Response is sent back to user with appropriate UI elements

#### State Management:
- **INITIAL**: Starting state, gathering basic info
- **GATHERING_FACTS**: Collecting party details (dates, group size, preferences)
- **SELECTING_OPTIONS**: AI chooses appropriate services based on preferences
- **PRESENTING_OPTIONS**: Shows customized itinerary to user
- **COMPLETE**: Conversation finished, collecting contact info

### Prompt Templates Explained:

#### reducer.user.txt
- **Purpose**: Core conversation processor and intent classifier
- **Function**: Takes user messages and converts them into structured data (dates, preferences, wildness level)
- **Key Features**: 
  - Extracts facts from natural language
  - Determines conversation flow
  - Identifies when enough info is collected
  - Maintains conversational context

#### wildness.user.txt
- **Purpose**: Handles initial wildness level responses
- **Function**: Creates engaging responses when users select their party intensity level (1-10)
- **Key Features**:
  - Matches enthusiasm to selected level
  - Sets appropriate tone for rest of conversation
  - Uses emoji and language that reflects chosen intensity
  - Builds excitement for the planning process

#### general.user.txt
- **Purpose**: Handles general questions about completed itineraries
- **Function**: Answers followup questions after itinerary is presented
- **Key Features**:
  - Provides details about specific venues/activities
  - Handles pricing questions
  - Explains logistics and timing
  - Maintains helpful, informative tone

#### options.user.txt
- **Purpose**: Lists available service options
- **Function**: Shows what's available when users want to see all options
- **Key Features**:
  - Organizes services by category
  - Provides brief descriptions
  - Shows pricing information
  - Helps users understand choices

#### selector.system.txt
- **Purpose**: AI logic for choosing optimal services
- **Function**: Analyzes user preferences and selects best matching venues/activities
- **Key Features**:
  - Matches wildness level to appropriate venues
  - Considers group size and logistics
  - Balances different activity types
  - Creates cohesive itinerary flow

#### response.user.txt
- **Purpose**: Creates natural language itinerary presentations
- **Function**: Takes selected services and presents them as engaging narrative
- **Key Features**:
  - Formats itinerary in easy-to-read structure
  - Adds contextual descriptions
  - Includes timing and logistics
  - Maintains excitement and energy

### Technical Details:

#### Template Variables:
The prompts use \${variable} syntax for dynamic content insertion:
- \${conversationHistory} - Previous messages in conversation
- \${facts} - Collected party details
- \${services} - Available venues and activities
- \${selectedOptions} - AI-chosen itinerary items

#### Service Selection Algorithm:
1. Filters services by group size compatibility
2. Scores each service based on wildness level match
3. Ensures variety (mix of day/night activities)
4. Considers logical flow and proximity
5. Validates budget constraints if provided

#### Version Control:
- All prompt changes are backed up automatically
- Version history shows who changed what and when
- Can revert to any previous version if needed
- Commit messages explain reasoning for changes

### Common Questions Answered:

**Q: How does the bot know what venues to recommend?**
A: The selector.system.txt prompt contains logic that matches user preferences (wildness level, interests) with venue attributes in the service catalog.

**Q: Can the bot handle custom requests?**
A: Yes, the reducer.user.txt prompt extracts any specific requests and the selector considers them when choosing services.

**Q: How does conversation flow work?**
A: The ChatHandler manages states. It starts in INITIAL, moves to GATHERING_FACTS as info comes in, then to SELECTING_OPTIONS when enough is collected.

**Q: What happens if a user asks something off-topic?**
A: The reducer.user.txt prompt is designed to gently redirect while still being helpful. It acknowledges the question but guides back to party planning.

**Q: How are prices calculated?**
A: Each service in the catalog has pricing info. The system doesn't calculate totals automatically but presents individual prices for transparency.

**Q: Can prompts be changed without breaking the system?**
A: Yes, as long as the \${template} variables and JSON response formats are preserved. The system is designed to be flexible.

## YOUR ROLE:
- Answer questions clearly and helpfully
- Explain technical concepts in simple terms
- Provide specific examples when helpful
- Reference the relevant files or prompts when answering
- Help clients understand both WHAT the system does and WHY it works that way
`;

// Question answering template
const QA_PROMPT_TEMPLATE = `
Current Prompts Content: [provided for reference if user asks about specific prompt content]

User Question: "[user message]"

ANALYSIS:
1. What is the user asking about?
2. Which parts of the system are relevant?
3. What level of technical detail is appropriate?
4. Are there any misconceptions to clarify?

Provide a clear, helpful answer that:
- Directly addresses their question
- References specific files/prompts when relevant
- Includes examples if helpful
- Explains both what and why
- Suggests related topics they might want to know about

Keep the tone friendly and professional. Remember, you're helping clients understand what they've purchased without needing to bother the developer.
`;


export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Handler-Version', HANDLER_VERSION);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message: userMessage, currentPrompts } = req.body || {};
  if (!userMessage) return res.status(400).json({ error: 'Missing "message" in body' });

  const openai = getOpenAI();

  try {
    const messages = [
      ...buildSystemMessage(),
      buildUserMessage({ userMessage, currentPrompts })
    ];

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o', // or 'gpt-4o-mini' if you prefer
      temperature: 0.2,
      max_tokens: 1200,
      messages
    });

    let answer = (response.choices?.[0]?.message?.content || '').trim();
    answer = sanitize(answer);

    return res.json({
      response: answer,
      modifiedPrompts: null,
      commitMessage: null,
      needsChanges: false,
      mode: 'qna',
      handlerVersion: HANDLER_VERSION
    });

  } catch (error) {
    console.error('OpenAI API Error:', error);
    return res.status(500).json({
      error: 'OpenAI request failed',
      details: error?.message || String(error),
      handlerVersion: HANDLER_VERSION
    });
  }
}

async function answerUserQuestion(userMessage, currentPrompts) {
  const prompt = `${SYSTEM_KNOWLEDGE}

CURRENT PROMPTS AVAILABLE FOR REFERENCE:
${Object.keys(currentPrompts).map(file => `${file}: [${currentPrompts[file].length} characters of configuration]`).join('\n')}

USER QUESTION: "${userMessage}"

Please provide a helpful, clear answer to the user's question about the Connected bachelor party planning system. Focus on explaining how things work and why design decisions were made. If the question is about a specific prompt, you can reference its purpose and function.

Remember:
- You're helping them understand their system, not modify it
- Use clear, non-technical language when possible
- Provide specific examples when helpful
- Reference the relevant components/files
- Suggest what else they might want to know

Response:`;

  const openai = getOpenAI();

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        {
          role: "system",
          content: "You are a helpful AI assistant explaining a bachelor party planning chatbot system to clients who have purchased it. Be friendly, clear, and thorough in your explanations. Help them understand both the technical aspects and the business logic."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 2000,
      temperature: 0.7
    });

    const answer = response.choices[0].message.content.trim();
    
    // Return in the same format the frontend expects, but with no modifications
    return {
      response: answer,
      modifiedPrompts: null, // No modifications, just Q&A
      commitMessage: null,
      needsChanges: false
    };

  } catch (error) {
    console.error('OpenAI API Error:', error);
    
    // Try with fallback model
    if (error.code === 'model_not_found') {
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            {
              role: "system",
              content: "You are a helpful AI assistant explaining a bachelor party planning chatbot system. Be clear and thorough."
            },
            { role: "user", content: prompt }
          ],
          max_tokens: 2000
        });

        const answer = response.choices[0].message.content.trim();
        
        return {
          response: answer,
          modifiedPrompts: null,
          commitMessage: null,
          needsChanges: false
        };
      } catch (fallbackError) {
        console.error('Fallback model also failed:', fallbackError);
        throw new Error('Unable to process your question. Please try again.');
      }
    }
    
    throw error;
  }
}

// Keep these utility functions even though we're not modifying prompts anymore
// They might be useful for displaying prompt content in answers
function tryParseJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// Remove all modification-related functions since we're just answering questions now
// The frontend will handle the response appropriately since we're returning
// modifiedPrompts: null, which means no changes to preview or apply