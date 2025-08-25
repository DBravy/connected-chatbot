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
[Previous architecture description remains the same...]

## SURGICAL EDITING PRINCIPLES:

### CRITICAL RULES FOR ALL MODIFICATIONS:
1. **PRESERVE STRUCTURE**: Never rewrite entire prompts unless absolutely necessary
2. **TARGETED CHANGES ONLY**: Modify only the specific sections that need to change
3. **NO META-HEADERS**: Never add "MODIFIED PROMPT:" or similar headers
4. **TEMPLATE VARIABLE SAFETY**: All \${variable} syntax must remain exactly unchanged
5. **MINIMAL FOOTPRINT**: Make the smallest change that achieves the desired behavior
6. **VERSION AWARENESS**: Always create meaningful commit messages that describe the changes

### GOOD MODIFICATION EXAMPLES:
- User wants "more casual tone" → Add specific casual language guidelines to existing tone section
- User wants "less pushy sales" → Modify existing sales language, don't rewrite entire response logic
- User wants "different question flow" → Adjust specific conversation flow rules, preserve overall structure

### BAD MODIFICATION EXAMPLES:
- Rewriting entire prompt files for small tone changes
- Adding system headers or meta-information to prompts
- Changing template variables or breaking JSON schemas
- Making cosmetic changes that don't address the user's request

### MODIFICATION TYPES (Use these specific categories):
- **targeted_insertion**: Add new content to a specific location
- **targeted_replacement**: Replace specific text with new text
- **targeted_removal**: Remove specific problematic content
- **section_enhancement**: Add guidelines to existing sections

### PRECISION REQUIREMENTS:
When analyzing changes, specify:
- Exact section to modify (e.g. "TONE GUIDELINES section", "line 23-25")
- Precise text to find (for replacements)
- Exact new content to add/replace
- Why this specific change achieves the user's goal
- A meaningful commit message describing the change

Your job is to understand what the user wants to change about their chatbot's behavior and provide surgical, targeted modifications to achieve that goal with minimal disruption.
`;

// Updated analysis prompt template
const ANALYSIS_PROMPT_TEMPLATE = `
SURGICAL MODIFICATION ANALYSIS

Current Prompts: [prompt summaries]
User Request: "[user message]"

ANALYSIS FRAMEWORK:
1. What specific behavior needs to change?
2. Which prompt file(s) control this behavior?  
3. What is the minimum change needed?
4. Where exactly should the change be made?
5. What commit message best describes this change?

RESPONSE FORMAT:
{
  "needsChanges": boolean,
  "response": "I'll make targeted changes to [specific sections] to [specific behavior change]. This will [explain expected outcome].",
  "commitMessage": "Brief description of what this change accomplishes",
  "changes": [
    {
      "promptFile": "[filename]",
      "reason": "[why this specific file needs modification]",
      "modifications": [
        {
          "type": "targeted_insertion|targeted_replacement|targeted_removal|section_enhancement",
          "description": "[precise description of the surgical change]",
          "target_section": "[exact section identifier - be specific]",
          "search_text": "[exact text to find, if replacing]",
          "replacement_text": "[exact replacement text]"
        }
      ]
    }
  ]
}

VALIDATION CHECKLIST:
☐ Changes are surgical and targeted
☐ No complete prompt rewrites  
☐ Template variables preserved
☐ Structure maintained
☐ Specific sections identified
☐ Clear behavior outcome predicted
☐ Meaningful commit message provided
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
    const { message, currentPrompts, previewMode = true } = req.body;
    
    if (!message || !currentPrompts) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Analyze the user's request and prepare changes
    const result = await analyzeAndModifyPrompts(message, currentPrompts, previewMode);
    
    res.json(result);
  } catch (error) {
    console.error('AI Prompt Modifier error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}

async function analyzeAndModifyPrompts(userMessage, currentPrompts, previewMode = true) {
  // First, analyze what the user wants to change
  const analysis = await analyzeUserRequest(userMessage, currentPrompts);
  
  if (!analysis.needsChanges) {
    return {
      response: analysis.response,
      modifiedPrompts: null,
      commitMessage: null
    };
  }
  
  // Apply the changes to the relevant prompts with validation
  const modifiedPrompts = {};
  
  for (const change of analysis.changes) {
    const { promptFile, modifications } = change;
    
    if (currentPrompts[promptFile]) {
      const originalContent = currentPrompts[promptFile];
      const modifiedContent = await applyModificationsToPrompt(
        originalContent,
        modifications,
        promptFile
      );
      
      // Validation: Ensure the modification was actually surgical
      const originalLines = originalContent.split('\n').length;
      const modifiedLines = modifiedContent.split('\n').length;
      const lineDifference = Math.abs(originalLines - modifiedLines);
      
      // If more than 10% of lines changed, flag as potentially problematic
      if (lineDifference > originalLines * 0.1) {
        console.warn(`Warning: Large structural change detected in ${promptFile}. Original: ${originalLines} lines, Modified: ${modifiedLines} lines`);
      }
      
      // Ensure template variables are preserved
      const originalVariables = (originalContent.match(/\$\{[^}]+\}/g) || []).sort();
      const modifiedVariables = (modifiedContent.match(/\$\{[^}]+\}/g) || []).sort();
      
      if (JSON.stringify(originalVariables) !== JSON.stringify(modifiedVariables)) {
        console.error(`ERROR: Template variables changed in ${promptFile}!`);
        console.error('Original variables:', originalVariables);
        console.error('Modified variables:', modifiedVariables);
        throw new Error(`Template variable preservation failed for ${promptFile}`);
      }
      
      modifiedPrompts[promptFile] = modifiedContent;
    }
  }
  
  const result = {
    response: analysis.response,
    modifiedPrompts: Object.keys(modifiedPrompts).length > 0 ? modifiedPrompts : null,
    commitMessage: analysis.commitMessage || null,
    previewMode
  };
  
  return result;
}

function tryParseJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

async function analyzeUserRequest(userMessage, currentPrompts) {
  const prompt = `${SYSTEM_KNOWLEDGE}

CURRENT PROMPTS SUMMARY:
${Object.keys(currentPrompts).map(file => `${file}: ${currentPrompts[file].substring(0, 200)}...`).join('\n\n')}

USER REQUEST: "${userMessage}"

CRITICAL ANALYSIS RULES:
- Only suggest changes if they're actually needed
- Make SURGICAL modifications, not complete rewrites
- Preserve all template variables (\${variable}) and structure
- Focus on the specific behavior change requested
- Avoid making cosmetic or unnecessary changes
- Create a meaningful commit message that describes the change

Analyze the request and produce a JSON object with this exact shape:

{
  "needsChanges": boolean,
  "response": string (a clear explanation of what will be changed and why),
  "commitMessage": string (brief description of the change for version history),
  "changes": [
    {
      "promptFile": "reducer.user.txt" | "general.user.txt" | "options.user.txt" | "selector.system.txt" | "response.user.txt",
      "reason": string (why this file needs to be modified),
      "modifications": [
        {
          "type": "tone_change" | "logic_change" | "content_addition" | "content_removal" | "format_change",
          "description": string (what specific change will be made),
          "target_section": string | null (which part of the prompt to modify),
          "new_content": string | null (any new content to add)
        }
      ]
    }
  ]
}

IMPORTANT: Be surgical and precise. Only change what's necessary for the requested behavior modification.

Rules:
- Return ONLY valid JSON, no prose.
- Keep the object small and concise.
- Omit "changes" or use an empty array if none are needed.
- The "response" should clearly explain what changes will be made in user-friendly language.
- The "commitMessage" should be a brief, descriptive summary suitable for version history.
`;

  const openai = getOpenAI();

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",  // Using gpt-4-turbo as fallback since gpt-5 might not be available
      messages: [
        {
          role: "system",
          content: "You are an expert prompt engineer. Respond ONLY with valid JSON as specified. Focus on explaining changes clearly and providing meaningful commit messages."
        },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 6000
    });

    const choice = response.choices?.[0];
    const message = choice?.message;

    // Parse JSON content directly
    const parsed = tryParseJSON(message?.content);
    if (parsed) return parsed;

    // Legacy fallbacks (if you later reintroduce tools)
    if (message?.tool_calls?.length) {
      const tc = message.tool_calls.find(t => t.function?.arguments);
      const args = tc?.function?.arguments;
      const parsedTC = tryParseJSON(args);
      if (parsedTC) return parsedTC;
    }
    if (message?.function_call?.arguments) {
      const parsedFC = tryParseJSON(message.function_call.arguments);
      if (parsedFC) return parsedFC;
    }

    // Last resort: helpful error that surfaces finish_reason
    const fr = choice?.finish_reason || "unknown";
    return {
      needsChanges: false,
      response:
        fr === "length"
          ? "I hit the output limit before I could finish analyzing your request. Please try again or break it into smaller parts."
          : "I couldn't parse the analysis response. Please try rephrasing your request.",
      commitMessage: null,
      changes: []
    };
  } catch (error) {
    console.error('OpenAI API Error:', error);
    if (error.code === 'model_not_found') {
      // Try with gpt-4 as fallback
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            {
              role: "system",
              content: "You are an expert prompt engineer. Respond ONLY with valid JSON as specified. Focus on explaining changes clearly and providing meaningful commit messages."
            },
            { role: "user", content: prompt }
          ],
          response_format: { type: "json_object" },
          max_tokens: 4000
        });

        const choice = response.choices?.[0];
        const message = choice?.message;
        const parsed = tryParseJSON(message?.content);
        if (parsed) return parsed;
      } catch (fallbackError) {
        console.error('Fallback model also failed:', fallbackError);
      }
      
      throw new Error('GPT models not available. Please ensure you have access to GPT-4 or newer models.');
    } else if (error.code === 'insufficient_quota') {
      throw new Error('OpenAI API quota exceeded. Please check your billing settings.');
    } else if (error.code === 'unsupported_value') {
      throw new Error(`Unsupported parameter value: ${error.message}`);
    } else {
      throw error;
    }
  }
}

