// api/ai-prompt-modifier.js
import dotenv from 'dotenv';
import OpenAI from 'openai';
dotenv.config();

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing OPENAI_API_KEY. Add it to your environment or .env file.'
    );
  }
  return new OpenAI({ apiKey });
}

// System understanding of the Connected bachelor party planning system
const SYSTEM_KNOWLEDGE = `
You are an expert AI prompt engineer with deep knowledge of the Connected bachelor party planning system. Here's how the system works:

## SYSTEM ARCHITECTURE:
The Connected chatbot helps users plan bachelor parties through a conversation-based interface with these phases:
1. GATHERING: Collects essential facts (destination, group size, dates) and helpful info (wildness level, budget, activities)
2. PLANNING: Uses AI to select services day-by-day, allowing user feedback and modifications
3. STANDBY: All days planned, handles questions and modifications

## PROMPT FILES & THEIR ROLES:

### 1. reducer.user.txt (Core Conversation Processor)
- Analyzes every user message to extract/update facts
- Classifies user intent: approval_next, substitution, addition, removal, show_day, general_question
- Determines when to transition between conversation phases
- Controls the conversation flow and fact gathering
- IMPACT: Changes here affect how the bot understands users and manages the entire conversation

### 2. general.user.txt (Question Handler)
- Handles questions when planning is complete (STANDBY phase)
- Answers questions about pricing, timing, logistics, service details
- Uses full trip context to provide informed responses
- IMPACT: Changes here affect how well the bot helps customers after planning

### 3. options.user.txt (Service Catalog Presenter)
- Presents lists of available services when users ask "what are my options"
- Formats service catalogs with descriptions and pricing
- Guides users toward making selections
- IMPACT: Changes here affect how services are presented and marketed

### 4. selector.system.txt (AI Service Selection Logic)
- Controls how the AI chooses optimal services for each day
- Balances user preferences, practical flow, and deduplication
- Handles substitutions and modifications to day plans
- IMPACT: Changes here affect which services get selected and recommended

### 5. response.user.txt (Itinerary Presentation)
- Generates natural language presentations of daily plans
- Creates engaging descriptions and explanations
- Manages approval requests and next-step guidance
- IMPACT: Changes here affect how itineraries are presented and sold

## USER CHANGE CATEGORIES:

**Personality/Tone Changes:** Modify response.user.txt, general.user.txt, and sometimes reducer.user.txt
**Conversation Flow:** Primarily reducer.user.txt
**Service Selection Logic:** selector.system.txt
**Sales/Marketing Approach:** options.user.txt, response.user.txt
**Customer Service:** general.user.txt
**Fact Gathering:** reducer.user.txt

## CRITICAL RULES:
1. Preserve all template variable syntax (\${variable}) exactly
2. Maintain JSON schema requirements for structured outputs
3. Keep function calling specifications intact
4. Don't break the conversation phase logic
5. Preserve the deduplication and service selection logic
6. Maintain backward compatibility with existing conversations

Your job is to understand what the user wants to change about their chatbot's behavior and modify the appropriate prompt(s) accordingly.
`;

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

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { message, currentPrompts } = req.body;
    
    if (!message || !currentPrompts) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Analyze the user's request and modify prompts
    const result = await analyzeAndModifyPrompts(message, currentPrompts);
    
    res.json(result);
  } catch (error) {
    console.error('AI Prompt Modifier error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}

async function analyzeAndModifyPrompts(userMessage, currentPrompts) {
  // First, analyze what the user wants to change
  const analysis = await analyzeUserRequest(userMessage, currentPrompts);
  
  if (!analysis.needsChanges) {
    return {
      response: analysis.response,
      modifiedPrompts: null
    };
  }
  
  // Apply the changes to the relevant prompts
  const modifiedPrompts = {};
  
  for (const change of analysis.changes) {
    const { promptFile, modifications } = change;
    
    if (currentPrompts[promptFile]) {
      const modifiedContent = await applyModificationsToPrompt(
        currentPrompts[promptFile],
        modifications,
        promptFile
      );
      modifiedPrompts[promptFile] = modifiedContent;
    }
  }
  
  return {
    response: analysis.response,
    modifiedPrompts: Object.keys(modifiedPrompts).length > 0 ? modifiedPrompts : null
  };
}

async function analyzeUserRequest(userMessage, currentPrompts) {
    const prompt = `${SYSTEM_KNOWLEDGE}
  
  CURRENT PROMPTS SUMMARY:
  ${Object.keys(currentPrompts).map(file => `${file}: ${currentPrompts[file].substring(0, 200)}...`).join('\n\n')}
  
  USER REQUEST: "${userMessage}"
  
  Analyze this request and determine:
  1. What changes are needed to achieve the user's goal
  2. Which prompt files need to be modified
  3. Specific modifications for each file
  
  Respond with a plan for implementing the changes.`;
  
    const openai = getOpenAI();
    const response = await openai.chat.completions.create({
      // You can keep "gpt-5" if your account supports it for Chat Completions + tools.
      // Otherwise, use a tool-enabled chat model you have access to (e.g., "gpt-4o-mini").
      model: "gpt-5",
      messages: [
        {
          role: "system",
          content: "You are an expert prompt engineer analyzing a request to modify a chatbot system. Provide clear analysis of what needs to change."
        },
        { role: "user", content: prompt }
      ],
      tools: [{
        type: "function",
        function: {
          name: "analyze_request",
          description: "Analyze user request and plan prompt modifications",
          parameters: {
            type: "object",
            properties: {
              needsChanges: { type: "boolean" },
              response: { type: "string" },
              changes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    promptFile: {
                      type: "string",
                      enum: [
                        "reducer.user.txt",
                        "general.user.txt",
                        "options.user.txt",
                        "selector.system.txt",
                        "response.user.txt"
                      ]
                    },
                    reason: { type: "string" },
                    modifications: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          type: {
                            type: "string",
                            enum: ["tone_change","logic_change","content_addition","content_removal","format_change"]
                          },
                          description: { type: "string" },
                          target_section: { type: "string" },
                          new_content: { type: "string" }
                        },
                        required: ["type", "description"]
                      }
                    }
                  },
                  required: ["promptFile", "reason", "modifications"]
                }
              }
            },
            required: ["needsChanges", "response"]
          }
        }
      }],
      // Force the model to call our function
      tool_choice: { type: "function", function: { name: "analyze_request" } },
      max_completion_tokens: 1500
    });
  
    const msg = response.choices?.[0]?.message;
  
    // 1) New-style tools
    const toolCall = msg?.tool_calls?.find(
      t => t.type === "function" && t.function?.name === "analyze_request"
    );
    if (toolCall?.function?.arguments) {
      try {
        return JSON.parse(toolCall.function.arguments);
      } catch (e) {
        console.error("Failed to parse tool arguments:", e, toolCall.function.arguments);
      }
    }
  
    // 2) Back-compat: legacy function_call
    if (msg?.function_call?.arguments) {
      try {
        return JSON.parse(msg.function_call.arguments);
      } catch (e) {
        console.error("Failed to parse legacy function_call arguments:", e, msg.function_call.arguments);
      }
    }
  
    // Fallback (what you're seeing today)
    return {
      needsChanges: false,
      response: "I understand you want to make changes, but I need more specific details about what you'd like to modify. Could you describe the specific behavior you want to change?",
      changes: []
    };
  }

