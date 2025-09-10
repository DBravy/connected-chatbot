import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { PHASES, FIELD_STATUS, FACT_PRIORITY, createNewConversation } from './conversationState.js';
import { AIServiceSelector } from './aiServiceSelector.js';
import { AIResponseGenerator } from './aiResponseGenerator.js';
import { globalConversations } from './globalState.js';

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Define the function-calling tool the model should use for the reducer
const reducerFunction = {
  name: "reduce_state",
  description: "Update conversation state based on user message with intelligent intent classification",
  parameters: {
    type: "object",
    properties: {
      facts: {
        type: "object",
        properties: {
          destination: {
            type: "object", 
            properties: {
              value: { type: ["string", "null"] },
              status: { type: "string", enum: ["unknown", "suggested", "assumed", "set", "corrected"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              provenance: { type: ["string", "null"] }
            }
          },
          groupSize: {
            type: "object",
            properties: {
              value: { type: ["number", "null"] },
              status: { type: "string", enum: ["unknown", "suggested", "assumed", "set", "corrected"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              provenance: { type: ["string", "null"] }
            }
          },
          startDate: {
            type: "object",
            properties: {
              value: { type: ["string", "null"] },
              status: { type: "string", enum: ["unknown", "suggested", "assumed", "set", "corrected"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              provenance: { type: ["string", "null"] }
            }
          },
          endDate: {
            type: "object",
            properties: {
              value: { type: ["string", "null"] },
              status: { type: "string", enum: ["unknown", "suggested", "assumed", "set", "corrected"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              provenance: { type: ["string", "null"] }
            }
          },
          wildnessLevel: {
            type: "object",
            properties: {
              value: { type: ["number", "null"] },
              status: { type: "string", enum: ["unknown", "suggested", "assumed", "set", "corrected"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              provenance: { type: ["string", "null"] }
            }
          },
          relationship: {
            type: "object",
            properties: {
              value: { type: ["string", "null"] },
              status: { type: "string", enum: ["unknown", "suggested", "assumed", "set", "corrected"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              provenance: { type: ["string", "null"] }
            }
          },
          interestedActivities: {
            type: "object",
            properties: {
              value: { type: "array", items: { type: "string" } },
              status: { type: "string", enum: ["unknown", "suggested", "assumed", "set", "corrected"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              provenance: { type: ["string", "null"] }
            }
          },
          ageRange: {
            type: "object",
            properties: {
              value: { type: ["string", "null"] },
              status: { type: "string", enum: ["unknown", "suggested", "assumed", "set", "corrected"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              provenance: { type: ["string", "null"] }
            }
          },
          budget: {
            type: "object",
            properties: {
              value: { type: ["string", "null"] },
              status: { type: "string", enum: ["unknown", "suggested", "assumed", "set", "corrected"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              provenance: { type: ["string", "null"] }
            }
          }
        }
      },
      assumptions: { type: "array", items: { type: "string" } },
      blocking_questions: { type: "array", items: { type: "string" } },
      safe_transition: { type: "boolean" },
      reply: { type: "string" },
      intent_type: {
        type: "string", 
        enum: ["edit_itinerary", "general_question", "approval_next", "show_day", "substitution", "addition", "removal"],
        description: "Type of user intent"
      },
      target_day_index: {
        type: ["integer","null"],
        description: "0-based day index the user referred to explicitly (e.g., 'day one', 'Friday', 'Sept 5'); null if not specified/unresolvable."
      },

      substitution_details: {
        type: "object",
        properties: {
          what_changed: { type: "string" },
          changed_from: { type: "string" },
          changed_to: { type: "string" }
        }
      }
    },
    required: ["facts", "assumptions", "blocking_questions", "safe_transition", "reply", "intent_type"]
  }
};


export class ChatHandler {

  
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL, 
      process.env.SUPABASE_ANON_KEY
    );
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    // In-memory storage for now
    this.conversations = globalConversations;
    this.aiSelector = new AIServiceSelector();
    this.aiResponseGenerator = new AIResponseGenerator();
  }

  templateCache = new Map();

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
  // NOTE: This evaluates expressions from your own file—do not feed user input here.
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
  setFact(conversation, key, value, provenance = 'dev') {
    if (!conversation.facts[key]) return;
    conversation.facts[key] = {
      ...conversation.facts[key],
      value,
      status: 'set',
      confidence: 0.99,
      provenance
    };
  }
  
  deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
  
  // Export/import a minimal snapshot of state for fast replays
  exportSnapshot(conversation) {
    // Turn Set -> Array so JSON can carry it
    const snap = {
      phase: conversation.phase,
      facts: conversation.facts,
      availableServices: conversation.availableServices,
      selectedServices: conversation.selectedServices,
      expectingFirstWildnessResponse: conversation.expectingFirstWildnessResponse,
      // NEW: persist awaiting fact capture hint
      awaiting: conversation.awaiting || { fact: null, sinceMessageId: null },
      // NEW: persist guided first day state
      guidedFirstDay: conversation.guidedFirstDay || { step: null, airportPickup: null, eveningActivity: null, isComplete: false },
      dayByDayPlanning: {
        ...conversation.dayByDayPlanning,
        usedServices: Array.from(conversation.dayByDayPlanning?.usedServices || [])
      },
      messages: conversation.messages
    };
    return this.deepClone(snap);
  }

  importSnapshot(conversation, snapshot) {
    const snap = this.deepClone(snapshot);
  
        conversation.phase = snap.phase ?? conversation.phase;
    conversation.facts = snap.facts ?? conversation.facts;
    conversation.availableServices = snap.availableServices ?? [];
    conversation.selectedServices = snap.selectedServices ?? {};
    conversation.expectingFirstWildnessResponse = snap.expectingFirstWildnessResponse ?? false;

    // NEW: restore awaiting (fallback to a safe default)
    conversation.awaiting = snap.awaiting ?? conversation.awaiting ?? { fact: null, sinceMessageId: null };
    
    // NEW: restore guided first day state
    conversation.guidedFirstDay = snap.guidedFirstDay ?? conversation.guidedFirstDay ?? { step: null, airportPickup: null, eveningActivity: null, isComplete: false };
  
    // Merge then rehydrate Set <- Array/object
    conversation.dayByDayPlanning = {
      ...(conversation.dayByDayPlanning || {}),
      ...(snap.dayByDayPlanning || {})
    };
    const us = snap.dayByDayPlanning?.usedServices;
    conversation.dayByDayPlanning.usedServices =
      us instanceof Set ? us
      : Array.isArray(us) ? new Set(us)
      : (us && typeof us === 'object') ? new Set(Object.values(us))
      : new Set();
  
    conversation.messages = snap.messages ?? conversation.messages;
    return conversation;
  }
  

  ensureUsedServicesSet(conversation) {
    const d = conversation.dayByDayPlanning || (conversation.dayByDayPlanning = {});
    const us = d.usedServices;
    if (us instanceof Set) return;
    if (Array.isArray(us)) d.usedServices = new Set(us);
    else if (us && typeof us === 'object') d.usedServices = new Set(Object.values(us));
    else d.usedServices = new Set();
  }
  
  // --- NEW: rebuild used services from all saved days (safer than delete) ---
  rebuildUsedServices(conversation) {
    this.ensureUsedServicesSet(conversation);
    const used = new Set();
    const all = conversation.selectedServices || [];
    all.forEach(day =>
      (day?.selectedServices || []).forEach(s => { if (s?.serviceId) used.add(String(s.serviceId)); })
    );
    conversation.dayByDayPlanning.usedServices = used;
  }

  // --- NEW: convert ordinal/word to number (1..10 basic) ---
  wordToNumber(word) {
    const map = {
      'one':1,'first':1,
      'two':2,'second':2,
      'three':3,'third':3,
      'four':4,'fourth':4,
      'five':5,'fifth':5,
      'six':6,'sixth':6,
      'seven':7,'seventh':7,
      'eight':8,'eighth':8,
      'nine':9,'ninth':9,
      'ten':10,'tenth':10
    };
    return map[word] || null;
  }

  // --- NEW: parse a concrete date from free text (YYYY-MM-DD | M/D | Month D) ---
  parseExplicitDateFromText(text) {
    const t = (text || '').trim();

    // YYYY-MM-DD
    let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);

    // M/D or MM/DD (optionally with year)
    m = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (m) {
      const y = m[3] ? Number(m[3].length === 2 ? ('20' + m[3]) : m[3]) : new Date().getFullYear();
      return new Date(y, Number(m[1]) - 1, Number(m[2]), 12, 0, 0);
    }

    // Month name + day
    m = t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i);
    if (m) {
      const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      const month = monthNames.indexOf(m[1].toLowerCase().slice(0,3) === 'sep' ? 'september' : m[1].toLowerCase());
      const day = Number(m[2]);
      const y = m[3] ? Number(m[3]) : new Date().getFullYear();
      return new Date(y, month, day, 12, 0, 0);
    }

    return null;
  }

  // --- NEW: resolve which day index the user meant ---
  resolveTargetDayIndex(userMessage, conversation, fallbackIndex = null, reduction = null) {
    const msg = String(userMessage || '').toLowerCase();

    // If reducer gave us a clean answer, trust it (and validate bounds)
    const totalDays = conversation.dayByDayPlanning?.totalDays ||
                      this.calculateDuration(conversation?.facts?.startDate?.value, conversation?.facts?.endDate?.value) || 0;
    let idxFromReducer = (reduction && Number.isInteger(reduction.target_day_index)) ? reduction.target_day_index : null;
    if (idxFromReducer != null && idxFromReducer >= 0 && idxFromReducer < totalDays) return idxFromReducer;

    // Trip dates
    const start = this.toLocalDate(conversation?.facts?.startDate?.value);
    if (!start || !totalDays) return (fallbackIndex != null) ? fallbackIndex : (conversation.dayByDayPlanning?.currentDay || 0);

    // 1) "day 1" / "day one" / "first day" / "2nd day"
    let m = msg.match(/\bday\s*(\d+)\b/);
    if (!m) m = msg.match(/\b(\d+)(?:st|nd|rd|th)?\s*day\b/);
    if (!m) {
      // words/ordinals
      const w = msg.match(/\bday\s+(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/);
      if (w) {
        const n = this.wordToNumber(w[1]);
        if (n && n >= 1 && n <= totalDays) return n - 1;
      }
    } else {
      const n = Number(m[1]);
      if (n >= 1 && n <= totalDays) return n - 1;
    }

    // 2) Weekday name (fri, friday, etc.)
    const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12, 0, 0);
      const name = weekdays[d.getDay()];
      if (msg.includes(name)) return i;
    }

    // 3) explicit calendar date
    const explicit = this.parseExplicitDateFromText(msg);
    if (explicit) {
      const msPerDay = 24*60*60*1000;
      const delta = Math.floor((explicit.setHours(12,0,0,0) - new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12,0,0,0)) / msPerDay);
      if (delta >= 0 && delta < totalDays) return delta;
    }

    // default
    return (fallbackIndex != null) ? fallbackIndex : (conversation.dayByDayPlanning?.currentDay || 0);
  }

  // --- NEW: get an editable plan object for a specific day index ---
  getPlanRefForDay(conversation, dayIndex) {
    const currentIndex = conversation.dayByDayPlanning?.currentDay || 0;
    if (dayIndex === currentIndex) {
      return { source: 'current', dayNumber: dayIndex + 1, plan: conversation.dayByDayPlanning.currentDayPlan || { selectedServices: [], dayTheme: '', logisticsNotes: '' } };
    }

    const saved = (conversation.selectedServices && conversation.selectedServices[dayIndex]) ||
                  (conversation.dayByDayPlanning?.completedDays && conversation.dayByDayPlanning.completedDays[dayIndex]) || null;

          const selectedServices = (saved?.selectedServices || []).map(s => ({
      serviceId: String(s.serviceId || s.id),
      serviceName: s.serviceName || s.name || s.itinerary_name || '',
      timeSlot: s.timeSlot || s.time_slot || 'evening',
      reason: s.reason || 'Kept from earlier plan.',
      image_url: s.image_url ?? null,
      price_cad: s.price_cad ?? null,
      price_usd: s.price_usd ?? null,
      duration_hours: s.duration_hours ?? null,
      estimatedDuration: s.estimatedDuration ?? null
    }));

    return {
      source: 'completed',
      dayNumber: dayIndex + 1,
      plan: { selectedServices, dayTheme: saved?.dayTheme || '', logisticsNotes: saved?.logisticsNotes || '' }
    };
  }

  
  parseSeedArgs(rest) {
    // Accept either JSON or a compact token format:
    // JSON example:
    // /seed {"destination":"Austin","groupSize":7,"start":"2025-09-05","end":"2025-09-07","wild":5,"budget":"flexible"}
    // Compact example:
    // /seed Austin 7 2025-09-05..2025-09-07 wild=5 budget=flexible
    rest = rest.trim();
    try {
      if (rest.startsWith('{')) return JSON.parse(rest);
    } catch (_) {}
  
    const parts = rest.split(/\s+/);
    const out = {};
    if (parts[0]) out.destination = parts[0];
    if (parts[1] && !isNaN(Number(parts[1]))) out.groupSize = Number(parts[1]);
    if (parts[2] && parts[2].includes('..')) {
      const [s, e] = parts[2].split('..');
      out.start = s;
      out.end = e;
    } else if (parts[2]) {
      out.start = parts[2];
    }
    for (let i = 3; i < parts.length; i++) {
      const m = parts[i].match(/^(\w+)=([\w\-$]+)$/);
      if (!m) continue;
      const k = m[1].toLowerCase();
      const v = m[2];
      if (k === 'wild') out.wild = Number(v);
      if (k === 'budget') out.budget = v;
    }
    return out;
  }
  
  // Core: handle slash commands before normal flow
  async applyDevCommand(conversation, userMessage) {
    if (!userMessage || !userMessage.trim().startsWith('/')) {
      return { handled: false };
    }
    const [cmd, ...restArr] = userMessage.trim().split(' ');
    const rest = restArr.join(' ');
    const ok = (msg) => ({ handled: true, response: msg });
  
    switch (cmd.toLowerCase()) {
      case '/phase': {
        const target = (rest || '').trim().toLowerCase();
        const map = { gathering: 'gathering', planning: 'planning', standby: 'standby' };
        if (!map[target]) return ok(`Unknown phase "${rest}". Try: /phase gathering | planning | standby`);
        conversation.phase = map[target];
        return ok(`(dev) Phase forced to ${conversation.phase}`);
      }
  
      case '/seed': {
        const args = this.parseSeedArgs(rest);
        if (!args.destination || !args.groupSize || !args.start) {
          return ok(`Usage:
  - /seed {"destination":"Austin","groupSize":7,"start":"2025-09-05","end":"2025-09-07","wild":5,"budget":"flexible"}
  - /seed Austin 7 2025-09-05..2025-09-07 wild=5 budget=flexible`);
        }
  
        // Set essential facts quickly
        this.setFact(conversation, 'destination', args.destination);
        this.setFact(conversation, 'groupSize', args.groupSize);
        this.setFact(conversation, 'startDate', this.parseUserDate(String(args.start)));
        if (args.end) this.setFact(conversation, 'endDate', this.parseUserDate(String(args.end)));
  
        // Helpful facts (optional)
        if (typeof args.wild === 'number') this.setFact(conversation, 'wildnessLevel', args.wild);
        if (args.budget) this.setFact(conversation, 'budget', args.budget);
  
        // Jump into planning immediately
        conversation.phase = 'planning';
        if (!conversation.facts.endDate.value) {
          // If only start given, default to single day to keep going fast
          this.setFact(conversation, 'endDate', conversation.facts.startDate.value);
        }
  
        // Ensure services + itinerary text are ready
        await this.searchServicesForConversation(conversation);
        const presentation = await this.generateItineraryPresentation(conversation);
  
        return { handled: true, response: presentation };
      }
  
      case '/facts': {
        // Merge arbitrary fact overrides
        try {
          const updates = JSON.parse(rest);
          for (const [k, v] of Object.entries(updates)) {
            this.setFact(conversation, k, v);
          }
          return ok('(dev) Facts updated.');
        } catch (e) {
          return ok('Usage: /facts {"destination":{"value":"Austin","status":"set",...}} OR /facts {"groupSize":7}');
        }
      }
  
      case '/snapshot': {
        const sub = (rest.split(/\s+/)[0] || '').toLowerCase();
        const name = rest.split(/\s+/).slice(1).join(' ').trim() || 'default';
        this.devSnapshots ||= new Map();
  
        if (sub === 'save') {
          const snap = this.exportSnapshot(conversation);
          this.devSnapshots.set(name, snap);
          console.log('Saved snapshot:', name, snap);
          return ok(`(dev) Snapshot **${name}** saved.`);
        }
        if (sub === 'load') {
          if (!this.devSnapshots.has(name)) return ok(`(dev) No snapshot named "${name}".`);
          const snap = this.devSnapshots.get(name);
          this.importSnapshot(conversation, snap);
          return ok(`(dev) Snapshot **${name}** loaded. Phase=${conversation.phase}`);
        }
        if (sub === 'print') {
          const snap = this.exportSnapshot(conversation);
          console.log('Snapshot', name, JSON.stringify(snap, null, 2));
          return ok(`(dev) Snapshot **${name}** printed to server logs.`);
        }
        return ok('Usage: /snapshot save NAME | /snapshot load NAME | /snapshot print NAME');
      }
  
      case '/reset': {
        // Fresh conversation
        const fresh = createNewConversation();
        // overwrite fields in-place to keep same Map reference
        for (const k of Object.keys(conversation)) delete conversation[k];
        Object.assign(conversation, fresh);
        return ok('(dev) Conversation reset.');
      }
  
      default:
        return ok(`Unknown dev command "${cmd}". Try /seed, /phase, /facts, /snapshot, /reset.`);
    }
  }

  // Get or create conversation
  getConversation(conversationId) {
    if (!this.conversations.has(conversationId)) {
      const newConv = createNewConversation();
      // Don't set any default values - let the user drive the conversation
      this.conversations.set(conversationId, newConv);
      return newConv;
    }
    return this.conversations.get(conversationId);
  }

  // Handle the first user response as wildness level (uses GPT-4o for response)
  async handleFirstWildnessResponse(conversation, userMessage) {
    console.log('Handling first wildness response:', userMessage);
    
    // Extract any number from the user message (including negative numbers)
    const numberMatch = userMessage.match(/-?\d+/);
    if (!numberMatch) {
      // If no number found, ask again
      return {
        handled: true,
        response: "I need a number from 1-10 to understand how wild you want this party! How insane are we talking?",
        assumptions: [`User did not provide a numeric wildness level`]
      };
    }
    
    let wildnessValue = parseInt(numberMatch[0], 10);
    let assumptions = [];
    let originalValue = wildnessValue;
    
    // Handle extreme values and clamping
    if (wildnessValue > 50) {
      assumptions.push(`User provided extreme wildness value: ${wildnessValue}, interpreting as maximum wildness (10)`);
      wildnessValue = 10;
    } else if (wildnessValue > 10) {
      assumptions.push(`User provided wildness value above 10: ${wildnessValue}, clamping to 10`);
      wildnessValue = 10;
    } else if (wildnessValue < 1) {
      // This now handles negative numbers properly
      assumptions.push(`User provided wildness value below 1: ${wildnessValue}, clamping to 1`);
      wildnessValue = 1;
    } else {
      // Normal 1-10 range
      assumptions.push(`User provided wildness level: ${wildnessValue}`);
    }
    
    // Set the wildness level fact
    this.setFact(conversation, 'wildnessLevel', wildnessValue, `first response: "${userMessage}"`);
    
    // Clear the flag so future responses go through normal processing
    conversation.expectingFirstWildnessResponse = false;
    
    // Generate response using template and GPT-4o
    try {
      // Load and render the wildness template
      const wildnessTemplate = await this.loadTemplate("wildness.user.txt");
      const wildnessPrompt = this.renderTemplate(wildnessTemplate, {
        userMessage,
        originalValue,
        wildnessValue,
        wasValueClamped: originalValue !== wildnessValue,
        clampingReason: originalValue > 50 ? 'extreme' : (originalValue > 10 ? 'above_range' : (originalValue < 1 ? 'below_range' : 'none')),
        wasNegative: originalValue < 0  // Add this context for template
      });

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are a casual, enthusiastic bachelor party planning assistant. Match your energy to the user's wildness level." },
          { role: "user", content: wildnessPrompt }
        ],
        temperature: 0.7,
        max_tokens: 150
      });

      const responseText = response.choices[0].message.content;
      
      // Check if this response is asking for Austin confirmation
      const isAustinConfirmation = responseText.toLowerCase().includes('austin') && 
                                  (responseText.includes('?') || responseText.toLowerCase().includes('confirm'));
      
      let interactive = null;
      if (isAustinConfirmation) {
        // Set flag to expect Austin confirmation
        conversation.awaitingAustinConfirmation = true;
        interactive = {
          type: 'buttons',
          buttons: [
            { text: 'Yes', value: 'yes', style: 'primary' },
            { text: 'No', value: 'no', style: 'secondary' }
          ]
        };
      }
      
      return {
        handled: true,
        response: responseText,
        interactive,
        assumptions
      };
      
    } catch (error) {
      console.error('Error generating wildness response:', error);
      
      // Enhanced fallback response for negative numbers
      let fallbackResponse = "";
      if (originalValue < 0) {
        fallbackResponse = `Haha, ${originalValue}? I get it, you want to keep things super chill! Let's call that a 1 - we can still have an amazing time without going crazy. `;
      } else if (wildnessValue >= 8) {
        fallbackResponse = wildnessValue === 10 ? "Fuck yeah! A 10! Let's get absolutely wild! " : "Hell yeah! That's what I'm talking about! ";
      } else if (wildnessValue >= 6) {
        fallbackResponse = "Nice, solid choice! Perfect level of chaos! ";
      } else {
        fallbackResponse = "Cool, keeping it classy but still fun! ";
      }
      
      if (originalValue > 50) {
        fallbackResponse = `${originalValue}?! I can tell you want maximum chaos! That's definitely a 10 on my scale. `;
      }
      
      fallbackResponse += "What city are you planning to have this bachelor party?";
      
      return {
        handled: true,
        response: fallbackResponse,
        assumptions
      };
    }
  }
  // Main message handler - LLM-first approach
  async handleMessage(conversationId, userMessage, incomingSnapshot = null) {
    console.log(`\n=== Processing Message ===`);
    console.log(`Conversation: ${conversationId}`);
    console.log(`Message: ${userMessage}`);
    
    const conversation = this.getConversation(conversationId);

    // If client provided a snapshot, import it to hydrate state for stateless runtimes
    if (incomingSnapshot && typeof incomingSnapshot === 'object') {
      try {
        this.importSnapshot(conversation, incomingSnapshot);
      } catch (e) {
        console.warn('Failed to import snapshot, proceeding with existing state:', e?.message);
      }
    }

    console.log(`Current phase: ${conversation.phase}`);

  // >>> DEV SHORTCUTS <<<
  const dev = await this.applyDevCommand(conversation, userMessage);
  if (dev.handled) {
    // Record messages exactly like normal so UI stays in sync
    conversation.messages.push(
      { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
      { role: 'assistant', content: dev.response, timestamp: new Date().toISOString() }
    );
    const snapshot = this.exportSnapshot(conversation);
    return {
      response: dev.response,
      phase: conversation.phase,
      facts: conversation.facts,
      assumptions: [],
      itinerary: this.buildSidebarItinerary(conversation),

      snapshot
    };
  }
  // <<< END DEV SHORTCUTS >>>

    // >>> HARDCODED FIRST RESPONSE HANDLING <<<
    if (conversation.expectingFirstWildnessResponse) {
      const result = await this.handleFirstWildnessResponse(conversation, userMessage);
      if (result.handled) {
        // Record messages exactly like normal so UI stays in sync
        conversation.messages.push(
          { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
          { role: 'assistant', content: result.response, timestamp: new Date().toISOString() }
        );
        const snapshot = this.exportSnapshot(conversation);
        return {
          response: result.response,
          interactive: result.interactive,
          phase: conversation.phase,
          facts: conversation.facts,
          assumptions: result.assumptions || [],
          itinerary: this.buildSidebarItinerary(conversation),
          snapshot
        };
      }
    }
    // <<< END HARDCODED FIRST RESPONSE HANDLING >>>
    
    // Handle Austin confirmation responses
    if (conversation.awaitingAustinConfirmation) {
      const userResponse = userMessage.toLowerCase().trim();
      if (userResponse === 'yes' || userResponse === 'y' || userResponse.includes('yes')) {
        // User confirmed Austin - set destination as confirmed
        this.setFact(conversation, 'destination', 'Austin', `Austin confirmation: "${userMessage}"`);
        conversation.facts.destination.status = 'set';
        conversation.awaitingAustinConfirmation = false;
        
        // Continue with normal conversation flow
        const continueResponse = "Perfect! Let's plan your Austin bachelor party. How many people are in your group, and what dates are you thinking?";
        
        conversation.messages.push(
          { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
          { role: 'assistant', content: continueResponse, timestamp: new Date().toISOString() }
        );
        
        const snapshot = this.exportSnapshot(conversation);
        return {
          response: continueResponse,
          phase: conversation.phase,
          facts: conversation.facts,
          assumptions: [`User confirmed Austin as destination`],
          itinerary: this.buildSidebarItinerary(conversation),
          snapshot
        };
      } else if (userResponse === 'no' || userResponse === 'n' || userResponse.includes('no')) {
        // User said no to Austin - explain limitation
        this.setFact(conversation, 'destination', 'unavailable', `Austin rejection: "${userMessage}"`);
        conversation.facts.destination.status = 'corrected';
        conversation.awaitingAustinConfirmation = false;
        
        const rejectionResponse = "Unfortunately our services are only available in Austin, let me know if you change your mind.";
        
        conversation.messages.push(
          { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
          { role: 'assistant', content: rejectionResponse, timestamp: new Date().toISOString() }
        );
        
        const snapshot = this.exportSnapshot(conversation);
        return {
          response: rejectionResponse,
          phase: conversation.phase,
          facts: conversation.facts,
          assumptions: [`User rejected Austin as destination`],
          itinerary: this.buildSidebarItinerary(conversation),
          snapshot
        };
      }
      // If response is unclear, continue with normal processing
    }
    
    // Handle different phases
    let finalResponse;
    let newPhase = conversation.phase;
    let reduction = null;

    if (conversation.phase === PHASES.STANDBY) {
      // Handle standby mode interactions
      finalResponse = await this.handleStandbyMode(conversation, userMessage);
    } else {
      // Single LLM call to reduce state + generate response for gathering/planning
      reduction = await this.reduceState(conversation, userMessage);
      
      // Update facts based on LLM output
      this.updateConversationFacts(conversation, reduction.facts);
      
      // Check if we can transition phases
      newPhase = this.checkPhaseTransition(conversation, reduction);
      const phaseChanged = newPhase !== conversation.phase;
      conversation.phase = newPhase;
      
      // Handle phase-specific logic
      finalResponse = reduction.reply;
      
      if (newPhase === PHASES.GUIDED_FIRST_DAY) {
        if (phaseChanged) {
          // Just transitioned to guided first day - start the guided experience
          await this.searchServicesForConversation(conversation);
          const guidedResponse = await this.startGuidedFirstDay(conversation);
          
          // Handle interactive response format
          if (typeof guidedResponse === 'object' && guidedResponse.interactive) {
            finalResponse = guidedResponse.response;
            // Store interactive elements for return
            conversation.pendingInteractive = guidedResponse.interactive;
          } else {
            finalResponse = guidedResponse;
          }
        } else {
          // Already in guided first day phase - handle user responses
          const guidedResult = await this.handleGuidedFirstDay(conversation, userMessage, reduction);
          finalResponse = guidedResult.response;
          newPhase = guidedResult.newPhase;
          conversation.phase = newPhase;
          
          // Handle interactive response format
          if (guidedResult.interactive) {
            conversation.pendingInteractive = guidedResult.interactive;
          }
          
          // If we completed guided first day and moved to planning, generate the itinerary
          if (newPhase === PHASES.PLANNING) {
            const result = await this.generateGuidedItineraryPresentation(conversation);
            // Handle both string and object responses
            if (typeof result === 'object' && result.response) {
              finalResponse = result.response;
              if (result.interactive) {
                conversation.pendingInteractive = result.interactive;
              }
            } else {
              finalResponse = result;
              // Clear any pending interactive elements since we're moving to planning
              delete conversation.pendingInteractive;
            }
          }
        }
      } else if (newPhase === PHASES.PLANNING) {
        if (phaseChanged) {
          // Just transitioned to planning - search services and generate itinerary
          await this.searchServicesForConversation(conversation);
          const result = await this.generateItineraryPresentation(conversation);
          // Handle both string and object responses
          if (typeof result === 'object' && result.response) {
            finalResponse = result.response;
            if (result.interactive) {
              conversation.pendingInteractive = result.interactive;
            }
          } else {
            finalResponse = result;
          }
            } else if (conversation.availableServices.length > 0) {
      // Already in planning phase with services - handle user feedback on itinerary
      // Check if we are in a guided day flow and the user clicked a card
      const guidedHandled = await this.handleGuidedDayResponse(conversation, userMessage);
      if (guidedHandled) {
        finalResponse = guidedHandled.response;
        // carry interactive if present
        if (guidedHandled.interactive) conversation.pendingInteractive = guidedHandled.interactive;
      } else {
        const planningResult = await this.handlePlanningMode(conversation, userMessage, reduction);
        finalResponse = planningResult.response;
        newPhase = planningResult.newPhase;
        conversation.phase = newPhase;
        if (planningResult.interactive) {
          conversation.pendingInteractive = planningResult.interactive;
        }
      }
    }
      }
    }
    
    // Add messages to conversation
    conversation.messages.push(
      { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
      { role: 'assistant', content: finalResponse, timestamp: new Date().toISOString() }
    );
    
    console.log(`New phase: ${newPhase}`);
    console.log(`Response: ${finalResponse.substring(0, 100)}...`);

    const snapshot = this.exportSnapshot(conversation);
    
    const result = {
      response: finalResponse,
      phase: newPhase,
      facts: conversation.facts,
      assumptions: reduction?.assumptions || [],
      itinerary: this.buildSidebarItinerary(conversation),
      snapshot
    };
    
    // Add interactive elements if present
    if (conversation.pendingInteractive) {
      result.interactive = conversation.pendingInteractive;
      delete conversation.pendingInteractive; // Clean up after use
    }
    
    return result;
  }
  

  async reduceState(conversation, userMessage) {
    // ---------- PRE: deterministic capture when we're awaiting group size ----------
    const assumptions = [];
    let awaitingSystemNote = '';
  
    // Ensure awaiting exists even if older snapshots didn't have it
    if (!conversation.awaiting) {
      conversation.awaiting = { fact: null, sinceMessageId: null };
    }
  
    // If we *just asked* "How many people..." and the user sent a bare number,
    // capture it deterministically here, then nudge the model forward.
    if (conversation.awaiting?.fact === 'groupSize') {
      const parsed = this.parseGroupSizeFromMessage(userMessage); // helper below
      if (parsed != null) {
        const n = Math.max(1, Math.min(300, parsed)); // sanity clamp
        this.setFact(conversation, 'groupSize', n, `awaiting.groupSize numeric capture ("${userMessage}")`);
        // Clear awaiting now that we've set it
        conversation.awaiting = { fact: null, sinceMessageId: null };
        assumptions.push(`Captured groupSize=${n} from numeric-only reply while awaiting group size.`);
  
        // Tell the reducer to *not* ask this again and move on to the next missing essential fact
        awaitingSystemNote =
          `\nassistant: (system note) The user has just provided group size = ${n}. ` +
          `Treat facts.groupSize as SET and proceed to the next missing essential fact.\n`;
      }
    }
  
    // ---------- Build reducer prompt ----------
    const currentFacts = this.serializeFacts(conversation.facts);
  
    // Inject the system note at the end of recent messages so the template sees it
    const recentMessagesBase = conversation.messages.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
    const recentMessages = recentMessagesBase + awaitingSystemNote;
  
    const currentYear = new Date().getFullYear();
  
    // Planning context if relevant (safe guards around optional nesting)
    const isInPlanningWithActiveDay =
      conversation.phase === 'planning' &&
      conversation.dayByDayPlanning &&
      conversation.dayByDayPlanning.currentDayPlan &&
      Array.isArray(conversation.dayByDayPlanning.currentDayPlan.selectedServices) &&
      conversation.dayByDayPlanning.currentDayPlan.selectedServices.length > 0;
  
    const planningContext = isInPlanningWithActiveDay ? `
    
    CURRENT DAY PLANNING CONTEXT:
    - Currently planning Day ${(conversation.dayByDayPlanning.currentDay || 0) + 1}
    - Current day has ${conversation.dayByDayPlanning.currentDayPlan.selectedServices.length} services selected:
    ${conversation.dayByDayPlanning.currentDayPlan.selectedServices.map(s =>
      `  * ${s.serviceName} (${s.timeSlot})`
    ).join('\n')}
    ` : '';
  
    const intentTypeOptions = (conversation?.phase === 'planning')
      ? '"approval_next", "substitution", "addition", "removal", "show_day", "general_question"'
      : '"edit_itinerary", "general_question", "approval_next"';
  
    const reducerTemplate = await this.loadTemplate("reducer.user.txt");
  
    const planningPhaseInstructions = conversation.phase === 'planning' ? 
      `PLANNING PHASE INTENT CLASSIFICATION:
      When in planning phase, classify user intent precisely:
      
      - "approval_next": User wants to approve current day and move to next day
      - "show_day": User wants to view/work on a SPECIFIC day
      - "substitution": Swap/replace something in current day
      - "addition": Add something new to current day
      - "removal": Remove something from current day
      - "general_question": Info/details request
      ` : '';
  
    const reducerPrompt = this.renderTemplate(reducerTemplate, {
      currentYear,
      conversation,
      currentFacts,
      recentMessages,
      planningContext,
      userMessage,
      intentTypeOptions,
      planningPhaseInstructions
    });
  
    // ---------- Call model with function/tool to enforce structure ----------
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o", // keep your current model here for the reducer, or swap later
        messages: [
          { role: "system", content: "You are an expert bachelor party planner with intelligent intent classification. Return proper JSON with intent_type classification." },
          { role: "user", content: reducerPrompt }
        ],
        functions: [reducerFunction],
        function_call: { name: "reduce_state" },
        temperature: 0.2,
        max_tokens: 1000
      });
  
      const functionCall = response.choices?.[0]?.message?.function_call;
      if (functionCall) {
        let parsed;
        try {
          parsed = JSON.parse(functionCall.arguments || "{}");
        } catch {
          parsed = {};
        }
  
        // Ensure fields exist
        parsed.facts = parsed.facts || {};
        parsed.assumptions = Array.isArray(parsed.assumptions) ? parsed.assumptions : [];
        parsed.blocking_questions = Array.isArray(parsed.blocking_questions) ? parsed.blocking_questions : [];
        parsed.safe_transition = Boolean(parsed.safe_transition);
        parsed.reply = typeof parsed.reply === 'string' ? parsed.reply : "Got it.";
  
        // ---------- Merge our PRE assumptions into the reducer output ----------
        if (assumptions.length) {
          parsed.assumptions.push(...assumptions);
        }
  
        // If we deterministically captured groupSize above, make sure reducer output reflects it.
        const haveGS = !!(conversation && conversation.facts && conversation.facts.groupSize && conversation.facts.groupSize.value != null);
        if (haveGS) {
          const n = conversation.facts.groupSize.value;
          parsed.facts.groupSize = {
            value: n,
            status: 'set',
            confidence: Math.max(0.95, (conversation.facts.groupSize.confidence || 0.95)),
            provenance: conversation.facts.groupSize.provenance || 'awaiting.groupSize numeric capture'
          };
        }
  
        // ---------- POST: set/clear `awaiting` based on the model's reply ----------
        const replyText = parsed.reply || '';
        const weAlreadyHaveGroupSize = !!(parsed.facts && parsed.facts.groupSize && parsed.facts.groupSize.value != null)
          || haveGS;
  
        if (!weAlreadyHaveGroupSize) {
          // Only set the awaiting flag if we *don't* already have a group size
          if (this.askedForGroupSize(replyText)) {
            conversation.awaiting = { fact: 'groupSize', sinceMessageId: null };
          }
        } else {
          // If model output (or our capture) includes groupSize, ensure awaiting is cleared
          if (conversation.awaiting?.fact === 'groupSize') {
            conversation.awaiting = { fact: null, sinceMessageId: null };
          }
        }
  
        return parsed;
      }
    } catch (error) {
      console.error('Error in LLM reducer:', error);
    }
  
    // ---------- Fallback ----------
    return {
      facts: {},
      assumptions,
      blocking_questions: ["I need more information to help plan your trip"],
      safe_transition: false,
      reply: "Tell me more about what you're looking for and I'll help you plan an amazing bachelor party!",
      intent_type: "general_question"
    };
  }
  
  
  parseGroupSizeFromMessage(msg) {
    if (typeof msg !== 'string') return null;
    const trimmed = msg.trim().toLowerCase();
  
    // Digits only, e.g., "10"
    const m = trimmed.match(/^\d{1,3}$/);
    if (m) return parseInt(m[0], 10);
  
    // Simple single-word numbers (common cases)
    const wordsToInt = {
      one:1, two:2, three:3, four:4, five:5,
      six:6, seven:7, eight:8, nine:9, ten:10,
      eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15,
      sixteen:16, seventeen:17, eighteen:18, nineteen:19, twenty:20
    };
    if (/^[a-z]+$/.test(trimmed) && trimmed in wordsToInt) {
      return wordsToInt[trimmed];
    }
  
    return null;
  }
  
  // Heuristic: did the assistant ask for group size?
  askedForGroupSize(text) {
    if (typeof text !== 'string') return false;
    const t = text.toLowerCase();
    return /how many\s+(people|guys)\b/i.test(t)
        || /how many.*\b(in|are in)\s+(your|the)\s+(group|party)\b/i.test(t)
        || /\bwhat(?:'s| is)\s+(the\s+)?group\s+size\b/i.test(t)
        || /\bhow big is\s+(your|the)\s+group\b/i.test(t);
  }

  // Update conversation facts based on LLM output
  updateConversationFacts(conversation, factUpdates) {
    Object.entries(factUpdates).forEach(([key, update]) => {
      if (conversation.facts[key] && update) {
        const currentFact = conversation.facts[key];
        
        // Special handling for destination unavailable
        if (key === 'destination' && update.value === 'unavailable') {
          conversation.facts[key] = { 
            ...currentFact, 
            ...update,
            status: 'corrected'
          };
          return;
        }
        
        // Priority system for status updates
        const statusPriority = {
          'unknown': 0,
          'suggested': 1, 
          'assumed': 2,
          'set': 3,
          'corrected': 4
        };

        const currentPriority = statusPriority[currentFact.status] || 0;
        const newPriority = statusPriority[update.status] || 0;

        // For optional fields, allow "set" status even with lower confidence 
        // if user shows disinterest (helps move conversation forward)
        if (currentFact.priority === FACT_PRIORITY.OPTIONAL && 
            update.status === 'set' && 
            currentFact.status === 'unknown') {
          conversation.facts[key] = { ...currentFact, ...update };
        }
        // Normal priority rules for other cases
        else if (newPriority >= currentPriority) {
          conversation.facts[key] = { ...currentFact, ...update };
        }
      }
    });
  }

transformConversationFacts(facts) {
  return {
    destination: facts.destination?.value,
    groupSize: facts.groupSize?.value,
    startDate: facts.startDate?.value,
    endDate: facts.endDate?.value,
    duration: this.calculateDuration(facts.startDate?.value, facts.endDate?.value),
    wildnessLevel: facts.wildnessLevel?.value || 5,
    budget: facts.budget?.value,
    budgetType: facts.budgetType?.value,
    interestedActivities: facts.interestedActivities?.value || [],
    specialRequests: Array.isArray(facts.interestedActivities?.value) 
      ? facts.interestedActivities.value.join(', ') 
      : (facts.interestedActivities?.value || ''),
    relationship: facts.relationship?.value,
    ageRange: facts.ageRange?.value
  };
}

  fallbackItineraryPresentation(conversation) {
    const { facts } = conversation;
    const destination = facts.destination?.value || 'your destination';
    const groupSize = facts.groupSize?.value || 'your group';
    
    return `Perfect! Let me put together an amazing ${destination} bachelor party for ${groupSize} guys. I'm finding the best options that match what you're looking for. Give me just a moment to craft something epic!`;
  }

  transformConversationData(conversationData) {
    // Handle both direct object format (from tests) and facts format (from real conversations)
    if (conversationData.facts) {
      // Real conversation format with facts
      return {
        destination: conversationData.facts.destination?.value,
        groupSize: conversationData.facts.groupSize?.value,
        startDate: conversationData.facts.startDate?.value,
        endDate: conversationData.facts.endDate?.value,
        duration: this.calculateDuration(conversationData.facts.startDate?.value, conversationData.facts.endDate?.value),
        wildnessLevel: conversationData.facts.wildnessLevel?.value || 5,
        budget: conversationData.facts.budget?.value,
        interestedActivities: conversationData.facts.interestedActivities?.value || [],
        specialRequests: conversationData.facts.interestedActivities?.value?.join(', ') || '',
        relationship: conversationData.facts.relationship?.value,
        ageRange: conversationData.facts.ageRange?.value
      };
    } else {
      // Test format or direct object format
      return {
        destination: conversationData.destination,
        groupSize: conversationData.groupSize,
        startDate: conversationData.startDate,
        endDate: conversationData.endDate,
        duration: conversationData.duration || this.calculateDuration(conversationData.startDate, conversationData.endDate),
        wildnessLevel: conversationData.wildnessLevel || 5,
        budget: conversationData.budget,
        interestedActivities: conversationData.interestedActivities || [],
        specialRequests: conversationData.specialRequests || conversationData.interestedActivities?.join(', ') || '',
        relationship: conversationData.relationship,
        ageRange: conversationData.ageRange
      };
    }
  }
  
  calculateDuration(startDate, endDate) {
    // If we have neither start nor end date, return default
    if (!startDate && !endDate) return 3;
    
    // If we only have start date but no end date, return 1 (single day)
    if (startDate && !endDate) return 1;
    
    // If we somehow have end date but no start date, return default
    if (!startDate && endDate) return 3;
    
    // If we have both dates, calculate normally
    const start = this.toLocalDate(startDate);
    const end = this.toLocalDate(endDate);
    
    // Reset to midnight for accurate day calculation
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    
    // Calculate difference in days (inclusive)
    const diffTime = end - start;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    
    return Math.max(1, diffDays);
  }

// chatHandler.js
// chatHandler.js
async generateItinerary(conversationData) {
  const DBG = process.env.CONNECTED_DEBUG_LOGS === '1';
  const log = (...a) => { if (DBG) console.log('[Itinerary]', ...a); };

  // small helper to coerce things like "3 hours" -> 3
  const toHours = (s) => {
    if (s == null) return null;
    const m = String(s).match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
  };

  try {
    log('START generateItinerary');

    const userPreferences = this.transformConversationData(conversationData);
    log('User preferences:', JSON.stringify(userPreferences, null, 2));

    // 1) Fetch all available services (includes rolled-up price_cad/price_usd from DB)
    const allServices = await this.searchAvailableServices(
      userPreferences.destination,
      userPreferences.groupSize,
      userPreferences
    );
    log(`Fetched ${allServices.length} services from searchAvailableServices`);
    if (DBG) {
      const sample = allServices.slice(0, 8).map(s => ({
        id: s.id, name: s.name, type: s.type,
        price_cad: s.price_cad, price_usd: s.price_usd, dur: s.duration_hours
      }));
      log('Sample services (first 8):', sample);
      const priceStats = {
        priced: allServices.filter(s => s.price_cad != null || s.price_usd != null).length,
        total: allServices.length
      };
      log('Catalog price coverage:', priceStats);
    }

    // 2) Keyword enhancement
    const enhancedServices = await this.enhanceServicesWithKeywords(
      allServices,
      userPreferences
    );
    log(`After keyword enhancement: ${enhancedServices.length} services`);
    if (DBG) {
      const priceStats2 = {
        priced: enhancedServices.filter(s => s.price_cad != null || s.price_usd != null).length,
        total: enhancedServices.length
      };
      log('Enhanced catalog price coverage:', priceStats2);
    }

    // 3) By-category snapshot (helps verify selection pool)
    const servicesByCategory = this.groupServicesByCategory(enhancedServices);
    if (DBG) {
      const catSummary = Object.fromEntries(
        Object.entries(servicesByCategory).map(([k, v]) => [
          k, { total: v.length, priced: v.filter(s => s.price_cad != null || s.price_usd != null).length }
        ])
      );
      log('By-category counts (priced/total):', catSummary);
    }

    // 4) Build each day
    const itinerary = [];
    for (let day = 1; day <= userPreferences.duration; day++) {
      const dayInfo = {
        dayNumber: day,
        totalDays: userPreferences.duration,
        timeSlots: this.getTimeSlotsForDay(day, userPreferences.duration),
        isFirstDay: day === 1,
        isLastDay: day === userPreferences.duration
      };

      log(`\n— Day ${day}/${userPreferences.duration}: selecting services`);
      const dayPlan = await this.aiSelector.selectOptimalServices(
        enhancedServices,
        userPreferences,
        dayInfo
      );

      if (DBG) {
        log(`[Day ${day}] raw selectedServices from selector:`,
          (dayPlan.selectedServices || []).map(s => ({
            serviceId: s.serviceId, serviceName: s.serviceName,
            timeSlot: s.timeSlot, reason: s.reason
          }))
        );
      }

      // === CRITICAL FIX: map catalog prices to the writer's expected keys ===
      const byId = new Map(enhancedServices.map(s => [String(s.id), s]));
      const writerSelected = (dayPlan.selectedServices || []).map(s => {
        const meta = byId.get(String(s.serviceId)) || {};
        return {
          // keep original field names expected downstream
          serviceId: String(s.serviceId),
          serviceName: s.serviceName,
          timeSlot: s.timeSlot,
      
          // << critical: use price_cad / price_usd >>
          price_cad: meta.price_cad ?? null,
          price_usd: meta.price_usd ?? null,
          image_url: meta.image_url ?? null,
      
          duration_hours: meta.duration_hours ?? toHours(s.estimatedDuration),
          reason: s.reason,
          groupSuitability: s.groupSuitability
        };
      });

      if (DBG) {
        log(`[Day ${day}] writerSelected (id, name, cad, usd, dur):`,
          writerSelected.map(x => ({
            id: x.id, name: x.name, cad: x.cad, usd: x.usd, dur: x.dur
          }))
        );
      }

      // Build the payload the writer expects
      const enrichedDayPlan = {
        ...dayPlan,
        selectedServices: writerSelected
      };

      log(`[Day ${day}] generating response…`);
      const responseText = await this.aiResponseGenerator.generateItineraryResponse(
        enrichedDayPlan,
        dayInfo,
        userPreferences
      );

      const normalizedResponseText = (typeof responseText === 'object' && responseText?.response) ? responseText.response : responseText;

      if (DBG) {
        log(`[Day ${day}] response preview:`,
          String(normalizedResponseText).slice(0, 500).replace(/\n/g, '\\n') + (String(normalizedResponseText).length > 500 ? '…' : '')
        );
      }

      itinerary.push({
        dayNumber: day,
        selectedServices: enrichedDayPlan.selectedServices,
        text: normalizedResponseText
      });
    }

    log('END generateItinerary');
    return { itinerary, servicesByCategory };
  } catch (error) {
    console.error('[Itinerary] ERROR:', error);
    return { error: 'Failed to generate itinerary' };
  }
}



  groupServicesByCategory(services) {
    const categories = {};
    services.forEach(service => {
      const category = service.category || service.type || 'other';
      if (!categories[category]) categories[category] = [];
      categories[category].push(service);
    });
    return categories;
  }

  getTimeSlotsForDay(dayNumber, totalDays) {
    if (dayNumber === 1) {
      return ['afternoon', 'evening', 'night']; // Arrival day
    } else if (dayNumber === totalDays) {
      return ['morning', 'afternoon']; // Departure day
    } else {
      return ['afternoon', 'evening', 'night', 'late_night']; // Full party day
    }
  }

  formatDate(startDate, daysToAdd) {
    const date = this.toLocalDate(startDate);
    date.setDate(date.getDate() + daysToAdd);
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/Chicago'
    });
  }

  toLocalDate(input) {
    if (!input) return null;
    
    // If it's already a Date object, return it
    if (input instanceof Date) return input;
    
    // If it's YYYY-MM-DD format, parse it as local midnight
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
        const [y, m, d] = input.split('-').map(Number);
        // Create date at noon to avoid DST issues
        return new Date(y, m - 1, d, 12, 0, 0);
    }
    
    // For other formats, parse at noon to avoid timezone issues
    const date = new Date(input + ' 12:00:00');
    if (isNaN(date.getTime())) {
        // If that fails, try without the time
        return new Date(input);
    }
    return date;
}
  
  // Avoid returning UTC-derived ISO; return a local YYYY-MM-DD
  parseUserDate(dateString, now = new Date()) {
    if (!dateString) return null;
  
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const raw = String(dateString).trim();
    if (iso.test(raw)) return raw; // pass ISO through
  
    // helpers (scoped here for simplicity)
    const formatYYYYMMDD = (d) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };
  
    const nthWeekdayOfMonth = (year, monthIdx, weekdayIdx, occurrence) => {
      if (occurrence > 0) {
        const firstOfMonth = new Date(year, monthIdx, 1, 12, 0, 0);
        const offset = (weekdayIdx - firstOfMonth.getDay() + 7) % 7;
        const day = 1 + offset + (occurrence - 1) * 7;
        const d = new Date(year, monthIdx, day, 12, 0, 0);
        // guard overflow
        if (d.getMonth() !== monthIdx) return null;
        return d;
      } else { // last
        const lastOfMonth = new Date(year, monthIdx + 1, 0, 12, 0, 0);
        const offset = (lastOfMonth.getDay() - weekdayIdx + 7) % 7;
        const day = lastOfMonth.getDate() - offset;
        return new Date(year, monthIdx, day, 12, 0, 0);
      }
    };
  
    const s = raw
      .toLowerCase()
      .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  
    const currentYear = now.getFullYear();
  
    // Resolve year from explicit 4-digit or relative phrases
    let year = currentYear;
    const explicitYear = s.match(/\b(19|20)\d{2}\b/);
    if (explicitYear) {
      year = parseInt(explicitYear[0], 10);
    } else if (/\bnext year\b/.test(s)) {
      year = currentYear + 1;
    } else if (/\bthis year\b/.test(s)) {
      year = currentYear;
    }
  
    const months = {
      january:0, jan:0, february:1, feb:1, march:2, mar:2, april:3, apr:3, may:4,
      june:5, jun:5, july:6, jul:6, august:7, aug:7,
      september:8, sep:8, sept:8, october:9, oct:9, november:10, nov:10, december:11, dec:11
    };
    const weekdays = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
    const nthMap = { first:1, '1st':1, second:2, '2nd':2, third:3, '3rd':3, fourth:4, '4th':4, last:-1 };
  
    // Pattern: "first Saturday of (the) September (next year|this year|YYYY)"
    const nthRe = new RegExp(
      `\\b(${Object.keys(nthMap).join('|')})\\s+` +
      `(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\s+` +
      `of\\s+(?:the\\s+)?` +
      `(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)` +
      `(?:\\s+of\\s+(?:the\\s+)?(year))?`,
      'i'
    );
  
    const nthMatch = s.match(nthRe);
    if (nthMatch) {
      const occ = nthMap[nthMatch[1].toLowerCase()];
      const weekdayIdx = weekdays[nthMatch[2].toLowerCase()];
      const monthIdx = months[nthMatch[3].toLowerCase()];
      const d = nthWeekdayOfMonth(year, monthIdx, weekdayIdx, occ);
      return d ? formatYYYYMMDD(d) : null;
    }
  
    // Pattern: "September 5" (+ optional relative year already captured)
    const md = s.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})\b/i
    );
    if (md) {
      const monthIdx = months[md[1].toLowerCase()];
      const day = parseInt(md[2], 10);
      const d = new Date(year, monthIdx, day, 12, 0, 0);
      return formatYYYYMMDD(d);
    }
  
    // Month-only fallback: "September (next year)"
    const monthOnly = s.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i
    );
    if (monthOnly) {
      const monthIdx = months[monthOnly[1].toLowerCase()];
      const d = new Date(year, monthIdx, 1, 12, 0, 0);
      return formatYYYYMMDD(d);
    }
  
    // Last resort: let JS try, then format
    const attempt = new Date(raw);
    if (!isNaN(attempt.getTime())) return formatYYYYMMDD(new Date(attempt.getFullYear(), attempt.getMonth(), attempt.getDate(), 12, 0, 0));
  
    return null; // unparseable
  }
  // Phase transition logic
  checkPhaseTransition(conversation, reduction) {
    const { facts } = conversation;
  
    // From GATHERING to GUIDED_FIRST_DAY (instead of PLANNING)
    if (conversation.phase === PHASES.GATHERING) {
      // Check if destination is unavailable (user said no to Austin)
      if (facts.destination.value === "unavailable") {
        return conversation.phase; // Stay in gathering - can't proceed without valid destination
      }
      
      // Essentials must be set to ever leave gathering (destination can be "assumed" or "set" for Austin)
      const essentialFactsSet = [
        facts.destination.status === FIELD_STATUS.SET || (facts.destination.status === FIELD_STATUS.ASSUMED && facts.destination.value === "Austin"),
        facts.groupSize.status === FIELD_STATUS.SET,
        facts.startDate.status === FIELD_STATUS.SET,
        facts.endDate.status === FIELD_STATUS.SET
      ];
    
      if (!essentialFactsSet.every(Boolean)) {
        return conversation.phase;
      }
    
      // If the reducer says it's safe (it has asked about helpfuls), proceed to guided first day.
      if (reduction?.safe_transition === true) {
        return PHASES.GUIDED_FIRST_DAY;
      }
    
      // Fallback: legacy stricter gate (kept for safety)
      const helpfulFactsAddressed = [
        facts.wildnessLevel.status !== FIELD_STATUS.UNKNOWN,
        facts.housing.status !== FIELD_STATUS.UNKNOWN
        // REMOVED: budget check - budget is no longer required for progression
        // facts.budget.status !== FIELD_STATUS.UNKNOWN
      ];
    
      return helpfulFactsAddressed.every(Boolean) ? PHASES.GUIDED_FIRST_DAY : conversation.phase;
    }
    
    // From GUIDED_FIRST_DAY to PLANNING
    if (conversation.phase === PHASES.GUIDED_FIRST_DAY) {
      if (conversation.guidedFirstDay?.isComplete) {
        return PHASES.PLANNING;
      }
    }
    
    // Other phases don't automatically transition based on facts
    return conversation.phase;
  }

  generateActivitiesForDay(services, dayIndex, totalDays) {
    const activities = [];
    const isFirstDay = dayIndex === 0;
    const isLastDay = dayIndex === totalDays - 1;
    
    if (isFirstDay) {
      // First day - arrival and dinner
      if (services.restaurant) {
        activities.push({
          time: "Evening",
          description: `Dinner at ${services.restaurant.name} - ${services.restaurant.description || 'great food and atmosphere for groups'}`
        });
      }
      
      if (services.nightlife) {
        activities.push({
          time: "Night",
          description: `Hit up ${services.nightlife.name} for drinks and nightlife`
        });
      }
    } else if (isLastDay && totalDays > 1) {
      // Last day - recovery
      if (services.brunch) {
        activities.push({
          time: "Morning",
          description: `Recovery brunch at ${services.brunch.name} before heading home`
        });
      } else {
        activities.push({
          time: "Morning",
          description: "Recovery brunch before heading home"
        });
      }
    } else {
      // Middle days - full activities
      if (services.activity) {
        activities.push({
          time: "Afternoon", 
          description: `${services.activity.name} - ${services.activity.description || 'perfect group activity'}`
        });
      }
      
      if (services.restaurant) {
        activities.push({
          time: "Evening",
          description: `Dinner at ${services.restaurant.name} to fuel up for the night`
        });
      } else {
        activities.push({
          time: "Evening",
          description: `Great dinner and drinks to fuel up for the night`
        });
      }
      
              if (services.nightlife) {
          activities.push({
            time: "Night",
            description: `Amazing night out at ${services.nightlife.name} - this is where the legendary stories happen`
          });
        }
    }
    
    // Ensure every day has at least one activity
    if (activities.length === 0) {
      activities.push({
        time: "Evening",
        description: `Explore the best of the city and make some memories`
      });
    }
    
    return activities;
  }

  enrichSelectedWithMeta(selected, allServices) {
    const byId = new Map((allServices || []).map(s => [String(s.id), s]));
    return (selected || []).map(s => {
      const meta = byId.get(String(s.serviceId)) || {};
      return {
        ...s,
        price_cad: s.price_cad ?? meta.price_cad ?? null,
        price_usd: s.price_usd ?? meta.price_usd ?? null,
        duration_hours: s.duration_hours ?? meta.duration_hours ?? null,
        image_url: s.image_url ?? meta.image_url ?? null
      };
    });
  }

  // NEW: Start guided first day experience
  async startGuidedFirstDay(conversation) {
    // Initialize guided first day state
    conversation.guidedFirstDay = {
      step: 'airport_pickup',
      airportPickup: null,
      eveningActivity: null,
      isComplete: false
    };

    // initialize dayByDayPlanning for immediate sidebar updates
    const totalDays = this.calculateDuration(conversation.facts.startDate?.value, conversation.facts.endDate?.value);
    conversation.dayByDayPlanning = {
      currentDay: 0,
      totalDays: totalDays,
      completedDays: [],
      usedServices: new Set(),
      isComplete: false
    };

    const airportQuestion = await this.askAirportPickupQuestion(conversation);
    
    // Ensure we return the interactive format properly
    if (typeof airportQuestion === 'object' && airportQuestion.interactive) {
      return airportQuestion;
    }
    
    return airportQuestion;
  }

  // NEW: Ask airport pickup question with specific options
  async askAirportPickupQuestion(conversation) {
    const availableServices = conversation.availableServices || [];
    const groupSize = conversation.facts?.groupSize?.value || 8;
    
    // Find the specific airport pickup options
    const partyBusPickup = availableServices.find(s => 
      s.name && s.name.toLowerCase().includes('party bus') && 
      s.name.toLowerCase().includes('airport')
    );
    
    const sprinterTour = availableServices.find(s => 
      s.name && s.name.toLowerCase().includes('sprinter') && 
      (s.name.toLowerCase().includes('bbq') || s.name.toLowerCase().includes('beer'))
    );

    if (!partyBusPickup || !sprinterTour) {
      // Fallback if we can't find the specific services
      return "I'm setting up your first day options. Let me find the best airport pickup and activity choices for you!";
    }

    // Calculate per-person pricing
    const partyBusPerPerson = partyBusPickup.price_usd ? Math.round(partyBusPickup.price_usd / groupSize) : null;
    const sprinterPerPerson = sprinterTour.price_usd ? Math.round(sprinterTour.price_usd / groupSize) : null;

    return {
      response: "Perfect! Let's plan your arrival day. Do you want to go straight to the house from the airport, or get the party started immediately with a BBQ & Beer Tour?",
      interactive: {
        type: 'guided_cards',
        options: [
          {
            value: 'party_bus_pickup',
            title: 'Party Bus to House',
            description: partyBusPickup.itinerary_description || partyBusPickup.description || 'Get picked up in style with a party bus and head straight to your accommodation',
            price_cad: partyBusPickup.price_cad,
            price_usd: partyBusPickup.price_usd,
            price_per_person: partyBusPerPerson,
            duration: partyBusPickup.duration_hours ? `${partyBusPickup.duration_hours}h` : '1h',
            features: ['Airport Pickup', 'Party Bus', 'Direct to House', 'Group Transport'],
            timeSlot: 'Afternoon',
            image_url: partyBusPickup.image_url
          },
          {
            value: 'sprinter_bbq_tour',
            title: 'BBQ & Beer Tour',
            description: sprinterTour.itinerary_description || sprinterTour.description || 'Start the party immediately with a BBQ and beer tour around Austin',
            price_usd: sprinterTour.price_usd,
            price_per_person: sprinterPerPerson,
            duration: sprinterTour.duration_hours ? `${sprinterTour.duration_hours}h` : '4h',
            features: ['Airport Pickup', 'BBQ Tour', 'Beer Tasting', 'Immediate Party Start'],
            timeSlot: 'Afternoon',
            image_url: sprinterTour.image_url
          }
        ]
      }
    };
  }

  // NEW: Ask evening activity question
  async askEveningActivityQuestion(conversation) {
    const availableServices = conversation.availableServices || [];
    const groupSize = conversation.facts?.groupSize?.value || 8;
    
    // Find relevant services for evening options
    const barService = availableServices.find(s => 
      s.category === 'bar' || (s.name && s.name.toLowerCase().includes('bar'))
    );
    const steakhouseService = availableServices.find(s => 
      s.name && s.name.toLowerCase().includes('steak')
    );
    const stripClubService = availableServices.find(s => 
      s.category === 'strip_club' || (s.name && s.name.toLowerCase().includes('gentlemen'))
    );

    const options = [
      {
        value: 'bar_hopping',
        title: 'Dirty Six Bar Hop',
        description: barService?.itinerary_description || barService?.description || 'Hit the best bars in Austin for an epic night out',
        ...this.calculatePricing(barService, groupSize),
        duration: barService?.duration_hours ? `${barService.duration_hours}h` : '3-4h',
        features: ['Multiple Bars', 'Group Activities', 'Local Favorites', 'Night Out'],
        timeSlot: 'Night',
        image_url: barService?.image_url
      },
      {
        value: 'steakhouse',
        title: 'Steakhouse Dinner',
        description: steakhouseService?.itinerary_description || steakhouseService?.description || 'Premium steakhouse experience with the best cuts in Austin',
        ...this.calculatePricing(steakhouseService, groupSize),
        duration: steakhouseService?.duration_hours ? `${steakhouseService.duration_hours}h` : '2-3h',
        features: ['Premium Steaks', 'Group Dining', 'Fine Dining', 'Celebration Meal'],
        timeSlot: 'Evening',
        image_url: steakhouseService?.image_url
      },
      {
        value: 'strip_club',
        title: 'Strip Club',
        description: stripClubService?.itinerary_description || stripClubService?.description || 'Premium gentlemen\'s club experience for the bachelor party',
        ...this.calculatePricing(stripClubService, groupSize),
        duration: stripClubService?.duration_hours ? `${stripClubService.duration_hours}h` : '3-4h',
        features: ['VIP Access', 'Bachelor Party', 'Entertainment', 'Late Night'],
        timeSlot: 'Night',
        image_url: stripClubService?.image_url
      },
      {
        value: 'open_evening',
        title: 'Keep it Open',
        description: 'Leave your evening flexible and decide what you want to do based on how you\'re feeling',
        price_usd: null,
        price_per_person: null,
        duration: 'Flexible',
        features: ['Flexible Plans', 'Spontaneous', 'Game Time Decision', 'No Commitment'],
        timeSlot: 'Evening'
      }
    ];

    return {
      response: "Great choice! Now, what do you want to do for your evening after that?",
      interactive: {
        type: 'guided_cards',
        options: options
      }
    };
  }

  // NEW: Handle guided first day user responses
  async handleGuidedFirstDay(conversation, userMessage, reduction) {
    const guidedState = conversation.guidedFirstDay;
    
    if (guidedState.step === 'airport_pickup') {
      // Handle airport pickup selection
      if (userMessage === 'party_bus_pickup' || userMessage === 'sprinter_bbq_tour') {
        guidedState.airportPickup = userMessage;
        guidedState.step = 'evening_activity';

        // Update current day plan immediately for sidebar (no pending state)
        try {
          const partialPlan = await this.buildGuidedFirstDayPlan(conversation, conversation.availableServices || []);
          conversation.dayByDayPlanning ||= { currentDay: 0, totalDays: this.calculateDuration(conversation.facts.startDate?.value, conversation.facts.endDate?.value), completedDays: [], usedServices: new Set(), isComplete: false };
          conversation.dayByDayPlanning.currentDayPlan = partialPlan;
        } catch (_) {}
        
        const response = await this.askEveningActivityQuestion(conversation);
        return {
          response: response.response,
          interactive: response.interactive,
          newPhase: PHASES.GUIDED_FIRST_DAY
        };
      }
    } else if (guidedState.step === 'evening_activity') {
      // Handle evening activity selection
      if (['bar_hopping', 'steakhouse', 'strip_club', 'open_evening'].includes(userMessage)) {
        guidedState.eveningActivity = userMessage;

        // Update plan immediately to reflect selection
        try {
          const plan = await this.buildGuidedFirstDayPlan(conversation, conversation.availableServices || []);
          conversation.dayByDayPlanning.currentDayPlan = plan;
        } catch (_) {}
        guidedState.isComplete = true;
        
        return {
          response: "Perfect! I'm putting together your first day based on your choices.",
          newPhase: PHASES.PLANNING
        };
      }
    }
    
    // Fallback for unrecognized responses
    return {
      response: "I didn't catch that. Please use the buttons to make your selection.",
      newPhase: PHASES.GUIDED_FIRST_DAY
    };
  }

  // NEW: Generate itinerary presentation using guided choices
  async generateGuidedItineraryPresentation(conversation) {
    const { facts, guidedFirstDay } = conversation;
    const availableServices = conversation.availableServices || [];
    
    try {
      console.log('🎯 Starting guided itinerary generation...');
      
      // Initialize day-by-day planning
      const totalDays = this.calculateDuration(facts.startDate?.value, facts.endDate?.value);
      conversation.dayByDayPlanning = {
        currentDay: 0,
        totalDays: totalDays,
        completedDays: [],
        usedServices: new Set(),
        isComplete: false
      };
      
      // Build first day plan based on guided choices
      const firstDayPlan = await this.buildGuidedFirstDayPlan(conversation, availableServices);
      
      // Store the day plan
      conversation.dayByDayPlanning.currentDayPlan = firstDayPlan;
      
      // Generate response text
      const userPreferences = this.transformConversationFacts(facts);
      const dayInfo = {
        dayNumber: 1,
        totalDays: totalDays,
        timeSlots: this.getTimeSlotsForDay(1, totalDays),
        isFirstDay: true,
        isLastDay: totalDays === 1
      };
      
      const result = await this.aiResponseGenerator.generateItineraryResponse(
        firstDayPlan,
        dayInfo,
        userPreferences,
        { short: true }
      );
      
      // Handle both string and object responses
      return typeof result === 'string' ? result : result;
      
    } catch (error) {
      console.error('Error in guided itinerary presentation:', error);
      return this.fallbackItineraryPresentation(conversation);
    }
  }

  // NEW: Build first day plan based on guided choices
  async buildGuidedFirstDayPlan(conversation, availableServices) {
    const { guidedFirstDay } = conversation;
    const selectedServices = [];
    
    // Add airport pickup service
    if (guidedFirstDay.airportPickup === 'party_bus_pickup') {
      const partyBusService = availableServices.find(s => 
        s.name && s.name.toLowerCase().includes('party bus') && 
        s.name.toLowerCase().includes('airport')
      );
      if (partyBusService) {
        const title = 'Party Bus to House';
        const description = partyBusService.itinerary_description || partyBusService.description || 'Get picked up in style with a party bus and head straight to your accommodation';
        selectedServices.push({
          serviceId: String(partyBusService.id),
          serviceName: title,
          timeSlot: 'afternoon',
          reason: description,
          estimatedDuration: '1 hour',
          groupSuitability: 'Perfect for groups',
          price_cad: partyBusService.price_cad,
          price_usd: partyBusService.price_usd,
          duration_hours: partyBusService.duration_hours,
          image_url: partyBusService.image_url
        });
      }
    } else if (guidedFirstDay.airportPickup === 'sprinter_bbq_tour') {
      const sprinterService = availableServices.find(s => 
        s.name && s.name.toLowerCase().includes('sprinter') && 
        (s.name.toLowerCase().includes('bbq') || s.name.toLowerCase().includes('beer'))
      );
      if (sprinterService) {
        const title = 'BBQ & Beer Tour';
        const description = sprinterService.itinerary_description || sprinterService.description || 'Start the party immediately with a BBQ and beer tour around Austin';
        selectedServices.push({
          serviceId: String(sprinterService.id),
          serviceName: title,
          timeSlot: 'afternoon',
          reason: description,
          estimatedDuration: '3-4 hours',
          groupSuitability: 'Perfect for groups',
          price_cad: sprinterService.price_cad,
          price_usd: sprinterService.price_usd,
          duration_hours: sprinterService.duration_hours,
          image_url: sprinterService.image_url
        });
      }
    }
    
    // Add evening activity based on choice
    if (guidedFirstDay.eveningActivity === 'bar_hopping') {
      const barService = availableServices.find(s => 
        s.category === 'bar' || (s.name && s.name.toLowerCase().includes('bar'))
      );
      const title = 'Dirty Six Bar Hop';
      const description = barService?.itinerary_description || barService?.description || 'Hit the best bars in Austin for an epic night out';
      if (barService) {
        selectedServices.push({
          serviceId: String(barService.id),
          serviceName: title,
          timeSlot: 'night',
          reason: description,
          estimatedDuration: '3-4 hours',
          groupSuitability: 'Great for groups',
          price_cad: barService.price_cad,
          price_usd: barService.price_usd,
          duration_hours: barService.duration_hours,
          image_url: barService.image_url
        });
      }
    } else if (guidedFirstDay.eveningActivity === 'steakhouse') {
      const steakhouseService = availableServices.find(s => 
        s.name && s.name.toLowerCase().includes('steak')
      );
      const title = 'Steakhouse Dinner';
      const description = steakhouseService?.itinerary_description || steakhouseService?.description || 'Premium steakhouse experience with the best cuts in Austin';
      if (steakhouseService) {
        selectedServices.push({
          serviceId: String(steakhouseService.id),
          serviceName: title,
          timeSlot: 'evening',
          reason: description,
          estimatedDuration: '2-3 hours',
          groupSuitability: 'Perfect for groups',
          price_cad: steakhouseService.price_cad,
          price_usd: steakhouseService.price_usd,
          duration_hours: steakhouseService.duration_hours,
          image_url: steakhouseService.image_url
        });
      }
    } else if (guidedFirstDay.eveningActivity === 'strip_club') {
      const stripClubService = availableServices.find(s => 
        s.category === 'strip_club' || (s.name && s.name.toLowerCase().includes('gentlemen'))
      );
      const title = 'Strip Club';
      const description = stripClubService?.itinerary_description || stripClubService?.description || "Premium gentlemen's club experience for the bachelor party";
              if (stripClubService) {
          selectedServices.push({
            serviceId: String(stripClubService.id),
            serviceName: stripClubService.itinerary_name || stripClubService.name,
            timeSlot: 'night',
            reason: description,
            estimatedDuration: '3-4 hours',
            groupSuitability: 'Adult entertainment',
            price_cad: stripClubService.price_cad,
            price_usd: stripClubService.price_usd,
            duration_hours: stripClubService.duration_hours,
            image_url: stripClubService.image_url
          });
        }
    }
    // For 'open_evening', we don't add a specific service
    
    return {
      selectedServices: selectedServices,
      dayTheme: 'Arrival Day',
      logisticsNotes: 'First day of the bachelor party'
    };
  }

  // Generate and present day-by-day itinerary when transitioning to planning
  async generateItineraryPresentation(conversation) {
    const { facts } = conversation;
    
    try {
      console.log('🎯 Starting day-by-day itinerary generation...');
      
      // Search for available services first using conversation-specific method
      await this.searchServicesForConversation(conversation);
      
      // Initialize day-by-day planning
      const totalDays = this.calculateDuration(facts.startDate?.value, facts.endDate?.value);
      conversation.dayByDayPlanning = {
        currentDay: 0,
        totalDays: totalDays,
        completedDays: [],
        usedServices: new Set(), // Initialize used services tracking - NEW
        isComplete: false
      };
      
      // Transform conversation facts to format expected by AI system
      const userPreferences = this.transformConversationFacts(facts);
      const allServices = conversation.availableServices || [];
      
      console.log(`🎯 Planning Day 1 with ${allServices.length} available services`);
      
      const dayInfo = {
        dayNumber: 1,
        totalDays: totalDays,
        timeSlots: this.getTimeSlotsForDay(1, totalDays),
        isFirstDay: true,
        isLastDay: totalDays === 1
      };
      
      // AI selects optimal services for Day 1 - UPDATED with deduplication context
      const dayPlan = await this.aiSelector.selectOptimalServices(
        allServices,
        userPreferences,
        dayInfo,
        {
          usedServices: [], // Empty for first day
          allowRepeats: false,
          userExplicitRequest: null
        }
      );
      
      // Store the day plan so it can be saved when user confirms
      const enrichedDayPlan = {
        ...dayPlan,
        selectedServices: this.enrichSelectedWithMeta(dayPlan.selectedServices, allServices)
      };
      
      // Keep the enriched plan in conversation state
      conversation.dayByDayPlanning.currentDayPlan = enrichedDayPlan;      
      // AI generates engaging response text for Day 1
      const result = await this.aiResponseGenerator.generateItineraryResponse(
        enrichedDayPlan,
        dayInfo,
        userPreferences
      );
      
      // Handle both string and object responses
      return typeof result === 'string' ? result : result;
      
    } catch (error) {
      console.error('Error in AI itinerary presentation:', error);
      return this.fallbackItineraryPresentation(conversation);
    }
  }

  // New method to plan a single day
  planSingleDay(dayIndex, totalDays, startDate, availableServices, wildnessLevel, groupSize) {
    // Create date object and reset to start of day
    const currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0);
    
    // Add days (dayIndex should be 0 for first day, 1 for second day, etc.)
    currentDate.setDate(currentDate.getDate() + dayIndex);
    
    const dayOfWeek = currentDate.getDay();
    const isWeekend = dayOfWeek === 5 || dayOfWeek === 6; // Friday or Saturday
    const isFirstDay = dayIndex === 0;
    const isLastDay = dayIndex === totalDays - 1;
    
    // Select services for this specific day
    const dayServices = this.selectServicesForDay(
      availableServices, 
      dayIndex, 
      totalDays, 
      wildnessLevel, 
      groupSize, 
      isWeekend
    );
    
    return {
      date: currentDate,
      dayIndex,
      isFirstDay,
      isLastDay,
      isWeekend,
      services: dayServices,
      activities: this.generateActivitiesForDay(dayServices, dayIndex, totalDays)
    };
  }
  
  // New method to select services specifically for one day
  selectServicesForDay(availableServices, dayIndex, totalDays, wildnessLevel, groupSize, isWeekend) {
    const services = {
      restaurants: availableServices.filter(s => s.type.toLowerCase() === 'restaurant'),
      bars: availableServices.filter(s => s.type.toLowerCase() === 'bar'),
      nightclubs: availableServices.filter(s => s.type.toLowerCase() === 'night club'),
      activities: availableServices.filter(s => s.type.toLowerCase() === 'daytime'),
      transportation: availableServices.filter(s => s.type.toLowerCase() === 'transportation')
    };
    
    const selected = {};
    
    // Day-specific logic
    if (dayIndex === 0) {
      // First day - focus on arrival dinner and nightlife
      if (services.restaurants.length > 0) {
        selected.restaurant = this.pickBestService(services.restaurants, groupSize, ['group', 'welcome']);
      }
      if (isWeekend && services.nightclubs.length > 0 && wildnessLevel >= 7) {
        selected.nightlife = this.pickBestService(services.nightclubs, groupSize, ['vip', 'bottle']);
      } else if (services.bars.length > 0) {
        selected.nightlife = this.pickBestService(services.bars, groupSize, ['group', 'fun']);
      }
    } else if (dayIndex === totalDays - 1 && totalDays > 1) {
      // Last day - recovery focus
      if (services.restaurants.length > 0) {
        selected.brunch = this.pickBestService(services.restaurants, groupSize, ['brunch', 'casual']);
      }
    } else {
      // Middle days - full activity days
      if (services.activities.length > 0) {
        selected.activity = this.pickBestService(services.activities, groupSize, ['team', 'competitive']);
      }
      if (services.restaurants.length > 0) {
        selected.restaurant = this.pickBestService(services.restaurants, groupSize, ['dinner', 'party']);
      }
      if (services.nightclubs.length > 0 && wildnessLevel >= 7) {
        selected.nightlife = this.pickBestService(services.nightclubs, groupSize, ['vip', 'amazing']);
      }
    }
    
    return selected;
  }
  
  // New method to present options for a single day
  presentDayOptions(dayPlan, dayIndex, totalDays) {
    let presentation = "";
    const { services, activities } = dayPlan;
    
    // Show the planned activities
    activities.forEach(activity => {
      presentation += `💡 ${activity.time}: ${activity.description}\n`;
    });
    
    // Show alternative options if available
    if (Object.keys(services).length > 1) {
      presentation += `\n*Alternative options for this day:*\n`;
      Object.entries(services).forEach(([type, service]) => {
        if (service && service.name) {
          presentation += `${type}: ${service.name} - ${service.description || 'great option'}\n`;
        }
      });
    }
    
    return presentation;
  }

  async handleItineraryState(message, conversationData) {
    console.log('Handling itinerary state with AI-powered planning');
    
    const result = await this.generateItinerary(conversationData);
    
    if (!result.success) {
      return {
        response: result.fallback || "I'm having trouble putting together your itinerary. Let me try a different approach...",
        state: 'itinerary',
        conversationData
      };
    }
  
    const firstDay = result.itinerary[0];
    
    return {
      response: firstDay.responseText,
      state: 'approval',
      conversationData: {
        ...conversationData,
        currentItinerary: result.itinerary,
        currentDay: 1,
        totalServicesFound: result.totalServices,
        categoriesAvailable: result.categoriesAvailable
      }
    };
  }
  
  // Modified handleItineraryFeedback for day-by-day progression
  trackUsedServices(conversation, selectedServices) {
    this.ensureUsedServicesSet(conversation);
    (selectedServices || []).forEach(s => {
      if (s?.serviceId) conversation.dayByDayPlanning.usedServices.add(s.serviceId);
    });
  }
  
  getUsedServicesContext(conversation) {
    this.ensureUsedServicesSet(conversation);
    const usedServiceIds = Array.from(conversation.dayByDayPlanning.usedServices);
    const availableServices = conversation.availableServices || [];
    return usedServiceIds.map(id => {
      const svc = availableServices.find(s => s.id === id);
      return svc ? { id, name: svc.name, category: svc.category || svc.type } : null;
    }).filter(Boolean);
  }
  
  // Handle planning mode - day-by-day itinerary building
  async handlePlanningMode(conversation, userMessage, reduction) {
    // Check if planning is complete
    if (conversation.dayByDayPlanning?.isComplete) {
      // Transition to STANDBY phase
      return {
        response: this.generateAllDaysScheduledMessage(conversation),
        newPhase: PHASES.STANDBY
      };
    }
    
    // Continue with planning logic
    const result = await this.handleItineraryFeedback(conversation, userMessage, reduction);
    
    // Handle both string and object responses
    const response = typeof result === 'string' ? result : result.response;
    const interactive = typeof result === 'object' ? result.interactive : null;
    
    // Check if we just completed planning
    if (conversation.dayByDayPlanning?.isComplete) {
      return {
        response: response,
        interactive: interactive,
        newPhase: PHASES.STANDBY
      };
    }
    
    return {
      response: response,
      interactive: interactive,
      newPhase: PHASES.PLANNING
    };
  }

  // Handle standby mode - modifications and questions after planning is complete
  async handleStandbyMode(conversation, userMessage) {
    return await this.handleStandbyInteraction(conversation, userMessage, null);
  }
  
  // ===== EXISTING handleItineraryFeedback METHOD (now only used during PLANNING) =====
  
  async handleItineraryFeedback(conversation, userMessage, reduction) {
    const { dayByDayPlanning } = conversation;
    
    // Handle button responses for day confirmation
    if (userMessage === 'next_day_yes') {
      // User confirmed moving to next day - treat as approval_next
      const mockReduction = { intent_type: 'approval_next', target_day_index: null };
      return await this.handleItineraryFeedback(conversation, 'yes, next day', mockReduction);
    }
    
    if (userMessage === 'next_day_no') {
      // User wants to make changes - ask what they'd like to modify
      return "What would you like to change about this day?";
    }
    
    if (userMessage === 'finalize_yes') {
      // User confirmed finalizing - mark planning complete
      dayByDayPlanning.isComplete = true;
      return this.generateAllDaysScheduledMessage(conversation);
    }
    
    if (userMessage === 'finalize_no') {
      // User wants to make changes to final day - ask what they'd like to modify
      return "What would you like to change about the itinerary?";
    }
    
    // Handle options-style questions during planning
    if (this.isOptionsStyleQuestion(userMessage)) {
      const scoped = await this.handleScopedOptionsRequest(conversation, userMessage);
      if (scoped) return scoped;
    }
    
    // Use the enhanced reducer's intent classification
    const intentType = reduction.intent_type;
    
    // 1) Handle approvals/next-day requests
    // ===== APPROVAL → SAVE CURRENT DAY, THEN ADVANCE =====
    if (intentType === 'approval_next') {
      // Ensure structure exists
      const dayByDayPlanning = conversation.dayByDayPlanning || (conversation.dayByDayPlanning = {});
      const currentDayIndex = Number.isInteger(dayByDayPlanning.currentDay) ? dayByDayPlanning.currentDay : 0;

      // Decide where to go AFTER saving today:
      // If reducer gave us a specific target (e.g., "day 2"), use it; else go to next day.
      const nextDayIndex = Number.isInteger(reduction?.target_day_index)
        ? reduction.target_day_index
        : currentDayIndex + 1;

      const totalDays =
        dayByDayPlanning.totalDays ||
        this.calculateDuration(conversation.facts.startDate?.value, conversation.facts.endDate?.value);

      // Persist CURRENT day's plan into CURRENT index
      const pending = dayByDayPlanning.currentDayPlan;
      if (pending) {
        if (!Array.isArray(dayByDayPlanning.completedDays)) dayByDayPlanning.completedDays = [];
        if (!Array.isArray(conversation.selectedServices)) conversation.selectedServices = [];

        const available = conversation.availableServices || [];
        const enrichedSelected = (pending.selectedServices || []).map((item) => {
          const match = available.find((s) => String(s.id) === String(item.serviceId));
          return {
            ...item,
            serviceName: item.serviceName || match?.itinerary_name || match?.name || 'Selected service',
            price_cad: match?.price_cad ?? item.price_cad ?? null,
            price_usd: match?.price_usd ?? item.price_usd ?? null,
            image_url: match?.image_url ?? item.image_url ?? null,
            duration_hours: item.duration_hours ?? match?.duration_hours ?? null
          };
        });

        // Track used services for future days
        this.trackUsedServices(conversation, enrichedSelected);

        const savedDay = {
          dayNumber: currentDayIndex + 1,
          selectedServices: enrichedSelected,
          dayTheme: pending.dayTheme || '',
          logisticsNotes: pending.logisticsNotes || ''
        };

        // ✅ Write to the CURRENT day, not the target
        dayByDayPlanning.completedDays[currentDayIndex] = savedDay;
        conversation.selectedServices[currentDayIndex] = savedDay;

        // Clear pending to avoid overlay weirdness
        dayByDayPlanning.currentDayPlan = null;
      }

      // If there are no more days, mark complete and exit
      if (nextDayIndex >= totalDays) {
        dayByDayPlanning.isComplete = true;
        return this.generateAllDaysScheduledMessage(conversation);
      }

      // Advance to the chosen day and build its plan
      dayByDayPlanning.currentDay = nextDayIndex;

      // NEW: Guided flow for Friday/Saturday
      const guidedInit = await this.maybeStartGuidedDay(conversation, nextDayIndex);
      if (guidedInit) {
        // Store interactive for frontend and return prompt
        conversation.pendingInteractive = guidedInit.interactive;
        return guidedInit.response;
      }

      try {
        const userPreferences = this.transformConversationFacts(conversation.facts);
        const allServices = conversation.availableServices || [];
        const usedServicesContext = this.getUsedServicesContext(conversation);

        const dayInfo = {
          dayNumber: nextDayIndex + 1,
          totalDays,
          timeSlots: this.getTimeSlotsForDay(nextDayIndex + 1, totalDays),
          isFirstDay: nextDayIndex === 0,
          isLastDay: nextDayIndex + 1 === totalDays
        };

        const dayPlan = await this.aiSelector.selectOptimalServices(
          allServices,
          userPreferences,
          dayInfo,
          { usedServices: usedServicesContext, allowRepeats: false, userExplicitRequest: null }
        );

        const enrichedNextPlan = {
          ...dayPlan,
          selectedServices: this.enrichSelectedWithMeta(dayPlan.selectedServices, allServices)
        };
        dayByDayPlanning.currentDayPlan = enrichedNextPlan;
        const result = await this.aiResponseGenerator.generateItineraryResponse(enrichedNextPlan, dayInfo, userPreferences);
        return typeof result === 'string' ? result : result;
      } catch (e) {
        console.error('[approval_next][select/generate error]', e?.stack || e);
        return `Awesome! Let's plan day ${nextDayIndex + 1}. I'm putting together some epic options for you guys!`;
      }
    }

    // ===== NAVIGATE WITHOUT SAVING (SHOW A SPECIFIC DAY) =====
    if (intentType === 'show_day') {
      // Ensure structure exists
      const dayByDayPlanning = conversation.dayByDayPlanning || (conversation.dayByDayPlanning = {});
      const userPreferences = this.transformConversationFacts(conversation.facts);
      const allServices = conversation.availableServices || [];
      const usedServicesContext = this.getUsedServicesContext(conversation);

      const totalDays =
        dayByDayPlanning.totalDays ||
        this.calculateDuration(conversation.facts.startDate?.value, conversation.facts.endDate?.value);

      // Trust reducer for the day index; if absent, fall back to current
      const targetIndex = Number.isInteger(reduction?.target_day_index)
        ? reduction.target_day_index
        : (Number.isInteger(dayByDayPlanning.currentDay) ? dayByDayPlanning.currentDay : 0);

      const currentIndex = Number.isInteger(dayByDayPlanning.currentDay) ? dayByDayPlanning.currentDay : 0;

      // If asking for the active day and we already have a plan, just (re)present it
      if (targetIndex === currentIndex && dayByDayPlanning.currentDayPlan) {
        const dayInfo = {
          dayNumber: currentIndex + 1,
          totalDays,
          timeSlots: this.getTimeSlotsForDay(currentIndex + 1, totalDays),
          isFirstDay: currentIndex === 0,
          isLastDay: currentIndex + 1 === totalDays
        };
        const result = await this.aiResponseGenerator.generateItineraryResponse(
          dayByDayPlanning.currentDayPlan,
          dayInfo,
          userPreferences
        );
        return typeof result === 'string' ? result : result;
      }

      // Navigate WITHOUT approving: stash current draft
      dayByDayPlanning.drafts = dayByDayPlanning.drafts || {};
      if (dayByDayPlanning.currentDayPlan) {
        dayByDayPlanning.drafts[currentIndex] = this.deepClone(dayByDayPlanning.currentDayPlan);
      }

      dayByDayPlanning.currentDay = targetIndex;

      // Load a draft if present; otherwise build a fresh plan
      let nextPlan = dayByDayPlanning.drafts[targetIndex];

      // NEW: Guided flow for Friday/Saturday when no draft exists
      if (!nextPlan) {
        const guidedInit = await this.maybeStartGuidedDay(conversation, targetIndex);
        if (guidedInit) {
          conversation.pendingInteractive = guidedInit.interactive;
          return guidedInit.response;
        }
      }

      if (!nextPlan) {
        const dayInfo = {
          dayNumber: targetIndex + 1,
          totalDays,
          timeSlots: this.getTimeSlotsForDay(targetIndex + 1, totalDays),
          isFirstDay: targetIndex === 0,
          isLastDay: targetIndex + 1 === totalDays
        };
        try {
          nextPlan = await this.aiSelector.selectOptimalServices(
            allServices,
            userPreferences,
            dayInfo,
            { usedServices: usedServicesContext, allowRepeats: false, userExplicitRequest: null }
          );
        } catch (e) {
          console.error('[show_day][select error]', e?.stack || e);
          nextPlan = { selectedServices: [] };
        }
      }

      const enrichedPlan = {
        ...nextPlan,
        selectedServices: this.enrichSelectedWithMeta(nextPlan.selectedServices, allServices)
      };
      dayByDayPlanning.currentDayPlan = enrichedPlan;

      const dayInfo = {
        dayNumber: targetIndex + 1,
        totalDays,
        timeSlots: this.getTimeSlotsForDay(targetIndex + 1, totalDays),
        isFirstDay: targetIndex === 0,
        isLastDay: targetIndex + 1 === totalDays
      };
      const result = await this.aiResponseGenerator.generateItineraryResponse(enrichedPlan, dayInfo, userPreferences);
      return typeof result === 'string' ? result : result;
    }

    
  
    // 2) Handle substitutions using the reducer's intelligence
    if (['substitution','addition','removal','edit_itinerary'].includes(intentType)) {
      const { dayByDayPlanning } = conversation;
      const currentDayIndex = dayByDayPlanning.currentDay || 0;
    
      // Figure out which day the user meant
      const targetDayIndex = this.resolveTargetDayIndex(userMessage, conversation, currentDayIndex, reduction);
      const totalDays = dayByDayPlanning.totalDays || this.calculateDuration(
        conversation.facts.startDate?.value, conversation.facts.endDate?.value
      );
    
      // Build dayInfo for the *target* day
      const dayInfo = {
        dayNumber: (targetDayIndex + 1),
        totalDays,
        timeSlots: this.getTimeSlotsForDay(targetDayIndex + 1, totalDays),
        isFirstDay: targetDayIndex === 0,
        isLastDay: (targetDayIndex + 1) === totalDays
      };
    
      const userPreferences = this.transformConversationFacts(conversation.facts);
      const allServices = conversation.availableServices || [];
      const usedServicesContext = this.getUsedServicesContext(conversation);
    
      // Get an editable plan for the target day (current or completed)
      const planRef = this.getPlanRefForDay(conversation, targetDayIndex);
      const currentDayPlan = planRef.plan;
    
      // Build edit directives via your existing helper (LLM or heuristic)
      const editDirectives = await this.inferEditDirectives(
        userMessage,
        reduction,
        currentDayPlan,
        allServices,
        userPreferences,
        dayInfo
      );
    
      // Try LLM rewrite first; if it fails, fall back to local applier
      let rewritten;
      try {
        rewritten = await this.aiSelector.rewriteDayWithEdits(
          allServices,
          userPreferences,
          dayInfo,
          currentDayPlan,
          editDirectives,
          {
            usedServices: usedServicesContext,
            allowRepeats: false,
            userExplicitRequest: userMessage
          }
        );
      } catch {
        rewritten = this.applyEditDirectivesLocally(currentDayPlan, editDirectives, allServices, dayInfo);
      }
    
      // Persist back to the right place
      if (planRef.source === 'current') {
        dayByDayPlanning.currentDayPlan = rewritten;
      } else {
        // If we modified a completed day but we're still on that day index,
        // we need to put it back into currentDayPlan for re-approval
        if (targetDayIndex === (dayByDayPlanning.currentDay || 0)) {
          dayByDayPlanning.currentDayPlan = rewritten;
        } else {
          // Save to completed days for other days
          const available = conversation.availableServices || [];
          const enrichedSelected = (rewritten.selectedServices || []).map(item => {
            const match = available.find(s => String(s.id) === String(item.serviceId));
            return {
              serviceId: item.serviceId,
              serviceName: item.serviceName,
              timeSlot: item.timeSlot,
              reason: item.reason,
              estimatedDuration: item.estimatedDuration || null,
              groupSuitability: item.groupSuitability || null,
              price_cad: match?.price_cad ?? item.price_cad ?? null,
              price_usd: match?.price_usd ?? item.price_usd ?? null,
              image_url: match?.image_url ?? item.image_url ?? null,
              duration_hours: item.duration_hours ?? match?.duration_hours ?? null
            };
          });
    
          if (!Array.isArray(conversation.selectedServices)) conversation.selectedServices = [];
          if (!Array.isArray(dayByDayPlanning.completedDays)) dayByDayPlanning.completedDays = [];
    
          const savedDay = {
            dayNumber: targetDayIndex + 1,
            selectedServices: enrichedSelected,
            dayTheme: rewritten.dayTheme || '',
            logisticsNotes: rewritten.logisticsNotes || ''
          };
    
          conversation.selectedServices[targetDayIndex] = savedDay;
          dayByDayPlanning.completedDays[targetDayIndex] = savedDay;
    
          // Keep de-duplication state in sync across all days
          this.rebuildUsedServices(conversation);
        }
      }
          
      // Friendly confirmation with next-step prompt
      const isLastDay = (targetDayIndex + 1) === totalDays;
      return this.generateEditConfirmationForPlanning(editDirectives, userMessage, targetDayIndex + 1, isLastDay);
    }
  }

  buildSidebarItinerary(conversation) {
    // Base = confirmed/saved days
    const base = this.formatItineraryForFrontend(
      conversation.selectedServices,
      conversation.facts
    ) || [];
  
    const currentIdx = conversation.dayByDayPlanning?.currentDay ?? 0;
    const completedLen = conversation.dayByDayPlanning?.completedDays?.length || 0;
  
    // NEW: Merge in completedDays as a fallback if a day is missing or empty in base
    const completed = Array.isArray(conversation.dayByDayPlanning?.completedDays)
      ? conversation.dayByDayPlanning.completedDays
      : [];
    for (let i = 0; i < completed.length; i++) {
      const comp = completed[i];
      if (!comp) continue;
      const hasBaseDay = !!base[i];
      const baseServicesLen = hasBaseDay && Array.isArray(base[i].selectedServices) ? base[i].selectedServices.length : 0;
      const compServicesLen = Array.isArray(comp.selectedServices) ? comp.selectedServices.length : 0;
      if (!hasBaseDay || baseServicesLen === 0) {
        base[i] = {
          dayNumber: i + 1,
          selectedServices: (comp.selectedServices || []).map(s => ({ ...s, confirmed: true })),
          dayTheme: comp.dayTheme || '',
          logisticsNotes: comp.logisticsNotes || ''
        };
      }
    }
  
    // SAFER duration calculation so we never "lose" a day in the UI
    const calcDuration = this.calculateDuration(
      conversation?.facts?.startDate?.value,
      conversation?.facts?.endDate?.value
    ) || 1;
  
    const duration = Math.max(
      calcDuration,
      base.length,
      completedLen,
      currentIdx + 1  // ensure we have a slot for the active day
    );
  
    // Build days from base (confirmed), then overlay pending on current day
    const days = Array.from({ length: duration }, (_, i) => {
      const d = base[i] || { dayNumber: i + 1, selectedServices: [], dayTheme: '', logisticsNotes: '' };
      return {
        dayNumber: i + 1,
        selectedServices: (d.selectedServices || []).map(s => ({ ...s, confirmed: true })),
        dayTheme: d.dayTheme || '',
        logisticsNotes: d.logisticsNotes || ''
      };
    });
  
    // Overlay current pending plan (pending shows first, confirmed fallback remains)
    const pending = conversation.dayByDayPlanning?.currentDayPlan;
    if (pending && Array.isArray(pending.selectedServices) && days[currentIdx]) {
      const pendingServices = pending.selectedServices.map(s => ({
        ...s,
        confirmed: true
      }));
      const confirmedForDay = days[currentIdx].selectedServices.filter(s => s.confirmed);
      days[currentIdx] = {
        dayNumber: currentIdx + 1,
        selectedServices: [...pendingServices, ...confirmedForDay],
        dayTheme: pending.dayTheme || days[currentIdx].dayTheme,
        logisticsNotes: pending.logisticsNotes || days[currentIdx].logisticsNotes
      };
    }
  
    return days;
  }
  
  // NEW: Helper method to detect if edits are primarily substitutions
  isPrimarylySubstitution(editDirectives) {
    if (!editDirectives?.ops?.length) return false;
    
    const substitutionOps = editDirectives.ops.filter(op => 
      op.op === 'substitute_service' || op.op === 'replace_activity'
    );
    
    // Consider it a substitution if:
    // 1. All operations are substitutions, OR
    // 2. Majority are substitutions and no additions
    const totalOps = editDirectives.ops.length;
    const hasAdditions = editDirectives.ops.some(op => op.op === 'add_activity');
    
    return substitutionOps.length === totalOps || 
           (substitutionOps.length > totalOps / 2 && !hasAdditions);
  }
  
  // NEW: Generate simple confirmation for planning mode (similar to standby)
  generateEditConfirmationForPlanning(editDirectives, userMessage, dayNumber, isLastDay) {
    const ops = editDirectives?.ops || [];
    const msg = userMessage.toLowerCase();
    
    // Detect what type of change was made
    let changeType = 'updated';
    let what = 'the plan';
    
    if (ops.some(op => op.op === 'substitute_service' || op.op === 'replace_activity') || 
        msg.includes('replace') || msg.includes('swap') || msg.includes('change')) {
      changeType = 'swapped';
      if (msg.includes('club')) what = 'the club';
      else if (msg.includes('restaurant') || msg.includes('dinner')) what = 'the restaurant';
      else if (msg.includes('activity')) what = 'the activity';
      else if (msg.includes('bottle') || msg.includes('service')) what = 'the service';
      else what = 'that spot';
    }
    
    // Generate confirmations with appropriate next steps
    const baseConfirmations = [
      `Done! I ${changeType} ${what} for Day ${dayNumber}.`,
      `Perfect, ${changeType} ${what} on Day ${dayNumber}.`,
      `Got it! ${changeType} ${what} for Day ${dayNumber}.`,
      `All set! I ${changeType} ${what} on Day ${dayNumber}.`
    ];
    
    // Rotate through different confirmations to avoid repetition
    const baseIndex = Math.floor(Math.random() * baseConfirmations.length);
    const baseResponse = baseConfirmations[baseIndex];
    
    if (isLastDay) {
      return {
        response: baseResponse + " Ready to finalize the itinerary?",
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
        response: baseResponse + ` Ready for Day ${dayNumber + 1}?`,
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

  async handleStandbyInteraction(conversation, userMessage, reduction) {
    const msg = String(userMessage || '').toLowerCase().trim();
    const { dayByDayPlanning } = conversation;
  
    // Use reduceState to classify the user's intent
    const standbyReduction = await this.classifyStandbyIntent(conversation, userMessage);
    const intentType = standbyReduction?.intent_type || 'general_question';
  
    // Handle based on intent type
    switch (intentType) {
      case 'edit_itinerary':
        return await this.handleItineraryEdit(conversation, userMessage, standbyReduction);
      
      case 'approval_next':
        return this.generateAllDaysScheduledMessage(conversation);
      
      case 'general_question':
      default:
        return await this.handleGeneralQuestion(conversation, userMessage, standbyReduction);
    }
  }
  
  // NEW: Classify user intent in standby mode
  async classifyStandbyIntent(conversation, userMessage) {
    const currentFacts = this.serializeFacts(conversation.facts);
    const recentMessages = conversation.messages.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
    
    const intentPrompt = `You are analyzing a user message in the context of a completed bachelor party itinerary.
  
  CONTEXT:
  CURRENT FACTS: ${currentFacts}
  RECENT CONVERSATION: ${recentMessages}
  USER MESSAGE: "${userMessage}"
  
  INTENT CLASSIFICATION:
  - "edit_itinerary": User wants to change, swap, remove, add, or modify something in their itinerary
    Examples: "change dinner", "swap the strip club", "add golf", "move this earlier", "different restaurant"
    
  - "general_question": User is asking for information about their itinerary, available options, prices, details, recommendations, or any other info
    Examples: "what strip club options are there?", "what's the price?", "when does this start?", "what are the alternatives?", "tell me about X"
    
  - "approval_next": User is acknowledging completion or saying they're satisfied
    Examples: "thanks", "looks good", "we're all set", "perfect"
  
  Classify the user's intent and provide a brief reply acknowledging their request.
  
  Return JSON with: intent_type, assumptions, reply`;
  
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are classifying user intent for a bachelor party planning assistant." },
          { role: "user", content: intentPrompt }
        ],
        functions: [{
          name: "classify_intent",
          description: "Classify user intent in standby mode",
          parameters: {
            type: "object",
            properties: {
              intent_type: {
                type: "string", 
                enum: ["edit_itinerary", "general_question", "approval_next"]
              },
              assumptions: { type: "array", items: { type: "string" } },
              reply: { type: "string" }
            },
            required: ["intent_type", "assumptions", "reply"]
          }
        }],
        function_call: { name: "classify_intent" },
        temperature: 0.3,
        max_tokens: 300
      });
  
      const functionCall = response.choices[0].message.function_call;
      if (functionCall) {
        return JSON.parse(functionCall.arguments);
      }
    } catch (error) {
      console.error('Error classifying standby intent:', error);
    }
  
    // Fallback classification
    return {
      intent_type: 'general_question',
      assumptions: [],
      reply: ''
    };
  }
  
  // NEW: Handle itinerary edits (similar to existing logic)
  async handleItineraryEdit(conversation, userMessage, reduction) {
    const totalDays = conversation.dayByDayPlanning.totalDays
      || this.calculateDuration(conversation.facts.startDate?.value, conversation.facts.endDate?.value)
      || 1;

    // Try to detect a target day; default to Day 1 if none mentioned
    const dayMatch = userMessage.toLowerCase().match(/day\s*(\d+)/i);
    const targetIndex = dayMatch
      ? Math.min(Math.max(parseInt(dayMatch[1], 10) - 1, 0), totalDays - 1)
      : 0;

    // Convert saved day into a plan shape usable by the selector
    const completed = conversation.selectedServices?.[targetIndex] || {};
    const currentDayPlan = {
      selectedServices: (completed.selectedServices || []).map(s => ({
        serviceId: s.serviceId,
        serviceName: s.serviceName,
        timeSlot: s.timeSlot,
        reason: s.reason || 'Selected earlier',
        estimatedDuration: s.estimatedDuration || '2-3 hours',
        groupSuitability: s.groupSuitability || 'Works well for groups'
      })),
      dayTheme: completed.dayTheme || '',
      logisticsNotes: completed.logisticsNotes || ''
    };

    const userPreferences = this.transformConversationFacts(conversation.facts);
    const allServices = conversation.availableServices || [];
    const dayInfo = {
      dayNumber: targetIndex + 1,
      totalDays,
      timeSlots: this.getTimeSlotsForDay(targetIndex + 1, totalDays),
      isFirstDay: targetIndex === 0,
      isLastDay: targetIndex + 1 === totalDays
    };

    // Parse edit directives
    const editDirectives =
      (await this.inferEditDirectives(userMessage, currentDayPlan, userPreferences, dayInfo)) ||
      this.heuristicEditDirectives(userMessage, allServices, dayInfo);

    if (editDirectives?.ops?.length) {
      try {
        const usedServicesContext = this.getUsedServicesContext(conversation);

        const rewritten = await this.aiSelector.rewriteDayWithEdits(
          allServices, 
          userPreferences, 
          dayInfo, 
          currentDayPlan, 
          editDirectives,
          {
            usedServices: usedServicesContext,
            allowRepeats: true,
            userExplicitRequest: userMessage
          }
        );

        // Save the rewritten day back into the itinerary
        if (!Array.isArray(conversation.selectedServices)) conversation.selectedServices = [];
        
        // Update the used services tracking
        const oldServices = conversation.selectedServices[targetIndex]?.selectedServices || [];
        this.ensureUsedServicesSet(conversation);

        (oldServices || []).forEach(service => {
          if (service?.serviceId) {
            conversation.dayByDayPlanning.usedServices.delete(service.serviceId);
          }
        });
        
        this.trackUsedServices(conversation, rewritten.selectedServices);
        
        conversation.selectedServices[targetIndex] = {
          dayNumber: targetIndex + 1,
          selectedServices: rewritten.selectedServices,
          dayTheme: rewritten.dayTheme || '',
          logisticsNotes: rewritten.logisticsNotes || ''
        };

        // NEW: Generate a simple edit confirmation instead of full day presentation
        return this.generateEditConfirmation(editDirectives, userMessage, targetIndex + 1);

      } catch (e) {
        console.error('Standby edit failed:', e);
        return `Updated Day ${targetIndex + 1}. Want to see the new lineup or tweak anything else?`;
      }
    }

    return `Tell me what to change and which day (e.g., "Swap dinner on Day ${Math.min(2, totalDays)} for a steakhouse" or "Move the club later").`;
  }

  // NEW: Add this method to generate simple edit confirmations
  generateEditConfirmation(editDirectives, userMessage, dayNumber) {
    const ops = editDirectives?.ops || [];
    const msg = userMessage.toLowerCase();
    
    // Detect what type of change was made
    let changeType = 'updated';
    let what = 'the plan';
    
    if (ops.some(op => op.op === 'substitute_service') || msg.includes('replace') || msg.includes('swap') || msg.includes('change')) {
      changeType = 'swapped';
      if (msg.includes('club')) what = 'the club';
      else if (msg.includes('restaurant') || msg.includes('dinner')) what = 'the restaurant';
      else if (msg.includes('activity')) what = 'the activity';
      else what = 'that spot';
    } else if (ops.some(op => op.op === 'add_activity') || msg.includes('add')) {
      changeType = 'added';
      what = 'that to the lineup';
    } else if (ops.some(op => op.op === 'remove_activity') || msg.includes('remove')) {
      changeType = 'removed';
      what = 'that from the plan';
    }
    
    const confirmations = [
      `Done! I ${changeType} ${what} for Day ${dayNumber}. Your itinerary is updated.`,
      `Perfect, ${changeType} ${what} on Day ${dayNumber}. The plan is all set with that change.`,
      `Got it! ${changeType} ${what} for Day ${dayNumber}. Itinerary updated.`,
      `All set! I ${changeType} ${what} on Day ${dayNumber}. Want any other tweaks?`
    ];
    
    // Rotate through different confirmations to avoid repetition
    const index = Math.floor(Math.random() * confirmations.length);
    return confirmations[index];
  }

  // NEW: Handle general questions with full context
  async handleGeneralQuestion(conversation, userMessage, reduction) {
    const fullContext = this.buildFullContextForQuestion(conversation);

    // Try to load & render the external template first
    let questionPrompt;
    try {
      const generalTemplate = await this.loadTemplate("general.user.txt"); // cached via templateCache
      questionPrompt = this.renderTemplate(generalTemplate, {
        userMessage,
        fullContext,
      });
    } catch (e) {
      console.warn("general.user.txt load/render failed; using inline fallback:", e?.message);
      // Fallback: previous inline prompt
      questionPrompt = `You are Connected, a professional bachelor party planner. Answer the user's question using all the context provided.
  
  USER QUESTION: "${userMessage}"
  
  FULL CONTEXT:
  ${fullContext}
  
  INSTRUCTIONS:
  - Answer the user's question directly and helpfully
  - Use the specific details from their itinerary and available services
  - Be conversational and natural, not robotic
  - If asking about options, list specific services with names and brief descriptions
  - Include relevant prices, timing, or logistics when helpful
  - If they ask about something not in the context, acknowledge that and suggest alternatives
  - Keep responses focused and not overly long (under 200 words)
  - No emojis or excessive enthusiasm`;
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "You are Connected, a bachelor party planning assistant. Answer questions directly using the provided context. Be helpful and conversational.",
          },
          { role: "user", content: questionPrompt },
        ],
        temperature: 0.6,
        max_tokens: 400,
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error("Error handling general question:", error);
      return "I'm having trouble accessing that information right now. Can you be more specific about what you'd like to know?";
    }
  }

  // NEW: Build comprehensive context for answering questions
  buildFullContextForQuestion(conversation) {
    const facts = conversation.facts;
    const itinerary = Array.isArray(conversation.selectedServices) ? conversation.selectedServices : [];
    const availableServices = conversation.availableServices || [];
    
    // Format basic trip info
    const basicInfo = `
  TRIP DETAILS:
  - Destination: ${facts.destination?.value || 'Unknown'}
  - Group Size: ${facts.groupSize?.value || 'Unknown'}
  - Dates: ${facts.startDate?.value || 'Unknown'} to ${facts.endDate?.value || 'Unknown'}
  - Duration: ${this.calculateDuration(facts.startDate?.value, facts.endDate?.value)} days
  - Wildness Level: ${facts.wildnessLevel?.value || 5}/10
  - Budget: ${facts.budget?.value || 'Not specified'}
  - Interested Activities: ${facts.interestedActivities?.value?.join(', ') || 'None specified'}
  - Age Range: ${facts.ageRange?.value || 'Not specified'}
  - Relationship: ${facts.relationship?.value || 'Not specified'}`;
    
    // Format current itinerary
    const itineraryInfo = itinerary.length > 0 ? `
  CURRENT ITINERARY:
  ${itinerary.map((day, index) => {
    const services = day.selectedServices || [];
    const serviceList = services.map(s => 
      `  - ${s.timeSlot}: ${s.serviceName}${s.price_usd ? ` ($${s.price_usd} CAD)` : ''}${s.estimatedDuration ? ` - ${s.estimatedDuration}` : ''}`
    ).join('\n');
    return `Day ${day.dayNumber}:\n${serviceList || '  - No services selected'}`;
  }).join('\n\n')}` : '\nCURRENT ITINERARY: No itinerary planned yet';
    
    // Format available services by category
    const servicesByCategory = this.groupServicesByCategory(availableServices);
    const servicesInfo = Object.keys(servicesByCategory).length > 0 ? `
  AVAILABLE SERVICES BY CATEGORY:
  ${Object.entries(servicesByCategory).map(([category, services]) => {
    const serviceList = services.slice(0, 8).map(s => // Limit to first 8 per category to avoid overwhelming
      `  - ${s.name}${s.price_usd ? ` ($${s.price_usd} CAD)` : ''}${s.duration_hours ? ` - ${s.duration_hours}h` : ''}${s.description ? ` - ${s.description.slice(0, 80)}...` : ''}`
    ).join('\n');
    return `${category.toUpperCase()} (${services.length} total):\n${serviceList}${services.length > 8 ? '\n  - ... and more options available' : ''}`;
  }).join('\n\n')}` : '\nAVAILABLE SERVICES: No services loaded';
    
    return `${basicInfo}\n${itineraryInfo}\n${servicesInfo}`;
  }

  async inferEditDirectives(userMessage, currentDayPlan, userPreferences, dayInfo) {
    try {
      const openai = this.openai || this.aiSelector?.openai;
      if (!openai) return null;

      const functionSchema = {
        name: "propose_plan_edits",
        description: "Turn free-form feedback into concrete edits to the current day",
        parameters: {
          type: "object",
          properties: {
            ops: {
              type: "array",
              description: "List of edit operations to apply",
              items: {
                type: "object",
                properties: {
                  op: { 
                    type: "string", 
                    enum: ["add_activity","replace_activity","remove_activity","substitute_service","reorder","adjust_time","set_constraint"] 
                  },
                  // targeting
                  target_time: { type: "string", enum: ["afternoon","evening","night","late_night"], nullable: true },
                  target_name: { type: "string", nullable: true },
                  target_category: { type: "string", nullable: true },
                  target_service_id: { type: "string", nullable: true },
                  // payload
                  keywords: { type: "array", items: { type: "string" }, nullable: true },
                  category_hint: { type: "string", nullable: true },
                  new_time: { type: "string", enum: ["afternoon","evening","night","late_night"], nullable: true },
                  new_service_name: { type: "string", nullable: true },
                  sequence: { type: "array", items: { type: "string" }, nullable: true },
                  constraints: { type: "object", additionalProperties: true, nullable: true },
                  notes: { type: "string", nullable: true }
                },
                required: ["op"]
              }
            },
            confidence: { type: "number" }
          },
          required: ["ops"]
        }
      };

      const prompt = `
  You are editing DAY ${dayInfo.dayNumber} of a bachelor-party itinerary.
  User feedback: "${userMessage}".
  
  Current selected services:
  ${(currentDayPlan.selectedServices||[]).map(s => `- ${s.serviceName} (${s.timeSlot})`).join('\n') || '(none yet)'}
  
  User context:
  - Destination: ${userPreferences.destination || userPreferences.facts?.destination?.value || 'Unknown'}
  - Group size: ${userPreferences.groupSize || userPreferences.facts?.groupSize?.value || '?'}
  - Wildness level: ${userPreferences.wildnessLevel || userPreferences.facts?.wildnessLevel?.value || 5}/10
  - Known requests: ${userPreferences.specialRequests || userPreferences.interestedActivities?.join(', ') || '—'}
  
  SUBSTITUTION DETECTION:
  - If user says "X instead of Y", use "substitute_service" op
  - If user says "just do the [service name]", check if it replaces an existing similar service
  - Look for phrases like "swap", "change to", "instead", "rather than"
  
  Example substitutions:
  - "club access instead of bottle service" → substitute_service with target_name="bottle service", new_service_name="club access"
  - "just do the basic entry" → substitute_service if there's currently a premium service
  
  Return structured edits (ops). Prefer minimal-change edits that respect the day's natural flow.
  `;

      const res = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are an expert trip editor. Focus on substitution detection for service swaps." },
          { role: "user", content: prompt }
        ],
        functions: [functionSchema],
        function_call: { name: "propose_plan_edits" },
        temperature: 0.3,
        max_tokens: 800
      });

      const fc = res.choices?.[0]?.message?.function_call;
      if (!fc?.arguments) return null;
      const parsed = JSON.parse(fc.arguments);
      if (!parsed?.ops?.length) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  // Heuristic fallback if LLM parsing fails (keyword + category sniffing)
  heuristicEditDirectives(userMessage, allServices, dayInfo) {
    const msg = (userMessage||'').toLowerCase();

    // Try to detect any service-like noun in the message by scanning catalog
    const catalogKeywords = new Set();
    for (const s of allServices) {
      if (s.name) catalogKeywords.add(s.name.toLowerCase());
      if (s.category) catalogKeywords.add(String(s.category).toLowerCase());
      if (s.type) catalogKeywords.add(String(s.type).toLowerCase());
    }

    const found = [];
    for (const kw of catalogKeywords) {
      if (kw.length >= 4 && msg.includes(kw)) found.push(kw);
    }
    if (!found.length) return null;

    // Default: add the first matched thing into a sensible slot (night if nightlife-like, else last available)
    const nightlifeHints = ['club','bar','strip'];
    const wantsNightlife = nightlifeHints.some(h => msg.includes(h));
    const preferred_time = wantsNightlife
      ? (dayInfo.timeSlots.includes('night') ? 'night' : (dayInfo.timeSlots.includes('late_night') ? 'late_night' : dayInfo.timeSlots.slice(-1)[0]))
      : dayInfo.timeSlots.slice(-1)[0];

    return {
      ops: [{ op: 'add_activity', keywords: found.slice(0,3), category_hint: null, target_time: preferred_time, notes: 'heuristic add' }],
      confidence: 0.55
    };
  }

  // Apply directives locally if LLM rewrite fails
  applyEditDirectivesLocally(currentDayPlan, directives, allServices, dayInfo) {
    // --- base clone ---
    const clone = JSON.parse(JSON.stringify(currentDayPlan || { selectedServices: [] }));
    clone.selectedServices ||= [];
  
    // --- helpers ---
    const safeSlots = Array.isArray(dayInfo?.timeSlots) && dayInfo.timeSlots.length
      ? dayInfo.timeSlots
      : ['morning', 'afternoon', 'evening', 'night'];
  
    const norm = (s = '') => String(s)
      .toLowerCase()
      .replace(/['`]/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  
    const byId = new Map(allServices.map(s => [String(s.id), s]));
  
    const displayName = (s) => s?.itinerary_name || s?.name || '';
  
    const pickTimeSlot = (svc, forced) => {
      if (forced && safeSlots.includes(forced)) return forced;
      const hay = norm(`${svc?.itinerary_name || ''} ${svc?.name || ''} ${svc?.category || ''} ${svc?.type || ''}`);
      if (safeSlots.includes('night') && /club|bar|strip|gentlemen/.test(hay)) return 'night';
      return safeSlots[safeSlots.length - 1]; // default to latest slot in the day
    };
  
    const findServiceByAnyName = (name) => {
      if (!name) return null;
      const n = norm(name);
      return allServices.find(s =>
        norm(s.itinerary_name || '') === n || norm(s.name || '') === n
      ) || null;
    };
  
    const pickServiceSmart = (keywords, categoryHint) => {
      const kw = (keywords || []).filter(Boolean).map(k => norm(k));
      let pool = allServices;
      if (categoryHint) {
        const hint = norm(categoryHint).replace(/\s+/g, '_');
        pool = pool.filter(s => {
          const cat = norm(s.category || s.type || '');
          return cat.includes(hint);
        });
      }
      const scored = pool.map(s => {
        const hay = norm(`${displayName(s)} ${s.description || ''} ${s.category || ''} ${s.type || ''}`);
        const hits = kw.reduce((acc, k) => acc + (hay.includes(k) ? 1 : 0), 0);
        return { s, score: hits + (categoryHint ? 0.25 : 0) };
      }).sort((a, b) => b.score - a.score);
      return scored[0]?.s || null;
    };
  
    const selectedIndexMatch = (sel, op) => {
      // Try by explicit service id
      if (op.target_service_id != null) {
        const id = String(op.target_service_id);
        const i = sel.findIndex(s => String(s.serviceId) === id);
        if (i >= 0) return i;
      }
      // Try by name (substring match)
      if (op.target_name) {
        const t = norm(op.target_name);
        const i = sel.findIndex(s => norm(s.serviceName).includes(t));
        if (i >= 0) return i;
      }
      // Try by category/type
      if (op.target_category) {
        const c = norm(op.target_category);
        const i = sel.findIndex(s => norm(s.category || '').includes(c));
        if (i >= 0) return i;
      }
      // Try by time
      if (op.target_time) {
        const i = sel.findIndex(s => s.timeSlot === op.target_time);
        if (i >= 0) return i;
      }
      // Fallback: last nightlife-ish item
      const ri = [...sel].reverse().findIndex(s => /club|bar|night/i.test(s.serviceName));
      return ri === -1 ? (sel.length ? sel.length - 1 : -1) : (sel.length - 1 - ri);
    };
  
    const pushSelection = (arr, svc, timeSlot, reason) => {
      if (!svc) return;
  
      // Avoid exact dup in same timeslot
      const idStr = String(svc.id);
      const name = displayName(svc);
      const slot = timeSlot || pickTimeSlot(svc);
      const exists = arr.some(s =>
        String(s.serviceId) === idStr && s.timeSlot === slot
      );
      if (exists) return;
  
      arr.push({
        serviceId: idStr,
        serviceName: name,
        timeSlot: slot,
        reason: reason || 'Updated per user feedback',
        estimatedDuration: `${svc.duration_hours || '2-3'} hours`,
        groupSuitability: 'Works well for groups',
        category: svc.category || svc.type || null
      });
    };
  
    // --- apply ops ---
    for (const op of (directives?.ops || [])) {
      switch (op.op) {
        case 'remove_activity': {
          const hasTName = !!op.target_name;
          const hasTCat = !!op.target_category;
          const hasTTime = !!op.target_time;
  
          const tname = norm(op.target_name || '');
          const tcat = norm(op.target_category || '');
          const ttime = op.target_time || null;
  
          clone.selectedServices = clone.selectedServices.filter(s => {
            const matchesName = hasTName ? norm(s.serviceName).includes(tname) : false;
            const matchesCat = hasTCat ? norm(s.category || '').includes(tcat) : false;
            const matchesTime = hasTTime ? (s.timeSlot === ttime) : false;
  
            // If any explicit target was provided, remove when ALL provided targets match.
            const providedCount = [hasTName, hasTCat, hasTTime].filter(Boolean).length;
            const matchedCount =
              (matchesName ? 1 : 0) +
              (matchesCat ? 1 : 0) +
              (matchesTime ? 1 : 0);
  
            return !(providedCount > 0 && matchedCount === providedCount);
          });
          break;
        }
  
        case 'substitute_service': {
          const sel = clone.selectedServices;
          if (!sel.length) break;
  
          const idx = selectedIndexMatch(sel, op);
          if (idx < 0) break;
  
          // Resolve replacement
          let replacement = null;
          if (op.new_service_id != null) {
            replacement = byId.get(String(op.new_service_id)) || null;
          }
          if (!replacement && op.new_service_name) {
            replacement = findServiceByAnyName(op.new_service_name);
          }
          if (!replacement) {
            const kws = Array.isArray(op.keywords) && op.keywords.length
              ? op.keywords
              : (op.new_service_name ? op.new_service_name.split(/\s+/) : []);
            replacement = pickServiceSmart(kws, op.category_hint);
          }
          if (!replacement) break;
  
          const prev = sel[idx];
          sel[idx] = {
            serviceId: String(replacement.id),
            serviceName: displayName(replacement),
            timeSlot: pickTimeSlot(replacement, op.target_time || prev.timeSlot),
            reason: op.notes || `Swapped to ${displayName(replacement)}`,
            estimatedDuration: `${replacement.duration_hours || prev.estimatedDuration || '2-3'} hours`,
            groupSuitability: prev.groupSuitability || 'Works well for groups',
            category: replacement.category || replacement.type || prev.category || null
          };
          break;
        }
  
        case 'replace_activity':
        case 'add_activity': {
          // Choose a service first
          let svc = null;
  
          if (op.new_service_id != null) {
            svc = byId.get(String(op.new_service_id)) || null;
          }
          if (!svc && op.new_service_name) {
            svc = findServiceByAnyName(op.new_service_name);
          }
          if (!svc) {
            svc = pickServiceSmart(op.keywords, op.category_hint);
          }
          if (!svc) break;
  
          // If replace_activity, drop a matching existing item (by id/name/cat/time)
          if (op.op === 'replace_activity') {
            const idx = selectedIndexMatch(clone.selectedServices, op);
            if (idx >= 0) {
              clone.selectedServices.splice(idx, 1);
            } else if (op.target_time) {
              // If we couldn't find a specific item, but we have a target_time, clear that slot
              clone.selectedServices = clone.selectedServices.filter(s => s.timeSlot !== op.target_time);
            }
          }
  
          const timeSlot = pickTimeSlot(svc, op.target_time || op.new_time);
          pushSelection(clone.selectedServices, svc, timeSlot, op.notes);
          break;
        }
  
        case 'adjust_time': {
          const hasId = op.target_service_id != null;
          const tname = norm(op.target_name || '');
          const to = op.new_time || op.target_time;
          if (!to || !safeSlots.includes(to)) break;
  
          const item = clone.selectedServices.find(s => {
            if (hasId && String(s.serviceId) === String(op.target_service_id)) return true;
            if (tname && norm(s.serviceName).includes(tname)) return true;
            return false;
          });
          if (item) item.timeSlot = to;
          break;
        }
  
        case 'reorder': {
          if (!Array.isArray(op.sequence)) break;
          const order = new Map(op.sequence.map((slot, i) => [slot, i]));
          clone.selectedServices.sort((a, b) =>
            (order.get(a.timeSlot) ?? 999) - (order.get(b.timeSlot) ?? 999)
          );
          break;
        }
  
        case 'set_constraint': {
          // Intentionally left as a no-op (persist if your app tracks per-day constraints)
          break;
        }
  
        default:
          // unknown op: ignore
          break;
      }
    }
  
    return clone;
  }
  
  // New method to handle modifications to current day
  async handleDayModification(conversation, userMessage, reduction) {
    const currentDay = conversation.dayByDayPlanning.currentDay + 1;
    
    // You could implement more sophisticated modification logic here
    // For now, offer to regenerate the day with different options
    
    return `Got it! Let me suggest some different options for Day ${currentDay}. What specifically would you like to change - the activities, timing, or type of venue?`;
  }
  
  // New method to get current day plan (helper)
  getCurrentDayPlan(conversation) {
    // This would return the currently planned day
    // Implementation depends on how you want to store the temporary day plan
    return {
      dayIndex: conversation.dayByDayPlanning.currentDay,
      activities: [], // Current day activities
      services: {}    // Current day services
    };
  }
  
  // New method to generate final summary when all days are planned
  generateFinalItinerarySummary(conversation) {
    const { facts, aiGeneratedItinerary } = conversation;
    const destination = facts.destination?.value;
    const groupSize = facts.groupSize?.value;
    
    if (aiGeneratedItinerary && aiGeneratedItinerary.length > 0) {
      let summary = `Perfect! Here's your complete ${destination} bachelor party itinerary:\n\n`;
      
      aiGeneratedItinerary.forEach((day, index) => {
        summary += `Day ${day.day} - ${day.date}:\n`;
        
        if (day.services && day.services.length > 0) {
          day.services.forEach(service => {
            summary += `${service.timeSlot}: ${service.serviceName}\n`;
          });
        } else {
          summary += `Epic ${destination} bachelor party activities\n`;
        }
        
        if (index < aiGeneratedItinerary.length - 1) summary += '\n';
      });
      
      summary += `\n\nThis is going to be absolutely legendary for you ${groupSize} guys! If you want any changes or have questions, just drop them here anytime.`;
      
      return summary;
    }
    
    // Fallback summary
        return `Amazing! We've planned your complete ${destination} bachelor party. This is going to be epic for your group of ${groupSize}! If you want any changes or have questions, just drop them here anytime.`;
   }

  // Select best services from available options
// Select best services from available options (now includes strip clubs)
selectBestServices(availableServices, wildnessLevel, groupSize) {
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, '_');

  const buckets = {
    restaurants: [],
    bars: [],
    nightclubs: [],
    stripclubs: [],
    activities: [],
    transportation: []
  };

  for (const s of availableServices) {
    const cat = norm(s.category || s.type);
    if (cat === 'restaurant') buckets.restaurants.push(s);
    else if (cat === 'bar') buckets.bars.push(s);
    else if (cat === 'night_club' || cat === 'nightclub') buckets.nightclubs.push(s);
    else if (cat === 'strip_club' || /gentlemen/.test((s.name || '').toLowerCase())) buckets.stripclubs.push(s);
    else if (cat === 'daytime' || cat === 'activity' || cat === 'activities') buckets.activities.push(s);
    else if (cat === 'transportation') buckets.transportation.push(s);
  }

  const pickBest = (arr, keywords = []) => {
    if (!arr.length) return null;
    const ks = keywords.map(k => k.toLowerCase());
    return arr
      .map(s => {
        const hay = `${s.name || ''} ${s.description || ''}`.toLowerCase();
        const score = ks.reduce((acc, k) => acc + (hay.includes(k) ? 1 : 0), 0);
        return { s, score };
      })
      .sort((a, b) => b.score - a.score)[0].s;
  };

  const selected = {};

  if (buckets.restaurants.length) {
    selected.restaurant = pickBest(buckets.restaurants, ['group', 'private', 'table', 'steak', 'bbq']);
  }

  // Prefer strip club at higher wildness, fall back to nightclub, then bar
  if ((wildnessLevel >= 7 && buckets.stripclubs.length) || (!buckets.nightclubs.length && buckets.stripclubs.length)) {
    selected.nightlife = pickBest(buckets.stripclubs, ['vip', 'bottle', 'table', 'access']);
  } else if (buckets.nightclubs.length) {
    selected.nightlife = pickBest(buckets.nightclubs, ['vip', 'bottle', 'table', 'entry']);
  } else if (buckets.bars.length) {
    selected.nightlife = pickBest(buckets.bars, ['bar hop', 'rainy', 'sixth']);
  }

  if (buckets.activities.length) {
    selected.activity = pickBest(buckets.activities, ['golf', 'boat', 'hunting', 'pickleball']);
  }

  if (buckets.transportation.length) {
    selected.transport = buckets.transportation[0];
  }

  return selected;
}


  // Helper to pick best service based on keywords and group size
  pickBestService(services, groupSize, keywords) {
    return services.sort((a, b) => {
      let scoreA = 0;
      let scoreB = 0;
      
      const aDesc = (a.description || '').toLowerCase();
      const bDesc = (b.description || '').toLowerCase();
      
      // Boost for relevant keywords
      keywords.forEach(keyword => {
        if (aDesc.includes(keyword)) scoreA += 2;
        if (bDesc.includes(keyword)) scoreB += 2;
      });
      
      // Prefer higher prices (often indicates better experience)
      scoreA += (a.price_usd || 0) * 0.01;
      scoreB += (b.price_usd || 0) * 0.01;
      
      return scoreB - scoreA;
    })[0];
  }

  // Generate day-by-day plan based on duration and services
  generateDayByDayPlan(days, startDate, selectedServices, wildnessLevel) {
    const itinerary = [];
    
    for (let i = 0; i < days; i++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + i);
      
      const dayOfWeek = currentDate.getDay();
      const isWeekend = dayOfWeek === 5 || dayOfWeek === 6; // Friday or Saturday
      
      const day = {
        date: currentDate,
        activities: []
      };
      
      if (i === 0) {
        // First day - arrival and dinner
        if (selectedServices.restaurant) {
          day.activities.push({
            time: "Evening",
            description: `Dinner at ${selectedServices.restaurant.name} - ${selectedServices.restaurant.description || 'great food and atmosphere for groups'}`
          });
        }
        
        if (selectedServices.nightlife && isWeekend) {
          day.activities.push({
            time: "Night",
            description: `Hit up ${selectedServices.nightlife.name} for drinks and nightlife`
          });
        }
      } else if (i === days - 1 && days > 1) {
        // Last day - recovery
        day.activities.push({
          time: "Morning",
          description: "Recovery brunch before heading home"
        });
      } else {
        // Middle days - full activities
        if (selectedServices.activity) {
          day.activities.push({
            time: "Afternoon", 
            description: `${selectedServices.activity.name} - ${selectedServices.activity.description || 'perfect group activity'}`
          });
        }
        
        if (selectedServices.restaurant && i !== 0) {
          day.activities.push({
            time: "Evening",
            description: `Dinner and drinks to fuel up for the night`
          });
        }
        
        if (selectedServices.nightlife) {
          day.activities.push({
            time: "Night",
            description: `Amazing night out at ${selectedServices.nightlife.name} - this is where the legendary stories happen`
          });
        }
      }
      
      // Ensure every day has at least one activity
      if (day.activities.length === 0) {
        day.activities.push({
          time: "Evening",
          description: `Explore ${selectedServices.restaurant ? 'great local spots' : 'the best of the city'} and make some memories`
        });
      }
      
      itinerary.push(day);
    }
    
    return itinerary;
  }

  // Search for available services when we transition to planning
