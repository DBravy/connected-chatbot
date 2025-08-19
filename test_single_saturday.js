import { ItineraryBuilder } from './lib/itineraryBuilder.js';

const builder = new ItineraryBuilder();

// Test case: User says "first saturday of september" and confirms "Saturday September 6 for one night"
console.log('=== Testing Single Saturday Confirmation ===');

// Simulate the dateInfo that would come from the confirmation
const dateInfo = {
  startDate: "Saturday September 6 2025", // What the user confirmed
  endDate: null // No end date provided - this was the issue
};

const preferences = {}; // No single event preference set

const groupInfo = {
  groupSize: 7,
  destination: "Austin"
};

console.log('Input dateInfo:', dateInfo);

const tripStructure = builder.detectTripStructure(groupInfo, dateInfo, preferences);

console.log('Generated trip structure:', tripStructure);
console.log('Expected: Single night (totalDays: 1, tripType: single_night)');
console.log('Actual result:');
console.log(`- Total days: ${tripStructure.totalDays}`);
console.log(`- Trip type: ${tripStructure.tripType}`);
console.log(`- Days: ${tripStructure.days}`);

// Test the weekend resolution function
console.log('\n=== Testing Weekend Resolution ===');
import { ChatHandler } from './lib/chatHandler.js';

const handler = new ChatHandler();

// Test that "first saturday of september" does NOT get expanded to weekend
const saturdayText = "first saturday of september";
const saturdayResult = handler.resolveWeekendRangeFromText(saturdayText);
console.log(`"${saturdayText}" resolved to:`, saturdayResult);
console.log('Expected: null (should not be treated as weekend)');

// Test that "first weekend of september" DOES get expanded
const weekendText = "first weekend of september";
const weekendResult = handler.resolveWeekendRangeFromText(weekendText);
console.log(`"${weekendText}" resolved to:`, weekendResult);
console.log('Expected: Friday-Sunday dates');

console.log('\n=== Test Complete ==='); 