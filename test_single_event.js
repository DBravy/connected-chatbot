// test_single_event.js
import { ItineraryBuilder } from './lib/itineraryBuilder.js';

// Test the new single event functionality
async function testSingleEvent() {
  console.log('=== Testing Single Event Functionality ===\n');
  
  const builder = new ItineraryBuilder();
  
  // Test case 1: Single event preference detected
  console.log('Test 1: Single Event with singleEvent preference');
  const preferences1 = {
    wildnessLevel: 4,
    interestedActivities: ["dinner", "nightlife"],
    singleEvent: true
  };
  
  const dateInfo1 = {
    startDate: "saturday night",
    endDate: null
  };
  
  const tripStructure1 = builder.detectTripStructure(
    { groupSize: 12, destination: "Las Vegas" },
    dateInfo1,
    preferences1
  );
  
  console.log('Trip Structure:', tripStructure1);
  console.log('Trip Type:', tripStructure1.tripType);
  console.log('Days:', tripStructure1.days);
  console.log('Total Days:', tripStructure1.totalDays);
  console.log('');
  
  // Test case 2: Single night (1 day)
  console.log('Test 2: Single Night Trip');
  const preferences2 = {
    wildnessLevel: 3,
    interestedActivities: ["bars", "clubs"],
    singleEvent: false
  };
  
  const dateInfo2 = {
    startDate: "friday night",
    endDate: null
  };
  
  const tripStructure2 = builder.detectTripStructure(
    { groupSize: 8, destination: "Montreal" },
    dateInfo2,
    preferences2
  );
  
  console.log('Trip Structure:', tripStructure2);
  console.log('Trip Type:', tripStructure2.tripType);
  console.log('Days:', tripStructure2.days);
  console.log('Total Days:', tripStructure2.totalDays);
  console.log('');
  
  // Test case 3: Regular weekend trip
  console.log('Test 3: Regular Weekend Trip');
  const preferences3 = {
    wildnessLevel: 4,
    interestedActivities: ["activities", "nightlife"],
    singleEvent: false
  };
  
  const dateInfo3 = {
    startDate: "friday",
    endDate: "sunday"
  };
  
  const tripStructure3 = builder.detectTripStructure(
    { groupSize: 15, destination: "Austin" },
    dateInfo3,
    preferences3
  );
  
  console.log('Trip Structure:', tripStructure3);
  console.log('Trip Type:', tripStructure3.tripType);
  console.log('Days:', tripStructure3.days);
  console.log('Total Days:', tripStructure3.totalDays);
  console.log('');
  
  // Test generateTripOverview for different types
  console.log('=== Testing Trip Overviews ===\n');
  
  console.log('Single Event Overview:');
  const overview1 = builder.generateTripOverview(tripStructure1, preferences1, { destination: "Las Vegas", groupSize: 12 });
  console.log(overview1);
  console.log('');
  
  console.log('Single Night Overview:');
  const overview2 = builder.generateTripOverview(tripStructure2, preferences2, { destination: "Montreal", groupSize: 8 });
  console.log(overview2);
  console.log('');
  
  console.log('Weekend Overview:');
  const overview3 = builder.generateTripOverview(tripStructure3, preferences3, { destination: "Austin", groupSize: 15 });
  console.log(overview3);
  console.log('');
}

// Run the test
testSingleEvent().catch(console.error); 