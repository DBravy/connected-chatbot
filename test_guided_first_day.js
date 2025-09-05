import { ChatHandler } from './api/chatHandler.js';
import { createNewConversation, PHASES } from './api/conversationState.js';

// Mock environment variables
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-key';
process.env.OPENAI_API_KEY = 'test-key';

async function testGuidedFirstDay() {
  console.log('🧪 Testing Guided First Day Experience...\n');
  
  const chatHandler = new ChatHandler();
  const conversation = createNewConversation();
  
  // Set up conversation to be ready for guided first day
  conversation.phase = PHASES.GATHERING;
  chatHandler.setFact(conversation, 'destination', 'Austin');
  chatHandler.setFact(conversation, 'groupSize', 8);
  chatHandler.setFact(conversation, 'startDate', '2025-09-05');
  chatHandler.setFact(conversation, 'endDate', '2025-09-07');
  chatHandler.setFact(conversation, 'wildnessLevel', 7);
  chatHandler.setFact(conversation, 'budget', 'flexible');
  
  // Mock some services for testing
  conversation.availableServices = [
    {
      id: 1,
      name: 'Party Bus Airport Pickup',
      category: 'transportation',
      description: 'Luxury party bus pickup from airport',
      price_cad: 500,
      duration_hours: 1
    },
    {
      id: 2,
      name: 'Sprinter Van | BBQ & Beer Tour',
      category: 'transportation',
      description: 'Start the party with BBQ and beer tour',
      price_cad: 800,
      duration_hours: 4
    },
    {
      id: 3,
      name: 'Austin Bar Hopping',
      category: 'bar',
      description: 'Best bars in Austin',
      price_cad: 300,
      duration_hours: 4
    },
    {
      id: 4,
      name: 'Prime Steakhouse',
      category: 'restaurant',
      name: 'Prime Steakhouse Dinner',
      description: 'Premium steakhouse experience',
      price_cad: 150,
      duration_hours: 2
    },
    {
      id: 5,
      name: "Yellow Rose Gentlemen's Club",
      category: 'strip_club',
      description: 'Premium gentlemen\'s club',
      price_cad: 400,
      duration_hours: 3
    }
  ];
  
  try {
    // Test transition to guided first day
    console.log('1. Testing transition to guided first day phase...');
    const result1 = await chatHandler.handleMessage('test-123', 'I\'m ready to plan');
    console.log('Phase:', result1.phase);
    console.log('Response:', result1.response);
    console.log('Has interactive:', !!result1.interactive);
    
    if (result1.interactive) {
      if (result1.interactive.type === 'guided_cards') {
        console.log('Interactive cards:', result1.interactive.options.map(o => o.title));
      } else {
        console.log('Interactive buttons:', result1.interactive.buttons?.map(b => b.text));
      }
    }
    
    console.log('\n2. Testing airport pickup selection...');
    const result2 = await chatHandler.handleMessage('test-123', 'party_bus_pickup', result1.snapshot);
    console.log('Phase:', result2.phase);
    console.log('Response:', result2.response);
    console.log('Has interactive:', !!result2.interactive);
    
    if (result2.interactive) {
      if (result2.interactive.type === 'guided_cards') {
        console.log('Interactive cards:', result2.interactive.options.map(o => o.title));
      } else {
        console.log('Interactive buttons:', result2.interactive.buttons?.map(b => b.text));
      }
    }
    
    console.log('\n3. Testing evening activity selection...');
    const result3 = await chatHandler.handleMessage('test-123', 'steakhouse', result2.snapshot);
    console.log('Phase:', result3.phase);
    console.log('Response:', result3.response);
    console.log('Has itinerary:', !!result3.itinerary);
    
    if (result3.itinerary && result3.itinerary[0]) {
      console.log('First day services:', result3.itinerary[0].selectedServices.map(s => s.serviceName));
    }
    
    console.log('\n✅ Guided First Day test completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error(error.stack);
  }
}

// Run the test
testGuidedFirstDay().catch(console.error); 