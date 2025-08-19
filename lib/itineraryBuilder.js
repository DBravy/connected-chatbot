export class ItineraryBuilder {
    constructor() {
      this.selectedServices = [];
    }
  
    // Generate a simple conversational summary of selected services
    generateItinerarySummary(selectedServices, facts) {
      const { destination, groupSize, startDate, endDate } = facts;
      
      // Calculate days
      const toLocalDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s)
      ? new Date(Number(s.slice(0,4)), Number(s.slice(5,7)) - 1, Number(s.slice(8,10)))
      : new Date(s);
    
    // Use local-safe dates
      const start = toLocalDate(startDate.value);
      const end = toLocalDate(endDate.value);
      const days = Math.max(1, Math.ceil((end - start) / (24 * 60 * 60 * 1000)) + 1);
      
      let summary = `here's what I'm thinking for your ${destination.value} ${days === 1 ? 'night' : 'weekend'}:\n\n`;
  
      // Format by day
      for (let i = 0; i < days; i++) {
        const currentDate = new Date(start);
        currentDate.setDate(start.getDate() + i);
        const dayName = currentDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        
        summary += `${dayName}:\n`;
        
        if (i === 0) {
          // First day
          if (selectedServices.restaurants?.[0]) {
            const restaurant = selectedServices.restaurants[0];
            summary += `• Evening: Dinner at ${restaurant.name} - ${restaurant.description}\n`;
          }
          const nightlifeFirst =
          (selectedServices.stripclubs?.[0]) ||
          (selectedServices.nightclubs?.[0]) ||
          (selectedServices.bars?.[0]) ||
          (selectedServices.nightlife?.name ? selectedServices.nightlife : null);
        
          if (nightlifeFirst) {
            const name = nightlifeFirst.name || nightlifeFirst.serviceName || 'Nightlife';
            summary += `• Night: ${name} — this is where the legendary stories happen\n`;
          }
        } else if (i === days - 1 && days > 1) {
          // Last day
          summary += `• Morning: Recovery brunch before heading home\n`;
        } else {
          // Middle days
          if (selectedServices.activities?.[0]) {
            const activity = selectedServices.activities[0];
            summary += `• Afternoon: ${activity.name} - ${activity.description}\n`;
          }
          summary += `• Evening: Great dinner and drinks\n`;
          const nightlifeMid =
          (selectedServices.stripclubs?.[0]) ||
          (selectedServices.nightclubs?.[0]) ||
          (selectedServices.bars?.[0]) ||
          (selectedServices.nightlife?.name ? selectedServices.nightlife : null);
        
          if (nightlifeMid) {
            const name = nightlifeMid.name || nightlifeMid.serviceName || 'Nightlife';
            summary += `• Night: Amazing night out at ${name}\n`;
          }
        }
        
        if (i < days - 1) summary += '\n';
      }
  
      if (selectedServices.transportation?.[0]) {
        const transport = selectedServices.transportation[0];
        summary += `\nTransportation: ${transport.name} - ${transport.description}\n`;
      }
  
      summary += `\nThis gives you guys the perfect mix of ${groupSize.value} dude energy and unforgettable experiences. What do you think of this flow?`;
  
      return summary;
    }
  
    // Calculate rough pricing estimate
    calculateEstimate(selectedServices, groupSize) {
      let totalEstimate = 0;
      const breakdown = {};
  
      Object.entries(selectedServices).forEach(([category, services]) => {
        let categoryTotal = 0;
        if (Array.isArray(services)) {
          services.forEach(service => {
            const servicePrice = service.price_cad || service.price_usd || 0;
            categoryTotal += servicePrice;
          });
        } else if (services) {
          // Single service object
          const servicePrice = services.price_cad || services.price_usd || 0;
          categoryTotal += servicePrice;
        }
        
        if (categoryTotal > 0) {
          breakdown[category] = categoryTotal;
          totalEstimate += categoryTotal;
        }
      });
  
      // Rough per-person estimate
      const perPersonEstimate = Math.round(totalEstimate);
      const totalForGroup = Math.round(totalEstimate * groupSize);
  
      return {
        perPerson: perPersonEstimate,
        total: totalForGroup,
        breakdown,
        currency: 'CAD' // Default to CAD for now
      };
    }
  
    // Reset selections
    reset() {
      this.selectedServices = [];
    }
  }