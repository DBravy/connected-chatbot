import OpenAI from 'openai';
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AIResponseGenerator {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    this.templateCache = new Map();
  }

  // Template loading and rendering methods (copied from ChatHandler)
  async loadTemplate(filename, { cache = process.env.NODE_ENV === "production" } = {}) {
    if (cache && this.templateCache.has(filename)) {
      return this.templateCache.get(filename);
    }
    const filePath = path.resolve(__dirname, "../prompts", filename); // api -> ../prompts
    const text = await fs.readFile(filePath, "utf8");
    if (cache) this.templateCache.set(filename, text);
    return text;
  }

  // Render ${...} expressions using the provided context.
  renderTemplate(template, context) {
    
    // Log each context value's type and sample
    Object.entries(context).forEach(([key, value]) => {
      const type = typeof value;
      let sample = '';
      if (type === 'object' && value !== null) {
        sample = JSON.stringify(value, null, 2).substring(0, 200) + '...';
      } else if (type === 'string') {
        sample = value.substring(0, 100) + (value.length > 100 ? '...' : '');
      } else {
        sample = String(value);
      }
    });
  
    // Find problematic template expressions
    const expressions = template.match(/\$\{[^}]+\}/g) || [];
  
    const keys = Object.keys(context);
    const vals = Object.values(context);
  
    // Build a real template literal to preserve ${…} semantics
    const body = "return `" +
      template
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`") +
      "`;";
  
    try {
      const fn = new Function(...keys, body);
      
      const out = fn(...vals);
      return out == null ? "" : String(out);
    } catch (e) {
      console.error("\n!!! TEMPLATE RENDER ERROR !!!");
      console.error("Error type:", e.constructor.name);
      console.error("Error message:", e.message);
      console.error("Error stack:", e.stack);
      
      // Try to identify which expression caused the error
      console.log("\nAttempting to identify problematic expression...");
      expressions.forEach((expr, i) => {
        try {
          // Try to evaluate each expression in isolation
          const testBody = `return \`\${${expr.slice(2, -1)}}\`;`;
          const testFn = new Function(...keys, testBody);
          testFn(...vals);
          console.log(`Expression ${i} OK: ${expr}`);
        } catch (testErr) {
          console.error(`Expression ${i} FAILED: ${expr}`);
          console.error(`  Error: ${testErr.message}`);
        }
      });
  
      console.warn("\nFalling back to simple replacement...");
  
      // --- Fallback: only replace ${var} and ${a.b.c}; ignore complex expressions ---
      const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
      return template.replace(/\$\{([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)\}/g, (_, path) => {
        const v = get(context, path);
        console.log(`Replacing ${path} with:`, v);
        return v == null ? "" : String(v);
      });
    }
  }

  async generateItineraryResponse(dayPlan, dayInfo, userPreferences) {
    const selectedServices = dayPlan.selectedServices || [];
    const dayTheme = dayPlan.dayTheme || 'Epic bachelor party day';
    const logisticsNotes = dayPlan.logisticsNotes || '';
  
    // Figure out if this is the last (or only) day
    const totalDays = (userPreferences.duration || dayInfo.totalDays || 1);
    const isLastDay = !!(dayInfo?.isLastDay || (dayInfo?.dayNumber >= totalDays));
    const nextDayNumber = Math.min(totalDays, (dayInfo?.dayNumber || 1) + 1);
  
    const closingInstruction = isLastDay
      ? `7. Closing: ask for approval or tweaks. Do NOT mention another day.`
      : `7. Closing: ask for approval to move to day ${nextDayNumber}.`;

    // PRE-FORMAT THE SELECTED SERVICES to avoid complex template expressions
    const selectedServicesFormatted = selectedServices.map(service => 
      `  - ${service.serviceName} (${service.timeSlot})
  - Why: ${service.reason}
  - Duration: ${service.estimatedDuration}
  - Group fit: ${service.groupSuitability}`
    ).join('\n');

    // Extract values from userPreferences with proper fallbacks
    const groupSize = userPreferences.groupSize || userPreferences.facts?.groupSize?.value || 8;
    const destination = userPreferences.destination || userPreferences.facts?.destination?.value || 'Unknown';
    const wildnessLevel = userPreferences.wildnessLevel || userPreferences.facts?.wildnessLevel?.value || 5;
    const budget = userPreferences.budget || userPreferences.facts?.budget?.value || 'Not specified';
    const specialRequests = userPreferences.specialRequests || 
                           userPreferences.interestedActivities?.join(', ') || 
                           userPreferences.facts?.interestedActivities?.value?.join(', ') || 
                           'having a great time';

    // Extract dayInfo values with proper fallbacks
    const dayNumber = dayInfo?.dayNumber || 1;

    try {
      // Load the template from response.user.txt
      const responseTemplate = await this.loadTemplate("response.user.txt");
      
      // Render the template with context - all complex expressions pre-computed
      const prompt = this.renderTemplate(responseTemplate, {
        dayNumber,
        totalDays,
        groupSize,
        destination,
        specialRequests,
        wildnessLevel,
        budget,
        selectedServicesFormatted,  // Pre-formatted string instead of complex expression
        dayTheme,
        logisticsNotes,
        closingInstruction
      });

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are Connected, a professional bachelor party planner. Write in a natural, conversational tone without excessive enthusiasm. No emojis or emoticons."
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.6, // Reduced from 0.8 for more consistent tone
        max_tokens: 300
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error('AI response generation error:', error);
      return this.generateFallbackResponse(selectedServices, dayInfo, userPreferences);
    }
  }

  generateFallbackResponse(selectedServices, dayInfo, userPreferences) {
    const totalDays = (userPreferences.duration || dayInfo.totalDays || 1);
    const isLastDay = !!(dayInfo?.isLastDay || (dayInfo?.dayNumber >= totalDays));
  
    if (!selectedServices || selectedServices.length === 0) {
      return isLastDay
        ? `Here's what I'm thinking for day ${dayInfo.dayNumber}. I can adjust anything you want—does this work?`
        : `Here's what I'm thinking for day ${dayInfo.dayNumber}. Let me put together some solid options for you. Sound good to plan the next day?`;
    }
  
    let response = `Here's the plan for day ${dayInfo.dayNumber}: `;
    selectedServices.forEach((service, index) => {
      const timeSlot = service.timeSlot.charAt(0).toUpperCase() + service.timeSlot.slice(1);
      response += `${timeSlot}: ${service.serviceName}`;
      if (index < selectedServices.length - 1) response += '. ';
    });

    return isLastDay
      ? `${response}. Does this look good, or want me to adjust anything?`
      : `${response}. This should flow well. Ready to map out day ${(dayInfo.dayNumber || 1) + 1}?`;
  }
}