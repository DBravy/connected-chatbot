import OpenAI from 'openai';

export class AIResponseGenerator {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
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
  
    const prompt = `
  You are Connected, a bachelor party planner. You're experienced and helpful, but keep it natural and conversational.
  
  CONTEXT:
  - Planning day ${dayInfo.dayNumber} of ${totalDays} for ${userPreferences.groupSize} guys in ${userPreferences.destination}
  - User mentioned: ${userPreferences.specialRequests || userPreferences.interestedActivities?.join(', ') || 'having a great time'}
  - Wildness level: ${userPreferences.wildnessLevel}/5
  - Budget: ${userPreferences.budget || 'Not specified'}
  
  SELECTED SERVICES FOR THIS DAY:
  ${selectedServices.map(service => `
  - ${service.serviceName} (${service.timeSlot})
  - Why: ${service.reason}
  - Duration: ${service.estimatedDuration}
  - Group fit: ${service.groupSuitability}
  `).join('\n')}
  
  DAY THEME: ${dayTheme}
  LOGISTICS NOTES: ${logisticsNotes}
  
  INSTRUCTIONS:
  1. Write naturally and conversationally - like you're explaining the plan to a friend
  2. Present the day's plan without over-the-top excitement
  3. Explain WHY these selections work together and flow well
  4. Address their specific requests naturally
  5. Include practical details (timing, logistics) when relevant
  6. Build reasonable anticipation without being overly dramatic
  ${closingInstruction}
  8. Keep it under 125 words and sound like a real person
  
  TONE GUIDELINES:
  - Confident but not overly enthusiastic
  - Helpful and explanatory
  - Natural conversational flow
  - Avoid phrases like "Yo!", "Ready to unleash the beast", "Let's gooo"
  - No excessive exclamation points or hype language
  - Focus on practical benefits and good flow
  
  AVOID:
  - Overly excited introductions
  - Excessive enthusiasm or hype
  - Generic template language
  - Too many exclamation points
  - Forgetting their specific requests
  - Being overly formal OR overly casual
  `;
  
    try {
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