async function applyModificationsToPrompt(originalPrompt, modifications, promptFile) {
  const modificationPrompt = `You are making SURGICAL modifications to a prompt template. Your goal is to make the minimum necessary changes while preserving all functionality.

ORIGINAL PROMPT:
${originalPrompt}

MODIFICATIONS TO APPLY:
${modifications.map(mod => `- ${mod.type}: ${mod.description}
  Target: ${mod.target_section || 'Not specified'}
  ${mod.search_text ? `Search for: "${mod.search_text}"` : ''}
  ${mod.replacement_text ? `Replace with: "${mod.replacement_text}"` : ''}`).join('\n\n')}

CRITICAL REQUIREMENTS FOR SURGICAL EDITING:

1. PRESERVE EVERYTHING UNCHANGED except what's specifically targeted
2. NEVER add meta-headers like "MODIFIED PROMPT:" or similar
3. NEVER rewrite entire sections unless explicitly required
4. Keep ALL template variables (\${variable}) exactly as they are
5. Maintain the exact same structure, spacing, and formatting
6. Only modify the specific lines/sections mentioned in the modifications
7. If adding new content, insert it naturally into the existing structure
8. If replacing text, find the exact match and replace only that text

EXAMPLES OF GOOD SURGICAL CHANGES:

Request: "Add tone guideline to avoid exclamation points"
BAD: Rewrite entire TONE section
GOOD: Add one line "- Avoid excessive exclamation points" to existing tone guidelines

Request: "Make conversation more casual" 
BAD: Rewrite entire prompt with casual language
GOOD: Add specific casual language guidelines to existing instruction section

YOUR OUTPUT SHOULD BE:
- The original prompt with only the targeted changes applied
- No extra headers, comments, or meta-information
- Identical formatting and structure to the original
- Only the specific modifications requested, nothing more

Return the modified prompt now:`;

  const openai = getOpenAI();
  
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        {
          role: "system",
          content: `You are a surgical prompt editor. Make ONLY the specific changes requested. Preserve everything else exactly. Never add meta-headers or rewrite unnecessarily.`
        },
        { role: "user", content: modificationPrompt }
      ],
      max_completion_tokens: 3000
    });

    const modifiedPrompt = response.choices[0].message.content.trim();
    
    // Validation: Check that the result doesn't contain meta-headers
    if (modifiedPrompt.includes('MODIFIED PROMPT:') || 
        modifiedPrompt.includes('UPDATED PROMPT:') ||
        modifiedPrompt.includes('NEW PROMPT:')) {
      console.warn('AI added meta-headers, attempting to clean...');
      return cleanMetaHeaders(modifiedPrompt);
    }
    
    return modifiedPrompt;

  } catch (error) {
    console.error('Error modifying prompt:', error);
    
    // Fallback to GPT-4 with same strict instructions
    if (error.code === 'model_not_found') {
      console.log('Falling back to gpt-4 with surgical instructions...');
      const response = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: `You are a surgical prompt editor for ${promptFile}. Make ONLY the specific changes requested. Preserve everything else exactly. Never add meta-headers.`
          },
          { role: "user", content: modificationPrompt }
        ],
        max_tokens: 3000
      });
      
      const modifiedPrompt = response.choices[0].message.content.trim();
      return cleanMetaHeaders(modifiedPrompt);
    }
    
    throw error;
  }
}

// Helper function to clean meta-headers that AI might add
function cleanMetaHeaders(prompt) {
  const lines = prompt.split('\n');
  const cleanedLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip lines that look like meta-headers
    if (line.match(/^(MODIFIED|UPDATED|NEW) PROMPT:?/i) ||
        line.match(/^Here is the modified prompt:?/i) ||
        line.match(/^Modified version:?/i)) {
      continue;
    }
    
    // Skip empty lines immediately after meta-headers
    if (cleanedLines.length === 0 && line.trim() === '') {
      continue;
    }
    
    cleanedLines.push(line);
  }
  
  return cleanedLines.join('\n');
}