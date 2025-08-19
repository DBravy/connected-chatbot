import { ChatHandler } from './api/chatHandler.js';
import dotenv from 'dotenv';

dotenv.config();

async function testAIPlanner() {
  const chatHandler = new ChatHandler();
  
  // Test 1: Basic test with strip clubs request
  console.log('🧪 TEST 1: Basic AI Planner with Strip Clubs');
  console.log('='.repeat(50));
  
  const testData1 = {
    destination: 'Austin',
    groupSize: 8,
    duration: 3,
    wildnessLevel: 4,
    startDate: '2024-09-04',
    endDate: '2024-09-06',
    budget: '$2000',
    specialRequests: 'strip clubs and college friends',
    interestedActivities: ['strip clubs', 'golf', 'nightlife']
  };

  console.log('Input:', testData1);
  
  const result1 = await chatHandler.generateItinerary(testData1);
  
  console.log('\n📊 Results:');
  console.log(`Success: ${result1.success}`);
  if (result1.success) {
    console.log(`Total services found: ${result1.totalServices}`);
    console.log(`Categories available: ${result1.categoriesAvailable?.join(', ')}`);
    
    if (result1.itinerary) {
      result1.itinerary.forEach(day => {
        console.log(`\n--- DAY ${day.day} (${day.date}) ---`);
        console.log('AI Response:');
        console.log(day.responseText);
        console.log('\nSelected Services:');
        day.services.forEach(service => {
          console.log(`  - ${service.serviceName} (${service.timeSlot})`);
          console.log(`    Reason: ${service.reason}`);
          console.log(`    Duration: ${service.estimatedDuration}`);
        });
        if (day.alternatives.length > 0) {
          console.log('\nAlternatives:');
          day.alternatives.forEach(alt => {
            console.log(`  - ${alt.serviceName}: ${alt.reason}`);
          });
        }
      });
    }
  } else {
    console.log(`Error: ${result1.error}`);
    console.log(`Fallback: ${result1.fallback}`);
  }

  // Test 2: Different wildness level and activities
  console.log('\n\n🧪 TEST 2: Lower Wildness Level with Golf');
  console.log('='.repeat(50));
  
  const testData2 = {
    destination: 'Austin',
    groupSize: 6,
    duration: 2,
    wildnessLevel: 2,
    startDate: '2024-10-15',
    endDate: '2024-10-16',
    specialRequests: 'golf and good food',
    interestedActivities: ['golf', 'steakhouse', 'bar hopping']
  };

  console.log('Input:', testData2);
  
  const result2 = await chatHandler.generateItinerary(testData2);
  
  console.log('\n📊 Results:');
  console.log(`Success: ${result2.success}`);
  if (result2.success && result2.itinerary) {
    result2.itinerary.forEach(day => {
      console.log(`\n--- DAY ${day.day} (${day.date}) ---`);
      console.log(day.responseText);
    });
  }

  // Test 3: Test conversation format (like real app would use)
  console.log('\n\n🧪 TEST 3: Conversation Facts Format');
  console.log('='.repeat(50));
  
  const conversationFormat = {
    facts: {
      destination: { value: 'Austin', status: 'set' },
      groupSize: { value: 12, status: 'set' },
      startDate: { value: '2024-11-01', status: 'set' },
      endDate: { value: '2024-11-03', status: 'set' },
      wildnessLevel: { value: 5, status: 'set' },
      interestedActivities: { value: ['strip clubs', 'boat', 'nightclub'], status: 'set' },
      relationship: { value: 'college friends', status: 'set' }
    }
  };

  console.log('Input (facts format):', JSON.stringify(conversationFormat, null, 2));
  
  const result3 = await chatHandler.generateItinerary(conversationFormat);
  
  console.log('\n📊 Results:');
  console.log(`Success: ${result3.success}`);
  if (result3.success && result3.itinerary) {
    result3.itinerary.forEach(day => {
      console.log(`\n--- DAY ${day.day} (${day.date}) ---`);
      console.log(day.responseText);
      console.log('\nServices by Time Slot:');
      day.services.forEach(service => {
        console.log(`  ${service.timeSlot.toUpperCase()}: ${service.serviceName}`);
      });
    });
  }

  // Test 4: Verify specific service inclusion
  console.log('\n\n🧪 TEST 4: Service Inclusion Analysis');
  console.log('='.repeat(50));
  
  // Check if strip clubs are actually being included
  const allResults = [result1, result2, result3].filter(r => r.success);
  
  allResults.forEach((result, index) => {
    console.log(`\nTest ${index + 1} Service Analysis:`);
    if (result.itinerary) {
      result.itinerary.forEach(day => {
        const hasStripClub = day.services.some(s => 
          s.serviceName.toLowerCase().includes('strip') || 
          s.serviceName.toLowerCase().includes('gentlemen')
        );
        const hasGolf = day.services.some(s => 
          s.serviceName.toLowerCase().includes('golf') || 
          s.serviceName.toLowerCase().includes('topgolf')
        );
        const hasNightlife = day.services.some(s => 
          s.timeSlot === 'night' || s.timeSlot === 'late_night'
        );
        
        console.log(`  Day ${day.day}: Strip Club: ${hasStripClub}, Golf: ${hasGolf}, Nightlife: ${hasNightlife}`);
      });
    }
  });
}

// Helper function to test individual components
async function testIndividualComponents() {
  console.log('\n\n🔧 COMPONENT TESTING');
  console.log('='.repeat(50));
  
  const chatHandler = new ChatHandler();
  
  // Test service search
  console.log('Testing service search...');
  const services = await chatHandler.searchAvailableServices('Austin', 8);
  console.log(`Found ${services.length} services`);
  
  // Group by category
  const grouped = chatHandler.groupServicesByCategory(services);
  console.log('Categories found:', Object.keys(grouped));
  Object.entries(grouped).forEach(([cat, services]) => {
    console.log(`  ${cat}: ${services.length} services`);
    if (services.length > 0) {
      console.log(`    Sample: ${services[0].name}`);
    }
  });
  
  // Test keyword extraction
  const keywords = chatHandler.extractKeywords({
    specialRequests: 'strip clubs and golf',
    interestedActivities: ['boat', 'steakhouse']
  });
  console.log('Extracted keywords:', keywords);
}

// Run all tests
async function runAllTests() {
  try {
    await testAIPlanner();
    await testIndividualComponents();
    
    console.log('\n✅ All tests completed!');
    console.log('\nKey things to check:');
    console.log('1. Strip clubs should be included when requested');
    console.log('2. Different wildness levels should affect selections');
    console.log('3. AI responses should be varied and conversational');
    console.log('4. Services should match user preferences');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
  
  process.exit(0);
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(console.error);
}