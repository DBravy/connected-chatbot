export const PHASES = {
  GATHERING: 'gathering',    // Collect basic requirements
  PLANNING: 'planning',      // Search services and build options day-by-day
  STANDBY: 'standby'        // All days planned, ready for modifications and questions
};

export const FIELD_STATUS = {
  UNKNOWN: 'unknown',
  SUGGESTED: 'suggested',    // Model proposed this
  ASSUMED: 'assumed',        // Model inferred this
  SET: 'set',               // User confirmed this
  CORRECTED: 'corrected'    // User corrected previous value
};

// Define which facts are essential vs optional
export const FACT_PRIORITY = {
  ESSENTIAL: 'essential',    // Must have to proceed to planning
  HELPFUL: 'helpful',       // Nice to have but not required - should ask about these
  OPTIONAL: 'optional'      // Don't persist if user doesn't answer
};

export const createNewConversation = (userId = null) => ({
  id: crypto.randomUUID(),
  userId,
  phase: PHASES.GATHERING,

  dayByDayPlanning: {
      currentDay: 0,          // Which day we're currently planning (0-indexed)
      totalDays: 0,           // Total number of days in the trip
      completedDays: [],      // Array of completed day plans
      usedServices: new Set(), // Track service IDs used across all days - NEW
      isComplete: false       // Have we finished planning all days?
    },
  
  standby: {
    nudgesSent: 0,
    lastTemplate: null
  },

  // Each fact has value, status, confidence (0-1), provenance (source text), and priority
  facts: {
    // ESSENTIAL - Must have to proceed
    destination: { 
      value: null, 
      status: FIELD_STATUS.UNKNOWN, 
      confidence: 0, 
      provenance: null,
      priority: FACT_PRIORITY.ESSENTIAL
    },
    groupSize: { 
      value: null, 
      status: FIELD_STATUS.UNKNOWN, 
      confidence: 0, 
      provenance: null,
      priority: FACT_PRIORITY.ESSENTIAL
    },
    startDate: { 
      value: null, 
      status: FIELD_STATUS.UNKNOWN, 
      confidence: 0, 
      provenance: null,
      priority: FACT_PRIORITY.ESSENTIAL
    },
    endDate: { 
      value: null, 
      status: FIELD_STATUS.UNKNOWN, 
      confidence: 0, 
      provenance: null,
      priority: FACT_PRIORITY.ESSENTIAL
    },
    
    // HELPFUL - Should ask about these before transitioning to planning
    wildnessLevel: { 
      value: null, 
      status: FIELD_STATUS.UNKNOWN, 
      confidence: 0, 
      provenance: null,
      priority: FACT_PRIORITY.HELPFUL
    },
    relationship: { 
      value: null, 
      status: FIELD_STATUS.UNKNOWN, 
      confidence: 0, 
      provenance: null,
      priority: FACT_PRIORITY.HELPFUL
    },
    interestedActivities: { 
      value: [], 
      status: FIELD_STATUS.UNKNOWN, 
      confidence: 0, 
      provenance: null,
      priority: FACT_PRIORITY.HELPFUL
    },
    ageRange: { 
      value: null, 
      status: FIELD_STATUS.UNKNOWN, 
      confidence: 0, 
      provenance: null,
      priority: FACT_PRIORITY.HELPFUL
    },
    budget: { 
      value: null, 
      status: FIELD_STATUS.UNKNOWN, 
      confidence: 0, 
      provenance: null,
      priority: FACT_PRIORITY.HELPFUL
    }
  },
  
  // Services from database
  availableServices: [],
  selectedServices: {},
  
  messages: [
    { 
      role: 'assistant', 
      content: "Welcome to Connected. Where are you planning to have your bachelor party?", 
      timestamp: new Date().toISOString() 
    }
  ],
  
  createdAt: new Date().toISOString()
});