async function applyModificationsToPrompt(originalPrompt, modifications, promptFile) {
  const modificationPrompt = `You are modifying a prompt template for the Connected bachelor party planning system.

ORIGINAL PROMPT:
${originalPrompt}

MODIFICATIONS TO APPLY:
${modifications.map(mod => `- ${mod.type}: ${mod.description}${mod.target_section ? ` (Target: ${mod.target_section})` : ''}${mod.new_content ? `\nNew content: ${mod.new_content}` : ''}`).join('\n')}

CRITICAL REQUIREMENTS:
1. Preserve ALL template variables (\${variable}) exactly as they are
2. Maintain any JSON schema or function calling specifications
3. Keep the overall structure and logic intact
4. Only modify the specific aspects mentioned in the modifications
5. Ensure the prompt still works within the existing system architecture

Return the modified prompt that incorporates these changes while maintaining system compatibility.`;
  const openai = getOpenAI();
  const response = await openai.chat.completions.create({
    model: "gpt-5",
    messages: [
      {
        role: "system",
        content: `You are an expert prompt engineer modifying ${promptFile}. Preserve all system functionality while implementing the requested changes.`
      },
      { role: "user", content: modificationPrompt }
    ],
    max_completion_tokens: 3000  // CHANGED: max_tokens -> max_completion_tokens
  });

  return response.choices[0].message.content;
}