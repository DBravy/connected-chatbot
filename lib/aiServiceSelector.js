import OpenAI from 'openai';

export class AIServiceSelector {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  // UPDATED: Now accepts options parameter for deduplication context
  async selectOptimalServices(allServices, userPreferences, dayInfo, options = {}) {
    const {
      usedServices = [],
      allowRepeats = false,
      userExplicitRequest = null
    } = options;
    
    const prompt = this.buildSelectionPrompt(allServices, userPreferences, dayInfo, {
      usedServices,
      allowRepeats,
      userExplicitRequest
    });
    
    try {
      // Try using function calling for more reliable JSON
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `You are an expert bachelor party planner. Select the best services for this specific day based on user preferences, group dynamics, and optimal flow.`
          },
          {
            role: "user", 
            content: prompt
          }
        ],
        functions: [{
          name: "select_services",
          description: "Select optimal services for a bachelor party day",
          parameters: {
            type: "object",
            properties: {
              selectedServices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    serviceId: { type: "string" },
                    serviceName: { type: "string" },
                    timeSlot: { type: "string", enum: ["afternoon", "evening", "night", "late_night"] },
                    reason: { type: "string" },
                    estimatedDuration: { type: "string" },
                    groupSuitability: { type: "string" }
                  },
                  required: ["serviceId", "serviceName", "timeSlot", "reason"]
                }
              },
              alternativeOptions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    serviceId: { type: "string" },
                    serviceName: { type: "string" },
                    reason: { type: "string" }
                  },
                  required: ["serviceId", "serviceName", "reason"]
                }
              },
              dayTheme: { type: "string" },
              logisticsNotes: { type: "string" }
            },
            required: ["selectedServices", "dayTheme"]
          }
        }],
        function_call: { name: "select_services" },
        temperature: 0.7,
        max_tokens: 1500
      });

      const functionCall = response.choices[0].message.function_call;
      if (functionCall && functionCall.arguments) {
        const result = JSON.parse(functionCall.arguments);
        
        // Ensure the response has the expected structure
        return {
          selectedServices: result.selectedServices || [],
          alternativeOptions: result.alternativeOptions || [],
          dayTheme: result.dayTheme || 'Epic bachelor party day',
          logisticsNotes: result.logisticsNotes || ''
        };
      } else {
        throw new Error('No function call returned');
      }
      
    } catch (error) {
      console.error('AI selection error (function call):', error);
      
      // Fallback to regular completion if function calling fails
      try {
        console.log('Trying fallback completion method...');
        const response = await this.openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: `You are an expert bachelor party planner. You MUST respond with ONLY valid JSON - no markdown, no code blocks, no explanations. Return raw JSON only.`
            },
            {
              role: "user", 
              content: prompt
            }
          ],
          temperature: 0.7,
          max_tokens: 1500
        });

        let jsonContent = response.choices[0].message.content.trim();
        
        // Remove markdown code blocks if present
        if (jsonContent.startsWith('```')) {
          jsonContent = jsonContent.replace(/^```json?\s*/, '').replace(/```\s*$/, '');
        }
        
        // Clean up any remaining markdown artifacts
        jsonContent = jsonContent.replace(/^```\s*/, '').replace(/```\s*$/, '');
        
        console.log('Fallback raw AI response (first 200 chars):', jsonContent.substring(0, 200));
        
        const result = JSON.parse(jsonContent);
        
        return {
          selectedServices: result.selectedServices || [],
          alternativeOptions: result.alternativeOptions || [],
          dayTheme: result.dayTheme || 'Epic bachelor party day',
          logisticsNotes: result.logisticsNotes || ''
        };
        
      } catch (fallbackError) {
        console.error('Fallback completion also failed:', fallbackError);
        return this.fallbackSelection(allServices, userPreferences, dayInfo);
      }
    }
  }

  // UPDATED: Now accepts options for edit context
  async rewriteDayWithEdits(allServices, userPreferences, dayInfo, currentDayPlan, editDirectives, options = {}) {
    const {
      usedServices = [],
      allowRepeats = true, // Default to true for edits
      userExplicitRequest = null
    } = options;
    
    // Reuse the same JSON shape as selectOptimalServices
    const prompt = `
  You are editing DAY ${dayInfo.dayNumber} of a bachelor party itinerary.
  
  CURRENT PLAN:
  ${(currentDayPlan.selectedServices||[]).map(s => `- ${s.serviceName} (${s.timeSlot})`).join('\n') || '(none yet)'}
  
  USER PREFERENCES:
  - Destination: ${userPreferences.destination || userPreferences.facts?.destination?.value || 'Unknown'}
  - Group Size: ${userPreferences.groupSize || userPreferences.facts?.groupSize?.value || 8}
  - Wildness Level: ${userPreferences.wildnessLevel || userPreferences.facts?.wildnessLevel?.value || 3}/5
  - Special Requests: ${userPreferences.specialRequests || userPreferences.facts?.interestedActivities?.value?.join(', ') || userPreferences.interestedActivities?.join(', ') || 'None'}
  
  EDIT DIRECTIVES (apply faithfully, but keep a natural flow):
  ${JSON.stringify(editDirectives, null, 2)}
  
  USER REQUEST: "${userExplicitRequest || 'Edit request'}"
  
  SUBSTITUTION HANDLING:
  - If the directive is "substitute_service", find the target service and replace it with the new one
  - Keep the same time slot and flow unless specifically requested to change
  - Look for services that match the new_service_name in the available services
  - Prioritize exact name matches for substitutions
  
  ${this.buildDeduplicationSection(usedServices, allowRepeats, userExplicitRequest)}
  
  AVAILABLE SERVICES (you MUST select from these exact services):
  ${allServices.slice(0, 40).map(s =>
    `- ${s.id} | name="${s.name}" | itinerary_name="${s.itinerary_name || s.name}" | ${s.category || s.type} | ${s.duration_hours || 'flex'}h`
  ).join('\n')}

  Time slots to choose from: ${dayInfo.timeSlots.join(', ')}.

  CRITICAL RULES:
  1. For substitutions, match against name OR itinerary_name.
  2. When outputting serviceName, use itinerary_name if present; otherwise use name.
  3. Keep the same time slot as the original service unless requested otherwise.
  4. Use EXACT service IDs and names from the available services list.
  
  Return ONLY valid JSON with keys: selectedServices, alternativeOptions, dayTheme, logisticsNotes.
  `;
  
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are an expert bachelor party trip editor. Handle substitutions by finding exact service matches and preserving timing flow." },
          { role: "user", content: prompt }
        ],
        functions: [{
          name: "select_services",
          description: "Select optimal services for this day (rewritten with edits)",
          parameters: {
            type: "object",
            properties: {
              selectedServices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    serviceId: { type: "string" },
                    serviceName: { type: "string" },
                    timeSlot: { type: "string", enum: ["afternoon","evening","night","late_night"] },
                    reason: { type: "string" },
                    estimatedDuration: { type: "string" },
                    groupSuitability: { type: "string" }
                  },
                  required: ["serviceId","serviceName","timeSlot","reason"]
                }
              },
              alternativeOptions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    serviceId: { type: "string" },
                    serviceName: { type: "string" },
                    reason: { type: "string" }
                  },
                  required: ["serviceId","serviceName","reason"]
                }
              },
              dayTheme: { type: "string" },
              logisticsNotes: { type: "string" }
            },
            required: ["selectedServices","dayTheme"]
          }
        }],
        function_call: { name: "select_services" },
        temperature: 0.4,
        max_tokens: 1400
      });
  
      const call = response.choices?.[0]?.message?.function_call;
      if (!call?.arguments) throw new Error('No function call');
      const result = JSON.parse(call.arguments);
  
      return {
        selectedServices: result.selectedServices || [],
        alternativeOptions: result.alternativeOptions || [],
        dayTheme: result.dayTheme || 'Refined plan for the day',
        logisticsNotes: result.logisticsNotes || ''
      };
    } catch (err) {
      // If LLM rewrite fails, punt back to caller to apply locally
      throw err;
    }
  }

  // UPDATED: Now accepts options for deduplication context
  buildSelectionPrompt(allServices, userPreferences, dayInfo, options = {}) {
    const {
      usedServices = [],
      allowRepeats = false,
      userExplicitRequest = null
    } = options;
    
    // Handle both conversation data format and test data format
    const destination = userPreferences.destination || userPreferences.facts?.destination?.value || 'Unknown';
    const groupSize = userPreferences.groupSize || userPreferences.facts?.groupSize?.value || 8;
    const duration = userPreferences.duration || dayInfo.totalDays || 3;
    const wildnessLevel = userPreferences.wildnessLevel || userPreferences.facts?.wildnessLevel?.value || 3;
    const budget = userPreferences.budget || userPreferences.facts?.budget?.value || 'Not specified';
    const specialRequests = userPreferences.specialRequests || 
                           userPreferences.facts?.interestedActivities?.value?.join(', ') || 
                           userPreferences.interestedActivities?.join(', ') || 
                           'None';
  
    return `
  BACHELOR PARTY PLANNING TASK:
  - Destination: ${destination}
  - Group Size: ${groupSize} people
  - Duration: ${duration} days
  - Wildness Level: ${wildnessLevel}/5
  - Budget: ${budget}
  - Special Requests: ${specialRequests}
  - User Request: "${userExplicitRequest || 'Standard planning'}"
  
  CURRENT DAY: ${dayInfo.dayNumber} of ${duration}
  - Day Type: ${dayInfo.dayNumber === 1 ? 'Arrival day' : dayInfo.dayNumber === duration ? 'Final day' : 'Main party day'}
  - Time Slots to Fill: ${dayInfo.timeSlots.join(', ')}
  
  ${this.buildDeduplicationSection(usedServices, allowRepeats, userExplicitRequest)}
  
  AVAILABLE SERVICES (YOU MUST ONLY SELECT FROM THESE):
  ${allServices.map(service => `
  - ID: ${service.id}
  - Name: "${service.name}"
  - Category: ${service.category || service.type}
  - Description: ${(service.description || '').substring(0, 100)}
  - Price: ${service.price_cad || service.price_usd || 'TBD'} ${service.price_cad ? 'CAD' : 'USD'}
  - Duration: ${service.duration_hours || 'Flexible'} hours
  `).join('\n')}
  
  CRITICAL SELECTION RULES:
  1. You MUST ONLY use serviceId and serviceName from the AVAILABLE SERVICES list above
  2. DO NOT create, invent, or modify service names
  3. DO NOT use generic terms like "Strip Club" or "Bottle Service" - use exact names like "Gentlemen's Club Bottle Service"
  4. If the user requests "bottle service" and there's "Gentlemen's Club Bottle Service" available, select that exact service
  5. If the user requests "strip club" and there are gentlemen's club services available, select from those
  6. Match user requests to the closest available service by name and description
  7. NEVER hallucinate services that aren't in the list
  
  USER REQUEST MATCHING:
  ${userExplicitRequest ? `
  - User specifically requested: "${userExplicitRequest}"
  - Look for services that match this request in name or description
  - If user said "bottle service", find services with "bottle" in the name
  - If user said "strip club", find "gentlemen's club" or similar services
  ` : ''}
  
  RETURN FORMAT - EXACT JSON ONLY:
  {
    "selectedServices": [
      {
        "serviceId": "EXACT_ID_FROM_AVAILABLE_SERVICES",
        "serviceName": "EXACT_NAME_FROM_AVAILABLE_SERVICES", 
        "timeSlot": "afternoon|evening|night|late_night",
        "reason": "Why this exact service was selected",
        "estimatedDuration": "X hours",
        "groupSuitability": "How it works for ${groupSize} people"
      }
    ],
    "alternativeOptions": [
      {
        "serviceId": "EXACT_ID_FROM_AVAILABLE_SERVICES", 
        "serviceName": "EXACT_NAME_FROM_AVAILABLE_SERVICES",
        "reason": "Why this is a good alternative"
      }
    ],
    "dayTheme": "Brief description of this day's overall vibe",
    "logisticsNotes": "Any important timing or transportation considerations"
  }`;
  }

  // NEW: Helper method to build deduplication instructions
  buildDeduplicationSection(usedServices, allowRepeats, userExplicitRequest) {
    if (usedServices.length === 0) {
      return '';
    }

    const usedList = usedServices.map(s => `- ${s.name} (${s.category})`).join('\n');
    
    if (allowRepeats) {
      return `
PREVIOUSLY USED SERVICES (repeats OK since this is an edit):
${usedList}

USER REQUEST: "${userExplicitRequest || 'User is making changes'}"`;
    }

    return `
DEDUPLICATION RULES:
PREVIOUSLY USED SERVICES (avoid unless contextually appropriate):
${usedList}

- AVOID repeating services from previous days unless:
  * User explicitly requested it ("strip club every night")
  * No suitable alternatives exist in that category
- PREFER variety and new experiences across the trip
- FOCUS on creating a diverse, memorable experience`;
  }

  fallbackSelection(allServices, userPreferences, dayInfo) {
    // Improved fallback if AI fails
    const categories = {
      restaurants: allServices.filter(s => (s.category === 'restaurant' || s.type?.toLowerCase() === 'restaurant')),
      bars: allServices.filter(s => (s.category === 'bar' || s.type?.toLowerCase() === 'bar')),
      nightclubs: allServices.filter(s => (s.category === 'night_club' || s.type?.toLowerCase() === 'night club')),
      stripclubs: allServices.filter(s => (s.category === 'strip_club' || s.type?.toLowerCase() === 'strip club')),
      activities: allServices.filter(s => (s.category === 'daytime' || s.type?.toLowerCase() === 'daytime')),
      packages: allServices.filter(s => (s.category === 'package' || s.type?.toLowerCase() === 'package'))
    };

    const selectedServices = [];
    
    // Add restaurant for dinner
    if (categories.restaurants[0]) {
      selectedServices.push({
        serviceId: categories.restaurants[0].id,
        serviceName: categories.restaurants[0].name,
        timeSlot: "evening",
        reason: "Fallback restaurant selection for group dinner",
        estimatedDuration: "2 hours",
        groupSuitability: "Perfect for group dining"
      });
    }
    
    // Add strip club if user requested it
    const specialRequests = userPreferences.specialRequests || 
                           userPreferences.interestedActivities?.join(', ') || '';
    if (specialRequests.toLowerCase().includes('strip') && categories.stripclubs[0]) {
      selectedServices.push({
        serviceId: categories.stripclubs[0].id,
        serviceName: categories.stripclubs[0].name,
        timeSlot: "night",
        reason: "User specifically requested strip clubs",
        estimatedDuration: "2-3 hours",
        groupSuitability: "Great for bachelor party groups"
      });
    }
    
    // Add bar/nightclub
    const nightlifeOption = categories.nightclubs[0] || categories.bars[0];
    if (nightlifeOption) {
      selectedServices.push({
        serviceId: nightlifeOption.id,
        serviceName: nightlifeOption.name,
        timeSlot: "late_night",
        reason: "Classic nightlife experience",
        estimatedDuration: "3+ hours",
        groupSuitability: "Perfect for group celebrations"
      });
    }

    return {
      selectedServices: selectedServices,
      alternativeOptions: [],
      dayTheme: "Classic bachelor party experience",
      logisticsNotes: "Standard timing progression"
    };
  }
}