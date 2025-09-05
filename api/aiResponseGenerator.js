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

  // aiResponseGenerator.js
  async generateItineraryResponse(dayPlan, dayInfo, userPreferences, options = {})  {

    if (options.short) {
      const dayNumber = dayInfo?.dayNumber || 1;
      const totalDays = userPreferences.duration || dayInfo.totalDays || 1;
      const isLastDay = dayNumber >= totalDays;
      
      if (isLastDay) {
        return {
          response: `Day ${dayNumber} is set. Want to finalize the itinerary?`,
          interactive: {
            type: 'buttons',
            buttons: [
              { text: 'Yes, finalize', value: 'finalize_yes', style: 'primary' },
              { text: 'No, make changes', value: 'finalize_no', style: 'secondary' }
            ]
          }
        };
      } else {
        return {
          response: `Day ${dayNumber} is set. Ready for Day ${dayNumber + 1}?`,
          interactive: {
            type: 'buttons',
            buttons: [
              { text: 'Yes, next day', value: 'next_day_yes', style: 'primary' },
              { text: 'No, make changes', value: 'next_day_no', style: 'secondary' }
            ]
          }
        };
      }
    }

    const DBG = process.env.CONNECTED_DEBUG_LOGS === '1';
    const STRIP = process.env.CONNECTED_STRIP_UNGROUNDED_PRICES === '1';
    const log = (...a) => { if (DBG) console.log('[ItinWriter]', ...a); };

    const selectedServices = dayPlan.selectedServices || [];
    const dayTheme = dayPlan.dayTheme || 'Epic bachelor party day';
    const logisticsNotes = dayPlan.logisticsNotes || '';

    const totalDays = (userPreferences.duration || dayInfo.totalDays || 1);
    const isLastDay = !!(dayInfo?.isLastDay || (dayInfo?.dayNumber >= totalDays));
    const nextDayNumber = Math.min(totalDays, (dayInfo?.dayNumber || 1) + 1);

    const closingInstruction = isLastDay
      ? `7. Closing: ask for approval or tweaks. Do NOT mention another day.`
      : `7. Closing: ask for approval to move to day ${nextDayNumber}.`;

    // Debug: what did we actually receive?
    if (DBG) {
      log('Selected services (received):',
        selectedServices.map(s => ({
          id: s.serviceId, name: s.serviceName, slot: s.timeSlot,
          cad: s.price_cad, usd: s.price_usd, dur: s.duration_hours
        }))
      );
    }

    // Pre-format with an explicit Price line based only on provided data
    const selectedServicesFormatted = selectedServices.map(s => {
      const price =
        (s?.price_cad != null) ? `$${s.price_cad} CAD`
        : (s?.price_usd != null) ? `$${s.price_usd} USD`
        : 'N/A';
      const duration = s.estimatedDuration || s.duration_hours || 'TBD';
      return `  - ${s.serviceName} (${s.timeSlot})
    - Why: ${s.reason}
    - Duration: ${duration}
    - Price: ${price}
    - Group fit: ${s.groupSuitability}`;
    }).join('\n');

    if (DBG) {
      log('selectedServicesFormatted:\n' + selectedServicesFormatted);
    }

    const groupSize = userPreferences.groupSize || userPreferences.facts?.groupSize?.value || 8;
    const destination = userPreferences.destination || userPreferences.facts?.destination?.value || 'Unknown';
    const wildnessLevel = userPreferences.wildnessLevel || userPreferences.facts?.wildnessLevel?.value || 5;
    const budget = userPreferences.budget || userPreferences.facts?.budget?.value || 'Not specified';
    const specialRequests = userPreferences.specialRequests ||
                            userPreferences.interestedActivities?.join(', ') ||
                            userPreferences.facts?.interestedActivities?.value?.join(', ') ||
                            'having a great time';
    const dayNumber = dayInfo?.dayNumber || 1;

    try {
      const responseTemplate = await this.loadTemplate("response.user.txt");
      const prompt = this.renderTemplate(responseTemplate, {
        dayNumber,
        totalDays,
        groupSize,
        destination,
        specialRequests,
        wildnessLevel,
        budget,
        selectedServicesFormatted,  // contains Price lines
        dayTheme,
        logisticsNotes,
        closingInstruction
      });

      // Build a set of grounded price strings we permit
      const allowedPriceStrings = new Set();
      selectedServices.forEach(s => {
        if (s?.price_cad != null) allowedPriceStrings.add(`$${s.price_cad} CAD`);
        if (s?.price_usd != null) allowedPriceStrings.add(`$${s.price_usd} USD`);
      });
      const anyKnownPrice = allowedPriceStrings.size > 0;

      const systemMsg =
        "You are Connected, a professional bachelor party planner. " +
        "Never invent prices, estimates, or price ranges. Only mention a price if it is explicitly provided in the user prompt. " +
        "If a price is not provided, write 'Price: N/A' or omit the price line. " +
        "Keep a natural, conversational tone. No emojis or emoticons.";

      if (DBG) {
        log('System message:', systemMsg);
        log('Prompt (first 800 chars):', prompt.slice(0, 800));
        log('Allowed price tokens:', Array.from(allowedPriceStrings));
        log('anyKnownPrice:', anyKnownPrice);
      }

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: prompt }
        ],
        temperature: 0.6,
        max_tokens: 300
      });

      let text = response.choices?.[0]?.message?.content || '';
      if (DBG) {
        log('Raw LLM text (first 800):', text.slice(0, 800));
      }

      // Detect any $ amounts the model produced
      const dollarRegex = /\$[\d][\d,]*(?:\.\d{2})?\s?(?:USD|CAD)?/g;
      const found = text.match(dollarRegex) || [];
      const ungrounded = found.filter(tok => !allowedPriceStrings.has(tok));
      if (DBG) {
        log('LLM price tokens found:', found);
        log('Ungrounded price tokens:', ungrounded);
      }

      // Optional: strip ungrounded prices (opt-in)
      if (STRIP && ungrounded.length) {
        log('STRIPPING ungrounded prices from text');
        ungrounded.forEach(tok => {
          // Replace stand-alone tokens and common "Price: $XYZ" shapes
          text = text.replace(new RegExp(tok.replace(/[$]/g, '\\$'), 'g'), 'N/A');
        });
      }

      // If no prices are known at all and it still inserted $ amounts, scrub hard
      if (!anyKnownPrice && found.length > 0) {
        log('No grounded prices available, but $ amounts were found — scrubbing.');
        text = text.replace(dollarRegex, 'N/A');
      }

      if (DBG) log('Final text (first 800):', text.slice(0, 800));

      // Always return interactive Yes/No controls when asking to proceed
      const buttons = isLastDay
        ? [
            { text: 'Yes, finalize', value: 'finalize_yes', style: 'primary' },
            { text: 'No, make changes', value: 'finalize_no', style: 'secondary' }
          ]
        : [
            { text: 'Yes, next day', value: 'next_day_yes', style: 'primary' },
            { text: 'No, make changes', value: 'next_day_no', style: 'secondary' }
          ];

      return { response: text, interactive: { type: 'buttons', buttons } };
    } catch (error) {
      console.error('[ItinWriter] ERROR:', error);
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