// MODIFIED: Update searchAvailableServices to actually populate conversation.availableServices
async searchAvailableServices(destination, groupSize, preferences = {}) {
  console.log(`🔎 Searching services for ${destination}, ${groupSize} people.`);

  const allServiceTypes = [
    'Restaurant', 'Bar', 'Night Club', 'Daytime', 'Transportation',
    'Strip Club', 'Package', 'Catering', 'Accommodation'
  ];

  const allServices = [];

  for (const serviceType of allServiceTypes) {
    const res = await this.searchServices({
      city_name: destination,
      service_type: serviceType,
      group_size: groupSize,
      max_results: 50
    });

    if (res?.services?.length) {
      allServices.push(
        ...res.services.map(s => ({
          ...s,
          category: serviceType.toLowerCase().replace(/\s+/g, '_')
        }))
      );
    }
  }

  return allServices;
}

async searchServicesForConversation(conversation) {
  const facts = conversation.facts;
  const destination = facts.destination?.value;
  const groupSize = facts.groupSize?.value || 8;

  if (!destination) {
    console.warn('No destination available for service search');
    conversation.availableServices = [];
    return [];
  }

  try {
    console.log(`🔎 Searching for services in ${destination} for ${groupSize} people.`);

    const allServiceTypes = [
      'Restaurant', 'Bar', 'Night Club', 'Daytime', 'Transportation',
      'Strip Club', 'Package', 'Catering', 'Accommodation'
    ];

    const allServices = [];

    for (const serviceType of allServiceTypes) {
      const res = await this.searchServices({
        city_name: destination,
        service_type: serviceType,
        group_size: groupSize,
        max_results: 50
      });

      if (res?.services?.length) {
        allServices.push(
          ...res.services.map(s => ({
            ...s,
            category: serviceType.toLowerCase().replace(/\s+/g, '_')
          }))
        );
      }
    }

    // Optional: enhance with keyword searches based on user preferences
    const userPreferences = this.transformConversationFacts?.(facts) || {};
    const enhanced = await this.enhanceServicesWithKeywords(allServices, { ...userPreferences, destination });

    conversation.availableServices = enhanced;
    return enhanced;
  } catch (err) {
    console.error('Error searching services for conversation:', err);
    conversation.availableServices = [];
    return [];
  }
}

  async enhanceServicesWithKeywords(services, userPreferences = {}) {
    const destination = userPreferences.destination;
    if (!destination) return services;

    const keywords = this.extractKeywords(userPreferences);
    const keywordServices = [];

    for (const keyword of keywords) {
      const results = await this.searchServicesByKeyword({ keyword, city_name: destination });
      if (results?.services?.length) keywordServices.push(...results.services);
    }

    // Merge & dedupe by id
    const all = [...services, ...keywordServices];
    const seen = new Set();
    const unique = [];
    for (const s of all) {
      const id = String(s.id);
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(s);
    }
    return unique;
  }
  
  extractKeywords(userInput) {
    const text = JSON.stringify(userInput).toLowerCase();
    const keywords = [];
    
    // Activity keywords
    if (text.includes('strip club') || text.includes('gentlemen')) keywords.push('strip club');
    if (text.includes('golf')) keywords.push('golf');
    if (text.includes('boat')) keywords.push('boat');
    if (text.includes('steakhouse') || text.includes('steak')) keywords.push('steakhouse');
    if (text.includes('hibachi')) keywords.push('hibachi');
    if (text.includes('hunting')) keywords.push('hunting');
    
    return keywords;
  }

  // Helper to serialize facts for LLM
  serializeFacts(facts) {
    return Object.entries(facts)
      .map(([key, fact]) => {
        const priorityIcon = fact.priority === FACT_PRIORITY.ESSENTIAL ? 'Ã°Å¸"' : 
                           fact.priority === FACT_PRIORITY.HELPFUL ? 'Ã°Å¸Â¡' : 'Ã°Å¸Â¢';
        const value = Array.isArray(fact.value) ? 
          (fact.value.length > 0 ? fact.value.join(', ') : 'none specified') : 
          (fact.value || 'unknown');
        return `${priorityIcon} ${key}: ${value} (${fact.status})`;
      })
      .join(', ');
  }

  // === DATABASE METHODS (keep these - they're useful) ===

  async getAvailableCities() {
    try {
      const { data: cities, error } = await this.supabase
        .from('cities')
        .select('cit_id, cit_name')
        .order('cit_name');
        
      if (error) throw error;
      
      return {
        cities: cities.map(city => ({
          id: city.cit_id,
          name: city.cit_name
        }))
      };
    } catch (error) {
      console.error('Error fetching cities:', error);
      return { error: "Could not fetch cities" };
    }
  }

  firstNumber(...vals) {
    for (const v of vals) {
      if (v == null) continue;
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
    return null;
  }

  // Helper function to calculate prices, returning empty object if price is null/0
  calculatePricing(service, groupSize) {
    const price = service?.price_usd ?? service?.ser_default_price_usd;
    if (!price || price === 0) return {};
    return {
      price_usd: price,
      price_per_person: Math.round(price / groupSize)
    };
  }

  async searchServices({ city_name, service_type, group_size, max_results = 10 }) {
    try {
      // Find city (case-insensitive exact name match)
      const { data: city, error: cityError } = await this.supabase
        .from('cities')
        .select('cit_id')
        .ilike('cit_name', city_name)
        .single();
  
      if (cityError || !city) {
        return {
          error: `City "${city_name}" not found in our database`,
          available_cities: await this.getAvailableCityNames?.() || []
        };
      }
  
      // Select ALL possibly-populated price fields
      const selectFields = `
        ser_id, ser_name, ser_type,
        ser_description, ser_in_app_description,
        ser_itinerary_name, ser_itinerary_description,
        ser_duration_hrs, ser_show_in_app,
  
        ser_default_price_cad, ser_minimum_price_cad,
        ser_default_price_2_cad, ser_minimum_price_2_cad,
        ser_base_price_cad,
  
        ser_default_price_usd, ser_minimum_price_usd,
        ser_default_price_2_usd, ser_minimum_price_2_usd,
  
        ser_image_url, ser_in_app_image
      `;
  
      let query = this.supabase
        .from('services')
        .select(selectFields)
        .eq('ser_city_id', city.cit_id)
        .eq('ser_show_in_app', true);
  
      if (service_type) query = query.eq('ser_type', service_type);
      query = query.limit(max_results);
  
      const { data: services, error } = await query;
      if (error) throw error;
  
      const mapped = services.map(s => {
        const price_usd = this.firstNumber(
          s.ser_default_price_usd, s.ser_minimum_price_usd,
          s.ser_default_price_2_usd, s.ser_minimum_price_2_usd
        );
        const price_cad = this.firstNumber(
          s.ser_default_price_cad, s.ser_minimum_price_cad,
          s.ser_default_price_2_cad, s.ser_minimum_price_2_cad,
          s.ser_base_price_cad
        );
        
        const inAppImage = Array.isArray(s.ser_in_app_image) && s.ser_in_app_image.length > 0
          ? (s.ser_in_app_image[0]?.url || s.ser_in_app_image[0]?.URL || null)
          : null;

        return {
          id: s.ser_id,
          name: s.ser_name,
          type: s.ser_type,
          description: s.ser_description || s.ser_in_app_description || '',
          itinerary_name: s.ser_itinerary_name || null,
          itinerary_description: s.ser_itinerary_description || null,
          price_cad,
          price_usd,
          duration_hours: s.ser_duration_hrs ?? null,
          image_url: inAppImage || s.ser_image_url || null
        };
      });
  
      return { city: city_name, total_results: mapped.length, services: mapped };
    } catch (err) {
      console.error('Error searching services:', err);
      return { error: 'Could not search services' };
    }
  }

  async getServiceDetails({ service_id }) {
    try {
      const { data: s, error } = await this.supabase
        .from('services')
        .select(`*, cities(cit_name)`)
        .eq('ser_id', service_id)
        .single();
  
      if (error || !s) return { error: `Service with ID ${service_id} not found` };
  
      const price_usd = this.firstNumber(
        s.ser_default_price_usd, s.ser_minimum_price_usd,
        s.ser_default_price_2_usd, s.ser_minimum_price_2_usd
      );
      const price_cad = this.firstNumber(
        s.ser_default_price_cad, s.ser_minimum_price_cad,
        s.ser_default_price_2_cad, s.ser_minimum_price_2_cad,
        s.ser_base_price_cad
      );
  
      return {
        id: s.ser_id,
        name: s.ser_name,
        type: s.ser_type,
        description: s.ser_description,
        in_app_description: s.ser_in_app_description,
        itinerary_name: s.ser_itinerary_name,
        itinerary_description: s.ser_itinerary_description,
        city: s.cities?.cit_name,
        pricing: {
          default_cad: s.ser_default_price_cad,
          minimum_cad: s.ser_minimum_price_cad,
          default_usd: s.ser_default_price_usd,
          minimum_usd: s.ser_minimum_price_usd,
          base_cad: s.ser_base_price_cad,
          // New: handy coalesced fields
          best_usd: price_usd,
          best_cad: price_cad,
          additional_person_price: s.ser_additional_person_price
        },
        timing: {
          duration_hours: s.ser_duration_hrs,
          default_start_time: s.ser_default_start_time,
          earliest_start_time: s.ser_earliest_start_time,
          latest_start_time: s.ser_latest_start_time
        },
        logistics: {
          venue_booking_required: s.ser_venue_booking_required,
          contractor_booking_required: s.ser_contractor_booking_required,
          accommodation_address: s.ser_accomodation_address
        },
        image_url: s.ser_image_url
      };
    } catch (err) {
      console.error('Error getting service details:', err);
      return { error: 'Could not get service details' };
    }
  }

  async searchServicesByKeyword({ keyword, city_name, max_results = 20 }) {
    try {
      const like = `%${keyword}%`;
  
      const { data: city, error: cityError } = await this.supabase
        .from('cities')
        .select('cit_id')
        .ilike('cit_name', city_name)
        .single();
  
      if (cityError || !city) {
        return {
          error: `City "${city_name}" not found in our database`,
          available_cities: await this.getAvailableCityNames?.() || []
        };
      }
  
      const selectFields = `
        ser_id, ser_name, ser_type,
        ser_description, ser_in_app_description,
        ser_itinerary_name, ser_itinerary_description,
        ser_duration_hrs, ser_show_in_app,
  
        ser_default_price_cad, ser_minimum_price_cad,
        ser_default_price_2_cad, ser_minimum_price_2_cad,
        ser_base_price_cad,
  
        ser_default_price_usd, ser_minimum_price_usd,
        ser_default_price_2_usd, ser_minimum_price_2_usd,
  
        ser_image_url, ser_in_app_image
      `;
  
      const { data, error } = await this.supabase
        .from('services')
        .select(selectFields)
        .eq('ser_city_id', city.cit_id)
        .eq('ser_show_in_app', true)
        .or([
          `ser_name.ilike.${like}`,
          `ser_itinerary_name.ilike.${like}`,
          `ser_description.ilike.${like}`,
          `ser_in_app_description.ilike.${like}`
        ].join(','))
        .limit(max_results);
  
      if (error) throw error;
  
      const services = (data || []).map(s => {
        const price_usd = this.firstNumber(
          s.ser_default_price_usd, s.ser_minimum_price_usd,
          s.ser_default_price_2_usd, s.ser_minimum_price_2_usd
        );
        const price_cad = this.firstNumber(
          s.ser_default_price_cad, s.ser_minimum_price_cad,
          s.ser_default_price_2_cad, s.ser_minimum_price_2_cad,
          s.ser_base_price_cad
        );
        const inAppImage = Array.isArray(s.ser_in_app_image) && s.ser_in_app_image.length > 0
          ? (s.ser_in_app_image[0]?.url || s.ser_in_app_image[0]?.URL || null)
          : null;
        return {
          id: s.ser_id,
          name: s.ser_name,
          type: s.ser_type,
          description: s.ser_description || s.ser_in_app_description || '',
          itinerary_name: s.ser_itinerary_name || null,
          itinerary_description: s.ser_itinerary_description || null,
          price_cad,
          price_usd,
          duration_hours: s.ser_duration_hrs ?? null,
          image_url: inAppImage || s.ser_image_url || null
        };
      });
  
      return { city: city_name, total_results: services.length, services };
    } catch (err) {
      console.error('Error in searchServicesByKeyword:', err);
      return { error: 'Could not search by keyword' };
    }
  }

  async getAvailableCityNames() {
    try {
      const { data: cities } = await this.supabase
        .from('cities')
        .select('cit_name')
        .order('cit_name');
      return cities?.map(c => c.cit_name) || [];
    } catch {
      return [];
    }
  }

  // Format itinerary data for the frontend sidebar
  formatItineraryForFrontend(selectedServices, facts) {
    if (!selectedServices || typeof selectedServices !== 'object') {
      return null;
    }

    // If selectedServices is organized by days (array)
    if (Array.isArray(selectedServices)) {
      return selectedServices.map((dayData, index) => ({
        dayNumber: index + 1,
        selectedServices: dayData.selectedServices || [],
        dayTheme: dayData.dayTheme || '',
        logisticsNotes: dayData.logisticsNotes || ''
      }));
    }

    // If selectedServices is organized by category (object)
    // Convert to day-based structure
    const duration = this.calculateDuration(facts?.startDate?.value, facts?.endDate?.value) || 1;
    const itinerary = [];

    for (let day = 1; day <= duration; day++) {
      const dayServices = [];
      
      // Distribute services across days (simplified logic)
      Object.entries(selectedServices).forEach(([category, services]) => {
        if (Array.isArray(services)) {
          services.forEach((service, index) => {
            // Simple distribution: spread services across days
            if ((index % duration) + 1 === day) {
              dayServices.push({
                serviceId: service.id || service.ser_id,
                serviceName: service.name || service.ser_name,
                timeSlot: this.guessTimeSlot(category, service),
                reason: service.description || service.ser_description || `Great ${category} choice`,
                estimatedDuration: service.duration_hours || '2-3 hours',
                groupSuitability: 'Perfect for your group',
                price_cad: service.price_cad ?? service.ser_default_price_cad ?? null,
                price_usd: service.price_usd ?? service.ser_default_price_usd ?? null,
                image_url: service.image_url ?? null,
                duration_hours: service.duration_hours ?? null
              });
            }
          });
        }
      });

      itinerary.push({
        dayNumber: day,
        selectedServices: dayServices,
        dayTheme: `Day ${day} adventures`,
        logisticsNotes: ''
      });
    }

    return itinerary;
  }

  // Helper method to guess time slot based on service category
  guessTimeSlot(category, service) {
    const timeSlotMap = {
      'restaurants': 'evening',
      'nightlife': 'night',
      'activities': 'afternoon',
      'transportation': 'morning',
      'accommodation': 'evening'
    };

    // Check service name for time indicators
    const serviceName = (service.name || service.ser_name || '').toLowerCase();
    if (serviceName.includes('breakfast') || serviceName.includes('brunch')) return 'morning';
    if (serviceName.includes('lunch')) return 'afternoon';
    if (serviceName.includes('dinner')) return 'evening';
    if (serviceName.includes('club') || serviceName.includes('bar')) return 'night';

    return timeSlotMap[category] || 'afternoon';
  }

  // Helper message when all days are scheduled but we remain in planning
  generateAllDaysScheduledMessage(conversation) {
    const { facts, dayByDayPlanning, standby = {} } = conversation;
  
    const destination = facts.destination?.value || 'your destination';
    const totalDays = dayByDayPlanning?.totalDays
      || this.calculateDuration(facts.startDate?.value, facts.endDate?.value)
      || 1;
  
    // lightweight date formatting (similar to frontend's)
    const formatDate = (iso) => {
      if (!iso) return null;
      const d = /^\d{4}-\d{2}-\d{2}$/.test(iso)
        ? new Date(+iso.slice(0,4), +iso.slice(5,7)-1, +iso.slice(8,10), 12, 0, 0)
        : new Date(iso);
      const includeYear = d.getFullYear() > new Date().getFullYear();
      const base = { weekday: 'short', month: 'short', day: 'numeric' };
      return d.toLocaleDateString('en-US', includeYear ? { ...base, year: 'numeric' } : base);
    };
  
    const dateRange = (() => {
      const s = formatDate(facts.startDate?.value);
      const e = formatDate(facts.endDate?.value);
      if (s && e) return facts.startDate?.value === facts.endDate?.value ? s : `${s} — ${e}`;
      if (s) return s;
      return null;
    })();
  
    const single = totalDays === 1;
    const rangePart = dateRange ? ` (${dateRange})` : '';
  
    const singleDayTemplates = [
      `Locked in for ${destination}${rangePart}. Ask me anything or say the word if you want tweaks.`,
      `Your night in ${destination} is set${rangePart}. Want to swap something or check details?`,
      `All set for ${destination}${rangePart}. I can adjust timing or venues—just tell me how.`
    ];
  
    const multiDayTemplates = [
      `Your ${totalDays}-day ${destination} plan is locked${rangePart}. Questions or changes? I can tweak any day.`,
      `All set for ${destination}${rangePart}. We can still swap activities, change timing, or add transport.`,
      `Itinerary saved${rangePart}. Want me to move dinner, add brunch, or upgrade nightlife? Just say the word.`
    ];
  
    const templates = single ? singleDayTemplates : multiDayTemplates;
  
    // Rotate templates and avoid repeats
    const nextIndex = (standby.nudgesSent ?? 0) % templates.length;
    let idx = nextIndex;
    if (standby.lastTemplate === idx) idx = (idx + 1) % templates.length;
  
    const msg = templates[idx];
  
    // Persist rotation state
    conversation.standby = {
      nudgesSent: (standby.nudgesSent ?? 0) + 1,
      lastTemplate: idx
    };
  
    return msg;
  }

  // Lightweight detector for "what are the options"-style queries
  isOptionsStyleQuestion(message) {
    const s = String(message || '').toLowerCase().trim();
  
    // Direct "options" / "choices" mentions
    if (/\b(options?|choices?|lineup|catalog|list)\b/.test(s)) return true;
  
    // Common Q forms: "what/which ... options", "show me ..."
    if (/^(what|which)\b.*\b(options?|choices?)\b/.test(s)) return true;
    if (/\bshow (me|us)\b.*\b(options?|spots?|places?)\b/.test(s)) return true;
  
    // Category + options phrasing: "what strip club options are there"
    if (/^(what|which)\b.*\b(strip|gentlemen|nightclub|club|restaurant|bar|activity|activities|transport|sprinter|bus|boat|golf)\b.*\b(options?|choices?)\b/.test(s)) {
      return true;
    }
  
    return false;
  }

  // Use LLM to extract a scoped intent (category + keywords) for option listing
  async extractOptionIntent(userMessage) {
    try {
      const categories = [
        "strip_club","night_club","restaurant","bar","daytime","transportation","package","accommodation","catering"
      ];
      const schema = {
        name: "extract_options_intent",
        description: "Extract category and keywords for a scoped options request",
        parameters: {
          type: "object",
          properties: {
            category: { type: "string", enum: categories },
            keywords: { type: "array", items: { type: "string" } }
          },
          required: ["category"]
        }
      };
      const res = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "Classify the user's request into a single service category and extract short keywords." },
          { role: "user", content: `User request: ${userMessage}` }
        ],
        functions: [schema],
        function_call: { name: "extract_options_intent" },
        temperature: 0.1,
        max_tokens: 200
      });
      const fc = res.choices?.[0]?.message?.function_call;
      if (!fc?.arguments) return null;
      const parsed = JSON.parse(fc.arguments);
      return {
        category: parsed.category,
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : []
      };
    } catch {
      // Heuristic fallback
      const msg = String(userMessage || '').toLowerCase();
      const map = [
        { cat: 'strip_club', hints: ['strip', 'gentlemen'] },
        { cat: 'night_club', hints: ['nightclub', 'club'] },
        { cat: 'restaurant', hints: ['restaurant', 'steak', 'steakhouse', 'dinner'] },
        { cat: 'bar', hints: ['bar', 'pub'] },
        { cat: 'daytime', hints: ['daytime', 'golf', 'boat', 'activity'] },
        { cat: 'transportation', hints: ['sprinter', 'van', 'bus', 'transport'] }
      ];
      for (const m of map) {
        if (m.hints.some(h => msg.includes(h))) return { category: m.cat, keywords: [] };
      }
      return null;
    }
  }

  // Score and select top services by intent
  selectTopServicesByIntent(availableServices, intent, limit = 5) {
    if (!intent) return [];
    const catNorm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '_');
    const kws = (intent.keywords || []).map(k => String(k).toLowerCase());
    const scored = (availableServices || []).map(s => {
      const category = catNorm(s.category || s.type);
      let score = 0;
      if (category.includes(intent.category)) score += 3;
      if (intent.category === 'night_club' && (category.includes('nightclub') || category.includes('night_club'))) score += 2;
      const hay = `${s.name||''} ${s.description||''} ${(s.itinerary_description||'')}`.toLowerCase();
      for (const k of kws) if (hay.includes(k)) score += 1;
      // Prefer items with pricing/duration data
      if (s.price_cad || s.price_usd) score += 0.5;
      if (s.duration_hours) score += 0.25;
      return { s, score };
    }).sort((a,b) => b.score - a.score);
    return scored.slice(0, limit).map(x => x.s);
  }

  // Present options succinctly using the model for copy
  async presentOptions(conversation, intent, options) {
    const facts = this.transformConversationFacts(conversation.facts);
    const payload = (options || []).map(o => ({
      id: o.id,
      name: o.name,
      category: o.category || o.type,
      price_cad: o.price_cad || null,
      price_usd: o.price_usd || null,
      duration_hours: o.duration_hours || null,
      blurb: (o.itinerary_description || o.description || '').slice(0, 160)
    }));
  
    // Build the prompt from external template; fallback to inline prompt on error
    let prompt;
    try {
      const optionsTemplate = await this.loadTemplate("options.user.txt"); // cached via templateCache
      prompt = this.renderTemplate(optionsTemplate, { intent, facts, payload });
    } catch (e) {
      console.warn("options.user.txt load/render failed; using inline fallback:", e?.message);
      prompt =
  `You are Connected, a bachelor party planner. The user asked for options for category: ${intent?.category}.
  Destination: ${facts.destination}, group size: ${facts.groupSize}, wildness: ${facts.wildnessLevel}/10.
  Options JSON: ${JSON.stringify(payload)}
  
  Write a tight answer:
  - Start with a one-line setup (e.g., "Top strip club picks in Austin for 8:")
  - List 3-5 numbered options: name — 3-8 word vibe; include rough price if present
  - Close with a single question to choose or refine vibe (high-energy vs. upscale), or ask which day/slot to place it
  - Max ~120 words, no emojis.`;
    }
  
    try {
      const res = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are a concise, high-signal trip concierge. Keep responses under 120 words." },
          { role: "user", content: prompt }
        ],
        temperature: 0.6,
        max_tokens: 220
      });
      return res.choices?.[0]?.message?.content?.trim() || '';
    } catch {
      // Simple fallback formatting
      const lines = payload.slice(0, 5).map((o, i) => {
        const price = o.price_cad ? ` — ~$${o.price_cad} CAD` : (o.price_usd ? ` — ~$${o.price_usd} USD` : '');
        return `${i + 1}) ${o.name}${price}`;
      }).join('\n');
      return `Here are a few solid options:\n${lines}\n\nWant me to slot one in for late night on Day 1, or do you want a different vibe?`;
    }
  }

  // Orchestrate scoped options request handling
  async handleScopedOptionsRequest(conversation, userMessage) {
    const intent = await this.extractOptionIntent(userMessage);
    if (!intent) return null;
    const options = this.selectTopServicesByIntent(conversation.availableServices || [], intent, 5);
    if (!options.length) return `I didn't find great matches for that yet. Want me to cast a wider net or try a different vibe?`;
    return await this.presentOptions(conversation, intent, options);
  }

  // === Guided day helpers (Friday/Saturday) ===
  dayOfWeekAtIndex(conversation, dayIndex) {
    const start = this.toLocalDate(conversation?.facts?.startDate?.value);
    if (!start) return null;
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayIndex, 12, 0, 0);
    return d.getDay(); // 0=Sun..6=Sat
  }

  async maybeStartGuidedDay(conversation, dayIndex) {
    const dow = this.dayOfWeekAtIndex(conversation, dayIndex);
    if (dow == null) return null;
    if (dow === 5) { // Friday
      return await this.promptGuidedFriday(conversation, dayIndex);
    }
    if (dow === 6) { // Saturday
      return await this.promptGuidedSaturday(conversation, dayIndex);
    }
    if (dow === 0) { // Sunday
      return await this.promptGuidedSunday(conversation, dayIndex);
    }
    return null;
  }

  async promptGuidedFriday(conversation, dayIndex) {
    const groupSize = conversation.facts?.groupSize?.value || 8;
    const svc = conversation.availableServices || [];

    // Morning: catering (Breakfast Taco Catering) or daytime gun activity
    const breakfast = svc.find(s => /breakfast\s*taco/i.test(s.name || ''));
    const gunRange = svc.find(s => /(gun\s*range|indoor.*range|outdoor.*range|clay.*shoot|skeet.*shoot)/i.test(`${s.name||''} ${s.description||''}`) && !/hog|hunt/i.test(`${s.name||''} ${s.description||''}`));

    const morningOptions = [];
    if (breakfast) morningOptions.push({
      value: 'fri_morning_catering',
      title: 'Breakfast Taco Catering',
      description: breakfast.itinerary_description || breakfast.description || 'Fuel up with Austin breakfast tacos at the house',
      ...this.calculatePricing(breakfast, groupSize),
      duration: breakfast.duration_hours ? `${breakfast.duration_hours}h` : '1-2h',
      features: ['At the House', 'Group-Friendly', 'Austin Tacos'],
      timeSlot: 'Morning',
      image_url: breakfast.image_url
    });
    if (gunRange) morningOptions.push({
      value: 'fri_morning_activity',
      title: 'Daytime Shooting Activity',
      description: gunRange.itinerary_description || gunRange.description || 'Head out for gun range / clay shooting / hog hunting',
      price_usd: null,
      price_per_person: null,
      duration: gunRange.duration_hours ? `${gunRange.duration_hours}h` : '3-4h',
      features: ['Outdoors', 'Adrenaline', 'Group Activity'],
      timeSlot: 'Afternoon',
      image_url: gunRange.image_url
    });

    if (!morningOptions.length) return null;

    // Build sub-options for shooting activity
    const clay = svc.find(s => /(clay|skeet)/i.test(`${s.name||''} ${s.description||''}`) && !/hog|hunt/i.test(`${s.name||''} ${s.description||''}`));
    const range = svc.find(s => /(gun\s*range|indoor.*range|outdoor.*range)/i.test(`${s.name||''} ${s.description||''}`) && !/hog|hunt/i.test(`${s.name||''} ${s.description||''}`));
    const hog = svc.find(s => /(hog|hunt|hunting)/i.test(`${s.name||''} ${s.description||''}`));

    const shootingSubOptions = [];
    if (clay) shootingSubOptions.push({
      value: 'fri_morning_activity_clay',
      title: 'Clay Shooting',
      description: clay.itinerary_description || clay.description || 'Clay/skeet shooting session',
      ...this.calculatePricing(clay, groupSize),
      duration: clay.duration_hours ? `${clay.duration_hours}h` : '2-3h',
      features: ['Outdoors', 'Team Challenge'],
      timeSlot: 'Afternoon',
      image_url: clay.image_url
    });
    if (hog) shootingSubOptions.push({
      value: 'fri_morning_activity_hog',
      title: 'Hog Hunting + Ranch Lunch',
      description: hog.itinerary_description || hog.description || 'Guided hog hunting experience',
      ...this.calculatePricing(hog, groupSize),
      duration: hog.duration_hours ? `${hog.duration_hours}h` : '4-6h',
      features: ['Guided', 'Outdoors'],
      timeSlot: 'Afternoon',
      image_url: hog.image_url
    });
    if (range) shootingSubOptions.push({
      value: 'fri_morning_activity_range',
      title: 'Gun Range',
      description: range.itinerary_description || range.description || 'Indoor/outdoor gun range session',
      ...this.calculatePricing(range, groupSize),
      duration: range.duration_hours ? `${range.duration_hours}h` : '2-3h',
      features: ['Range', 'Instructor'],
      timeSlot: 'Afternoon',
      image_url: range.image_url
    });

    // Evening dinner: at house or steakhouse
    const steak = svc.find(s => /steak/i.test(s.name || ''));
    const dinnerOptions = [
      {
        value: 'fri_dinner_house',
        title: 'Dinner at the House',
        description: 'Keep it easy at the house with food and drinks',
        price_usd: null,
        price_per_person: null,
        duration: 'Flexible',
        features: ['Chill Vibes', 'Flexible Timing', 'No Travel'],
        timeSlot: 'Evening',
        image_url: steak?.image_url
      }
    ];
    if (steak) dinnerOptions.push({
      value: 'fri_dinner_steak',
      title: 'Private Room at the Steakhouse',
      description: steak.itinerary_description || steak.description || 'Premium steakhouse dinner before the night out',
      ...this.calculatePricing(steak, groupSize),
      duration: steak.duration_hours ? `${steak.duration_hours}h` : '2-3h',
      features: ['Group Dining', 'Premium Steaks'],
      timeSlot: 'Evening',
      image_url: steak.image_url
    });

    // Night options: comedy club, bar hopping, strip club
    const comedy = svc.find(s => /comedy/i.test(`${s.name||''} ${s.description||''}`));
    const bar = svc.find(s => /dirty.*six|bar.*hop/i.test(`${s.name||''} ${s.itinerary_name||''}`));
    const strip = svc.find(s => (s.category === 'strip_club') || /gentlemen/i.test(s.name || ''));

    const nightOptions = [];
    if (comedy) nightOptions.push({
      value: 'fri_night_comedy',
      title: 'Comedy Club',
      description: comedy.itinerary_description || comedy.description || 'Laugh it up at a great Austin comedy club',
      ...this.calculatePricing(comedy, groupSize),
      duration: comedy.duration_hours ? `${comedy.duration_hours}h` : '2h',
      features: ['Seated Show', 'Fun Night Out'],
      timeSlot: 'Night',
      image_url: comedy.image_url
    });
    if (bar) nightOptions.push({
      value: 'fri_night_bars',
      title: 'Dirty Six Bar Hop',
      description: bar.itinerary_description || bar.description || 'Hit a few top bars for a classic Austin night',
      ...this.calculatePricing(bar, groupSize),
      duration: bar.duration_hours ? `${bar.duration_hours}h` : '3-4h',
      features: ['Multiple Bars', 'Group Vibe'],
      timeSlot: 'Night',
      image_url: bar.image_url
    });
    if (strip) nightOptions.push({
      value: 'fri_night_strip',
      title: 'Strip Club',
      description: strip.itinerary_description || strip.description || "Premium gentlemen's club experience for the bachelor party",
      ...this.calculatePricing(strip, groupSize),
      duration: strip.duration_hours ? `${strip.duration_hours}h` : '3-4h',
      features: ['VIP', 'Bachelor Party'],
      timeSlot: 'Night',
      image_url: strip.image_url
    });

    // Persist a small guided state for this day
    conversation.dayByDayPlanning.guided ||= {};
    conversation.dayByDayPlanning.guided[dayIndex] = { step: 'friday_morning', selections: {} };

    return {
      response: "Day set. For Friday morning, do you want Breakfast Taco Catering or a daytime shooting activity?",
      interactive: { type: 'guided_cards', options: morningOptions, subOptions: { 'fri_morning_activity': shootingSubOptions }, dynamicReplace: true }
    };
  }

  async promptGuidedSaturday(conversation, dayIndex) {
    const groupSize = conversation.facts?.groupSize?.value || 8;
    const svc = conversation.availableServices || [];

    // Lake activity: Booze Cruise or other activity
    const booze = svc.find(s => /booze\s*cruise/i.test((s.name || '') + ' ' + (s.itinerary_name || '')));
    const altDay = svc.find(s => /daytime|activity|golf|boat/i.test(`${s.name||''} ${s.description||''}`));

    const lakeOptions = [];
    if (booze) lakeOptions.push({
      value: 'sat_lake_booze',
      title: 'Lake Travis Booze Cruise',
      description: booze.itinerary_description || booze.description || 'Private party boat on the lake',
      ...this.calculatePricing(booze, groupSize),
      duration: booze.duration_hours ? `${booze.duration_hours}h` : '3-4h',
      features: ['Private Boat', 'Drinks', 'Music'],
      timeSlot: 'Afternoon',
      image_url: booze.image_url
    });
    lakeOptions.push({
      value: 'sat_lake_other',
      title: 'Other Daytime Activity',
      description: 'Pick another daytime activity for Saturday',
      ...this.calculatePricing(altDay, groupSize),
      duration: altDay?.duration_hours ? `${altDay.duration_hours}h` : '3-4h',
      features: ['Flexible'],
      timeSlot: 'Afternoon',
      image_url: altDay?.image_url
    });

    conversation.dayByDayPlanning.guided ||= {};
    conversation.dayByDayPlanning.guided[dayIndex] = { step: 'saturday_lake', selections: {} };

    return {
      response: "For Saturday, do you want start off with a Booze Cruise, or another activity?",
      interactive: { type: 'guided_cards', options: lakeOptions }
    };
  }

  async promptGuidedSunday(conversation, dayIndex) {
    // Set up guided state for Sunday
    conversation.dayByDayPlanning.guided ||= {};
    conversation.dayByDayPlanning.guided[dayIndex] = { step: 'sunday_planning', selections: {} };

    return {
      response: "Alright so for Sunday, do you want to plan anything, or keep it open?",
      interactive: {
        type: 'buttons',
        buttons: [
          { text: 'Yes, plan Sunday', value: 'sunday_plan_yes', style: 'primary' },
          { text: 'No, keep it open', value: 'sunday_plan_no', style: 'secondary' }
        ]
      }
    };
  }

  async handleGuidedDayResponse(conversation, userMessage) {
    const dp = conversation.dayByDayPlanning;
    if (!dp?.guided) return null;
    const idx = dp.currentDay ?? 0;
    const g = dp.guided[idx];
    if (!g) return null;

    const svc = conversation.availableServices || [];
    const groupSize = conversation.facts?.groupSize?.value || 8;

    const setStep = (s) => { g.step = s; };

    // Friday flow
    if (g.step === 'friday_morning') {
      if (
        userMessage === 'fri_morning_catering' ||
        userMessage === 'fri_morning_activity' ||
        userMessage === 'fri_morning_activity_clay' ||
        userMessage === 'fri_morning_activity_range' ||
        userMessage === 'fri_morning_activity_hog'
      ) {
        g.selections.morning = userMessage;
        setStep('friday_dinner');

        // Update current day plan immediately
        try {
          const plan = await this.buildGuidedDayPlan(conversation, idx, 'friday');
          conversation.dayByDayPlanning.currentDayPlan = plan;
        } catch (_) {}

        // Build dinner options (four choices)
        const steakPrivateRoom = svc.find(s =>
          /(steak|steakhouse)/i.test(`${s.name||''} ${s.itinerary_name||''}`) &&
          /private\s*room/i.test(`${s.name||''} ${s.itinerary_name||''} ${s.description||''} ${s.itinerary_description||''}`)
        );
        const privateChef = svc.find(s =>
          /private\s*chef/i.test(`${s.name||''} ${s.description||''} ${s.itinerary_name||''} ${s.itinerary_description||''}`)
        );
        const dinnerReservation = svc.find(s =>
          /reservation/i.test(`${s.name||''} ${s.description||''} ${s.itinerary_name||''} ${s.itinerary_description||''}`)
        ) || svc.find(s => /(restaurant)/i.test(`${s.category||''} ${s.type||''}`) || /restaurant/i.test(s.name || ''));
        const hibachi = svc.find(s =>
          /hibachi/i.test(`${s.name||''} ${s.description||''}`)
        );

        const opts = [
          {
            value: 'fri_dinner_steak_private_room',
            title: 'Private Room at the Steakhouse',
            description: steakPrivateRoom?.itinerary_description || steakPrivateRoom?.description || 'Private dining room at a top steakhouse',
            ...this.calculatePricing(steakPrivateRoom, groupSize),
            duration: steakPrivateRoom?.duration_hours ? `${steakPrivateRoom.duration_hours}h` : '2-3h',
            features: ['Private Room', 'Premium Steaks', 'Group Dining'],
            timeSlot: 'Evening',
            image_url: steakPrivateRoom?.image_url || null
          },
          {
            value: 'fri_dinner_private_chef',
            title: 'Private Chef',
            description: privateChef?.itinerary_description || privateChef?.description || 'Private chef dinner at your place',
            ...this.calculatePricing(privateChef, groupSize),
            duration: privateChef?.duration_hours ? `${privateChef.duration_hours}h` : '2-3h',
            features: ['At the House', 'Chef Experience'],
            timeSlot: 'Evening',
            image_url: privateChef?.image_url || null
          },
          {
            value: 'fri_dinner_reservation',
            title: 'Dinner Reservation',
            description: dinnerReservation?.itinerary_description || dinnerReservation?.description || 'Reserved dinner at a great Austin spot',
            ...this.calculatePricing(dinnerReservation, groupSize),
            duration: dinnerReservation?.duration_hours ? `${dinnerReservation.duration_hours}h` : '2-3h',
            features: ['Restaurant', 'Group Friendly'],
            timeSlot: 'Evening',
            image_url: dinnerReservation?.image_url || null
          },
          {
            value: 'fri_dinner_hibachi',
            title: 'Hibachi Chef',
            description: hibachi?.itinerary_description || hibachi?.description || 'Private hibachi chef experience at your place',
            ...this.calculatePricing(hibachi, groupSize),
            duration: hibachi?.duration_hours ? `${hibachi.duration_hours}h` : '2-3h',
            features: ['At the House', 'Chef Experience'],
            timeSlot: 'Evening',
            image_url: hibachi?.image_url || null
          }
        ];

        return {
          response: 'Nice. For dinner, pick your setup:',
          interactive: { type: 'guided_cards', options: opts }
        };
      }
    }

    if (g.step === 'friday_dinner') {
      if ([
        'fri_dinner_steak_private_room',
        'fri_dinner_private_chef',
        'fri_dinner_reservation',
        'fri_dinner_hibachi',
        'fri_dinner_house', // legacy
        'fri_dinner_steak'  // legacy
      ].includes(userMessage)) {
        g.selections.dinner = userMessage;
        setStep('friday_night');

        // Update current day plan immediately
        try {
          const plan = await this.buildGuidedDayPlan(conversation, idx, 'friday');
          conversation.dayByDayPlanning.currentDayPlan = plan;
        } catch (_) {}

        const comedy = svc.find(s => /comedy/i.test(`${s.name||''} ${s.description||''}`));
        const bar = svc.find(s => (s.category === 'bar') || /bar/i.test(s.name || ''));
        const strip = svc.find(s => (s.category === 'strip_club') || /gentlemen/i.test(s.name || ''));

        const opts = [];
        if (comedy) opts.push({
          value: 'fri_night_comedy', title: 'Comedy Club',
          description: comedy.itinerary_description || comedy.description || 'Laugh it up at a great Austin comedy club',
          ...this.calculatePricing(comedy, groupSize),
          duration: comedy.duration_hours ? `${comedy.duration_hours}h` : '2h',
          features: ['Seated Show', 'Fun Night Out'], timeSlot: 'Night',
          image_url: comedy.image_url
        });
        if (bar) opts.push({
          value: 'fri_night_bars', title: 'Dirty Six Bar Hop',
          description: bar.itinerary_description || bar.description || 'Hit a few top bars for a classic Austin night',
          ...this.calculatePricing(bar, groupSize),
          duration: bar.duration_hours ? `${bar.duration_hours}h` : '3-4h',
          features: ['Multiple Bars', 'Group Vibe'], timeSlot: 'Night',
          image_url: bar.image_url
        });
        if (strip) opts.push({
          value: 'fri_night_strip', title: 'Strip Club',
          description: strip.itinerary_description || strip.description || "Premium gentlemen's club night",
          ...this.calculatePricing(strip, groupSize),
          duration: strip.duration_hours ? `${strip.duration_hours}h` : '3-4h',
          features: ['VIP', 'Bachelor Party'], timeSlot: 'Night',
          image_url: strip.image_url
        });

        return { response: 'For the night, pick your vibe.', interactive: { type: 'guided_cards', options: opts } };
      }
    }

    if (g.step === 'friday_night') {
      if (['fri_night_comedy','fri_night_bars','fri_night_strip'].includes(userMessage)) {
        g.selections.night = userMessage;

        // Update current day plan immediately
        try {
          const plan = await this.buildGuidedDayPlan(conversation, idx, 'friday');
          conversation.dayByDayPlanning.currentDayPlan = plan;
        } catch (_) {}

        // Clear guided state for this day
        delete conversation.dayByDayPlanning.guided[idx];
        return { 
          response: 'Locked for Friday. Ready for the next day?', 
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

    // Saturday flow
    if (g.step === 'saturday_lake') {
      if (userMessage === 'sat_lake_booze') {
        g.selections.lake = userMessage;
        setStep('saturday_catering');

        // Update current day plan immediately
        try {
          const plan = await this.buildGuidedDayPlan(conversation, idx, 'saturday');
          conversation.dayByDayPlanning.currentDayPlan = plan;
        } catch (_) {}

        const svc = conversation.availableServices || [];
        const bbq = svc.find(s => /bbq/i.test(`${s.name||''} ${s.description||''}`));
        const hibachi = svc.find(s => /hibachi/i.test(`${s.name||''} ${s.description||''}`));

        const opts = [];
        if (bbq) opts.push({
          value: 'sat_cater_bbq', title: 'BBQ Catering',
          description: bbq.itinerary_description || bbq.description || 'Post-lake BBQ at the house',
          ...this.calculatePricing(bbq, groupSize),
          duration: bbq.duration_hours ? `${bbq.duration_hours}h` : '2-3h',
          features: ['At the House', 'Texas BBQ'], timeSlot: 'Evening',
          image_url: bbq.image_url
        });
        if (hibachi) opts.push({
          value: 'sat_cater_hibachi', title: 'Hibachi Chef',
          description: hibachi.itinerary_description || hibachi.description || 'Private hibachi chef experience at your place',
          ...this.calculatePricing(hibachi, groupSize),
          duration: hibachi.duration_hours ? `${hibachi.duration_hours}h` : '2-3h',
          features: ['At the House', 'Chef Experience'], timeSlot: 'Evening',
          image_url: hibachi.image_url
        });

        return { response: 'After the booze cruise, do you want BBQ catering or a Hibachi chef?', interactive: { type: 'guided_cards', options: opts } };
      } else if (userMessage === 'sat_lake_other') {
        g.selections.lake = userMessage;
        setStep('saturday_activity');

        // Present alternative activity options
        const svc = conversation.availableServices || [];
        const topgolf = svc.find(s => /topgolf/i.test(s.name || ''));
        const pickleball = svc.find(s => /pickleball/i.test(s.name || ''));
        const pitchputt = svc.find(s => /pitch.*putt|butler/i.test(s.name || ''));
        const karting = svc.find(s => /kart|go.*kart/i.test(s.name || ''));

        const opts = [];
        if (topgolf) opts.push({
          value: 'sat_activity_topgolf',
          title: 'Topgolf Reservation',
          description: topgolf.itinerary_description || topgolf.description || 'Private bay at Topgolf for the group',
          ...this.calculatePricing(topgolf, groupSize),
          duration: topgolf.duration_hours ? `${topgolf.duration_hours}h` : '2-3h',
          features: ['Private Bay', 'Food & Drinks'],
          timeSlot: 'Afternoon',
          image_url: topgolf.image_url
        });
        if (pickleball) opts.push({
          value: 'sat_activity_pickleball',
          title: 'Pickleball Court Rental',
          description: pickleball.itinerary_description || pickleball.description || 'Private pickleball courts for the group',
          ...this.calculatePricing(pickleball, groupSize),
          duration: pickleball.duration_hours ? `${pickleball.duration_hours}h` : '2-3h',
          features: ['Private Courts', 'Equipment Included'],
          timeSlot: 'Afternoon',
          image_url: pickleball.image_url
        });
        if (pitchputt) opts.push({
          value: 'sat_activity_pitchputt',
          title: 'Butler Pitch & Putt',
          description: pitchputt.itinerary_description || pitchputt.description || 'Mini golf and pitch & putt course',
          ...this.calculatePricing(pitchputt, groupSize),
          duration: pitchputt.duration_hours ? `${pitchputt.duration_hours}h` : '2-3h',
          features: ['Mini Golf', 'Group Friendly'],
          timeSlot: 'Afternoon',
          image_url: pitchputt.image_url
        });
        if (karting) opts.push({
          value: 'sat_activity_karting',
          title: 'Go-Karting',
          description: karting.itinerary_description || karting.description || 'High-speed go-kart racing for the group',
          ...this.calculatePricing(karting, groupSize),
          duration: karting.duration_hours ? `${karting.duration_hours}h` : '2-3h',
          features: ['Racing', 'Competitive Fun'],
          timeSlot: 'Afternoon',
          image_url: karting.image_url
        });

        // Add fallback options if services aren't found
        if (opts.length === 0) {
          opts.push(
            {
              value: 'sat_activity_topgolf',
              title: 'Topgolf Reservation',
              description: 'Private bay at Topgolf for the group',
              price_usd: null,
              price_per_person: null,
              duration: '2-3h',
              features: ['Private Bay', 'Food & Drinks'],
              timeSlot: 'Afternoon'
            },
            {
              value: 'sat_activity_pickleball',
              title: 'Pickleball Court Rental',
              description: 'Private pickleball courts for the group',
              price_usd: null,
              price_per_person: null,
              duration: '2-3h',
              features: ['Private Courts', 'Equipment Included'],
              timeSlot: 'Afternoon'
            },
            {
              value: 'sat_activity_pitchputt',
              title: 'Butler Pitch & Putt',
              description: 'Mini golf and pitch & putt course',
              price_usd: null,
              price_per_person: null,
              duration: '2-3h',
              features: ['Mini Golf', 'Group Friendly'],
              timeSlot: 'Afternoon'
            },
            {
              value: 'sat_activity_karting',
              title: 'Go-Karting',
              description: 'High-speed go-kart racing for the group',
              price_usd: null,
              price_per_person: null,
              duration: '2-3h',
              features: ['Racing', 'Competitive Fun'],
              timeSlot: 'Afternoon'
            }
          );
        }

        return { 
          response: 'What daytime activity would you prefer for Saturday?', 
          interactive: { type: 'guided_cards', options: opts } 
        };
      }
    }

    if (g.step === 'saturday_activity') {
      if (['sat_activity_topgolf', 'sat_activity_pickleball', 'sat_activity_pitchputt', 'sat_activity_karting'].includes(userMessage)) {
        g.selections.activity = userMessage;
        setStep('saturday_catering');

        // Update current day plan immediately
        try {
          const plan = await this.buildGuidedDayPlan(conversation, idx, 'saturday');
          conversation.dayByDayPlanning.currentDayPlan = plan;
        } catch (_) {}

        const svc = conversation.availableServices || [];
        const bbq = svc.find(s => /bbq/i.test(`${s.name||''} ${s.description||''}`));
        const hibachi = svc.find(s => /hibachi/i.test(`${s.name||''} ${s.description||''}`));

        const opts = [];
        if (bbq) opts.push({
          value: 'sat_cater_bbq', title: 'BBQ Catering',
          description: bbq.itinerary_description || bbq.description || 'BBQ catering at the house',
          ...this.calculatePricing(bbq, groupSize),
          duration: bbq.duration_hours ? `${bbq.duration_hours}h` : '2-3h',
          features: ['At the House', 'Texas BBQ'], timeSlot: 'Evening',
          image_url: bbq.image_url
        });
        if (hibachi) opts.push({
          value: 'sat_cater_hibachi', title: 'Hibachi Chef',
          description: hibachi.itinerary_description || hibachi.description || 'Private hibachi chef experience at your place',
          ...this.calculatePricing(hibachi, groupSize),
          duration: hibachi.duration_hours ? `${hibachi.duration_hours}h` : '2-3h',
          features: ['At the House', 'Chef Experience'], timeSlot: 'Evening',
          image_url: hibachi.image_url
        });

        return { response: 'Great choice! For dinner, do you want BBQ catering or a Hibachi chef?', interactive: { type: 'guided_cards', options: opts } };
      }
    }

    if (g.step === 'saturday_catering') {
      if (['sat_cater_bbq','sat_cater_hibachi'].includes(userMessage)) {
        g.selections.catering = userMessage;

        // Update current day plan immediately
        try {
          const plan = await this.buildGuidedDayPlan(conversation, idx, 'saturday');
          conversation.dayByDayPlanning.currentDayPlan = plan;
        } catch (_) {}

        // Clear guided state for this day
        delete conversation.dayByDayPlanning.guided[idx];
        return { 
          response: 'Saturday is set. Ready for the next day?', 
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

    // Sunday flow
    if (g.step === 'sunday_planning') {
      if (userMessage === 'sunday_plan_yes') {
        // Move to guided Sunday breakfast step
        g.step = 'sunday_breakfast';
        
        return {
          response: "Perfect! Sunday will be centered around recovery. Do you want to start the day with Breakfast Taco Catering?",
          interactive: {
            type: 'buttons',
            buttons: [
              { text: 'Yes, breakfast tacos', value: 'sunday_breakfast_yes', style: 'primary' },
              { text: 'No, skip breakfast', value: 'sunday_breakfast_no', style: 'secondary' }
            ]
          }
        };
      } else if (userMessage === 'sunday_plan_no') {
        // User wants to keep Sunday open - create an empty plan
        g.selections.planning = 'no_planning';
        
        // Create an empty plan for Sunday
        conversation.dayByDayPlanning.currentDayPlan = {
          selectedServices: [],
          dayTheme: 'Recovery Day',
          logisticsNotes: 'Keeping Sunday open for recovery and departure'
        };

        // Clear guided state for this day
        delete conversation.dayByDayPlanning.guided[idx];
        
        // Check if this is the last day
        const totalDays = conversation.dayByDayPlanning?.totalDays || 
                         this.calculateDuration(conversation.facts.startDate?.value, conversation.facts.endDate?.value) || 1;
        const isLastDay = (idx + 1) === totalDays;
        
        if (isLastDay) {
          return { 
            response: 'Sunday is kept open for recovery. Ready to finalize the itinerary?', 
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
            response: 'Sunday is kept open for recovery. Ready for the next day?', 
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
    }

    // Sunday breakfast step
    if (g.step === 'sunday_breakfast') {
      if (userMessage === 'sunday_breakfast_yes' || userMessage === 'sunday_breakfast_no') {
        g.selections.breakfast = userMessage;
        g.step = 'sunday_recovery';
        
        // Update current day plan immediately
        try {
          const plan = await this.buildGuidedDayPlan(conversation, idx, 'sunday');
          conversation.dayByDayPlanning.currentDayPlan = plan;
        } catch (_) {}

        // Build recovery options with actual service details
        const svc = conversation.availableServices || [];
        const groupSize = conversation.facts?.groupSize?.value || 8;
        
        const massage = svc.find(s => /massage/i.test(`${s.name||''} ${s.description||''}`));
        const sauna = svc.find(s => /sauna|cold\s*plunge/i.test(`${s.name||''} ${s.description||''}`));

        const recoveryOptions = [];
        
        if (massage) recoveryOptions.push({
          value: 'sunday_recovery_massage',
          title: 'On-Site Chair Massages',
          description: massage.itinerary_description || massage.description || 'Professional massage therapists come to your location for relaxing chair massages',
          ...this.calculatePricing(massage, groupSize),
          duration: massage.duration_hours ? `${massage.duration_hours}h` : '2-3h',
          features: ['On-Site Service', 'Professional Therapists', 'Recovery Focus', 'Group Friendly'],
          timeSlot: 'Afternoon',
          image_url: massage.image_url
        });
        
        if (sauna) recoveryOptions.push({
          value: 'sunday_recovery_sauna',
          title: 'Sauna & Cold Plunge Rental',
          description: sauna.itinerary_description || sauna.description || 'Mobile sauna and cold plunge setup delivered to your location for the ultimate recovery experience',
          ...this.calculatePricing(sauna, groupSize),
          duration: sauna.duration_hours ? `${sauna.duration_hours}h` : '3-4h',
          features: ['Mobile Setup', 'Sauna & Cold Plunge', 'Recovery Experience', 'At Your Location'],
          timeSlot: 'Afternoon',
          image_url: sauna.image_url
        });

        // Fallback options if services not found in database
        if (!massage) recoveryOptions.push({
          value: 'sunday_recovery_massage',
          title: 'On-Site Chair Massages',
          description: 'Professional massage therapists come to your location for relaxing chair massages',
          price_usd: null,
          price_per_person: null,
          duration: '2-3h',
          features: ['On-Site Service', 'Professional Therapists', 'Recovery Focus'],
          timeSlot: 'Afternoon',
          image_url: massage?.image_url
        });
        
        if (!sauna) recoveryOptions.push({
          value: 'sunday_recovery_sauna',
          title: 'Sauna & Cold Plunge Rental',
          description: 'Mobile sauna and cold plunge setup delivered to your location for the ultimate recovery experience',
          price_usd: null,
          price_per_person: null,
          duration: '3-4h',
          features: ['Mobile Setup', 'Sauna & Cold Plunge', 'Recovery Experience'],
          timeSlot: 'Afternoon',
          image_url: sauna?.image_url
        });

        return {
          response: "Great! Now for recovery, which sounds better for your Sunday?",
          interactive: {
            type: 'guided_cards',
            options: recoveryOptions
          }
        };
      }
    }

    // Sunday recovery step
    if (g.step === 'sunday_recovery') {
      if (userMessage === 'sunday_recovery_massage' || userMessage === 'sunday_recovery_sauna') {
        g.selections.recovery = userMessage;

        // Update current day plan immediately
        try {
          const plan = await this.buildGuidedDayPlan(conversation, idx, 'sunday');
          conversation.dayByDayPlanning.currentDayPlan = plan;
        } catch (_) {}

        // Clear guided state for this day
        delete conversation.dayByDayPlanning.guided[idx];
        
        // Check if this is the last day
        const totalDays = conversation.dayByDayPlanning?.totalDays || 
                         this.calculateDuration(conversation.facts.startDate?.value, conversation.facts.endDate?.value) || 1;
        const isLastDay = (idx + 1) === totalDays;
        
        if (isLastDay) {
          return { 
            response: 'Perfect! Sunday recovery plan is set. Ready to finalize the itinerary?', 
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
            response: 'Sunday recovery plan is set. Ready for the next day?', 
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
    }

    return null;
  }

  async buildGuidedDayPlan(conversation, dayIndex, kind) {
    const svc = conversation.availableServices || [];
    const selections = conversation.dayByDayPlanning?.guided?.[dayIndex]?.selections || {};
    const groupSize = conversation.facts?.groupSize?.value || 8;

    const pickBy = (predicate) => svc.find(predicate);
    const sel = [];

    // Use class method for price calculations
    const calculatePricing = (service) => this.calculatePricing(service, groupSize);

    if (kind === 'friday') {
      if (selections.morning === 'fri_morning_catering') {
        const breakfast = pickBy(s => /breakfast\s*taco/i.test(s.name || ''));
        if (breakfast) sel.push({
          serviceId: String(breakfast.id), serviceName: 'Breakfast Taco Catering',
          timeSlot: 'morning', reason: (breakfast.itinerary_description || breakfast.description || 'Fuel up with Austin breakfast tacos at the house'),
          ...calculatePricing(breakfast),
          duration: breakfast.duration_hours ? `${breakfast.duration_hours}h` : '1-2h',
          features: ['At the House', 'Group-Friendly', 'Austin Tacos'],
          timeSlot: 'Morning',
          image_url: breakfast.image_url
        });
      } else if (selections.morning === 'fri_morning_activity') {
        const gunRange = pickBy(s => /(gun\s*range|indoor.*range|outdoor.*range|clay.*shoot|skeet.*shoot)/i.test(`${s.name||''} ${s.description||''}`) && !/hog|hunt/i.test(`${s.name||''} ${s.description||''}`));
        if (gunRange) sel.push({
          serviceId: String(gunRange.id), serviceName: 'Daytime Shooting Activity',
          timeSlot: 'afternoon', reason: (gunRange.itinerary_description || gunRange.description || 'Head out for gun range / clay shooting / hog hunting'),
          ...calculatePricing(gunRange),
          duration: gunRange.duration_hours ? `${gunRange.duration_hours}h` : '3-4h',
          features: ['Outdoors', 'Adrenaline', 'Group Activity'],
          timeSlot: 'Afternoon',
          image_url: gunRange.image_url
        });
      }

      if (selections.dinner === 'fri_dinner_steak_private_room') {
        const steakPR = pickBy(s => /(steak|steakhouse)/i.test(`${s.name||''} ${s.itinerary_name||''}`) && /private\s*room/i.test(`${s.name||''} ${s.itinerary_name||''} ${s.description||''} ${s.itinerary_description||''}`));
        if (steakPR) {
          sel.push({
            serviceId: String(steakPR.id), serviceName: 'Private Room at the Steakhouse',
            timeSlot: 'evening', reason: (steakPR.itinerary_description || steakPR.description || 'Private dining room at a top steakhouse'),
            ...calculatePricing(steakPR),
            duration: steakPR.duration_hours ? `${steakPR.duration_hours}h` : '2-3h',
            features: ['Private Room', 'Premium Steaks', 'Group Dining'],
            timeSlot: 'Evening',
            image_url: steakPR.image_url || null
          });
        } else {
          const steak = pickBy(s => /steak|steakhouse/i.test(`${s.name || ''} ${s.itinerary_name || ''}`));
          if (steak) sel.push({
            serviceId: String(steak.id), serviceName: 'Steakhouse Dinner',
            timeSlot: 'evening', reason: (steak.itinerary_description || steak.description || 'Premium steakhouse dinner before the night out'),
            ...calculatePricing(steak),
            duration: steak.duration_hours ? `${steak.duration_hours}h` : '2-3h',
            image_url: steak.image_url || null
          });
        }
      } else if (selections.dinner === 'fri_dinner_private_chef') {
        const pc = pickBy(s => /private\s*chef/i.test(`${s.name||''} ${s.description||''} ${s.itinerary_name||''} ${s.itinerary_description||''}`));
        if (pc) {
          sel.push({
            serviceId: String(pc.id), serviceName: (pc.itinerary_name || pc.name || 'Private Chef'),
            timeSlot: 'evening', reason: (pc.itinerary_description || pc.description || 'Private chef dinner at your place'),
            ...calculatePricing(pc),
            duration: pc.duration_hours ? `${pc.duration_hours}h` : '2-3h',
            features: ['At the House', 'Chef Experience'],
            timeSlot: 'Evening',
            image_url: pc.image_url || null
          });
        } else {
          sel.push({
            serviceId: 'placeholder_private_chef', serviceName: 'Private Chef',
            timeSlot: 'evening', reason: 'Private chef dinner at your place', price_usd: null, price_per_person: null, duration_hours: null
          });
        }
      } else if (selections.dinner === 'fri_dinner_reservation') {
        const rest = pickBy(s => /reservation/i.test(`${s.name||''} ${s.description||''} ${s.itinerary_name||''} ${s.itinerary_description||''}`))
          || pickBy(s => /(restaurant)/i.test(`${s.category||''} ${s.type||''}`) || /restaurant/i.test(s.name || ''));
        if (rest) {
          sel.push({
            serviceId: String(rest.id), serviceName: 'Dinner Reservation',
            timeSlot: 'evening', reason: (rest.itinerary_description || rest.description || 'Reserved dinner at a great Austin spot'),
            ...calculatePricing(rest),
            duration: rest.duration_hours ? `${rest.duration_hours}h` : '2-3h',
            image_url: rest.image_url || null
          });
        } else {
          sel.push({
            serviceId: 'placeholder_dinner_res', serviceName: 'Dinner Reservation',
            timeSlot: 'evening', reason: 'Reserved dinner at a great Austin spot', price_usd: null, price_per_person: null, duration_hours: null
          });
        }
      } else if (selections.dinner === 'fri_dinner_hibachi') {
        const hib = pickBy(s => /hibachi/i.test(`${s.name||''} ${s.description||''}`));
        if (hib) {
          sel.push({
            serviceId: String(hib.id), serviceName: 'Hibachi Chef',
            timeSlot: 'evening', reason: (hib.itinerary_description || hib.description || 'Private hibachi chef experience at your place'),
            ...calculatePricing(hib),
            duration: hib.duration_hours ? `${hib.duration_hours}h` : '2-3h',
            features: ['At the House', 'Chef Experience'],
            timeSlot: 'Evening',
            image_url: hib.image_url || null
          });
        } else {
          sel.push({
            serviceId: 'placeholder_hibachi', serviceName: 'Hibachi Chef',
            timeSlot: 'evening', reason: 'Private hibachi chef experience at your place', price_usd: null, price_per_person: null, duration_hours: null
          });
        }
      } else if (selections.dinner === 'fri_dinner_steak') {
        const steak = pickBy(s => /steak|steakhouse/i.test(`${s.name || ''} ${s.itinerary_name || ''}`));
        if (steak) {
          sel.push({
            serviceId: String(steak.id), serviceName: 'Steakhouse Dinner',
            timeSlot: 'evening', reason: (steak.itinerary_description || steak.description || 'Premium steakhouse dinner before the night out'),
            ...calculatePricing(steak),
            duration: steak.duration_hours ? `${steak.duration_hours}h` : '2-3h',
            image_url: steak.image_url || null
          });
        } else {
          sel.push({
            serviceId: 'placeholder_steakhouse', serviceName: 'Steakhouse Dinner',
            timeSlot: 'evening', reason: 'Premium steakhouse dinner before the night out', price_usd: null, price_per_person: null, duration_hours: null
          });
        }
      } else if (selections.dinner === 'fri_dinner_house') {
        sel.push({
          serviceId: 'placeholder_house_dinner', serviceName: 'Dinner at the House',
          timeSlot: 'evening', reason: 'Keep it easy at the house with food and drinks', price_usd: null, price_per_person: null, duration_hours: null
        });
      }

      // Handle night selections
      if (selections.night === 'fri_night_bars') {
        const barHopping = pickBy(s => 
          /dirty.*six|bar.*hop/i.test(`${s.name||''} ${s.itinerary_name||''} ${s.description||''} ${s.itinerary_description||''}`)
        );
        if (barHopping) {
          sel.push({
            serviceId: String(barHopping.id), 
            serviceName: barHopping.itinerary_name || barHopping.name || 'Dirty Six Bar Hop',
            timeSlot: 'night', 
            reason: (barHopping.itinerary_description || barHopping.description || 'Experience Austin\'s best nightlife scene'),
            ...calculatePricing(barHopping),
            duration: barHopping.duration_hours ? `${barHopping.duration_hours}h` : '3-4h',
            features: ['Nightlife', 'Bar Crawl', 'Austin Scene'],
            timeSlot: 'Night',
            image_url: barHopping.image_url
          });
        } else {
          sel.push({
            serviceId: 'placeholder_bar_hopping', serviceName: 'Dirty Six Bar Hop',
            timeSlot: 'night', reason: 'Experience Austin\'s best nightlife scene', 
            price_usd: null, price_per_person: null, duration_hours: null
          });
        }
      } else if (selections.night === 'fri_night_comedy') {
        const comedy = pickBy(s => /comedy/i.test(`${s.name||''} ${s.description||''}`));
        if (comedy) {
          sel.push({
            serviceId: String(comedy.id), 
            serviceName: comedy.itinerary_name || comedy.name || 'Comedy Club',
            timeSlot: 'night', 
            reason: (comedy.itinerary_description || comedy.description || 'Laughs and drinks at Austin\'s comedy scene'),
            ...calculatePricing(comedy),
            duration: comedy.duration_hours ? `${comedy.duration_hours}h` : '2-3h',
            features: ['Comedy Show', 'Entertainment', 'Drinks'],
            timeSlot: 'Night',
            image_url: comedy.image_url
          });
        } else {
          sel.push({
            serviceId: 'placeholder_comedy', serviceName: 'Comedy Club',
            timeSlot: 'night', reason: 'Laughs and drinks at Austin\'s comedy scene', 
            price_usd: null, price_per_person: null, duration_hours: null
          });
        }
      } else if (selections.night === 'fri_night_strip') {
        const strip = pickBy(s => /strip|gentleman|club/i.test(`${s.name||''} ${s.description||''}`));
        if (strip) {
          sel.push({
            serviceId: String(strip.id), 
            serviceName: strip.itinerary_name || strip.name || 'Gentleman\'s Club',
            timeSlot: 'night', 
            reason: (strip.itinerary_description || strip.description || 'VIP experience at a premium gentleman\'s club'),
            ...calculatePricing(strip),
            duration: strip.duration_hours ? `${strip.duration_hours}h` : '2-3h',
            features: ['VIP Experience', 'Entertainment', 'Bachelor Party'],
            timeSlot: 'Night',
            image_url: strip.image_url
          });
        } else {
          sel.push({
            serviceId: 'placeholder_strip', serviceName: 'Gentleman\'s Club',
            timeSlot: 'night', reason: 'VIP experience at a premium gentleman\'s club', 
            price_usd: null, price_per_person: null, duration_hours: null
          });
        }
      }
    }

    if (kind === 'saturday') {
      if (selections.lake === 'sat_lake_booze') {
        const booze = pickBy(s => /booze\s*cruise/i.test(s.name || ''));
        if (booze) sel.push({
          serviceId: String(booze.id), serviceName: 'Lake Travis Booze Cruise',
          timeSlot: 'afternoon', reason: (booze.itinerary_description || booze.description || 'Private party boat on the lake'),
          ...calculatePricing(booze),
          duration: booze.duration_hours ? `${booze.duration_hours}h` : '3-4h',
          features: ['Private Boat', 'Drinks', 'Music'],
          timeSlot: 'Afternoon',
          image_url: booze.image_url
        });
      } else if (selections.lake === 'sat_lake_other' && selections.activity) {
        if (selections.activity === 'sat_activity_topgolf') {
          const topgolf = pickBy(s => /topgolf/i.test(s.name || ''));
          if (topgolf) {
            sel.push({
              serviceId: String(topgolf.id), serviceName: 'Topgolf Reservation',
              timeSlot: 'afternoon', reason: (topgolf.itinerary_description || topgolf.description || 'Private bay at Topgolf for the group'),
              ...calculatePricing(topgolf),
              duration: topgolf.duration_hours ? `${topgolf.duration_hours}h` : '2-3h',
              image_url: topgolf.image_url
            });
          } else {
            sel.push({
              serviceId: 'placeholder_topgolf', serviceName: 'Topgolf Reservation',
              timeSlot: 'afternoon', reason: 'Private bay at Topgolf for the group',
              price_usd: null, price_per_person: null, duration_hours: null
            });
          }
        } else if (selections.activity === 'sat_activity_pickleball') {
          const pickleball = pickBy(s => /pickleball/i.test(s.name || ''));
          if (pickleball) {
            sel.push({
              serviceId: String(pickleball.id), serviceName: 'Pickleball Court Rental',
              timeSlot: 'afternoon', reason: (pickleball.itinerary_description || pickleball.description || 'Private pickleball courts for the group'),
              ...calculatePricing(pickleball),
              duration: pickleball.duration_hours ? `${pickleball.duration_hours}h` : '2-3h',
              image_url: pickleball.image_url
            });
          } else {
            sel.push({
              serviceId: 'placeholder_pickleball', serviceName: 'Pickleball Court Rental',
              timeSlot: 'afternoon', reason: 'Private pickleball courts for the group',
              price_usd: null, price_per_person: null, duration_hours: null
            });
          }
        } else if (selections.activity === 'sat_activity_pitchputt') {
          const pitchputt = pickBy(s => /pitch.*putt|butler/i.test(s.name || ''));
          if (pitchputt) {
            sel.push({
              serviceId: String(pitchputt.id), serviceName: 'Butler Pitch & Putt',
              timeSlot: 'afternoon', reason: (pitchputt.itinerary_description || pitchputt.description || 'Mini golf and pitch & putt course'),
              ...calculatePricing(pitchputt),
              duration: pitchputt.duration_hours ? `${pitchputt.duration_hours}h` : '2-3h',
              image_url: pitchputt.image_url
            });
          } else {
            sel.push({
              serviceId: 'placeholder_pitchputt', serviceName: 'Butler Pitch & Putt',
              timeSlot: 'afternoon', reason: 'Mini golf and pitch & putt course',
              price_usd: null, price_per_person: null, duration_hours: null
            });
          }
        } else if (selections.activity === 'sat_activity_karting') {
          const karting = pickBy(s => /kart|go.*kart/i.test(s.name || ''));
          if (karting) {
            sel.push({
              serviceId: String(karting.id), serviceName: 'Go-Karting',
              timeSlot: 'afternoon', reason: (karting.itinerary_description || karting.description || 'High-speed go-kart racing for the group'),
              ...calculatePricing(karting),
              duration: karting.duration_hours ? `${karting.duration_hours}h` : '2-3h',
              features: ['Racing', 'Competitive Fun'],
              timeSlot: 'Afternoon',
              image_url: karting.image_url
            });
          } else {
            sel.push({
              serviceId: 'placeholder_karting', serviceName: 'Go-Karting',
              timeSlot: 'afternoon', reason: 'High-speed go-kart racing for the group',
              price_usd: null, price_per_person: null, duration_hours: null
            });
          }
        }
      }

      if (selections.catering === 'sat_cater_bbq') {
        const bbq = pickBy(s => /bbq/i.test(`${s.name||''} ${s.description||''}`));
        if (bbq) sel.push({
          serviceId: String(bbq.id), serviceName: 'BBQ Catering',
          timeSlot: 'evening', reason: (bbq.itinerary_description || bbq.description || 'BBQ catering at the house'),
          ...calculatePricing(bbq),
          duration: bbq.duration_hours ? `${bbq.duration_hours}h` : '2-3h',
          features: ['At the House', 'Texas BBQ'], timeSlot: 'Evening',
          image_url: bbq.image_url
        });
      } else if (selections.catering === 'sat_cater_hibachi') {
        const hibachi = pickBy(s => /hibachi/i.test(`${s.name||''} ${s.description||''}`));
        if (hibachi) sel.push({
          serviceId: String(hibachi.id), serviceName: 'Hibachi Chef',
          timeSlot: 'evening', reason: (hibachi.itinerary_description || hibachi.description || 'Private hibachi chef experience at your place'),
          ...calculatePricing(hibachi),
          duration: hibachi.duration_hours ? `${hibachi.duration_hours}h` : '2-3h',
          features: ['At the House', 'Chef Experience'], timeSlot: 'Evening',
          image_url: hibachi.image_url
        });
      }
    }

    if (kind === 'sunday') {
      if (selections.breakfast === 'sunday_breakfast_yes') {
        const breakfast = pickBy(s => /breakfast\s*taco/i.test(s.name || ''));
        if (breakfast) sel.push({
          serviceId: String(breakfast.id), serviceName: 'Breakfast Taco Catering',
          timeSlot: 'morning', reason: (breakfast.itinerary_description || breakfast.description || 'Recovery breakfast taco catering'),
          ...calculatePricing(breakfast),
          duration: breakfast.duration_hours ? `${breakfast.duration_hours}h` : '1-2h',
          image_url: breakfast.image_url
        });
      }

      if (selections.recovery === 'sunday_recovery_massage') {
        const massage = pickBy(s => /massage/i.test(`${s.name||''} ${s.description||''}`));
        if (massage) sel.push({
          serviceId: String(massage.id), serviceName: 'On-Site Chair Massages',
          timeSlot: 'afternoon', reason: (massage.itinerary_description || massage.description || 'Professional massage therapists come to your location for relaxing chair massages'),
          ...calculatePricing(massage),
          duration: massage.duration_hours ? `${massage.duration_hours}h` : '2-3h',
          image_url: massage.image_url
        });
      } else if (selections.recovery === 'sunday_recovery_sauna') {
        const sauna = pickBy(s => /sauna|cold\s*plunge/i.test(`${s.name||''} ${s.description||''}`));
        if (sauna) sel.push({
          serviceId: String(sauna.id), serviceName: 'Sauna & Cold Plunge Rental',
          timeSlot: 'afternoon', reason: (sauna.itinerary_description || sauna.description || 'Mobile sauna and cold plunge setup delivered to your location for the ultimate recovery experience'),
          ...calculatePricing(sauna),
          duration: sauna.duration_hours ? `${sauna.duration_hours}h` : '3-4h',
          features: ['Mobile Setup', 'Sauna & Cold Plunge', 'Recovery Experience', 'At Your Location'],
          timeSlot: 'Afternoon',
          image_url: sauna.image_url
        });
      }
    }

    const dayTheme = kind === 'friday' ? 'Friday Plan' : (kind === 'saturday' ? 'Saturday Plan' : 'Sunday Recovery');
    return { selectedServices: sel, dayTheme, logisticsNotes: '' };
  }
}