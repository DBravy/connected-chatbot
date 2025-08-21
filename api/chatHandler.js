import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { PHASES, FIELD_STATUS, FACT_PRIORITY, createNewConversation } from './conversationState.js';
import { AIServiceSelector } from './aiServiceSelector.js';
import { AIResponseGenerator } from './aiResponseGenerator.js';
import { globalConversations } from './globalState.js';

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
      reason: s.reason || 'Kept from earlier plan.'
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
      this.conversations.set(conversationId, newConv);
      return newConv;
    }
    return this.conversations.get(conversationId);
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
      itinerary: conversation.selectedServices
        ? this.formatItineraryForFrontend(conversation.selectedServices, conversation.facts)
        : null,
      snapshot
    };
  }
  // <<< END DEV SHORTCUTS >>>
    
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
      
      if (newPhase === PHASES.PLANNING) {
        if (phaseChanged) {
          // Just transitioned to planning - search services and generate itinerary
          await this.searchServicesForConversation(conversation);
          finalResponse = await this.generateItineraryPresentation(conversation);
        } else if (conversation.availableServices.length > 0) {
          // Already in planning phase with services - handle user feedback on itinerary
          const planningResult = await this.handlePlanningMode(conversation, userMessage, reduction);
          finalResponse = planningResult.response;
          newPhase = planningResult.newPhase;
          conversation.phase = newPhase;
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
    
    return {
      response: finalResponse,
      phase: newPhase,
      facts: conversation.facts,
      assumptions: reduction?.assumptions || [],
      itinerary: conversation.selectedServices ? this.formatItineraryForFrontend(conversation.selectedServices, conversation.facts) : null,
      snapshot
    };
  }
  

  // Core LLM reducer - single point of intelligence
// MODIFY the reduceState method in chatHandler.js around line 400
async reduceState(conversation, userMessage) {
  const currentFacts = this.serializeFacts(conversation.facts);
  const recentMessages = conversation.messages.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
  const currentYear = new Date().getFullYear();
  
  // Check if we're in planning mode with an active day
  const isInPlanningWithActiveDay = conversation.phase === 'planning' && 
    conversation.dayByDayPlanning?.currentDayPlan?.selectedServices?.length > 0;
  
  const planningContext = isInPlanningWithActiveDay ? `
  
  CURRENT DAY PLANNING CONTEXT:
  - Currently planning Day ${(conversation.dayByDayPlanning.currentDay || 0) + 1}
  - Current day has ${conversation.dayByDayPlanning.currentDayPlan.selectedServices.length} services selected:
  ${conversation.dayByDayPlanning.currentDayPlan.selectedServices.map(s => 
    `  * ${s.serviceName} (${s.timeSlot})`
  ).join('\n')}
  ` : '';
  
  const reducerPrompt = `You are a bachelor party planning assistant. Your job is to update facts and generate a conversational response.

  CURRENT YEAR: ${currentYear}
  CURRENT PHASE: ${conversation.phase}
  CURRENT FACTS: ${currentFacts}
  RECENT CONVERSATION:
  ${recentMessages}
  ${planningContext}
  
  USER MESSAGE: "${userMessage}"
  
  ${conversation.phase === 'planning' ? `
  PLANNING PHASE INTENT CLASSIFICATION:
  When in planning phase, classify user intent precisely:
  
  - "approval_next": User wants to approve current day and move to next day
    Examples: "sounds good", "yes", "let's move on", "ready for day 2", "next day", "continue"

  - "show_day": User wants to view/work on a SPECIFIC day (mentions day number/weekday/date)
    Examples: "go to day 2", "show me Friday", "let's plan Sept 5", "can we do day one now?"
    
  - "substitution": User wants to swap/replace something in current day  
    Examples: "gentlemen's club instead of nightclub", "swap the restaurant", "change dinner to steakhouse"
    
  - "addition": User wants to add something new to current day
    Examples: "add golf", "can we include", "also book"
    
  - "removal": User wants to remove something from current day  
    Examples: "skip the dinner", "remove the club", "don't need transportation"
    
  - "general_question": User asking for info/details
    Examples: "what time does it start", "how much does it cost", "where is this located"
    
  SUBSTITUTION RESPONSE GUIDELINES:
  If intent is "substitution":
  - Generate a natural, brief confirmation (like "Perfect! Swapped that for a gentlemen's club.")
  - Include what was changed and what it was changed to
  - End with appropriate transition question (next day if last day, otherwise ask for approval)
  - Keep response under 25 words
  - Be conversational, not robotic
  ` : ''}
  
  DATE HANDLING RULES:
  - Always convert concrete dates to YYYY-MM-DD.
  - RANGES like "September 5–7": set startDate="YYYY-09-05", endDate="YYYY-09-07".
  - SINGLE SPECIFIC DAY like "September 6": set startDate="YYYY-09-06", leave endDate null; do NOT assume duration.
  - VAGUE MONTH ONLY (e.g., "sometime in September", "September", "early September"):
      * DO NOT set startDate or endDate yet.
      * Ask a narrowing question first, e.g.:
        - "Are you thinking early, mid, or late September?"
        - If they say "weekend," offer 2–3 concrete Fri–Sun options with exact dates for that year.
        - If they say "weekday," ask for a 2–3 day window with exact dates.
      * Only once the user picks a specific day or range, set startDate/endDate.
  - PARTIAL like "5th to 7th": anchor to the already-known month/year; otherwise ask which month.
  - DURATION QUESTION ("one night or a whole weekend?") is asked ONLY after:
      * the user gave a single specific day (startDate set, endDate null), OR
      * they're hesitating between day vs weekend after you present specific date options.
   
  FACT PRIORITIES:
  - ESSENTIAL (must have): destination, groupSize, startDate, endDate
  - HELPFUL (should ask about): wildnessLevel, relationship, interestedActivities, ageRange, budget
  - OPTIONAL (don't persist): none currently
  
  CONVERSATION RULES:
  1. ASK ONLY ONE QUESTION at a time (max 2 if closely related)
  2. Get ESSENTIAL facts first, then ask about HELPFUL facts before transitioning to planning
  3. If user provides only a start date, ask about duration/end date next
  4. For HELPFUL facts: if user says "whatever you think is best" or "I don't care", set status to "set" with a reasonable default
  5. For OPTIONAL facts: if user doesn't answer or shows disinterest, don't keep asking
  6. Be conversational and natural, not robotic or overwhelming
  7. CRITICAL: Only set safe_transition to TRUE when you have ALL essential facts AND have asked about ALL helpful facts
  
  HELPFUL FACTS TO ASK ABOUT:
  - wildnessLevel: "How crazy do you want this to get? Scale of 1-5 where 1 is classy dinner and 5 is absolutely debaucherous?"
  - relationship: "How do you all know each other? College buddies, work friends, family?"
  - interestedActivities: "Anything specific you guys want to do? Strip clubs, golf, boat parties, extreme sports?"
  - ageRange: "What's the age range of the group?"
  - budget: "What's your budget looking like? Total for the group or per person?"

  INTENT CLASSIFICATION PRIORITY RULES:
  1. APPROVAL_NEXT takes priority when:
    - User expresses approval/satisfaction ("sounds good", "perfect", "great", "yes", "let's go")
    - AND mentions current day OR no specific different day
    - AND shows readiness to continue ("ready for", "let's move", "next", "continue")
    
  2. SHOW_DAY only when:
    - User explicitly wants to NAVIGATE to a different day ("go to day 2", "show me Friday", "let's plan day 3")
    - OR asks to REVIEW a specific day ("what's on day 2", "tell me about Friday")
    - AND is NOT expressing approval of current plan

  EXAMPLES OF APPROVAL_NEXT (even with day mentions):
  - "Day 1 sounds great, ready for day 2"
  - "Perfect for day 1, let's continue" 
  - "Day 1 looks good, what's next?"
  - "Sounds good" (no day reference)
  - "Yes, let's move to day 2"

  EXAMPLES OF SHOW_DAY:
  - "Go to day 2" (navigation without approval)
  - "Show me what you have for Friday"
  - "Let's work on day 3 now"
  - "Can we plan day 2?" (without approving current)

  DAY REFERENCE EXTRACTION:
  - If intent_type="show_day", extract target_day_index from the specific day mentioned
  - If intent_type="approval_next", set target_day_index=null (system will auto-advance)
  - Current day context: Day ${(conversation.dayByDayPlanning?.currentDay || 0) + 1}
  
  DURATION HANDLING:
  - If user provides only a start date, ask about duration: "Is this a one-night party or are you thinking a whole weekend? When do you want it to end?"
  - If user says "one night" or "just Saturday", set endDate same as startDate
  - If user says "weekend" with Saturday start, set endDate to Sunday
  
  PLANNING TRANSITION TRIGGERS (only after asking about helpful facts):
  - User says "that's why I'm here" when asked about activities
  - User expresses "we just want to party/get drunk/have fun" 
  - User asks "what do you suggest" or similar
  - User seems done with questions and ready for recommendations
  - You have ALL essential facts SET AND have asked about ALL helpful facts
  
  BUDGET HANDLING:
  - If user says "I don't think we know yet", "we haven't decided", "not sure", etc:
  - Set budget.status to "set" 
  - Set budget.value to "flexible" or "to be determined"
  - Mark this as ADDRESSED and don't ask again
  
  ASSUMPTION TAGS (REQUIRED):
  - Always include at least one of: ["approval", "next", "modification", "preference", "different", "substitution"] in the assumptions array.

  Return a JSON object with:
  1. facts: Object with any fact updates (dates in YYYY-MM-DD format)
  2. assumptions: Array of things you believe but aren't certain about  
  3. blocking_questions: Array of what's still needed (focus on ESSENTIAL and HELPFUL facts)
  4. safe_transition: boolean - can we move to planning phase? (only true if all essentials SET and all helpfuls addressed)
  5. reply: Conversational response with ONE question max
  6. intent_type: string - ${conversation.phase === 'planning' ? '"approval_next", "substitution", "addition", "removal", or "general_question"' : '"edit_itinerary", "general_question", or "approval_next"'}
  7. substitution_details: object (only if intent_type is "substitution") with:
     - what_changed: string describing what was swapped
     - changed_from: string describing the original item  
     - changed_to: string describing the new item`;

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

  try {
    const response = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are an expert bachelor party planner with intelligent intent classification. Return proper JSON with intent_type classification." },
        { role: "user", content: reducerPrompt }
      ],
      functions: [reducerFunction],
      function_call: { name: "reduce_state" },
      temperature: 0.3,
      max_tokens: 1000
    });

    const functionCall = response.choices[0].message.function_call;
    if (functionCall) {
      const result = JSON.parse(functionCall.arguments);
      
      // Process dates to ensure consistent format
      if (result.facts.startDate && result.facts.startDate.value) {
        result.facts.startDate.value = this.parseUserDate(result.facts.startDate.value);
      }
      
      if (result.facts.endDate && result.facts.endDate.value) {
        result.facts.endDate.value = this.parseUserDate(result.facts.endDate.value);
      }
      
      return result;
    }
  } catch (error) {
    console.error('Error in LLM reducer:', error);
  }

  // Fallback response
  return {
    facts: {},
    assumptions: [],
    blocking_questions: ["I need more information to help plan your trip"],
    safe_transition: false,
    reply: "Tell me more about what you're looking for and I'll help you plan an amazing bachelor party!",
    intent_type: "general_question"
  };
}

  // Update conversation facts based on LLM output
  updateConversationFacts(conversation, factUpdates) {
    Object.entries(factUpdates).forEach(([key, update]) => {
      if (conversation.facts[key] && update) {
        const currentFact = conversation.facts[key];
        
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
    wildnessLevel: facts.wildnessLevel?.value || 3,
    budget: facts.budget?.value,
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
        wildnessLevel: conversationData.facts.wildnessLevel?.value || 3,
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
        wildnessLevel: conversationData.wildnessLevel || 3,
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

  async generateItinerary(conversationData) {
    try {
      console.log('Ã°Å¸Å½Â¯ Generating AI-powered itinerary...');
      
      const userPreferences = this.transformConversationData(conversationData)
      // Get ALL available services (not just 5 types)
      const allServices = await this.searchAvailableServices(
        userPreferences.destination,
        userPreferences.groupSize,
        userPreferences
      );
      
      // Enhance with keyword-based services
      const enhancedServices = await this.enhanceServicesWithKeywords(
        allServices, 
        userPreferences
      );
      
      console.log(`Ã°Å¸" Found ${enhancedServices.length} total services to choose from`);
      
      // Group services by category for analysis
      const servicesByCategory = this.groupServicesByCategory(enhancedServices);
      console.log('Ã°Å¸" Services by category:', Object.keys(servicesByCategory).map(cat => 
        `${cat}: ${servicesByCategory[cat].length}`
      ).join(', '));

      // Generate each day using AI
      const itinerary = [];
      for (let day = 1; day <= userPreferences.duration; day++) {
        const dayInfo = {
          dayNumber: day,
          totalDays: userPreferences.duration,
          timeSlots: this.getTimeSlotsForDay(day, userPreferences.duration),
          isFirstDay: day === 1,
          isLastDay: day === userPreferences.duration
        };

        // AI selects optimal services for this day
        const dayPlan = await this.aiSelector.selectOptimalServices(
          enhancedServices,
          userPreferences,
          dayInfo
        );

        // AI generates engaging response text
        const responseText = await this.aiResponseGenerator.generateItineraryResponse(
          dayPlan,
          dayInfo,
          userPreferences
        );

        itinerary.push({
          day: day,
          date: this.formatDate(userPreferences.startDate, day - 1),
          plan: dayPlan,
          responseText: responseText,
          services: dayPlan.selectedServices || [],
          alternatives: dayPlan.alternativeOptions || []
        });
        
        // Only plan one day at a time for now
        if (day === 1) break;
      }

      return {
        success: true,
        itinerary: itinerary,
        totalServices: enhancedServices.length,
        categoriesAvailable: Object.keys(servicesByCategory)
      };

    } catch (error) {
      console.error('Error generating itinerary:', error);
      return {
        success: false,
        error: error.message,
        fallback: "Let me manually put together some options for you..."
      };
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
  
    // From GATHERING to PLANNING
    if (conversation.phase === PHASES.GATHERING) {
      // Essentials must be set to ever leave gathering
      const essentialFactsSet = [
        facts.destination.status === FIELD_STATUS.SET,
        facts.groupSize.status === FIELD_STATUS.SET,
        facts.startDate.status === FIELD_STATUS.SET,
        facts.endDate.status === FIELD_STATUS.SET
      ];
    
      if (!essentialFactsSet.every(Boolean)) {
        return conversation.phase;
      }
    
      // If the reducer says it's safe (it has asked about helpfuls), proceed.
      if (reduction?.safe_transition === true) {
        return PHASES.PLANNING;
      }
    
      // Fallback: legacy stricter gate (kept for safety)
      const helpfulFactsAddressed = [
        facts.wildnessLevel.status !== FIELD_STATUS.UNKNOWN,
        facts.relationship.status !== FIELD_STATUS.UNKNOWN,
        facts.interestedActivities.status !== FIELD_STATUS.UNKNOWN,
        facts.ageRange.status !== FIELD_STATUS.UNKNOWN,
        facts.budget.status !== FIELD_STATUS.UNKNOWN
      ];
    
      return helpfulFactsAddressed.every(Boolean) ? PHASES.PLANNING : conversation.phase;
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

  // Generate and present day-by-day itinerary when transitioning to planning
  async generateItineraryPresentation(conversation) {
    const { facts } = conversation;
    
    try {
      console.log('ðŸŽ¯ Starting day-by-day itinerary generation...');
      
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
      
      console.log(`ðŸŽ¯ Planning Day 1 with ${allServices.length} available services`);
      
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
      conversation.dayByDayPlanning.currentDayPlan = dayPlan;
      
      // AI generates engaging response text for Day 1
      const responseText = await this.aiResponseGenerator.generateItineraryResponse(
        dayPlan,
        dayInfo,
        userPreferences
      );
      
      return responseText;
      
    } catch (error) {
      console.error('Error in AI itinerary presentation:', error);
      return this.fallbackItineraryPresentation(conversation);
    }
  }
  // New method to generate intelligent transition using LLM
  async generatePlanningTransition(conversation, firstDayName, totalDays) {
    const recentMessages = conversation.messages.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
    const facts = this.serializeFacts(conversation.facts);
    
    const transitionPrompt = `You are transitioning from gathering information to planning a bachelor party itinerary. 
  
  CONTEXT:
  - Recent conversation: ${recentMessages}
  - All gathered facts: ${facts}
  - Trip duration: ${totalDays} days
  - First day: ${firstDayName}
  
  Create a smooth, natural transition that:
  1. Briefly acknowledges the last piece of information gathered (if relevant)
  2. Shows enthusiasm about planning
  3. Smoothly introduces the day-by-day planning approach
  4. Feels conversational, not robotic
  
  Examples of good transitions:
  - "Perfect! 22-year-olds are gonna love what I have in mind. Let's map out your ${totalDays} days in Austin..."
  - "Got it! With that age group, we can definitely go all out. Here's how I'm thinking we structure your ${totalDays} days..."
  
  Keep it to 1-2 sentences max. Be enthusiastic and personalized to their situation.
  
  Return just the transition text, nothing else.`;
  
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are an expert bachelor party planner creating smooth conversational transitions." },
          { role: "user", content: transitionPrompt }
        ],
        temperature: 0.7,
        max_tokens: 100
      });
  
      const transition = response.choices[0].message.content.trim();
      return transition + "\n\n";
      
    } catch (error) {
      console.error('Error generating transition:', error);
      // Fallback to a basic but slightly better template
      return `Perfect! Let's plan out your ${totalDays} ${totalDays === 1 ? 'day' : 'days'} step by step.\n\n`;
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
      if (isWeekend && services.nightclubs.length > 0 && wildnessLevel >= 4) {
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
      if (services.nightclubs.length > 0 && wildnessLevel >= 4) {
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
      presentation += `Ã¢â‚¬Â¢ ${activity.time}: ${activity.description}\n`;
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
    const response = await this.handleItineraryFeedback(conversation, userMessage, reduction);
    
    // Check if we just completed planning
    if (conversation.dayByDayPlanning?.isComplete) {
      return {
        response: response,
        newPhase: PHASES.STANDBY
      };
    }
    
    return {
      response: response,
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
    
    // Handle options-style questions during planning
    if (this.isOptionsStyleQuestion(userMessage)) {
      const scoped = await this.handleScopedOptionsRequest(conversation, userMessage);
      if (scoped) return scoped;
    }
    
    // Use the enhanced reducer's intent classification
    const intentType = reduction.intent_type;
    
    // 1) Handle approvals/next-day requests
    if (intentType === 'approval_next') {

      const currentDayIndex = dayByDayPlanning.currentDay || 0;
      const targetIndex = this.resolveTargetDayIndex(userMessage, conversation, null, reduction);
      
      // Approval keywords (keep broad but safe)
      const hasApprovalWords = /\b(yes|yep|yeah|sure|ok(?:ay)?|cool|perfect|great|works|approved|approve|sounds good|looks good|good to me|let'?s go|go ahead)\b/i.test(userMessage);
      
      // Phrases that indicate explicit navigation to a specific day
      const explicitNavigate = /\b(go to|show(?: me)?|switch(?: to)?|work on|plan|open)\b/i.test(userMessage);
      
      // Only treat as navigation if:
      //  - they *aren’t* approving, and
      //  - they’re explicitly navigating OR they referenced a *different* day than the current one.
      const wantsNavigation = !hasApprovalWords && (
        explicitNavigate ||
        (targetIndex != null && targetIndex !== currentDayIndex)
      );
      
      if (wantsNavigation) {
        return await this.handleItineraryFeedback(conversation, userMessage, {
          ...reduction,
          intent_type: 'show_day',
          target_day_index: targetIndex
        });
      }

      const nextDayIndex = currentDayIndex + 1;
  
      // Persist current day
      const totalDays = dayByDayPlanning.totalDays || this.calculateDuration(
        conversation.facts.startDate?.value, conversation.facts.endDate?.value
      );
      
      if (dayByDayPlanning.currentDayPlan) {
        if (!Array.isArray(dayByDayPlanning.completedDays)) dayByDayPlanning.completedDays = [];
        const available = conversation.availableServices || [];
        const enrichedSelected = (dayByDayPlanning.currentDayPlan.selectedServices || []).map((item) => {
          const match = available.find((s) => String(s.id) === String(item.serviceId));
          return {
            ...item,
            price_cad: match?.price_cad ?? null,
            price_usd: match?.price_usd ?? null,
          };
        });
        
        // Track used services
        this.trackUsedServices(conversation, enrichedSelected);
        
        dayByDayPlanning.completedDays[currentDayIndex] = {
          dayNumber: currentDayIndex + 1,
          selectedServices: enrichedSelected,
          dayTheme: dayByDayPlanning.currentDayPlan.dayTheme || '',
          logisticsNotes: dayByDayPlanning.currentDayPlan.logisticsNotes || ''
        };
        if (!Array.isArray(conversation.selectedServices)) conversation.selectedServices = [];
        conversation.selectedServices[currentDayIndex] = dayByDayPlanning.completedDays[currentDayIndex];
      }
  
      if (nextDayIndex >= totalDays) {
        // Mark planning complete - will transition to STANDBY phase in handlePlanningMode
        dayByDayPlanning.isComplete = true;
        return this.generateAllDaysScheduledMessage(conversation);
      }
  
      // Plan next day
      dayByDayPlanning.currentDay = nextDayIndex;
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
          {
            usedServices: usedServicesContext,
            allowRepeats: false,
            userExplicitRequest: null
          }
        );
        
        dayByDayPlanning.currentDayPlan = dayPlan;
        return await this.aiResponseGenerator.generateItineraryResponse(dayPlan, dayInfo, userPreferences);
      } catch {
        return `Awesome! Let's plan day ${nextDayIndex + 1}. I'm putting together some epic options for you guys!`;
      }
    }

    if (intentType === 'show_day') {
      const userPreferences = this.transformConversationFacts(conversation.facts);
      const allServices = conversation.availableServices || [];
      const usedServicesContext = this.getUsedServicesContext(conversation);
    
      const totalDays = conversation.dayByDayPlanning.totalDays || this.calculateDuration(
        conversation.facts.startDate?.value, conversation.facts.endDate?.value
      );
    
      // Resolve target day from reduction or parse basic patterns
      const resolveIndex = () => {
        const txt = String(userMessage || '').toLowerCase();
        if (Number.isInteger(reduction?.target_day_index)) return reduction.target_day_index;
    
        // "day X"
        let m = txt.match(/\bday\s*(\d{1,2})\b/);
        if (m) { const n = Number(m[1]) - 1; if (n >= 0 && n < totalDays) return n; }
    
        // weekdays → compute from trip start
        const start = this.toLocalDate(conversation.facts.startDate?.value);
        if (start) {
          const wd = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
          for (let i=0;i<totalDays;i++){
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate()+i);
            if (txt.includes(wd[d.getDay()])) return i;
          }
        }
    
        // fallback: current day
        return (conversation.dayByDayPlanning.currentDay || 0);
      };
    
      const targetIndex = resolveIndex();
      const currentIndex = conversation.dayByDayPlanning.currentDay || 0;
    
      // If they asked for the current day, just (re)present it
      if (targetIndex === currentIndex && conversation.dayByDayPlanning.currentDayPlan) {
        const dayInfo = {
          dayNumber: currentIndex + 1,
          totalDays,
          timeSlots: this.getTimeSlotsForDay(currentIndex + 1, totalDays),
          isFirstDay: currentIndex === 0,
          isLastDay: currentIndex + 1 === totalDays
        };
        return await this.aiResponseGenerator.generateItineraryResponse(
          conversation.dayByDayPlanning.currentDayPlan,
          dayInfo,
          userPreferences
        );
      }
    
      // Navigate to a different planning day WITHOUT approving anything
      // Optional: stash the current plan into drafts so you don't lose it
      conversation.dayByDayPlanning.drafts = conversation.dayByDayPlanning.drafts || {};
      if (conversation.dayByDayPlanning.currentDayPlan) {
        conversation.dayByDayPlanning.drafts[currentIndex] = this.deepClone(conversation.dayByDayPlanning.currentDayPlan);
      }
    
      conversation.dayByDayPlanning.currentDay = targetIndex;
    
      // If we already have a draft for that day, load it; else build a fresh plan
      let nextPlan = conversation.dayByDayPlanning.drafts[targetIndex];
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
        } catch {
          nextPlan = { selectedServices: [] };
        }
      }
    
      conversation.dayByDayPlanning.currentDayPlan = nextPlan;
    
      const dayInfo = {
        dayNumber: targetIndex + 1,
        totalDays,
        timeSlots: this.getTimeSlotsForDay(targetIndex + 1, totalDays),
        isFirstDay: targetIndex === 0,
        isLastDay: targetIndex + 1 === totalDays
      };
      return await this.aiResponseGenerator.generateItineraryResponse(nextPlan, dayInfo, userPreferences);
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
            price_cad: match?.price_cad ?? null,
            price_usd: match?.price_usd ?? null
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
    
      // Friendly confirmation that calls out the right day
      const weekNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      let dayLabel = `Day ${targetDayIndex + 1}`;
      const start = this.toLocalDate(conversation.facts.startDate?.value);
      if (start) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + targetDayIndex, 12, 0, 0);
        dayLabel = `${weekNames[d.getDay()]} (Day ${targetDayIndex + 1})`;
      }
    
      return `Done — updated ${dayLabel}. Want to keep planning Day ${Math.max(dayByDayPlanning.currentDay || 0, 0) + 1}, or review anything else?`;
    }
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
    
    // Add appropriate follow-up based on whether this is the last day
    const followUps = isLastDay ? [
      " Your itinerary is updated.",
      " Want any other tweaks?",
      " Does this work?",
      " Sound good?"
    ] : [
      " Ready for Day " + (dayNumber + 1) + "?",
      " Let's plan Day " + (dayNumber + 1) + "?",
      " Sound good to move to Day " + (dayNumber + 1) + "?",
      " Want to plan Day " + (dayNumber + 1) + " now?"
    ];
    
    // Rotate through different confirmations to avoid repetition
    const baseIndex = Math.floor(Math.random() * baseConfirmations.length);
    const followIndex = Math.floor(Math.random() * followUps.length);
    
    return baseConfirmations[baseIndex] + followUps[followIndex];
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
    
    const questionPrompt = `You are Connected, a professional bachelor party planner. Answer the user's question using all the context provided.
  
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
  
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { 
            role: "system", 
            content: "You are Connected, a bachelor party planning assistant. Answer questions directly using the provided context. Be helpful and conversational."
          },
          { role: "user", content: questionPrompt }
        ],
        temperature: 0.6,
        max_tokens: 400
      });
  
      return response.choices[0].message.content;
    } catch (error) {
      console.error('Error handling general question:', error);
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
  - Wildness Level: ${facts.wildnessLevel?.value || 3}/5
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
      `  - ${s.timeSlot}: ${s.serviceName}${s.price_cad ? ` ($${s.price_cad} CAD)` : ''}${s.estimatedDuration ? ` - ${s.estimatedDuration}` : ''}`
    ).join('\n');
    return `Day ${day.dayNumber}:\n${serviceList || '  - No services selected'}`;
  }).join('\n\n')}` : '\nCURRENT ITINERARY: No itinerary planned yet';
  
    // Format available services by category
    const servicesByCategory = this.groupServicesByCategory(availableServices);
    const servicesInfo = Object.keys(servicesByCategory).length > 0 ? `
  AVAILABLE SERVICES BY CATEGORY:
  ${Object.entries(servicesByCategory).map(([category, services]) => {
    const serviceList = services.slice(0, 8).map(s => // Limit to first 8 per category to avoid overwhelming
      `  - ${s.name}${s.price_cad ? ` ($${s.price_cad} CAD)` : ''}${s.duration_hours ? ` - ${s.duration_hours}h` : ''}${s.description ? ` - ${s.description.slice(0, 80)}...` : ''}`
    ).join('\n');
    return `${category.toUpperCase()} (${services.length} total):\n${serviceList}${services.length > 8 ? '\n  - ... and more options available' : ''}`;
  }).join('\n\n')}` : '\nAVAILABLE SERVICES: No services loaded';
  
    return `${basicInfo}\n${itineraryInfo}\n${servicesInfo}`;
  }

  describeItineraryAtAGlance(conversation) {
    const { facts } = conversation;
    const itinerary = Array.isArray(conversation.selectedServices) ? conversation.selectedServices : [];
    const formatDate = (iso) => {
      if (!iso) return null;
      const d = /^\d{4}-\d{2}-\d{2}$/.test(iso)
        ? new Date(+iso.slice(0,4), +iso.slice(5,7)-1, +iso.slice(8,10), 12, 0, 0)
        : new Date(iso);
      const includeYear = d.getFullYear() > new Date().getFullYear();
      const base = { weekday: 'short', month: 'short', day: 'numeric' };
      return d.toLocaleDateString('en-US', includeYear ? { ...base, year: 'numeric' } : base);
    };
    const start = facts.startDate?.value ? new Date(facts.startDate.value) : null;
  
    const dayLabel = (i) => {
      if (!start) return `Day ${i + 1}`;
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    };
  
    const prettySlot = (s) => ({afternoon:'Afternoon', evening:'Evening', night:'Night', late_night:'Late Night'})[s] || s;
  
    let text = `Here's the plan at a glance${formatDate(facts.startDate?.value) ? ` (starting ${formatDate(facts.startDate.value)})` : ''}:\n`;
    itinerary.forEach((day, i) => {
      const entries = (day?.selectedServices || []).map(s => `${prettySlot(s.timeSlot)}: ${s.serviceName}`).join(', ');
      text += `\n• ${dayLabel(i)} — ${entries || 'TBD'}`;
    });
    text += `\n\nAsk away—timing, prices, swaps—whatever you want to adjust.`;
    return text;
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
                  target_service_id: { type: "string", nullable: true }, // NEW: for specific service targeting
                  // payload
                  keywords: { type: "array", items: { type: "string" }, nullable: true },
                  category_hint: { type: "string", nullable: true },
                  new_time: { type: "string", enum: ["afternoon","evening","night","late_night"], nullable: true },
                  new_service_name: { type: "string", nullable: true }, // NEW: for substitutions
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
  - Wildness level: ${userPreferences.wildnessLevel || userPreferences.facts?.wildnessLevel?.value || 3}/5
  - Known requests: ${userPreferences.specialRequests || userPreferences.interestedActivities?.join(', ') || '—'}
  
  SUBSTITUTION DETECTION:
  - If user says "X instead of Y", use "substitute_service" op
  - If user says "just do the [service name]", check if it replaces an existing similar service
  - Look for phrases like "swap", "change to", "instead", "rather than"
  
  Example substitutions:
  - "club access instead of bottle service" â†' substitute_service with target_name="bottle service", new_service_name="club access"
  - "just do the basic entry" â†' substitute_service if there's currently a premium service
  
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
          summary += `Ã¢â‚¬Â¢ Epic ${destination} bachelor party activities\n`;
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
  if ((wildnessLevel >= 4 && buckets.stripclubs.length) || (!buckets.nightclubs.length && buckets.stripclubs.length)) {
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
      scoreA += (a.price_cad || 0) * 0.01;
      scoreB += (b.price_cad || 0) * 0.01;
      
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
    console.log(`Ã°Å¸" Searching services for ${destination}, ${groupSize} people...`);
    
    // Get ALL service types available in the database
    const allServiceTypes = [
      'Restaurant', 'Bar', 'Night Club', 'Daytime', 'Transportation',
      'Strip Club', 'Package', 'Catering', 'Accommodation'
    ];
    
    const allServices = [];
    
    for (const serviceType of allServiceTypes) {
      const services = await this.searchServices({
        city_name: destination,
        service_type: serviceType,
        group_size: groupSize,
        max_results: 10
      });
      
      if (services.services && services.services.length > 0) {
        for (const s of services.services) {
          allServices.push({
            ...s,
            category: serviceType.toLowerCase().replace(/\s+/g, '_')
          });
        }
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
      return [];
    }
    
    try {
      console.log(`Ã°Å¸" Searching for services in ${destination} for ${groupSize} people...`);
      
      // Get ALL service types available in the database
      const allServiceTypes = [
        'Restaurant', 'Bar', 'Night Club', 'Daytime', 'Transportation',
        'Strip Club', 'Package', 'Catering', 'Accommodation'
      ];
      
      const allServices = [];
      
      for (const serviceType of allServiceTypes) {
        const services = await this.searchServices({
          city_name: destination,
          service_type: serviceType,
          group_size: groupSize,
          max_results: 10
        });
        
        if (services.services && services.services.length > 0) {
          allServices.push(...services.services.map(s => ({ 
            ...s, 
            category: serviceType.toLowerCase().replace(' ', '_')
          })));
        }
      }
      
      // Enhance with keyword-based services
      const userPreferences = this.transformConversationFacts(facts);
      const enhancedServices = await this.enhanceServicesWithKeywords(allServices, userPreferences);
      
      // Store in conversation for later use
      conversation.availableServices = enhancedServices;
      
      console.log(`Ã¢Å" Found ${enhancedServices.length} total services for conversation`);
      
      // Group by category for logging
      const servicesByCategory = this.groupServicesByCategory(enhancedServices);
      console.log('Ã°Å¸" Services by category:', Object.keys(servicesByCategory).map(cat => 
        `${cat}: ${servicesByCategory[cat].length}`
      ).join(', '));
      
      return enhancedServices;
      
    } catch (error) {
      console.error('Error searching services for conversation:', error);
      conversation.availableServices = [];
      return [];
    }
  }

  async enhanceServicesWithKeywords(services, userPreferences) {
    // Extract keywords from user messages
    const keywords = this.extractKeywords(userPreferences);
    
    // Search for services matching specific keywords
    const keywordServices = [];
    for (const keyword of keywords) {
      const results = await this.searchServicesByKeyword({
        keyword: keyword,
        city_name: userPreferences.destination
      });
      
      if (results.services) {
        keywordServices.push(...results.services);
      }
    }
    
    // Merge and deduplicate services
    const allServices = [...services, ...keywordServices];
    const uniqueServices = allServices.filter((service, index, self) => 
      index === self.findIndex(s => s.id === service.id)
    );
    
    return uniqueServices;
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

  async searchServices({ city_name, service_type, group_size, max_results = 10 }) {
    try {
      // Get city ID
      const { data: city, error: cityError } = await this.supabase
        .from('cities')
        .select('cit_id')
        .ilike('cit_name', city_name)
        .single();

      if (cityError || !city) {
        return { 
          error: `City "${city_name}" not found in our database`,
          available_cities: await this.getAvailableCityNames()
        };
      }

      // Search services
      let query = this.supabase
        .from('services')
        .select(`
          ser_id,
          ser_name,
          ser_type,
          ser_description,
          ser_itinerary_name,
          ser_itinerary_description,
          ser_default_price_cad,
          ser_default_price_usd,
          ser_duration_hrs,
          ser_show_in_app,
          ser_in_app_description
        `)
        .eq('ser_city_id', city.cit_id)
        .eq('ser_show_in_app', true);

      if (service_type) {
        query = query.eq('ser_type', service_type);
      }

      query = query.limit(max_results);
      const { data: services, error } = await query;
      
      if (error) throw error;
      
      return {
        city: city_name,
        total_results: services.length,
        services: services.map(service => ({
          id: service.ser_id,
          name: service.ser_name,
          type: service.ser_type,
          description: service.ser_description || service.ser_in_app_description,
          itinerary_name: service.ser_itinerary_name,
          itinerary_description: service.ser_itinerary_description,
          price_cad: service.ser_default_price_cad,
          price_usd: service.ser_default_price_usd,
          duration_hours: service.ser_duration_hrs
        }))
      };
    } catch (error) {
      console.error('Error searching services:', error);
      return { error: "Could not search services" };
    }
  }

  async getServiceDetails({ service_id }) {
    try {
      const { data: service, error } = await this.supabase
        .from('services')
        .select(`
          *,
          cities(cit_name)
        `)
        .eq('ser_id', service_id)
        .single();

      if (error || !service) {
        return { error: `Service with ID ${service_id} not found` };
      }

      return {
        id: service.ser_id,
        name: service.ser_name,
        type: service.ser_type,
        description: service.ser_description,
        in_app_description: service.ser_in_app_description,
        itinerary_name: service.ser_itinerary_name,
        itinerary_description: service.ser_itinerary_description,
        city: service.cities?.cit_name,
        pricing: {
          default_cad: service.ser_default_price_cad,
          minimum_cad: service.ser_minimum_price_cad,
          default_usd: service.ser_default_price_usd,
          minimum_usd: service.ser_minimum_price_usd,
          base_cad: service.ser_base_price_cad,
          additional_person_price: service.ser_additional_person_price
        },
        timing: {
          duration_hours: service.ser_duration_hrs,
          default_start_time: service.ser_default_start_time,
          earliest_start_time: service.ser_earliest_start_time,
          latest_start_time: service.ser_latest_start_time
        },
        logistics: {
          venue_booking_required: service.ser_venue_booking_required,
          contractor_booking_required: service.ser_contractor_booking_required,
          accommodation_address: service.ser_accomodation_address
        },
        image_url: service.ser_image_url
      };
    } catch (error) {
      console.error('Error getting service details:', error);
      return { error: "Could not get service details" };
    }
  }

  async searchServicesByKeyword({ keyword, city_name }) {
    try {
      let query = this.supabase
        .from('services')
        .select(`
          ser_id,
          ser_name,
          ser_type,
          ser_description,
          ser_itinerary_name,
          ser_default_price_cad,
          ser_show_in_app,
          cities(cit_name)
        `)
        .eq('ser_show_in_app', true);

      if (city_name) {
        const { data: city } = await this.supabase
          .from('cities')
          .select('cit_id')
          .ilike('cit_name', city_name)
          .single();
        
        if (city) {
          query = query.eq('ser_city_id', city.cit_id);
        }
      }

      query = query.or(`ser_name.ilike.%${keyword}%,ser_description.ilike.%${keyword}%,ser_itinerary_name.ilike.%${keyword}%`)
                   .limit(10);

      const { data: services, error } = await query;
      
      if (error) throw error;
      
      return {
        keyword,
        city: city_name || "all cities",
        total_results: services.length,
        services: services.map(service => ({
          id: service.ser_id,
          name: service.ser_name,
          type: service.ser_type,
          description: service.ser_description,
          itinerary_name: service.ser_itinerary_name,
          price_cad: service.ser_default_price_cad,
          city: service.cities?.cit_name
        }))
      };
    } catch (error) {
      console.error('Error searching by keyword:', error);
      return { error: "Could not search by keyword" };
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
                price_usd: service.price_usd ?? service.ser_default_price_usd ?? null
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
    const payload = options.map(o => ({
      id: o.id,
      name: o.name,
      category: o.category || o.type,
      price_cad: o.price_cad || null,
      price_usd: o.price_usd || null,
      duration_hours: o.duration_hours || null,
      blurb: (o.itinerary_description || o.description || '').slice(0, 160)
    }));
    try {
      const prompt = `You are Connected, a bachelor party planner. The user asked for options for category: ${intent.category}.
Destination: ${facts.destination}, group size: ${facts.groupSize}, wildness: ${facts.wildnessLevel}/5.
Options JSON: ${JSON.stringify(payload)}

Write a tight answer:
- Start with a one-line setup (e.g., "Top strip club picks in Austin for 8:")
- List 3-5 numbered options: name — 3-8 word vibe; include rough price if present
- Close with a single question to choose or refine vibe (high-energy vs. upscale), or ask which day/slot to place it
- Max ~120 words, no emojis.`;
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
        return `${i+1}) ${o.name}${price}`;
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
}